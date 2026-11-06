import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BizziError, GLOBAL_CHANNEL, sessionChannel, type SessionInfo } from '@bizzi/protocol';
import type { BizziNode } from '../src/index.ts';
import { FakeAdapter } from '../src/testing/index.ts';
import { makeNode, record, tempDir, waitFor } from './helpers.ts';

async function setup(t: { after: (fn: () => unknown) => void }, adapters = [new FakeAdapter()]) {
  const dir = tempDir();
  const node = await makeNode(dir.path, adapters);
  t.after(async () => {
    await node.close();
    dir.cleanup();
  });
  const { workspace } = await node.call('workspace.create', { path: dir.path + '/ws', create: true });
  return { node, workspace, dir };
}

async function idleSession(node: BizziNode, workspaceId: string, extra: Partial<{ mode: 'terminal' | 'structured'; agent: 'claude' | 'shell' }> = {}) {
  const { session } = await node.call('session.create', { workspaceId, agent: extra.agent ?? 'claude', ...(extra.mode ? { mode: extra.mode } : {}) });
  await waitFor(() => node.sessions.get(session.id).session.status === 'idle', 5000, 'idle');
  return session;
}

const rejectsWith = (code: string) => (err: unknown) => err instanceof BizziError && err.code === code;

test('full turn: deltas, tool, approval round-trip, completion and status derivation', async (t) => {
  const fake = new FakeAdapter();
  const { node, workspace } = await setup(t, [fake]);
  const global = record(node, GLOBAL_CHANNEL);

  const { session } = await node.call('session.create', { workspaceId: workspace.id, agent: 'claude', model: 'fake-model-large' });
  assert.equal(session.status, 'starting');
  assert.equal(session.mode, 'structured');
  await waitFor(() => node.sessions.get(session.id).session.status === 'idle');
  assert.equal(fake.starts[0]?.cwd, workspace.path);
  assert.equal(fake.starts[0]?.model, 'fake-model-large');

  const ch = record(node, sessionChannel(session.id));
  const statuses: string[] = [];
  const offStatus = node.bus.on(GLOBAL_CHANNEL, (ev) => {
    if (ev.type === 'session.updated' && ev.data.session.id === session.id) statuses.push(ev.data.session.status);
  });
  t.after(offStatus);

  const { turnId } = await node.call('session.send', { sessionId: session.id, input: [{ type: 'text', text: '/approve rm -rf build' }] });
  assert.match(turnId, /^t_/);
  assert.equal(ch.find('turn.started')?.data.turnId, turnId);

  const requested = await ch.waitFor('approval.requested');
  assert.equal(node.sessions.get(session.id).session.status, 'waiting_approval');

  // A second turn while one is running is a conflict.
  await assert.rejects(node.call('session.send', { sessionId: session.id, input: [{ type: 'text', text: 'hi' }] }), rejectsWith('conflict'));
  // approval.respond is validated against the pending set.
  await assert.rejects(
    node.call('approval.respond', { sessionId: session.id, approvalId: 'ap_nope', decision: 'allow' }),
    rejectsWith('not_found'),
  );
  await assert.rejects(
    node.call('approval.respond', { sessionId: session.id, approvalId: requested.data.approvalId, decision: 'maybe' as never }),
    rejectsWith('bad_request'),
  );

  await node.call('approval.respond', {
    sessionId: session.id,
    approvalId: requested.data.approvalId,
    decision: 'allow',
    editedInput: { command: 'rm -rf build/tmp' },
  });
  const done = await ch.waitFor('turn.completed');
  assert.equal(done.data.turnId, turnId);
  assert.equal(done.data.stopReason, 'end_turn');
  assert.equal(node.sessions.get(session.id).session.status, 'idle');

  const types = ch.types();
  for (const ty of ['message.delta', 'message.completed', 'tool.started', 'approval.requested', 'approval.resolved', 'tool.completed']) {
    assert.ok(types.includes(ty as never), `missing ${ty}`);
  }
  const tool = ch.find('tool.completed');
  assert.equal(tool?.data.status, 'ok');
  assert.match(tool?.data.output ?? '', /build\/tmp/);
  // Approval no longer pending.
  await assert.rejects(
    node.call('approval.respond', { sessionId: session.id, approvalId: requested.data.approvalId, decision: 'allow' }),
    rejectsWith('not_found'),
  );

  assert.deepEqual(statuses, ['running', 'waiting_approval', 'running', 'idle']);
  // seq is contiguous on the session channel.
  assert.deepEqual(ch.events.map((e) => e.seq), ch.events.map((_, i) => i + 1));
  // session.created then updates on the global channel; agentSessionRef picked up from session.info.
  assert.equal(global.events[0]?.type === 'machine.updated' || global.events[0]?.type === 'workspace.created', true);
  assert.ok(global.find('session.created'));
  const info = node.sessions.get(session.id).session;
  assert.match(info.agentSessionRef ?? '', /^fake_/);
  assert.equal(info.lastSeq, ch.events.at(-1)?.seq);
});

