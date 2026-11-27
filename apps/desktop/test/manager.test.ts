// Supervisor behavior against the stub core (test/fixtures/stub-core.ts) run by this Node.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServeReady } from '@bizzi/protocol';
import { nullLogger } from '../src/core/log.ts';
import { CoreManager, type CoreManagerOptions, type CoreStatus } from '../src/core/manager.ts';
import { isPidAlive } from '../src/core/serve-file.ts';
import { waitForReadyLine } from '../src/core/ready-line.ts';

const STUB = fileURLToPath(new URL('./fixtures/stub-core.ts', import.meta.url));

async function tempDir(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bizzi-desktop-mgr-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function manager(dataDir: string, stubEnv: Record<string, string> = {}, extra: Partial<CoreManagerOptions> = {}) {
  const statuses: CoreStatus[] = [];
  let launches = 0;
  const m = new CoreManager({
    dataDir,
    logger: nullLogger,
    resolveLaunch: async () => {
      launches++;
      return { command: process.execPath, args: [STUB], env: stubEnv };
    },
    readyTimeoutMs: 5000,
    healthIntervalMs: 50,
    healthTimeoutMs: 200,
    stopTimeoutMs: 3000,
    backoff: { initialMs: 50, maxMs: 200, jitter: 0 },
    onStatus: (s) => statuses.push(s),
    ...extra,
  });
  return { m, statuses, launches: () => launches };
}

async function until(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('spawns the core when nothing runs, then stops it on quit (drain, serve.json removed)', async (t) => {
  const dir = await tempDir(t);
  const { m, launches } = manager(dir);
  // A failed assertion must not leave the spawned core running: it would keep the test process alive.
  t.after(() => m.stop());
  const conn = await m.start();
  assert.ok(conn, 'got a connection');
  assert.match(conn.url, /^ws:\/\/127\.0\.0\.1:\d+\/ws$/);
  assert.equal(m.status.state, 'running');
  assert.equal(m.status.owned, true);
  assert.equal(launches(), 1);
  assert.ok(existsSync(join(dir, 'serve.json')));
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'desktop-core.json'), 'utf8')).pid, conn.pid);
  // The core writes stderr on its own schedule; the ready line can come first.
  let log = '';
  for (let i = 0; i < 50 && !/stub-core/.test(log); i++) {
    log = await readFile(join(dir, 'logs', 'core.log'), 'utf8').catch(() => '');
    if (!/stub-core/.test(log)) await new Promise((r) => setTimeout(r, 50));
  }
  assert.match(log, /stub-core/, 'core stderr goes to the log file');

  await m.stop();
  assert.equal(m.status.state, 'stopped');
  assert.equal(isPidAlive(conn.pid), false);
  assert.equal(existsSync(join(dir, 'serve.json')), false);
  assert.equal(existsSync(join(dir, 'desktop-core.json')), false);
});

