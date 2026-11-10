// Agent updates and restarts (docs/updates.md §2–§6): agentVersion, stale detection, safe points,
// the restart sequence, policies, session.restart; plus session.set clamping and budget raises.

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
  type ChannelEvent,
  type EmitFn,
  type RestartPolicy,
  type SessionInfo,
  type StartSessionOptions,
} from '@bizzi/protocol';
import { createNode, installKey, precheckProblem, staleReason, type BizziNode, type PrepareStart } from '../src/index.ts';
import { FakeAdapter } from '../src/testing/index.ts';
import { record, tempDir, waitFor } from './helpers.ts';

interface Setup {
  node: BizziNode;
  fake: FakeAdapter;
  workspaceId: string;
  dir: string;
  bin: string;
}

async function setup(
  t: TestContext,
  o: { policy?: RestartPolicy; fake?: FakeAdapter; adapters?: AgentAdapter[]; prepareStart?: PrepareStart; restartWaitMs?: number } = {},
): Promise<Setup> {
  const tmp = tempDir('bizzi-restart-');
  const bin = join(tmp.path, 'claude-1.0.0');
  writeFileSync(bin, '#!/bin/sh\n');
  const fake = o.fake ?? new FakeAdapter();
  fake.options.probe = { version: '1.0.0', realPath: bin, ...fake.options.probe };
  const node = await createNode({
    dataDir: join(tmp.path, 'data'),
    adapters: o.adapters ?? [fake, new FakeAdapter({ agent: 'shell', modes: ['terminal'] })],
    version: '0.0.0-test',
    machineName: 'test-machine',
    ...(o.prepareStart ? { prepareStart: o.prepareStart } : {}),
  });
  t.after(async () => {
    await node.close();
    tmp.cleanup();
  });
  // What @bizzi/services' updates extension does: decorate agents.list with the restart policy.
  if (o.policy) node.registry.addDecorator((l) => ({ ...l, restartPolicy: o.policy }));
  const { workspace } = await node.call('workspace.create', { path: join(tmp.path, 'ws'), create: true });
  return { node, fake, workspaceId: workspace.id, dir: tmp.path, bin };
}

async function idleSession(s: Setup, extra: Record<string, unknown> = {}): Promise<SessionInfo> {
  const { session } = await s.node.call('session.create', { workspaceId: s.workspaceId, agent: 'claude', ...extra });
  return waitFor(() => {
    const info = s.node.sessions.get(session.id).session;
    return info.status === 'idle' && !s.node.sessions.isBusy(session.id) && info.agentVersion ? info : undefined;
  }, 5000, 'idle session with agentVersion');
}

