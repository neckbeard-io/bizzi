// updates.md §8 leftovers: shared agent servers restart as one unit, fallback to the previous
// version on a failed spawn, resume through the restart sequence after a node restart (§7), and a
// drain that waits for starts and restarts.

import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  BizziError,
  sessionChannel,
  type AdapterContext,
  type AdapterSession,
  type AgentAdapter,
  type EmitFn,
  type RestartPolicy,
  type SessionInfo,
  type StartSessionOptions,
} from '@bizzi/protocol';
import { createNode, type BizziNode } from '../src/index.ts';
import { FakeAdapter, type FakeAdapterOptions } from '../src/testing/index.ts';
import { record, tempDir, waitFor } from './helpers.ts';

/**
 * One fake server shared by every session (like `opencode serve`): it runs the version installed
 * when it was spawned, sessions report that version, and only recycle() replaces it.
 */
class SharedServerAdapter extends FakeAdapter {
  readonly sharedProcess: 'owned' | 'external';
  /** Version the running server was spawned with; undefined = not running. */
  server: string | undefined;
  recycles = 0;

  constructor(options: FakeAdapterOptions & { external?: boolean } = {}) {
    super(options);
    this.sharedProcess = options.external ? 'external' : 'owned';
  }

  override async start(opts: StartSessionOptions, emit: EmitFn, ctx: AdapterContext): Promise<AdapterSession> {
    this.server ??= this.options.probe?.version;
    const session = await super.start(opts, emit, ctx);
    const running = this.server;
    return Object.assign(session, { agentVersion: () => running });
  }

  async recycle(): Promise<void> {
    if (this.sessions.some((s) => !s.stopped)) throw new BizziError('conflict', 'sessions still run on the server');
    this.recycles++;
    this.server = undefined;
  }
}

/** Takes an explicit executable; the installed `bad` path refuses to start. */
class PinnableAdapter extends FakeAdapter {
  readonly acceptsExecutable = true;
  bad: string | undefined;

  override start(opts: StartSessionOptions, emit: EmitFn, ctx: AdapterContext): Promise<AdapterSession> {
    const path = opts.executable ?? this.options.probe?.realPath;
    if (this.bad && path === this.bad) {
      this.starts.push(opts);
      return Promise.reject(new Error(`${path} crashed on start`));
    }
    return super.start(opts, emit, ctx);
  }
}

/** Ignores resumeRef: every start is a new conversation. */
class ForgetfulAdapter extends FakeAdapter {
  override start(opts: StartSessionOptions, emit: EmitFn, ctx: AdapterContext): Promise<AdapterSession> {
    const { resumeRef: _ignored, ...rest } = opts;
    return super.start(rest, emit, ctx);
  }
}

interface Setup {
  node: BizziNode;
  workspaceId: string;
  dir: string;
  bin: string;
}

async function setup(t: TestContext, adapter: FakeAdapter, policy?: RestartPolicy): Promise<Setup> {
  const tmp = tempDir('bizzi-updates-');
  const bin = join(tmp.path, 'agent-1.0.0');
  writeFileSync(bin, '#!/bin/sh\n');
  adapter.options.probe = { version: '1.0.0', realPath: bin, ...adapter.options.probe };
  const node = await createNode({ dataDir: join(tmp.path, 'data'), adapters: [adapter as AgentAdapter], version: '0.0.0-test', machineName: 'm' });
  t.after(async () => {
    await node.close();
    tmp.cleanup();
  });
  if (policy) node.registry.addDecorator((l) => ({ ...l, restartPolicy: policy }));
  const { workspace } = await node.call('workspace.create', { path: join(tmp.path, 'ws'), create: true });
  return { node, workspaceId: workspace.id, dir: tmp.path, bin };
}

async function idle(s: Setup, title?: string): Promise<SessionInfo> {
  const { session } = await s.node.call('session.create', { workspaceId: s.workspaceId, agent: 'claude', ...(title ? { title } : {}) });
  return waitFor(() => {
    const info = s.node.sessions.get(session.id).session;
    return info.status === 'idle' && !s.node.sessions.isBusy(session.id) && info.agentVersion ? info : undefined;
  }, 5000, 'idle session');
}

async function install(s: Setup, adapter: FakeAdapter, probe: Record<string, unknown>): Promise<void> {
  adapter.options.probe = { ...adapter.options.probe, ...probe };
  await s.node.registry.list(true);
  await s.node.restarts.settled();
}

async function rejects(p: Promise<unknown>, code: string, re?: RegExp): Promise<void> {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof BizziError, String(err));
    assert.equal(err.code, code, err.message);
    if (re) assert.match(err.message, re);
    return true;
  });
}