test('deny, interrupt, failing turns, stop and ended sessions', async (t) => {
  const { node, workspace } = await setup(t);
  const session = await idleSession(node, workspace.id);
  const ch = record(node, sessionChannel(session.id));
  const send = (text: string) => node.call('session.send', { sessionId: session.id, input: [{ type: 'text', text }] });

  // deny
  await send('/approve make');
  const req = await ch.waitFor('approval.requested');
  await node.call('approval.respond', { sessionId: session.id, approvalId: req.data.approvalId, decision: 'deny', message: 'no' });
  await ch.waitFor('turn.completed');
  assert.equal(ch.find('tool.completed')?.data.status, 'denied');

  // interrupt a slow turn
  const { turnId } = await send('/slow 5000');
  await ch.waitFor('message.delta', (e) => ch.events.some((x) => x.type === 'turn.started' && x.data.turnId === turnId) && e.seq > 0);
  await node.call('session.interrupt', { sessionId: session.id });
  const interrupted = await ch.waitFor('turn.completed', (e) => e.data.turnId === turnId);
  assert.equal(interrupted.data.stopReason, 'interrupted');
  assert.equal(node.sessions.get(session.id).session.status, 'idle');
  // interrupt with nothing running is a no-op
  await node.call('session.interrupt', { sessionId: session.id });

  // failing turn
  const failed = await send('/fail boom');
  const fc = await ch.waitFor('turn.completed', (e) => e.data.turnId === failed.turnId);
  assert.equal(fc.data.stopReason, 'error');
  assert.equal(fc.data.error, 'boom');

  // steer requires a running turn
  await assert.rejects(node.call('session.steer', { sessionId: session.id, input: [{ type: 'text', text: 'x' }] }), rejectsWith('conflict'));
  // bad input
  await assert.rejects(node.call('session.send', { sessionId: session.id, input: [] }), rejectsWith('bad_request'));
  await assert.rejects(node.call('session.send', { sessionId: session.id, input: [{ type: 'nope' }] as never }), rejectsWith('bad_request'));

  // session.set while running the adapter
  const { session: updated } = await node.call('session.set', { sessionId: session.id, model: 'fake-model-large', effort: 'high' });
  assert.equal(updated.model, 'fake-model-large');
  assert.equal(updated.effort, 'high');

  // stop mid-turn: the turn is closed and the session ends
  const slow = await send('/slow 5000');
  await node.call('session.stop', { sessionId: session.id });
  const stopped = await ch.waitFor('turn.completed', (e) => e.data.turnId === slow.turnId);
  assert.equal(stopped.data.stopReason, 'interrupted');
  assert.equal(node.sessions.get(session.id).session.status, 'ended');
  await assert.rejects(send('again'), rejectsWith('conflict'));
  await node.call('session.stop', { sessionId: session.id }); // idempotent
  // exactly one turn.completed per turn
  const completedIds = ch.events.filter((e) => e.type === 'turn.completed').map((e) => (e.data as { turnId: string }).turnId);
  assert.equal(new Set(completedIds).size, completedIds.length);
});