/** Change what the probe reports and re-probe (what the updates extension does on a file change). */
async function install(s: Setup, probe: Record<string, unknown>): Promise<void> {
  s.fake.options.probe = { ...s.fake.options.probe, ...probe };
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

function types(events: ChannelEvent[]): string[] {
  return events.map((e) => e.type);
}

function assertContiguous(node: BizziNode, id: string): void {
  const seqs = node.bus.replay(sessionChannel(id)).map((e) => e.seq);
  assert.deepEqual(seqs, seqs.map((_, i) => i + 1), 'seq keeps counting without gaps');
  assert.equal(node.sessions.get(id).session.lastSeq, seqs.at(-1));
}

test('pure helpers: staleReason, precheckProblem, installKey', () => {
  const installed = { agent: 'claude' as const, installed: true, auth: 'ok' as const, version: '2.0.0' };
  assert.equal(staleReason({ version: '2.0.0' }, installed), undefined);
  assert.match(staleReason({ version: '1.9.0' }, installed)!, /running 1\.9\.0, 2\.0\.0 installed/);
  assert.match(staleReason({ version: '2.0.0', path: '/x' }, installed, () => false)!, /\/x no longer exists/);
  assert.equal(staleReason({ version: '1.9.0' }, { ...installed, installed: false }), undefined, 'uninstalled: only the path rule applies');
  assert.equal(staleReason({}, installed), undefined, 'unknown running version is not stale');

  assert.equal(precheckProblem(installed), undefined);
  assert.match(precheckProblem(undefined)!, /could not be probed/);
  assert.match(precheckProblem({ ...installed, installed: false })!, /no longer installed/);
  assert.match(precheckProblem({ ...installed, version: undefined })!, /--version/);
  assert.match(precheckProblem({ ...installed, auth: 'expired' })!, /login no longer works/);
  assert.match(precheckProblem({ ...installed, support: 'unsupported', supportReason: 'v1 is not supported' })!, /v1 is not supported/);
  assert.notEqual(installKey(installed), installKey({ ...installed, auth: 'missing' }));
});

test('agentVersion and the executable path are recorded at spawn; stale detection fills staleSessions', async (t) => {
  const s = await setup(t);
  const session = await idleSession(s);
  assert.equal(session.agentVersion, '1.0.0');
  assert.deepEqual(s.node.sessions.agentProcess(session.id), { running: true, version: '1.0.0', path: s.bin });
  const listing = async () => (await s.node.call('agents.list', {})).agents.find((a) => a.agent === 'claude')!;
  assert.equal((await listing()).staleSessions, 0);

  // A newer version is installed: stale, but the default policy (manual, no services) restarts nothing.
  await install(s, { version: '1.1.0' });
  assert.equal((await listing()).staleSessions, 1);
  assert.match(s.node.restarts.stale(session.id)!, /running 1\.0\.0, 1\.1\.0 installed/);
  assert.ok(!types(s.node.bus.replay(sessionChannel(session.id))).includes('session.restarting'));

  // Back on 1.0.0, but the executable the process runs was removed.
  await install(s, { version: '1.0.0' });
  assert.equal(s.node.restarts.stale(session.id), undefined);
  rmSync(s.bin);
  assert.match(s.node.restarts.stale(session.id)!, /no longer exists/);
  assert.equal((await listing()).staleSessions, 1);

  // A session whose agent isn't running is never stale (the next start runs the installed version).
  await s.node.call('session.stop', { sessionId: session.id });
  assert.equal(s.node.restarts.stale(session.id), undefined);
  assert.equal((await listing()).staleSessions, 0);
});

test('agentVersion is cleared on node restart and recorded again on resume', async (t) => {
  const tmp = tempDir('bizzi-restart-');
  t.after(tmp.cleanup);
  const probe = { version: '1.0.0' };
  const n1 = await createNode({ dataDir: tmp.path, adapters: [new FakeAdapter({ probe })], version: '0', machineName: 'm' });
  const { workspace } = await n1.call('workspace.create', { path: join(tmp.path, 'ws'), create: true });
  const { session } = await n1.call('session.create', { workspaceId: workspace.id, agent: 'claude' });
  await waitFor(() => n1.sessions.get(session.id).session.agentVersion === '1.0.0');
  await n1.close();

  const fake2 = new FakeAdapter({ probe: { version: '1.2.0' } });
  const n2 = await createNode({ dataDir: tmp.path, adapters: [fake2], version: '0', machineName: 'm' });
  t.after(() => n2.close());
  assert.equal(n2.sessions.get(session.id).session.agentVersion, undefined);
  const ch = record(n2, sessionChannel(session.id));
  await n2.call('session.send', { sessionId: session.id, input: [{ type: 'text', text: 'hi' }] });
  await ch.waitFor('turn.completed');
  await waitFor(() => n2.sessions.get(session.id).session.agentVersion === '1.2.0');
});

test('session.restart: events in order, seq continuous, runtime state re-applied, same conversation', async (t) => {
  const prepareStart: PrepareStart = () => ({
    mcpServers: { 'bizzi-test': { type: 'http', url: 'http://127.0.0.1:1/mcp' } },
    systemPromptAppend: 'be brief',
  });
  const s = await setup(t, { prepareStart });
  const session = await idleSession(s, { model: 'fake-model-large', permissionMode: 'acceptEdits', effort: 'high' });
  const ch = record(s.node, sessionChannel(session.id));
  await s.node.call('session.send', { sessionId: session.id, input: [{ type: 'text', text: 'hello' }] });
  await ch.waitFor('turn.completed');
  const ref = s.node.sessions.get(session.id).session.agentSessionRef;
  assert.ok(ref);

  s.fake.options.probe = { ...s.fake.options.probe, version: '1.1.0' };
  const mark = s.node.bus.lastSeq(sessionChannel(session.id));
  assert.deepEqual(await s.node.call('session.restart', { sessionId: session.id }), {});
  const done = await ch.waitFor('session.restarted');
  assert.deepEqual(done.data, { fromVersion: '1.0.0', toVersion: '1.1.0', ok: true });
  const after = ch.events.filter((e) => e.seq > mark);
  assert.equal(after[0]?.type, 'session.restarting');
  assert.deepEqual(after[0]?.data, { fromVersion: '1.0.0', toVersion: '1.1.0', reason: 'restart requested' });
  assert.ok(!types(after).includes('session.status'), 'the status never changes during a restart');

  assert.equal(s.fake.starts.length, 2);
  assert.ok(s.fake.sessions[0]!.stopped, 'the old process was stopped');
  const second = s.fake.starts[1]!;
  assert.equal(second.resumeRef, ref);
  assert.equal(second.fork, undefined);
  assert.equal(second.model, 'fake-model-large');
  assert.equal(second.permissionMode, 'acceptEdits');
  assert.equal(second.effort, 'high');
  assert.deepEqual(Object.keys(second.mcpServers ?? {}), ['bizzi-test']);
  assert.equal(second.systemPromptAppend, 'be brief');

  const info = s.node.sessions.get(session.id).session;
  assert.equal(info.id, session.id);
  assert.equal(info.agentSessionRef, ref);
  assert.equal(info.agentVersion, '1.1.0');
  assert.equal(info.status, 'idle');
  assert.equal(s.node.restarts.stale(session.id), undefined);

  // The session carries on.
  await s.node.call('session.send', { sessionId: session.id, input: [{ type: 'text', text: 'again' }] });
  await waitFor(() => ch.events.filter((e) => e.type === 'turn.completed').length === 2);
  assertContiguous(s.node, session.id);
});

test('session.restart: validation, not running = no-op, and waits for the next safe point', async (t) => {
  const s = await setup(t);
  await rejects(s.node.call('session.restart', { sessionId: 's_nope' }), 'not_found');
  const { session: term } = await s.node.call('session.create', { workspaceId: s.workspaceId, agent: 'shell' });
  await rejects(s.node.call('session.restart', { sessionId: term.id }), 'unsupported', /cannot be resumed/);

  const session = await idleSession(s);
  const ch = record(s.node, sessionChannel(session.id));
  // Requested mid-turn: it waits for the turn to end.
  await s.node.call('session.send', { sessionId: session.id, input: [{ type: 'text', text: '/slow 150' }] });
  await s.node.call('session.restart', { sessionId: session.id });
  assert.ok(s.node.restarts.isRequested(session.id));
  await ch.waitFor('session.restarted');
  const completed = ch.find('turn.completed')!;
  const restarting = ch.find('session.restarting')!;
  assert.equal(completed.data.stopReason, 'end_turn', 'the turn was not cut short');
  assert.ok(restarting.seq > completed.seq);

  // Stopped (no process): nothing to restart. Ended sessions are refused.
  await s.node.call('session.stop', { sessionId: session.id });
  await rejects(s.node.call('session.restart', { sessionId: session.id }), 'conflict', /ended/);
});

test('safe points: a pending approval blocks a when-idle restart until the turn ends', async (t) => {
  const s = await setup(t, { policy: 'when-idle' });
  const session = await idleSession(s);
  const ch = record(s.node, sessionChannel(session.id));
  await s.node.call('session.send', { sessionId: session.id, input: [{ type: 'text', text: '/approve deploy' }] });
  const asked = await ch.waitFor('approval.requested');
  await waitFor(() => s.node.sessions.get(session.id).session.status === 'waiting_approval');

  await install(s, { version: '1.1.0' });
  assert.ok(s.node.restarts.stale(session.id));
  assert.match(s.node.sessions.unsafeReason(session.id)!, /turn is in progress|approval/);
  assert.equal(ch.find('session.restarting'), undefined);
  await rejects(s.node.sessions.restartAgent(session.id), 'conflict', /safe point|cannot restart now/);

  await s.node.call('approval.respond', { sessionId: session.id, approvalId: asked.data.approvalId, decision: 'allow' });
  const restarted = await ch.waitFor('session.restarted');
  assert.equal(restarted.data.ok, true);
  const completed = ch.find('turn.completed')!;
  assert.ok(ch.find('session.restarting')!.seq > completed.seq);
  assert.equal(s.node.sessions.get(session.id).session.agentVersion, '1.1.0');
  assertContiguous(s.node, session.id);
});

test('when-idle restarts automatically after a version change; manual and ask do not', async (t) => {
  for (const policy of ['manual', 'ask'] as const) {
    const s = await setup(t, { policy });
    const session = await idleSession(s);
    await install(s, { version: '1.1.0' });
    assert.equal(s.fake.starts.length, 1, `${policy}: no automatic restart`);
    assert.ok(s.node.restarts.stale(session.id), `${policy}: shows as stale`);
  }
  const s = await setup(t, { policy: 'when-idle' });
  const session = await idleSession(s);
  const ch = record(s.node, sessionChannel(session.id));
  await install(s, { version: '1.1.0' });
  const restarted = await ch.waitFor('session.restarted');
  assert.equal(restarted.data.ok, true);
  assert.match((ch.find('session.restarting')!.data.reason ?? ''), /update detected: running 1\.0\.0, 1\.1\.0 installed/);
  assert.equal(s.fake.starts.length, 2);
  // Nothing more to do: another probe doesn't restart again.
  await install(s, {});
  assert.equal(s.fake.starts.length, 2);
});

test('a failed precheck keeps the old process; no automatic retry until the install changes', async (t) => {
  const s = await setup(t, { policy: 'when-idle' });
  const session = await idleSession(s);
  const ch = record(s.node, sessionChannel(session.id));
  await install(s, { version: '1.1.0', auth: 'missing' });
  const err = await ch.waitFor('error');
  assert.equal(err.data.code, 'restart_precheck');
  assert.match(err.data.message, /login no longer works.*keeps running on 1\.0\.0/);
  assert.equal(ch.find('session.restarting'), undefined);
  assert.equal(s.fake.starts.length, 1);
  assert.equal(s.fake.sessions[0]!.stopped, false);
  assert.equal(s.node.sessions.get(session.id).session.status, 'idle');

  // Same broken install: not retried.
  await install(s, {});
  assert.equal(ch.events.filter((e) => e.type === 'error').length, 1);
  // Direct call reports it.
  const outcome = await s.node.sessions.restartAgent(session.id);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.precheck, true);

  // Login fixed: a new install as far as restarts go.
  await install(s, { auth: 'ok' });
  assert.equal((await ch.waitFor('session.restarted')).data.ok, true);
});

