// Finds or starts the bizzi core (node role) for this laptop and keeps it running.
//
// - attach: `<dataDir>/serve.json` names a live pid whose /healthz answers -> use it (e.g. a
//   launchd `bizzi serve`). It is polled; if it goes away we attach-or-spawn again.
// - spawn: run `<node> <cli entry> serve --host 127.0.0.1 --port 0 --data-dir <dataDir>` as a
//   detached process (its own process group, stderr straight to the log file) so it survives a UI
//   crash, read the ready line from stdout, and restart it with backoff if it dies.
// - stop: only a core this app spawned is stopped (SIGTERM, which drains), never an attached one.
//   Ownership is recorded in `<dataDir>/desktop-core.json` so a relaunched app re-adopts a core
//   that a crashed instance had spawned.
//
// Electron-free, so it is testable under plain Node.

import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Logger, ServeReady } from '@bizzi/protocol';
import { Backoff, type BackoffOptions } from './backoff.ts';
import { rotateIfLarge } from './log.ts';
import { waitForReadyLine } from './ready-line.ts';
import { checkHealth, decideAttach, isPidAlive, type HealthCheck } from './serve-file.ts';

export interface CoreLaunch {
  command: string;
  /** Arguments before `serve ...`, typically the CLI entry path. */
  args: string[];
  env?: Record<string, string>;
}

export type CoreState = 'idle' | 'starting' | 'attached' | 'running' | 'restarting' | 'stopping' | 'stopped';

export interface CoreStatus {
  state: CoreState;
  connection: ServeReady | null;
  /** True when this app spawned (and will stop) the core. */
  owned: boolean;
  lastError?: string;
  restarts: number;
}

export interface CoreManagerOptions {
  dataDir: string;
  /** Resolved lazily (and again on every spawn) so a fixed PATH/BIZZI_NODE is picked up. */
  resolveLaunch: () => Promise<CoreLaunch>;
  logger: Logger;
  /** Where the core's stderr goes. Default `<dataDir>/logs/core.log`. */
  logFile?: string;
  readyTimeoutMs?: number;
  healthIntervalMs?: number;
  healthTimeoutMs?: number;
  stopTimeoutMs?: number;
  backoff?: BackoffOptions;
  health?: HealthCheck;
  onStatus?: (status: CoreStatus) => void;
}

const OWNER_FILE = 'desktop-core.json';

export class CoreManager {
  readonly #o: CoreManagerOptions;
  readonly #log: Logger;
  readonly #backoff: Backoff;
  #state: CoreState = 'idle';
  #conn: ServeReady | null = null;
  #owned = false;
  #child: ChildProcess | null = null;
  #since = 0;
  #restarts = 0;
  #lastError: string | undefined;
  #restartTimer: NodeJS.Timeout | null = null;
  #healthTimer: NodeJS.Timeout | null = null;
  #healthFailures = 0;
  #ensuring: Promise<void> | null = null;

  constructor(opts: CoreManagerOptions) {
    this.#o = opts;
    this.#log = opts.logger.child({ component: 'core-supervisor' });
    this.#backoff = new Backoff(opts.backoff);
  }

  get status(): CoreStatus {
    return {
      state: this.#state,
      connection: this.#conn,
      owned: this.#owned,
      lastError: this.#lastError,
      restarts: this.#restarts,
    };
  }

  get logFile(): string {
    return this.#o.logFile ?? join(this.#o.dataDir, 'logs', 'core.log');
  }