test('core completes the turn when the adapter ignores an interrupt', async (t) => {
  const { node, workspace } = await setup(t, [new FakeAdapter({ ignoreInterrupt: true })]);
  const session = await idleSession(node, workspace.id);
  const ch = record(node, sessionChannel(session.id));
  const { turnId } = await node.call('session.send', { sessionId: session.id, input: [{ type: 'text', text: '/slow 3000' }] });
  await node.call('session.interrupt', { sessionId: session.id });
  const done = await ch.waitFor('turn.completed', (e) => e.data.turnId === turnId);
  assert.equal(done.data.stopReason, 'interrupted');
  assert.equal(node.sessions.get(session.id).session.status, 'idle');
});

test('adapter-reported failure closes the open turn; the next send restarts the adapter with resume', async (t) => {
  const fake = new FakeAdapter();
  const { node, workspace } = await setup(t, [fake]);
  const session = await idleSession(node, workspace.id);
  const ch = record(node, sessionChannel(session.id));
  const { turnId } = await node.call('session.send', { sessionId: session.id, input: [{ type: 'text', text: '/crash' }] });
  await waitFor(() => node.sessions.get(session.id).session.status === 'failed');
  const tc = ch.find('turn.completed');
  assert.equal(tc?.data.turnId, turnId);
  assert.equal(tc?.data.stopReason, 'error');
  const ref = node.sessions.get(session.id).session.agentSessionRef;

  await node.call('session.send', { sessionId: session.id, input: [{ type: 'text', text: 'again' }] });
  await waitFor(() => ch.events.filter((e) => e.type === 'turn.completed').length === 2);
  assert.equal(fake.starts.length, 2);
  assert.equal(fake.starts[1]?.resumeRef, ref);
  assert.equal(node.sessions.get(session.id).session.status, 'idle');
});

test('start failure marks the session failed', async (t) => {
  const { node, workspace } = await setup(t, [new FakeAdapter({ failStart: 'claude not installed' })]);
  const { session } = await node.call('session.create', { workspaceId: workspace.id, agent: 'claude' });
  await waitFor(() => node.sessions.get(session.id).session.status === 'failed');
  const ch = record(node, sessionChannel(session.id));
  assert.equal(ch.find('session.status')?.data.reason, 'claude not installed');
  await assert.rejects(
    node.call('session.send', { sessionId: session.id, input: [{ type: 'text', text: 'x' }] }),
    rejectsWith('agent_unavailable'),
  );
});