test('a failed resume marks the session failed, keeps the old ref and is not retried', async (t) => {
  const s = await setup(t, { policy: 'when-idle' });
  const session = await idleSession(s);
  const ref = session.agentSessionRef;
  const ch = record(s.node, sessionChannel(session.id));
  s.fake.options.failStart = 'new binary crashed';
  await install(s, { version: '1.1.0' });
  const restarted = await ch.waitFor('session.restarted');
  assert.equal(restarted.data.ok, false);
  assert.match(restarted.data.error!, /new binary crashed/);
  const status = await ch.waitFor('session.status', (e) => e.data.status === 'failed');
  assert.ok(status.seq > restarted.seq);
  const info = s.node.sessions.get(session.id).session;
  assert.equal(info.status, 'failed');
  assert.equal(info.agentSessionRef, ref);
  assert.equal(s.fake.starts.length, 2);
  await install(s, {});
  assert.equal(s.fake.starts.length, 2, 'no automatic retry');
  assertContiguous(s.node, session.id);
});

/** Ignores resumeRef: every start is a new conversation. */
class ForgetfulAdapter extends FakeAdapter {
  override start(opts: StartSessionOptions, emit: EmitFn, ctx: AdapterContext): Promise<AdapterSession> {
    const { resumeRef: _ignored, ...rest } = opts;
    return super.start(rest, emit, ctx);
  }
}