  /** First attach-or-spawn attempt. Resolves with the connection, or null if that attempt failed
   *  (a retry is then already scheduled). */
  async start(): Promise<ServeReady | null> {
    if (this.#state !== 'idle') return this.#conn;
    await this.#ensure();
    return this.#conn;
  }

  /** Stops a core this app spawned (draining via SIGTERM); detaches from any other. */
  async stop(): Promise<void> {
    if (this.#state === 'stopped') return;
    this.#setState('stopping');
    this.#clearTimers();
    await this.#ensuring?.catch(() => {});
    const conn = this.#conn;
    if (this.#owned && conn) {
      this.#log.log('info', 'stopping core', { pid: conn.pid });
      await this.#terminate(conn.pid, this.#child);
      await rm(join(this.#o.dataDir, OWNER_FILE), { force: true });
    } else if (conn) {
      this.#log.log('info', 'detaching from core (not spawned by this app)', { pid: conn.pid });
    }
    this.#conn = null;
    this.#owned = false;
    this.#child = null;
    this.#setState('stopped');
  }

  // -------------------------------------------------------------------------------------------

  #ensure(): Promise<void> {
    this.#ensuring ??= this.#attachOrSpawn().finally(() => {
      this.#ensuring = null;
    });
    return this.#ensuring;
  }

  async #attachOrSpawn(): Promise<void> {
    if (this.#isStopping()) return;
    this.#setState('starting');
    try {
      const decision = await decideAttach(this.#o.dataDir, { health: this.#o.health });
      if (this.#isStopping()) return;
      if (decision.attach) {
        await this.#attach(decision.ready);
        return;
      }
      this.#log.log('info', 'no running core to attach to; spawning one', {
        reason: decision.reason,
        detail: decision.detail,
      });
      await this.#spawn();
    } catch (err) {
      if (this.#isStopping()) return;
      this.#lastError = err instanceof Error ? err.message : String(err);
      this.#log.log('error', 'core start failed', { error: this.#lastError });
      this.#scheduleRestart();
    }
  }

  async #attach(ready: ServeReady): Promise<void> {
    const owner = await this.#readOwner();
    this.#owned = owner === ready.pid;
    this.#child = null;
    this.#conn = ready;
    this.#since = Date.now();
    this.#lastError = undefined;
    this.#log.log('info', 'attached to running core', { pid: ready.pid, url: ready.url, owned: this.#owned });
    this.#startHealthPolling();
    this.#setState('attached');
  }

  async #spawn(): Promise<void> {
    const launch = await this.#o.resolveLaunch();
    const args = [...launch.args, 'serve', '--host', '127.0.0.1', '--port', '0', '--data-dir', this.#o.dataDir];
    mkdirSync(this.#o.dataDir, { recursive: true });
    mkdirSync(dirname(this.logFile), { recursive: true });
    rotateIfLarge(this.logFile);
    const errFd = openSync(this.logFile, 'a');
    let child: ChildProcess;
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, ...launch.env };
      if (!launch.env?.['ELECTRON_RUN_AS_NODE']) delete env['ELECTRON_RUN_AS_NODE'];
      child = spawn(launch.command, args, {
        stdio: ['ignore', 'pipe', errFd],
        env,
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } finally {
      closeSync(errFd);
    }
    this.#log.log('info', 'spawned core', { pid: child.pid, command: launch.command, args });

    const exited = new Promise<never>((_, reject) => {
      child.once('error', (err) => reject(err));
      child.once('exit', (code, signal) => reject(new Error(`core exited before ready (code ${code}, signal ${signal})`)));
    });
    exited.catch(() => {});

    let ready: ServeReady;
    try {
      ready = await Promise.race([
        waitForReadyLine(child.stdout!, {
          timeoutMs: this.#o.readyTimeoutMs ?? 30_000,
          onOtherLine: (line) => this.#log.log('warn', 'unexpected core stdout', { line }),
        }),
        exited,
      ]);
    } catch (err) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      throw err;
    }

    if (this.#isStopping()) {
      await this.#terminate(ready.pid, child);
      return;
    }

    this.#child = child;
    this.#conn = ready;
    this.#owned = true;
    this.#since = Date.now();
    this.#lastError = undefined;
    await writeFile(join(this.#o.dataDir, OWNER_FILE), JSON.stringify({ pid: ready.pid, startedAt: new Date().toISOString() }) + '\n');
    child.once('exit', (code, signal) => this.#onChildExit(child, code, signal));
    this.#log.log('info', 'core ready', { pid: ready.pid, url: ready.url, machineId: ready.machineId });
    this.#setState('running');
  }

  #onChildExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#child !== child || this.#isStopping()) return;
    const uptime = Date.now() - this.#since;
    this.#log.log('warn', 'core exited', { code, signal, uptimeMs: uptime });
    this.#lastError = `core exited (code ${code}, signal ${signal})`;
    this.#child = null;
    this.#conn = null;
    this.#owned = false;
    this.#backoff.onExit(uptime);
    this.#scheduleRestart();
  }

  #startHealthPolling(): void {
    this.#stopHealthPolling();
    this.#healthFailures = 0;
    const interval = this.#o.healthIntervalMs ?? 5000;
    const health = this.#o.health ?? checkHealth;
    this.#healthTimer = setInterval(async () => {
      const conn = this.#conn;
      if (!conn || this.#state !== 'attached') return;
      const ok = isPidAlive(conn.pid) && (await health(conn, this.#o.healthTimeoutMs ?? 2000));
      if (this.#conn !== conn || this.#state !== 'attached') return;
      this.#healthFailures = ok ? 0 : this.#healthFailures + 1;
      if (this.#healthFailures >= 2) {
        const uptime = Date.now() - this.#since;
        this.#log.log('warn', 'attached core stopped answering', { pid: conn.pid, uptimeMs: uptime });
        this.#lastError = 'attached core stopped answering';
        this.#stopHealthPolling();
        this.#conn = null;
        this.#owned = false;
        this.#backoff.onExit(uptime);
        this.#scheduleRestart();
      }
    }, interval);
    this.#healthTimer.unref();
  }

  #stopHealthPolling(): void {
    if (this.#healthTimer) clearInterval(this.#healthTimer);
    this.#healthTimer = null;
  }

  #scheduleRestart(): void {
    if (this.#isStopping()) return;
    const delay = this.#backoff.next();
    this.#restarts++;
    this.#log.log('info', 'restarting core', { inMs: delay, attempt: this.#backoff.attempt });
    this.#setState('restarting');
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      void this.#ensure();
    }, delay);
  }

  async #terminate(pid: number, child: ChildProcess | null): Promise<void> {
    const timeoutMs = this.#o.stopTimeoutMs ?? 30_000;
    const gone = child
      ? new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) resolve();
          else child.once('exit', () => resolve());
        })
      : waitForPidExit(pid, timeoutMs + 1000);
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return; // already gone
    }
    const timedOut = await Promise.race([gone.then(() => false), sleep(timeoutMs).then(() => true)]);
    if (timedOut) {
      this.#log.log('warn', 'core did not drain in time; killing it', { pid, timeoutMs });
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // gone in the meantime
      }
    }
  }

  async #readOwner(): Promise<number | null> {
    try {
      const v = JSON.parse(await readFile(join(this.#o.dataDir, OWNER_FILE), 'utf8')) as { pid?: unknown };
      return typeof v.pid === 'number' ? v.pid : null;
    } catch {
      return null;
    }
  }

  #isStopping(): boolean {
    return this.#state === 'stopping' || this.#state === 'stopped';
  }

  #clearTimers(): void {
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    this.#restartTimer = null;
    this.#stopHealthPolling();
  }

  #setState(state: CoreState): void {
    if (this.#state === 'stopped') return;
    this.#state = state;
    this.#o.onStatus?.(this.status);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isPidAlive(pid)) await sleep(100);
}
