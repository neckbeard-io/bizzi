import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_VERSION, sessionChannel, type ChannelEvent, type ServeReady } from '@bizzi/protocol';
import { createJsonLogger } from '@bizzi/core';
import WebSocket from 'ws';
import { loadAdapters } from '../src/adapters.ts';

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));

function tempDir() {
  const path = mkdtempSync(join(os.tmpdir(), 'bizzi-cli-'));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

interface Serving {
  child: ChildProcess;
  ready: ServeReady;
  stdout: () => string;
  stderr: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

async function startServe(dataDir: string, env: Record<string, string> = {}): Promise<Serving> {
  const child = spawn(process.execPath, [MAIN, 'serve', '--fake', '--port', '0', '--data-dir', dataDir, '--name', 'cli-test'], {
    env: { ...process.env, BIZZI_TOKEN: 'tok-cli', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout!.setEncoding('utf8').on('data', (d: string) => (out += d));
  child.stderr!.setEncoding('utf8').on('data', (d: string) => (err += d));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  const line = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no ready line; stderr:\n${err}`)), 10_000);
    const check = () => {
      const nl = out.indexOf('\n');
      if (nl >= 0) {
        clearTimeout(t);
        resolve(out.slice(0, nl));
      }
    };
    child.stdout!.on('data', check);
    child.once('exit', () => reject(new Error(`serve exited early; stderr:\n${err}`)));
  });
  return { child, ready: JSON.parse(line) as ServeReady, stdout: () => out, stderr: () => err, exited };
}

class Client {
  readonly ws: WebSocket;
  readonly events: ChannelEvent[] = [];
  readonly #pending = new Map<string, (m: { result?: unknown; error?: { code: string; message: string } }) => void>();
  #n = 0;
  readonly opened: Promise<void>;
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if ('ch' in msg) this.events.push(msg);
      else this.#pending.get(msg.id)?.(msg);
    });
  }
  async request(method: string, params: unknown = {}) {
    await this.opened;
    const id = `r_${++this.#n}`;
    return new Promise<{ result?: unknown; error?: { code: string; message: string } }>((resolve) => {
      this.#pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async call<T>(method: string, params: unknown = {}): Promise<T> {
    const r = await this.request(method, params);
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.result as T;
  }
}

async function waitFor<T>(fn: () => T | undefined | false, timeoutMs = 10_000, what = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('serve --fake prints a valid ready line, serves clients, and drains on SIGTERM', async (t) => {
  const dir = tempDir();
  t.after(dir.cleanup);
  const s = await startServe(dir.path, { BIZZI_DRAIN_SECONDS: '20' });
  t.after(() => {
    if (s.child.exitCode === null) s.child.kill('SIGKILL');
  });

  // Ready line matches ServeReady.
  assert.equal(s.ready.event, 'ready');
  assert.match(s.ready.url, /^ws:\/\/127\.0\.0\.1:\d+\/ws$/);
  assert.equal(s.ready.token, 'tok-cli');
  assert.match(s.ready.machineId, /^m_/);
  assert.equal(s.ready.pid, s.child.pid);
  const serveJson = join(dir.path, 'serve.json');
  assert.deepEqual(JSON.parse(readFileSync(serveJson, 'utf8')), s.ready);
  // stderr is JSON lines.
  for (const l of s.stderr().trim().split('\n').filter(Boolean)) JSON.parse(l);

  // bizzi status reads serve.json and talks to the node.
  const statusOut = await new Promise<string>((resolve, reject) =>
    execFile(process.execPath, [MAIN, 'status', '--data-dir', dir.path, '--json'], { env: { ...process.env, BIZZI_TOKEN: '' } }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr)) : resolve(stdout),
    ),
  );
  const report = JSON.parse(statusOut) as { machine: { name: string; id: string }; sessions: unknown[] };
  assert.equal(report.machine.name, 'cli-test');
  assert.equal(report.machine.id, s.ready.machineId);

  // Start a slow turn, then SIGTERM.
  const c = new Client(s.ready.url);
  t.after(() => c.ws.close());
  await c.call('hello', { protocol: PROTOCOL_VERSION, client: { name: 'cli-test', version: '0' }, token: s.ready.token });
  const { workspace } = await c.call<{ workspace: { id: string } }>('workspace.create', { path: join(dir.path, 'ws'), create: true });
  const { session } = await c.call<{ session: { id: string } }>('session.create', { workspaceId: workspace.id, agent: 'claude' });
  await c.call('subscribe', { ch: sessionChannel(session.id) });
  await waitFor(() => c.events.some((e) => e.type === 'session.status' && e.data.status === 'idle'), 10_000, 'idle');
  const { turnId } = await c.call<{ turnId: string }>('session.send', { sessionId: session.id, input: [{ type: 'text', text: '/slow 1500' }] });

  s.child.kill('SIGTERM');
  await waitFor(() => s.stderr().includes('"draining"'), 5000, 'drain log');
  // New turns are refused while draining; the running one keeps going.
  const refused = await c.request('session.create', { workspaceId: workspace.id, agent: 'claude' });
  assert.equal(refused.error?.code, 'conflict');
  assert.equal(s.child.exitCode, null);

  const done = await waitFor(() => c.events.find((e) => e.type === 'turn.completed'), 10_000, 'turn.completed');
  assert.equal(done.type === 'turn.completed' && done.data.turnId, turnId);
  assert.equal(done.type === 'turn.completed' && done.data.stopReason, 'end_turn');

  const { code } = await s.exited;
  assert.equal(code, 0);
  assert.equal(existsSync(serveJson), false);
  // Exactly one line on stdout.
  assert.equal(s.stdout().trim().split('\n').length, 1);
});

test('a second serve on the same data dir refuses to start; status without a node fails cleanly', async (t) => {
  const dir = tempDir();
  t.after(dir.cleanup);
  const s = await startServe(dir.path);
  t.after(() => {
    if (s.child.exitCode === null) s.child.kill('SIGKILL');
  });
  const second = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    execFile(process.execPath, [MAIN, 'serve', '--port', '0', '--data-dir', dir.path], (err, _out, stderr) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stderr }),
    );
  });
  assert.equal(second.code, 2);
  assert.match(second.stderr, /already serving/);
  s.child.kill('SIGINT');
  assert.equal((await s.exited).code, 0);

  const status = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    execFile(process.execPath, [MAIN, 'status', '--data-dir', dir.path], { env: { ...process.env, BIZZI_TOKEN: '' } }, (err, _out, stderr) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stderr }),
    );
  });
  assert.equal(status.code, 2);
  assert.match(status.stderr, /no running node/);
});

test('missing adapter packages are skipped', async () => {
  const lines: string[] = [];
  const logger = createJsonLogger({ level: 'debug', write: (l) => lines.push(l) });
  const adapters = await loadAdapters(logger, ['@bizzi/adapter-does-not-exist', '@bizzi/core/testing']);
  assert.deepEqual(adapters.map((a) => a.agent), ['claude', 'shell']);
  assert.ok(lines.some((l) => l.includes('adapter package not installed') && l.includes('"debug"')));
});