test('a resume that lands in a different conversation fails and restores the old ref', async (t) => {
  const s = await setup(t, { fake: new ForgetfulAdapter() });
  const session = await idleSession(s);
  const ref = session.agentSessionRef!;
  s.fake.options.probe = { ...s.fake.options.probe, version: '1.1.0' };
  const outcome = await s.node.sessions.restartAgent(session.id, { reason: 'test' });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error!, /different conversation/);
  const info = s.node.sessions.get(session.id).session;
  assert.equal(info.status, 'failed');
  assert.equal(info.agentSessionRef, ref);
  assert.ok(s.fake.sessions[1]!.stopped, 'the wrong process was stopped');
});

test('sends during a restart are queued, not rejected', async (t) => {
  const s = await setup(t, { fake: new FakeAdapter({ startDelayMs: 80 }) });
  const session = await idleSession(s);
  const ch = record(s.node, sessionChannel(session.id));
  s.fake.options.probe = { ...s.fake.options.probe, version: '1.1.0' };
  const restart = s.node.sessions.restartAgent(session.id);
  await ch.waitFor('session.restarting');
  assert.ok(s.node.sessions.isRestarting(session.id));
  const { turnId } = await s.node.call('session.send', { sessionId: session.id, input: [{ type: 'text', text: 'queued' }] });
  assert.equal((await restart).ok, true);
  const started = await ch.waitFor('turn.started', (e) => e.data.turnId === turnId);
  assert.ok(started.seq > ch.find('session.restarted')!.seq);
  await ch.waitFor('turn.completed', (e) => e.data.turnId === turnId);
  assert.equal(s.fake.sessions.length, 2);
  assert.equal(s.fake.sessions[1]!.opts.resumeRef, session.agentSessionRef);

  // Behind a restart that fails, the queued send is refused.
  s.fake.options.failStart = 'nope';
  const failing = s.node.sessions.restartAgent(session.id);
  await waitFor(() => s.node.sessions.isRestarting(session.id) && ch.events.filter((e) => e.type === 'session.restarting').length === 2);
  await rejects(s.node.call('session.send', { sessionId: session.id, input: [{ type: 'text', text: 'x' }] }), 'agent_unavailable', /restart failed/);
  assert.equal((await failing).ok, false);
});

