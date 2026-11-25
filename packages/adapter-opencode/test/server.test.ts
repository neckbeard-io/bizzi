// Server lifecycle against the fake server run as a child process (like a real `opencode serve`).

import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, test } from 'node:test';
import { BizziError } from '@bizzi/protocol';
import { OpenCodeAdapter } from '../src/index.ts';
import { ctx, Recorder, until } from './helpers.ts';

const MAIN = fileURLToPath(new URL('./fake-server-main.ts', import.meta.url));
const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'bizzi-oc-srv-')));

function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const made: OpenCodeAdapter[] = [];
afterEach(async () => {
  await Promise.all(made.splice(0).map((a) => a.dispose()));
});

function makeAdapter(extra: ConstructorParameters<typeof OpenCodeAdapter>[0] = {}): OpenCodeAdapter {
  const a = new OpenCodeAdapter({
    serverCommand: [process.execPath, MAIN],
    healthIntervalMs: 0,
    restartBackoffMs: 50,
    startupTimeoutMs: 10_000,
    ...extra,
  });
  made.push(a);
  return a;
}

describe('private server lifecycle', () => {
  test('spawns lazily with a private password, runs a turn, stops cleanly', async () => {
    const adapter = makeAdapter();
    assert.equal(adapter.server.state, 'stopped');
    const rec = new Recorder();
    const s = await adapter.start({ sessionId: 's1', mode: 'structured', cwd }, rec.emit, ctx);
    assert.equal(adapter.server.state, 'ready');
    const pid = adapter.server.pid;
    assert.ok(alive(pid));
    // The fake enforces basic auth with OPENCODE_SERVER_PASSWORD; an unauthenticated call fails.
    const res = await fetch(`${adapter.server.client!.baseUrl}/api/info`);
    assert.equal(res.status, 401);

    await s.send('t1', [{ type: 'text', text: 'scenario:basic' }]);
    assert.equal((await rec.waitFor('turn.completed')).stopReason, 'end_turn');
    await s.stop();
    await adapter.dispose();
    assert.equal(adapter.server.state, 'stopped');
    await until(() => !alive(pid), 3000, 'server exit');
  });

  test('crash mid-turn: turn fails, server restarts, session keeps working', async () => {
    const adapter = makeAdapter();
    const rec = new Recorder();
    const s = await adapter.start({ sessionId: 's2', mode: 'structured', cwd, systemPromptAppend: 'rules' }, rec.emit, ctx);
    const pid1 = adapter.server.pid!;
    await s.send('t1', [{ type: 'text', text: 'scenario:silent' }]);
    process.kill(pid1, 'SIGKILL');

    const failed = await rec.waitFor('turn.completed');
    assert.equal(failed.turnId, 't1');
    assert.equal(failed.stopReason, 'error');
    assert.match(failed.error!, /exited/);
    assert.ok(rec.of('error').some((e) => e.code === 'server_exited'));

    await until(() => adapter.server.state === 'ready' && adapter.server.pid !== pid1, 10_000, 'restart');
    assert.ok(alive(adapter.server.pid));
    await s.send('t2', [{ type: 'text', text: 'scenario:basic' }]);
    const ok = await rec.waitFor('turn.completed', (d) => d.turnId === 't2');
    assert.equal(ok.stopReason, 'end_turn');
    await adapter.dispose();
  });

  test('gives up after repeated crashes, recovers on next demand', async () => {
    const adapter = makeAdapter({ maxRestarts: 1, restartWindowMs: 60_000 });
    const rec = new Recorder();
    const s = await adapter.start({ sessionId: 's3', mode: 'structured', cwd }, rec.emit, ctx);
    const pid1 = adapter.server.pid!;
    process.kill(pid1, 'SIGKILL');
    await until(() => adapter.server.state === 'ready' && adapter.server.pid !== pid1, 10_000, 'first restart');
    process.kill(adapter.server.pid!, 'SIGKILL');
    await until(() => adapter.server.state === 'failed', 10_000, 'failed state');
    // next send restarts on demand
    await s.send('t1', [{ type: 'text', text: 'scenario:basic' }]);
    assert.equal((await rec.waitFor('turn.completed')).stopReason, 'end_turn');
    await adapter.dispose();
  });

  test('startup failure surfaces as agent_unavailable', async () => {
    const adapter = makeAdapter({ serverCommand: [process.execPath, '-e', 'process.exit(3)'], startupTimeoutMs: 5_000 });
    await assert.rejects(
      adapter.start({ sessionId: 's4', mode: 'structured', cwd }, () => {}, ctx),
      (e: unknown) => e instanceof BizziError && e.code === 'agent_unavailable' && /exited during startup/.test(e.message),
    );
    const missing = makeAdapter({ serverCommand: ['/nonexistent/opencode-binary', 'serve'] });
    await assert.rejects(missing.start({ sessionId: 's5', mode: 'structured', cwd }, () => {}, ctx), (e: unknown) => e instanceof BizziError && e.code === 'agent_unavailable');
  });

  test('startup timeout kills a silent process', async () => {
    const adapter = makeAdapter({ serverCommand: [process.execPath, '-e', 'setInterval(() => {}, 1000)'], startupTimeoutMs: 500 });
    await assert.rejects(adapter.start({ sessionId: 's6', mode: 'structured', cwd }, () => {}, ctx), /did not start within/);
  });

  test('recycle replaces the private server; sessions report the version it runs (updates.md §3)', async () => {
    const env: Record<string, string> = { FAKE_OPENCODE_VERSION: '2.0.25' };
    const adapter = makeAdapter({ env });
    assert.equal(adapter.sharedProcess, 'owned');
    const s1 = await adapter.start({ sessionId: 'r1', mode: 'structured', cwd }, () => {}, ctx);
    assert.equal(s1.agentVersion?.(), '2.0.25');
    const pid1 = adapter.server.pid;
    await assert.rejects(adapter.recycle(), (e: unknown) => e instanceof BizziError && e.code === 'conflict');
    assert.equal(adapter.server.pid, pid1, 'a live session keeps the server');

    await s1.stop();
    env.FAKE_OPENCODE_VERSION = '2.2.6'; // the CLI was updated meanwhile
    await adapter.recycle();
    assert.equal(adapter.server.state, 'stopped');
    await until(() => !alive(pid1), 5_000, 'old server exit');
    const s2 = await adapter.start({ sessionId: 'r2', mode: 'structured', cwd }, () => {}, ctx);
    assert.notEqual(adapter.server.pid, pid1);
    assert.equal(s2.agentVersion?.(), '2.2.6');
    await s2.stop();
  });

  test('an attached server is external and never recycled', async () => {
    const adapter = makeAdapter({ serverUrl: 'http://127.0.0.1:9', serverPassword: 'x' });
    assert.equal(adapter.sharedProcess, 'external');
    await assert.rejects(adapter.recycle(), (e: unknown) => e instanceof BizziError && e.code === 'unsupported');
  });

  test('idle shutdown stops the server after the last session', async () => {
    const adapter = makeAdapter({ idleShutdownMs: 100 });
    const s = await adapter.start({ sessionId: 's7', mode: 'structured', cwd }, () => {}, ctx);
    const pid = adapter.server.pid;
    await s.stop();
    await until(() => adapter.server.state === 'stopped' && !alive(pid), 5_000, 'idle shutdown');
  });
});