test('adapter selection by agent and mode; agents.list merges and caches', async (t) => {
  const structured = new FakeAdapter({ agent: 'claude' });
  const terminal = new FakeAdapter({ agent: 'claude', modes: ['terminal'] });
  const shell = new FakeAdapter({ agent: 'shell', modes: ['terminal'] });
  let probes = 0;
  const probe = shell.probe.bind(shell);
  shell.probe = async () => {
    probes++;
    return probe();
  };
  const { node, workspace } = await setup(t, [structured, terminal, shell]);

  const s1 = await idleSession(node, workspace.id);
  assert.equal(structured.starts.length, 1);
  const s2 = await idleSession(node, workspace.id, { mode: 'terminal' });
  assert.equal(terminal.starts.length, 1);
  const s3 = await idleSession(node, workspace.id, { agent: 'shell' });
  assert.equal(s3.mode, 'terminal');
  await assert.rejects(node.call('session.create', { workspaceId: workspace.id, agent: 'codex' }), rejectsWith('agent_unavailable'));
  await assert.rejects(
    node.call('session.create', { workspaceId: workspace.id, agent: 'shell', mode: 'structured' }),
    rejectsWith('agent_unavailable'),
  );

  const { agents } = await node.call('agents.list', {});
  const claude = agents.find((a) => a.agent === 'claude');
  assert.deepEqual(claude?.capabilities?.modes, ['structured', 'terminal']);
  assert.equal(claude?.capabilities?.terminal, true);
  assert.equal(claude?.capabilities?.steer, true);
  assert.equal(claude?.installed, true);
  await node.call('agents.list', {});
  assert.equal(probes, 1);
  await node.call('agents.list', { refresh: true });
  assert.equal(probes, 2);

  const got = await node.call('session.get', { sessionId: s2.id });
  assert.equal(got.capabilities.terminal, true);
  const list = await node.call('sessions.list', { workspaceId: workspace.id });
  assert.deepEqual(new Set(list.sessions.map((s: SessionInfo) => s.id)), new Set([s1.id, s2.id, s3.id]));

  // terminal I/O
  const ch = record(node, sessionChannel(s3.id));
  await node.call('term.input', { sessionId: s3.id, dataBase64: Buffer.from('ls\r').toString('base64') });
  await node.call('term.resize', { sessionId: s3.id, cols: 120, rows: 40 });
  assert.deepEqual(shell.last?.size, { cols: 120, rows: 40 });
  assert.equal(Buffer.from(shell.last?.terminalInput[0] ?? []).toString(), 'ls\r');
  assert.ok(ch.events.some((e) => e.type === 'term.output' && Buffer.from(e.data.dataBase64, 'base64').toString() === 'ls\r'));
  await assert.rejects(
    node.call('term.input', { sessionId: s1.id, dataBase64: 'eA==' }),
    rejectsWith('unsupported'),
  );
});

test('workspaces: adopt, idempotent adopt, git kind, remove', async (t) => {
  const { node, workspace, dir } = await setup(t);
  assert.equal(workspace.kind, 'dir');
  const again = await node.call('workspace.create', { path: workspace.path });
  assert.equal(again.workspace.id, workspace.id);
  await assert.rejects(node.call('workspace.create', { path: dir.path + '/missing' }), rejectsWith('not_found'));
  await assert.rejects(node.call('workspace.create', { path: 'relative/path' }), rejectsWith('bad_request'));
  const { workspaces } = await node.call('workspaces.list', {});
  assert.equal(workspaces.length, 1);

  const session = await idleSession(node, workspace.id);
  await node.call('workspace.remove', { workspaceId: workspace.id });
  assert.equal(node.sessions.get(session.id).session.status, 'ended');
  assert.equal((await node.call('workspaces.list', {})).workspaces.length, 0);
  await assert.rejects(node.call('workspace.remove', { workspaceId: workspace.id }), rejectsWith('not_found'));
});

test('drain rejects new turns and waits for running ones', async (t) => {
  const { node, workspace } = await setup(t);
  const session = await idleSession(node, workspace.id);
  await node.call('session.send', { sessionId: session.id, input: [{ type: 'text', text: '/slow 300' }] });
  const drained = node.drain(5000);
  await assert.rejects(
    node.call('session.send', { sessionId: session.id, input: [{ type: 'text', text: 'x' }] }),
    rejectsWith('conflict'),
  );
  await assert.rejects(node.call('session.create', { workspaceId: workspace.id, agent: 'claude' }), rejectsWith('conflict'));
  assert.equal(await drained, true);
  assert.equal(node.sessions.get(session.id).session.status, 'idle');
});

test('unknown methods and channels', async (t) => {
  const { node } = await setup(t);
  await assert.rejects(node.dispatch('nope.nothing', {}), rejectsWith('unsupported'));
  await assert.rejects(node.dispatch('session.get', { sessionId: 's_missing' }), rejectsWith('not_found'));
  await assert.rejects(node.dispatch('session.get', 'bad'), rejectsWith('bad_request'));
  assert.throws(() => node.subscribe('bogus', 0, () => {}), rejectsWith('bad_request'));
  assert.throws(() => node.subscribe('session:s_missing', 0, () => {}), rejectsWith('not_found'));
});
