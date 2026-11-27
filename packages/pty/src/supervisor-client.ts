// Client side of the detached PTY supervisor: spawn one, connect/attach to one, list them.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BizziError, inheritedImportArgs } from '@bizzi/protocol';
import type { ExitInfo, PtyBackend, PtySpawnOptions } from './backend.ts';
import {
  SUPERVISOR_ID_RE,
  lineParser,
  metaPath,
  sendMessage,
  socketPath,
  specPath,
  type HelloMessage,
  type SupervisorMessage,
  type SupervisorMeta,
  type SupervisorSpec,
} from './supervisor-protocol.ts';

export const SUPERVISOR_SCRIPT = fileURLToPath(new URL('./supervisor.ts', import.meta.url));

/** macOS sun_path is 104 bytes incl. NUL (Linux: 108). */
const MAX_SOCKET_PATH = 103;

/** `$XDG_RUNTIME_DIR/bizzi-pty`, else `<tmpdir>/bizzi-pty-<uid>`. */
export function defaultRuntimeDir(): string {
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg) return join(xdg, 'bizzi-pty');
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
  return join(tmpdir(), `bizzi-pty-${uid}`);
}

/** Create the runtime dir (0700) and refuse one owned by someone else. */
export function ensureRuntimeDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = statSync(dir);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new BizziError('internal', `PTY runtime dir ${dir} is owned by another user`);
  }
  if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
}

export function newSupervisorId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let id = '';
  for (const b of randomBytes(16)) id += alphabet[b % 32];
  return id;
}

export interface SpawnSupervisorOptions extends PtySpawnOptions {
  runtimeDir: string;
  scrollbackBytes: number;
  lingerMs?: number;
  orphanTimeoutMs?: number;
  killTimeoutMs?: number;
  labels?: Record<string, string>;
  /** Node binary for the supervisor. Default: process.execPath (Electron: run as node). */
  nodePath?: string;
  /** Supervisor script. Default: the bundled supervisor.ts. */
  script?: string;
  readyTimeoutMs?: number;
}

/** Start a detached supervisor owning a new PTY. Resolves with its id once it is listening. */
export async function spawnSupervisor(opts: SpawnSupervisorOptions): Promise<string> {
  ensureRuntimeDir(opts.runtimeDir);
  const id = newSupervisorId();
  const sock = socketPath(opts.runtimeDir, id);
  if (Buffer.byteLength(sock) > MAX_SOCKET_PATH) {
    throw new BizziError('internal', `PTY runtime dir path too long for a Unix socket: ${sock}`);
  }
  const spec: SupervisorSpec = {
    id,
    command: opts.command,
    args: opts.args ?? [],
    cwd: opts.cwd,
    env: opts.env,
    cols: opts.cols ?? 120,
    rows: opts.rows ?? 32,
    scrollbackBytes: opts.scrollbackBytes,
    lingerMs: opts.lingerMs ?? 10 * 60_000,
    orphanTimeoutMs: opts.orphanTimeoutMs ?? 0,
    killTimeoutMs: opts.killTimeoutMs ?? 3000,
    labels: opts.labels ?? {},
  };
  const specFile = specPath(opts.runtimeDir, id);
  writeFileSync(specFile, JSON.stringify(spec), { mode: 0o600 });

  const env: Record<string, string | undefined> = { ...process.env };
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  // The parent's `--import` hook (packaged builds resolve @bizzi/* with it) goes along.
  const args = [...inheritedImportArgs(process.execArgv), opts.script ?? SUPERVISOR_SCRIPT, specFile];
  const child = spawn(opts.nodePath ?? process.execPath, args, {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: opts.runtimeDir,
    env,
  });

  try {
    await new Promise<void>((resolve, reject) => {
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new BizziError('agent_unavailable', `PTY supervisor did not start in time${err ? `: ${err.trim()}` : ''}`));
      }, opts.readyTimeoutMs ?? 10_000);
      child.stdout!.on('data', (d: Buffer) => {
        out += d.toString();
        if (out.includes('ready\n')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.stderr!.on('data', (d: Buffer) => {
        if (err.length < 8192) err += d.toString();
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(new BizziError('agent_unavailable', `cannot start PTY supervisor: ${e.message}`));
      });
      child.on('exit', (code, signal) => {
        clearTimeout(timer);
        reject(
          new BizziError(
            'agent_unavailable',
            `PTY supervisor exited during startup (${signal ?? `code ${code}`})${err ? `: ${err.trim()}` : ''}`,
          ),
        );
      });
    });
  } catch (e) {
    rmSync(specFile, { force: true });
    throw e;
  } finally {
    child.removeAllListeners();
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
  }
  return id;
}

export interface SupervisorAttachment {
  hello: HelloMessage;
  /** Full scrollback the supervisor held at attach time; covers [hello.start, hello.end). */
  scrollback: Buffer;
  backend: SupervisorBackend;
}