test('attaches to an already running core and leaves it running on quit', async (t) => {
  const dir = await tempDir(t);
  const ext = spawn(process.execPath, [STUB, 'serve', '--host', '127.0.0.1', '--port', '0', '--data-dir', dir], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  t.after(() => {
    ext.kill('SIGKILL');
  });
  const extReady = await waitForReadyLine(ext.stdout, { timeoutMs: 5000 });

  const { m, launches } = manager(dir);
  const conn = await m.start();
  assert.deepEqual(conn, extReady);
  assert.equal(m.status.state, 'attached');
  assert.equal(m.status.owned, false);
  assert.equal(launches(), 0, 'did not spawn a second core');

  await m.stop();
  assert.equal(isPidAlive(extReady.pid), true, 'external core still running');
  ext.kill('SIGTERM');
});

test('restarts a crashed core with backoff and reports the new connection', async (t) => {
  const dir = await tempDir(t);
  const { m, statuses, launches } = manager(dir, { STUB_CRASH_AFTER_MS: '300' });
  const first = await m.start();
  assert.ok(first);
  await until(() => launches() >= 3);
  await until(() => m.status.state === 'running');
  const states = statuses.map((s) => s.state);
  assert.ok(states.includes('restarting'));
  const conns = statuses.map((s) => s.connection).filter((c): c is ServeReady => c !== null);
  assert.ok(new Set(conns.map((c) => c.pid)).size >= 2, 'new process after the crash');
  assert.ok(m.status.restarts >= 2);
  await m.stop();
});

test('a crashed core leaves a stale serve.json; the restart spawns instead of attaching', async (t) => {
  const dir = await tempDir(t);
  const { m, launches } = manager(dir, { STUB_CRASH_AFTER_MS: '200' });
  const first = await m.start();
  assert.ok(first);
  await until(() => launches() >= 2 && m.status.state === 'running' && m.status.connection?.pid !== first.pid);
  assert.equal(m.status.owned, true);
  await m.stop();
});

test('ready timeout counts as a failed start and is retried', async (t) => {
  const dir = await tempDir(t);
  const { m, launches } = manager(dir, { STUB_NO_READY: '1' }, { readyTimeoutMs: 200 });
  const conn = await m.start();
  assert.equal(conn, null);
  assert.equal(m.status.state, 'restarting');
  assert.match(m.status.lastError ?? '', /ready line/);
  // the silent stub was killed, so its serve.json is stale and the retry spawns again
  await until(() => launches() >= 2);
  await m.stop();
});

test('launch resolution errors are retried, not thrown', async (t) => {
  const dir = await tempDir(t);
  let calls = 0;
  const { m } = manager(dir, {}, {
    resolveLaunch: async () => {
      calls++;
      throw new Error('no Node >= 26 found');
    },
  });
  assert.equal(await m.start(), null);
  assert.equal(m.status.lastError, 'no Node >= 26 found');
  await until(() => calls >= 3);
  await m.stop();
  const after = calls;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(calls, after, 'no retries after stop');
});

test('an attached core that disappears is replaced by a spawned one', async (t) => {
  const dir = await tempDir(t);
  const ext = spawn(process.execPath, [STUB, 'serve', '--host', '127.0.0.1', '--port', '0', '--data-dir', dir], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  t.after(() => {
    ext.kill('SIGKILL');
  });
  const extReady = await waitForReadyLine(ext.stdout, { timeoutMs: 5000 });
  const { m, launches } = manager(dir);
  await m.start();
  assert.equal(m.status.state, 'attached');
  ext.kill('SIGTERM');
  await until(() => m.status.state === 'running');
  assert.equal(launches(), 1);
  assert.notEqual(m.status.connection?.pid, extReady.pid);
  await m.stop();
});

test('a relaunched app re-adopts the core it had spawned', async (t) => {
  const dir = await tempDir(t);
  const a = manager(dir);
  const conn = await a.m.start();
  assert.ok(conn);
  // simulate the app crashing: forget about it without stopping the core
  const b = manager(dir);
  assert.deepEqual(await b.m.start(), conn);
  assert.equal(b.m.status.state, 'attached');
  assert.equal(b.m.status.owned, true);
  await b.m.stop();
  assert.equal(isPidAlive(conn.pid), false);
  await a.m.stop();
});

test('detach leaves an owned core running; a relaunch with the same core id re-adopts it', async (t) => {
  const dir = await tempDir(t);
  const first = manager(dir, {}, { coreId: 'aaaa1111' });
  const conn = await first.m.start();
  assert.ok(conn);
  t.after(() => {
    try {
      process.kill(conn.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  });
  assert.equal(first.m.runningCoreId, 'aaaa1111');
  assert.equal(JSON.parse(await readFile(join(dir, 'desktop-core.json'), 'utf8')).coreId, 'aaaa1111');

  await first.m.detach();
  assert.equal(first.m.status.state, 'stopped');
  assert.equal(isPidAlive(conn.pid), true, 'the core outlives the app');

  const second = manager(dir, {}, { coreId: 'aaaa1111' });
  const again = await second.m.start();
  assert.equal(again?.pid, conn.pid, 'same process, nothing restarted');
  assert.equal(second.m.status.state, 'attached');
  assert.equal(second.m.status.owned, true);
  assert.equal(second.launches(), 0);
  await second.m.stop();
  assert.equal(isPidAlive(conn.pid), false, 'an owned core still stops on an explicit stop');
});

test('a relaunch with a different core id restarts the owned core on the new code', async (t) => {
  const dir = await tempDir(t);
  const first = manager(dir, {}, { coreId: 'aaaa1111' });
  const old = await first.m.start();
  assert.ok(old);
  await first.m.detach();

  const second = manager(dir, {}, { coreId: 'bbbb2222' });
  t.after(() => second.m.stop());
  const conn = await second.m.start();
  assert.ok(conn);
  assert.notEqual(conn.pid, old.pid);
  assert.equal(isPidAlive(old.pid), false, 'the out-of-date core was stopped');
  assert.equal(second.m.status.state, 'running');
  assert.equal(second.launches(), 1);
  assert.equal(second.m.runningCoreId, 'bbbb2222');
  assert.equal(JSON.parse(await readFile(join(dir, 'desktop-core.json'), 'utf8')).coreId, 'bbbb2222');
});

test('an out-of-date core busy with turns is told to stop without waiting for them', async (t) => {
  const dir = await tempDir(t);
  // A core whose drain would take a minute (turns in flight).
  const first = manager(dir, { STUB_DRAIN_MS: '60000' }, { coreId: 'aaaa1111' });
  const old = await first.m.start();
  assert.ok(old);
  await first.m.detach();
  t.after(() => {
    try {
      process.kill(old.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  });

  const second = manager(dir, {}, { coreId: 'bbbb2222', handoffMs: 100 });
  t.after(() => second.m.stop());
  const started = Date.now();
  const conn = await second.m.start();
  assert.ok(conn);
  assert.equal(isPidAlive(old.pid), false, 'the old core stopped');
  assert.ok(Date.now() - started < 2500, `handed over quickly (${Date.now() - started} ms)`);
});

test('without a core id (dev runs, older builds) an owned core is adopted whatever recorded it', async (t) => {
  const dir = await tempDir(t);
  const first = manager(dir, {}, { coreId: 'aaaa1111' });
  const old = await first.m.start();
  assert.ok(old);
  await first.m.detach();
  const second = manager(dir);
  t.after(() => second.m.stop());
  assert.equal((await second.m.start())?.pid, old.pid);
  assert.equal(second.launches(), 0);
});