test('shared server: restarts once every session on it is at a safe point, and all resume on the new one', async (t) => {
  const fake = new SharedServerAdapter();
  const s = await setup(t, fake, 'when-idle');
  const a = await idle(s, 'alpha');
  const b = await idle(s, 'beta');
  assert.deepEqual(s.node.sessions.restartGroup(a.id).sort(), [a.id, b.id].sort());
  const chA = record(s.node, sessionChannel(a.id));
  const chB = record(s.node, sessionChannel(b.id));

  // b is mid-turn when the update lands: a is idle, but the server waits for b.
  await s.node.call('session.send', { sessionId: b.id, input: [{ type: 'text', text: '/slow 150' }] });
  await install(s, fake, { version: '1.1.0' });
  assert.equal(chA.find('session.restarting'), undefined, 'a waits for b');
  assert.match(s.node.sessions.unsafeReason(a.id)!, /session "beta" on the same claude server: a turn is in progress/);

  const doneA = await chA.waitFor('session.restarted');
  const doneB = await chB.waitFor('session.restarted');
  assert.deepEqual(doneA.data, { fromVersion: '1.0.0', toVersion: '1.1.0', ok: true });
  assert.deepEqual(doneB.data, { fromVersion: '1.0.0', toVersion: '1.1.0', ok: true });
  assert.ok(chB.find('session.restarting')!.seq > chB.find('turn.completed')!.seq, "b's turn was not cut short");
  assert.equal(fake.recycles, 1, 'the server was replaced once');
  assert.equal(fake.server, '1.1.0');
  assert.equal(fake.starts.length, 4);
  for (const x of [a, b]) {
    const info = s.node.sessions.get(x.id).session;
    assert.equal(info.agentVersion, '1.1.0');
    assert.equal(info.status, 'idle');
    assert.equal(s.node.restarts.stale(x.id), undefined);
  }
  assert.deepEqual(fake.starts.slice(2).map((o) => o.resumeRef).sort(), [a.agentSessionRef, b.agentSessionRef].sort());
  await s.node.call('session.send', { sessionId: a.id, input: [{ type: 'text', text: 'still here' }] });
  await chA.waitFor('turn.completed');
});

test('shared server: a session started on the old server after an update reports the server version, not the probe', async (t) => {
  const fake = new SharedServerAdapter();
  const s = await setup(t, fake);
  await idle(s);
  fake.options.probe = { ...fake.options.probe, version: '1.1.0', realPath: join(s.dir, 'agent-1.1.0') };
  await s.node.registry.list(true);
  const late = await idle(s);
  assert.equal(late.agentVersion, '1.0.0', 'what the shared server runs');
  assert.equal(s.node.sessions.agentProcess(late.id).path, undefined, "the probe's path is not what runs");
  assert.match(s.node.restarts.stale(late.id)!, /running 1\.0\.0, 1\.1\.0 installed/);
  assert.equal((await s.node.call('agents.list', {})).agents.find((x) => x.agent === 'claude')?.staleSessions, 2);

  // session.restart on one restarts the server for both.
  await s.node.call('session.restart', { sessionId: late.id });
  await s.node.restarts.settled();
  await waitFor(() => s.node.sessions.list().every((x) => x.agentVersion === '1.1.0'), 5000, 'both on 1.1.0');
  assert.equal(fake.recycles, 1);
});

test('shared server bizzi did not start: never restarted', async (t) => {
  const fake = new SharedServerAdapter({ external: true });
  const s = await setup(t, fake, 'when-idle');
  const a = await idle(s);
  await install(s, fake, { version: '1.1.0' });
  assert.equal(fake.starts.length, 1);
  assert.ok(s.node.restarts.stale(a.id));
  await rejects(s.node.call('session.restart', { sessionId: a.id }), 'unsupported', /server bizzi did not start/);
});

test('a failed spawn falls back to the previous version while it is on disk, and alerts', async (t) => {
  const fake = new PinnableAdapter();
  const s = await setup(t, fake, 'when-idle');
  const a = await idle(s);
  const ch = record(s.node, sessionChannel(a.id));
  const next = join(s.dir, 'agent-1.1.0');
  writeFileSync(next, '#!/bin/sh\n');
  fake.bad = next;
  await install(s, fake, { version: '1.1.0', realPath: next });

  const done = await ch.waitFor('session.restarted');
  assert.equal(done.data.ok, false);
  assert.equal(done.data.fallbackVersion, '1.0.0');
  assert.equal(done.data.toVersion, '1.1.0');
  assert.match(done.data.error!, /could not start claude 1\.1\.0: .*crashed on start/);
  const alert = await ch.waitFor('error', (e) => e.data.code === 'restart_fallback');
  assert.match(alert.data.message, /resumed on 1\.0\.0 instead/);

  assert.equal(fake.starts.length, 3);
  assert.equal(fake.starts[1]!.executable, undefined, 'first the installed version');
  assert.equal(fake.starts[2]!.executable, s.bin, 'then the previous executable');
  assert.equal(fake.starts[2]!.resumeRef, a.agentSessionRef);
  const info = s.node.sessions.get(a.id).session;
  assert.equal(info.status, 'idle', 'the session keeps running');
  assert.equal(info.agentVersion, '1.0.0');
  assert.equal(info.agentSessionRef, a.agentSessionRef);
  assert.equal(s.node.sessions.agentProcess(a.id).path, s.bin);
  assert.ok(s.node.restarts.stale(a.id), 'still stale');

  // Not retried automatically on the same broken install; the session works.
  await install(s, fake, {});
  assert.equal(fake.starts.length, 3);
  await s.node.call('session.send', { sessionId: a.id, input: [{ type: 'text', text: 'hi' }] });
  await ch.waitFor('turn.completed');

  // The previous version is gone from disk: no fallback, the restart fails.
  rmSync(s.bin);
  const outcome = await s.node.sessions.restartAgent(a.id);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.fallbackVersion, undefined);
  assert.equal(s.node.sessions.get(a.id).session.status, 'failed');
});