/** Connect to a running supervisor and attach. Rejects with BizziError('not_found') if it is gone. */
export function attachSupervisor(runtimeDir: string, id: string, opts: { timeoutMs?: number } = {}): Promise<SupervisorAttachment> {
  if (!SUPERVISOR_ID_RE.test(id)) return Promise.reject(new BizziError('bad_request', `invalid PTY supervisor id: ${id}`));
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath(runtimeDir, id));
    let hello: HelloMessage | undefined;
    const replay: Buffer[] = [];
    let backend: SupervisorBackend | undefined;
    let settled = false;
    const fail = (err: BizziError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    };
    const timer = setTimeout(() => fail(new BizziError('internal', `PTY supervisor ${id} did not answer`)), opts.timeoutMs ?? 5000);

    socket.on('error', (e: NodeJS.ErrnoException) => {
      if (!settled) {
        const gone = e.code === 'ENOENT' || e.code === 'ECONNREFUSED';
        fail(new BizziError(gone ? 'not_found' : 'internal', `PTY supervisor ${id} unreachable: ${e.message}`));
      }
    });
    socket.on('close', () => {
      if (!settled) fail(new BizziError('not_found', `PTY supervisor ${id} closed the connection`));
    });
    socket.on(
      'data',
      lineParser<SupervisorMessage>((msg) => {
        if (backend) {
          backend.handle(msg);
          return;
        }
        if (msg.t === 'hello') hello = msg;
        else if (msg.t === 'replay') replay.push(Buffer.from(msg.b64, 'base64'));
        else if (msg.t === 'replayed' && hello) {
          settled = true;
          clearTimeout(timer);
          backend = new SupervisorBackend(socket, hello);
          resolve({ hello, scrollback: Buffer.concat(replay), backend });
        }
      }),
    );
    socket.on('connect', () => sendMessage(socket, { t: 'attach' }));
  });
}

/** PtyBackend over a supervisor connection. Buffers events until handlers are registered. */
export class SupervisorBackend implements PtyBackend {
  readonly pid: number;
  readonly #socket: Socket;
  #dataCb: ((d: Buffer) => void) | undefined;
  #exitCb: ((e: ExitInfo) => void) | undefined;
  #pendingData: Buffer[] = [];
  #pendingExit: ExitInfo | undefined;
  #exited = false;
  #detached = false;
  #lastAck = -1;

  constructor(socket: Socket, hello: HelloMessage) {
    this.#socket = socket;
    this.pid = hello.pid;
    socket.on('close', () => {
      // Supervisor vanished without reporting an exit (crash, kill -9): treat as exited.
      if (!this.#exited && !this.#detached) this.#emitExit({ exitCode: null, signal: 'SIGKILL' });
    });
  }

  /** @internal */
  handle(msg: SupervisorMessage): void {
    if (msg.t === 'data') {
      const buf = Buffer.from(msg.b64, 'base64');
      if (this.#dataCb) this.#dataCb(buf);
      else this.#pendingData.push(buf);
    } else if (msg.t === 'exit') {
      this.#emitExit(msg.signal ? { exitCode: null, signal: msg.signal } : { exitCode: msg.exitCode });
    }
  }

  write(data: Buffer): void {
    if (!this.#exited) sendMessage(this.#socket, { t: 'input', b64: data.toString('base64') });
  }
  resize(cols: number, rows: number): void {
    if (!this.#exited) sendMessage(this.#socket, { t: 'resize', cols, rows });
  }
  kill(signal?: string): void {
    if (!this.#exited) sendMessage(this.#socket, { t: 'kill', signal });
  }
  ack(offset: number): void {
    if (offset > this.#lastAck) {
      this.#lastAck = offset;
      sendMessage(this.#socket, { t: 'ack', offset });
    }
  }
  onData(cb: (data: Buffer) => void): void {
    this.#dataCb = cb;
    const pending = this.#pendingData;
    this.#pendingData = [];
    for (const d of pending) cb(d);
  }
  onExit(cb: (info: ExitInfo) => void): void {
    this.#exitCb = cb;
    if (this.#pendingExit) cb(this.#pendingExit);
  }
  detach(): void {
    this.#detached = true;
    this.#socket.end();
  }

  #emitExit(info: ExitInfo): void {
    if (this.#exited) return;
    this.#exited = true;
    if (this.#exitCb) this.#exitCb(info);
    else this.#pendingExit = info;
    // The supervisor shuts down once we disconnect after seeing the exit.
    this.#socket.end();
  }
}

export function readSupervisorMeta(runtimeDir: string, id: string): SupervisorMeta | undefined {
  if (!SUPERVISOR_ID_RE.test(id)) return undefined;
  try {
    return JSON.parse(readFileSync(metaPath(runtimeDir, id), 'utf8')) as SupervisorMeta;
  } catch {
    return undefined;
  }
}

export function removeSupervisorFiles(runtimeDir: string, id: string): void {
  if (!SUPERVISOR_ID_RE.test(id)) return;
  rmSync(metaPath(runtimeDir, id), { force: true });
  rmSync(socketPath(runtimeDir, id), { force: true });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Supervisors known in `runtimeDir` (live or exited-but-uncollected), for discovery and GC. */
export function listSupervisors(runtimeDir: string = defaultRuntimeDir()): (SupervisorMeta & { alive: boolean })[] {
  let names: string[];
  try {
    names = readdirSync(runtimeDir);
  } catch {
    return [];
  }
  const out: (SupervisorMeta & { alive: boolean })[] = [];
  for (const name of names) {
    const m = /^([a-z2-7]{16})\.json$/.exec(name);
    if (!m) continue;
    const meta = readSupervisorMeta(runtimeDir, m[1]!);
    if (meta) out.push({ ...meta, alive: pidAlive(meta.supervisorPid) });
  }
  return out;
}