test('a parent blocked in session_wait survives its helper restarting', async (t) => {
  const s = await setup(t);
  const parent = await idleSession(s);
  const { session: helper } = await s.node.orchestration.startHelper(parent.id, { agent: 'claude', prompt: 'hello' });
  await waitFor(() => {
    const h = s.node.sessions.get(helper.id).session;
    return h.status === 'idle' && !s.node.sessions.isBusy(helper.id) && h.agentVersion;
  });
  let settled = false;
  const wait = s.node.orchestration.wait(parent.id, helper.id, 'ended', 10_000).then((r) => {
    settled = true;
    return r;
  });
  s.fake.options.probe = { ...s.fake.options.probe, version: '1.1.0' };
  const outcome = await s.node.sessions.restartAgent(helper.id);
  assert.equal(outcome.ok, true);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(settled, false, 'the wait is still blocked');
  assert.equal(s.node.sessions.get(parent.id).session.status, 'idle', 'the parent is untouched');
  await s.node.call('session.stop', { sessionId: helper.id });
  assert.equal((await wait).state, 'ended');
});

test('session.set: a helper cannot loosen its permission mode beyond its parent', async (t) => {
  const s = await setup(t);
  const parent = await idleSession(s, { permissionMode: 'default' });
  const { session: helper } = await s.node.orchestration.startHelper(parent.id, { agent: 'claude', prompt: 'hi' });
  assert.equal(helper.permissionMode, 'default');
  await rejects(s.node.call('session.set', { sessionId: helper.id, permissionMode: 'bypassPermissions' }), 'conflict', /looser than the parent/);
  await rejects(s.node.call('session.set', { sessionId: helper.id, permissionMode: 'acceptEdits' }), 'conflict', /at most default/);
  assert.equal((await s.node.call('session.set', { sessionId: helper.id, permissionMode: 'plan' })).session.permissionMode, 'plan');
  // A session you started yourself is not capped.
  assert.equal(
    (await s.node.call('session.set', { sessionId: parent.id, permissionMode: 'bypassPermissions' })).session.permissionMode,
    'bypassPermissions',
  );
});

test('session.set budget: raising it releases a session paused on budget; {} clears it', async (t) => {
  const s = await setup(t);
  const session = await idleSession(s, { budget: { turns: 1 } });
  const ch = record(s.node, sessionChannel(session.id));
  await s.node.call('session.send', { sessionId: session.id, input: [{ type: 'text', text: 'one' }] });
  await ch.waitFor('session.status', (e) => e.data.prompt === 'budget');
  await rejects(s.node.call('session.send', { sessionId: session.id, input: [{ type: 'text', text: 'two' }] }), 'conflict', /budget/);
  await rejects(s.node.call('session.set', { sessionId: session.id, budget: { turns: -1 } }), 'bad_request');

  const { session: raised } = await s.node.call('session.set', { sessionId: session.id, budget: { turns: 3 } });
  assert.deepEqual(raised.budget, { turns: 3 });
  const released = await ch.waitFor('session.status', (e) => e.data.reason === 'budget raised');
  assert.equal(released.data.status, 'idle');
  assert.equal(s.node.sessions.pending(session.id).budget, undefined);
  await s.node.call('session.send', { sessionId: session.id, input: [{ type: 'text', text: 'two' }] });
  await waitFor(() => ch.events.filter((e) => e.type === 'turn.completed').length === 2);

  const { session: cleared } = await s.node.call('session.set', { sessionId: session.id, budget: {} });
  assert.equal(cleared.budget, undefined);
});