test('no fallback for adapters that cannot take an explicit executable', async (t) => {
  const fake = new FakeAdapter();
  const s = await setup(t, fake);
  const a = await idle(s);
  fake.options.probe = { ...fake.options.probe, version: '1.1.0' };
  fake.options.failStart = 'broken';
  const outcome = await s.node.sessions.restartAgent(a.id);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.fallbackVersion, undefined);
  assert.equal(fake.starts.length, 2);
  assert.equal(s.node.sessions.get(a.id).session.status, 'failed');
});

test('after a node restart the first start resumes through the restart sequence (§7)', async (t) => {
  const tmp = tempDir('bizzi-updates-');
  t.after(tmp.cleanup);
  const n1 = await createNode({ dataDir: tmp.path, adapters: [new FakeAdapter({ probe: { version: '1.0.0' } })], version: '0', machineName: 'm' });
  const { workspace } = await n1.call('workspace.create', { path: join(tmp.path, 'ws'), create: true });
  const { session } = await n1.call('session.create', { workspaceId: workspace.id, agent: 'claude' });
  const { session: other } = await n1.call('session.create', { workspaceId: workspace.id, agent: 'claude' });
  await waitFor(() => n1.sessions.list().every((x) => x.agentVersion === '1.0.0'));
  const ref = n1.sessions.get(session.id).session.agentSessionRef!;
  await n1.close();

  // bizzi restarts (updated); meanwhile the agent moved to 1.2.0.
  const fake2 = new FakeAdapter({ probe: { version: '1.2.0' } });
  const n2 = await createNode({ dataDir: tmp.path, adapters: [fake2], version: '1', machineName: 'm' });
  const mark = n2.bus.lastSeq(sessionChannel(session.id));
  const ch = record(n2, sessionChannel(session.id), mark);
  await n2.call('session.send', { sessionId: session.id, input: [{ type: 'text', text: 'hi' }] });
  await ch.waitFor('turn.completed');
  const order = ch.types().filter((x) => x === 'session.restarting' || x === 'session.restarted' || x === 'turn.started');
  assert.deepEqual(order.slice(0, 3), ['session.restarting', 'session.restarted', 'turn.started']);
  assert.deepEqual(ch.find('session.restarting')!.data, { fromVersion: '1.0.0', toVersion: '1.2.0', reason: 'bizzi restarted' });
  assert.deepEqual(ch.find('session.restarted')!.data, { fromVersion: '1.0.0', toVersion: '1.2.0', ok: true });
  assert.equal(fake2.starts[0]!.resumeRef, ref);

  // Only once: the next start after a stop is a plain one.
  await n2.call('session.send', { sessionId: session.id, input: [{ type: 'text', text: 'again' }] });
  await waitFor(() => ch.events.filter((e) => e.type === 'turn.completed').length === 2);
  assert.equal(ch.events.filter((e) => e.type === 'session.restarting').length, 1);
  await n2.close();

  // `other` never started on n2: the mark survives another restart. Resuming into a different
  // conversation fails the session and keeps the old ref.
  const n3 = await createNode({ dataDir: tmp.path, adapters: [new ForgetfulAdapter({ probe: { version: '1.2.0' } })], version: '1', machineName: 'm' });
  t.after(() => n3.close());
  const otherRef = n3.sessions.get(other.id).session.agentSessionRef;
  const ch3 = record(n3, sessionChannel(other.id), n3.bus.lastSeq(sessionChannel(other.id)));
  await rejects(n3.call('session.send', { sessionId: other.id, input: [{ type: 'text', text: 'hi' }] }), 'agent_unavailable', /different conversation/);
  const failed = await ch3.waitFor('session.restarted');
  assert.equal(failed.data.ok, false);
  assert.equal(failed.data.fromVersion, '1.0.0');
  const info = n3.sessions.get(other.id).session;
  assert.equal(info.status, 'failed');
  assert.equal(info.agentSessionRef, otherRef);
});

test('drain waits for agents that are starting, not only for turns', async (t) => {
  const fake = new FakeAdapter({ startDelayMs: 120 });
  const s = await setup(t, fake);
  const { session } = await s.node.call('session.create', { workspaceId: s.workspaceId, agent: 'claude' });
  assert.ok(s.node.sessions.isBusy(session.id), 'starting');
  assert.equal(await s.node.drain(5000), true);
  assert.equal(s.node.sessions.agentProcess(session.id).running, true);
  assert.equal(s.node.sessions.isBusy(session.id), false);
  await rejects(s.node.call('session.send', { sessionId: session.id, input: [{ type: 'text', text: 'x' }] }), 'conflict', /shutting down/);
});
