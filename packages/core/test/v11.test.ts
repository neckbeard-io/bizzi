// Protocol v1.1 behaviour: fork, delete, questions, cancellations, turn semantics, terminal snapshot,
// session.create command, MachineTarget and the extension API.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  BizziError,
  GLOBAL_CHANNEL,
  sessionChannel,
  type AgentAdapter,
  type ChannelEvent,
  type SessionEvent,
} from '@bizzi/protocol';
import { createNode, TERMINAL_SNAPSHOT_MAX_BYTES, type BizziNode, type ExtensionContext, type NodeExtension } from '../src/index.ts';
import { Store } from '../src/store.ts';
import { FakeAdapter } from '../src/testing/index.ts';
import { makeNode, record, tempDir, waitFor } from './helpers.ts';

const rejectsWith = (code: string) => (err: unknown) => err instanceof BizziError && err.code === code;

async function setup(t: { after: (fn: () => unknown) => void }, adapters: AgentAdapter[] = [new FakeAdapter()]) {
  const dir = tempDir();
  const node = await makeNode(dir.path, adapters);
  t.after(async () => {
    await node.close();
    dir.cleanup();
  });
  const { workspace } = await node.call('workspace.create', { path: dir.path + '/ws', create: true });
  return { node, workspace, dir };
}

async function waitIdle(node: BizziNode, id: string) {
  await waitFor(() => node.sessions.get(id).session.status === 'idle', 5000, `${id} idle`);
}

async function idleSession(node: BizziNode, workspaceId: string, extra: Record<string, unknown> = {}) {
  const { session } = await node.call('session.create', { workspaceId, agent: 'claude', ...extra });
  await waitIdle(node, session.id);
  return node.sessions.get(session.id).session;
}

const text = (t: string) => [{ type: 'text' as const, text: t }];

function turnCompletions(events: ChannelEvent[], turnId: string) {
  return events.filter((e) => e.type === 'turn.completed' && e.data.turnId === turnId);
}

// --- session.fork -----------------------------------------------------------------------------------

test('session.fork uses the native fork when the agent supports it', async (t) => {
  const fake = new FakeAdapter();
  const { node, workspace } = await setup(t, [fake]);
  const global = record(node, GLOBAL_CHANNEL);
  const src = await idleSession(node, workspace.id, { model: 'fake-model-large', permissionMode: 'plan', effort: 'high', title: 'main' });
  assert.ok(src.agentSessionRef);

  const { session: fork } = await node.call('session.fork', { sessionId: src.id, title: 'experiment' });
  assert.notEqual(fork.id, src.id);
  assert.equal(fork.forkedFrom, src.id);
  assert.equal(fork.workspaceId, workspace.id);
  assert.equal(fork.title, 'experiment');
  assert.equal(fork.model, 'fake-model-large');
  assert.equal(fork.permissionMode, 'plan');
  assert.equal(fork.effort, 'high');
  assert.ok(global.events.some((e) => e.type === 'session.created' && e.data.session.id === fork.id));
  await waitIdle(node, fork.id);

  const start = fake.starts[1]!;
  assert.equal(start.resumeRef, src.agentSessionRef);
  assert.equal(start.fork, true);
  assert.equal(start.model, 'fake-model-large');
  assert.equal(fake.last?.forkedFromRef, src.agentSessionRef);
  const forkRef = node.sessions.get(fork.id).session.agentSessionRef;
  assert.match(forkRef ?? '', /^fake_fork_/);
  assert.equal(node.sessions.get(src.id).session.agentSessionRef, src.agentSessionRef);

  // Once the fork has its own conversation, later restarts resume it rather than forking again.
  const ch = record(node, sessionChannel(fork.id));
  await node.call('session.send', { sessionId: fork.id, input: text('/crash') });
  await waitFor(() => node.sessions.get(fork.id).session.status === 'failed');
  await node.call('session.send', { sessionId: fork.id, input: text('hi') });
  await ch.waitFor('message.completed', (e) => e.data.text === 'echo: hi');
  assert.equal(fake.starts[2]?.resumeRef, forkRef);
  assert.equal(fake.starts[2]?.fork, undefined);
  // No fallback note for a native fork; title defaults to the source's.
  assert.equal(ch.find('agent.raw'), undefined);
  const { session: fork2 } = await node.call('session.fork', { sessionId: src.id });
  assert.equal(fork2.title, 'main');

  await assert.rejects(node.call('session.fork', { sessionId: 's_missing' }), rejectsWith('not_found'));
});

test('session.fork without native support starts fresh and says so', async (t) => {
  const fake = new FakeAdapter({ capabilities: { fork: false } });
  const { node, workspace } = await setup(t, [fake]);
  const src = await idleSession(node, workspace.id, { model: 'fake-model-large' });
  const { session: fork } = await node.call('session.fork', { sessionId: src.id });
  await waitIdle(node, fork.id);
  assert.equal(fork.forkedFrom, src.id);
  assert.equal(fork.model, 'fake-model-large');
  assert.equal(fake.starts[1]?.resumeRef, undefined);
  assert.equal(fake.starts[1]?.fork, undefined);
  const ch = record(node, sessionChannel(fork.id));
  const note = ch.find('agent.raw');
  assert.ok(note);
  const payload = note.data.payload as { type: string; native: boolean; forkedFrom: string; message: string };
  assert.equal(payload.type, 'bizzi.fork');
  assert.equal(payload.native, false);
  assert.equal(payload.forkedFrom, src.id);
  assert.match(payload.message, /starts fresh/);
  assert.notEqual(node.sessions.get(fork.id).session.agentSessionRef, src.agentSessionRef);

  // Forking is refused while draining.
  void node.drain(1000);
  await assert.rejects(node.call('session.fork', { sessionId: src.id }), rejectsWith('conflict'));
});

test('session.fork copies terminal command and size', async (t) => {
  const shell = new FakeAdapter({ agent: 'shell', modes: ['terminal'] });
  const { node, workspace } = await setup(t, [shell]);
  const { session } = await node.call('session.create', {
    workspaceId: workspace.id,
    agent: 'shell',
    command: ['htop', '-d', '5'],
    cols: 100,
    rows: 30,
  });
  await waitIdle(node, session.id);
  const { session: fork } = await node.call('session.fork', { sessionId: session.id });
  await waitIdle(node, fork.id);
  assert.equal(fork.mode, 'terminal');
  assert.deepEqual(shell.starts[1]?.command, ['htop', '-d', '5']);
  assert.equal(shell.starts[1]?.cols, 100);
  assert.equal(shell.starts[1]?.rows, 30);
});

// --- session.delete --------------------------------------------------------------------------------

test('session.delete stops a running session and removes it and its events', async (t) => {
  const fake = new FakeAdapter();
  const dir = tempDir();
  t.after(dir.cleanup);
  const node = await makeNode(dir.path, [fake]);
  const { workspace } = await node.call('workspace.create', { path: dir.path + '/ws', create: true });
  const keep = await idleSession(node, workspace.id);
  const doomed = await idleSession(node, workspace.id);
  const global = record(node, GLOBAL_CHANNEL);
  await node.call('session.send', { sessionId: doomed.id, input: text('/slow 5000') });
  await waitFor(() => node.sessions.get(doomed.id).session.status === 'running');
  const handle = fake.sessions.find((s) => s.opts.sessionId === doomed.id)!;

  await node.call('session.delete', { sessionId: doomed.id });
  assert.equal(handle.stopped, true);
  const removed = global.find('session.removed');
  assert.deepEqual(removed?.data, { sessionId: doomed.id, workspaceId: workspace.id });
  assert.equal(node.sessions.has(doomed.id), false);
  assert.deepEqual(
    (await node.call('sessions.list', {})).sessions.map((s) => s.id),
    [keep.id],
  );
  assert.deepEqual(node.bus.replay(sessionChannel(doomed.id)), []);
  assert.throws(() => node.subscribe(sessionChannel(doomed.id), 0, () => {}), rejectsWith('not_found'));
  await assert.rejects(node.call('session.get', { sessionId: doomed.id }), rejectsWith('not_found'));
  await assert.rejects(node.call('session.delete', { sessionId: doomed.id }), rejectsWith('not_found'));
  assert.equal(node.sessions.activeTurns(), 0);

  // Deleting an idle session works while draining (it only removes work).
  void node.drain(1000);
  await node.call('session.delete', { sessionId: keep.id });
  await node.close();

  // Gone after a restart too.
  const n2 = await makeNode(dir.path, [new FakeAdapter()]);
  t.after(() => n2.close());
  assert.deepEqual((await n2.call('sessions.list', {})).sessions, []);
  assert.deepEqual(n2.bus.replay(sessionChannel(doomed.id)), []);
});

// --- questions ------------------------------------------------------------------------------------

test('question round-trip: validation, answer, status and decline', async (t) => {
  const fake = new FakeAdapter();
  const { node, workspace } = await setup(t, [fake]);
  const s = await idleSession(node, workspace.id);
  const ch = record(node, sessionChannel(s.id));

  const { turnId } = await node.call('session.send', { sessionId: s.id, input: text('/ask Ship it?') });
  const asked = await ch.waitFor('question.asked');
  assert.equal(asked.data.text, 'Ship it?');
  assert.deepEqual(asked.data.options, ['yes', 'no']);
  assert.equal(asked.data.questions?.[0]?.id, 'q1');
  assert.equal(node.sessions.get(s.id).session.status, 'waiting_input');

  const qid = asked.data.questionId;
  await assert.rejects(node.call('question.respond', { sessionId: s.id, questionId: 'q_nope', answers: { q1: 'yes' } }), rejectsWith('not_found'));
  await assert.rejects(node.call('question.respond', { sessionId: s.id, questionId: qid }), rejectsWith('bad_request'));
  await assert.rejects(node.call('question.respond', { sessionId: s.id, questionId: qid, answers: { nope: 'yes' } }), rejectsWith('bad_request'));
  await assert.rejects(
    node.call('question.respond', { sessionId: s.id, questionId: qid, answers: { q1: 3 } as never }),
    rejectsWith('bad_request'),
  );

  await node.call('question.respond', { sessionId: s.id, questionId: qid, answers: { q1: 'yes' } });
  const resolved = await ch.waitFor('question.resolved');
  assert.deepEqual(resolved.data, { questionId: qid, answers: { q1: 'yes' } });
  await ch.waitFor('turn.completed', (e) => e.data.turnId === turnId);
  assert.ok(ch.events.some((e) => e.type === 'message.completed' && e.data.text === 'answer: yes'));
  assert.deepEqual(fake.last?.answered, [{ questionId: qid, answers: { q1: 'yes' } }]);
  assert.equal(node.sessions.get(s.id).session.status, 'idle');
  await assert.rejects(node.call('question.respond', { sessionId: s.id, questionId: qid, answers: { q1: 'no' } }), rejectsWith('not_found'));

  // Decline: the adapter gets `undefined`.
  await node.call('session.send', { sessionId: s.id, input: text('/ask Again?') });
  const asked2 = await ch.waitFor('question.asked', (e) => e.data.questionId !== qid);
  await node.call('question.respond', { sessionId: s.id, questionId: asked2.data.questionId, cancel: true });
  await ch.waitFor('question.resolved', (e) => e.data.questionId === asked2.data.questionId);
  assert.deepEqual(fake.last?.answered[1], { questionId: asked2.data.questionId, answers: undefined });
  await waitIdle(node, s.id);
  assert.ok(ch.events.some((e) => e.type === 'message.completed' && e.data.text === 'question declined'));
});

test('pending question is cancelled when the turn is interrupted', async (t) => {
  const { node, workspace } = await setup(t);
  const s = await idleSession(node, workspace.id);
  const ch = record(node, sessionChannel(s.id));
  const { turnId } = await node.call('session.send', { sessionId: s.id, input: text('/ask Proceed?') });
  const asked = await ch.waitFor('question.asked');
  await node.call('session.interrupt', { sessionId: s.id });
  await ch.waitFor('turn.completed', (e) => e.data.turnId === turnId);
  const resolutions = ch.events.filter((e) => e.type === 'question.resolved');
  assert.equal(resolutions.length, 1);
  assert.deepEqual(resolutions[0]?.data, { questionId: asked.data.questionId, cancelled: true });
  const types = ch.types();
  assert.ok(types.lastIndexOf('question.resolved') < types.lastIndexOf('turn.completed'));
  assert.equal(node.sessions.get(s.id).session.status, 'idle');
  await assert.rejects(
    node.call('question.respond', { sessionId: s.id, questionId: asked.data.questionId, answers: { q1: 'yes' } }),
    rejectsWith('not_found'),
  );
});

test('question.respond is unsupported when the adapter cannot answer questions', async (t) => {
  const { node, workspace } = await setup(t, [new FakeAdapter({ questions: false })]);
  const s = await idleSession(node, workspace.id);
  const ch = record(node, sessionChannel(s.id));
  await node.call('session.send', { sessionId: s.id, input: text('/ask Hm?') });
  const asked = await ch.waitFor('question.asked');
  await assert.rejects(
    node.call('question.respond', { sessionId: s.id, questionId: asked.data.questionId, answers: { q1: 'yes' } }),
    rejectsWith('unsupported'),
  );
});

// --- approvals cancelled ---------------------------------------------------------------------------

test('pending approval is cancelled when the session stops', async (t) => {
  const { node, workspace } = await setup(t);
  const s = await idleSession(node, workspace.id);
  const ch = record(node, sessionChannel(s.id));
  const { turnId } = await node.call('session.send', { sessionId: s.id, input: text('/approve deploy') });
  const req = await ch.waitFor('approval.requested');
  await node.call('session.stop', { sessionId: s.id });
  const resolved = ch.events.filter((e) => e.type === 'approval.resolved');
  assert.deepEqual(resolved.map((e) => e.data), [{ approvalId: req.data.approvalId, decision: 'cancelled' }]);
  assert.equal(turnCompletions(ch.events, turnId).length, 1);
  const types = ch.types();
  assert.ok(types.indexOf('approval.resolved') < types.indexOf('turn.completed'));
  assert.equal(node.sessions.get(s.id).session.status, 'ended');
  await assert.rejects(
    node.call('approval.respond', { sessionId: s.id, approvalId: req.data.approvalId, decision: 'allow' }),
    rejectsWith('not_found'),
  );
});

test('pending approval is cancelled on shutdown and after a crash-restart', async (t) => {
  const dir = tempDir();
  t.after(dir.cleanup);

  // Clean shutdown: the open turn is closed and the approval cancelled.
  const n1 = await makeNode(dir.path, [new FakeAdapter()]);
  const { workspace } = await n1.call('workspace.create', { path: dir.path + '/ws', create: true });
  const s = await idleSession(n1, workspace.id);
  const ch = record(n1, sessionChannel(s.id));
  await n1.call('session.send', { sessionId: s.id, input: text('/approve deploy') });
  const req = await ch.waitFor('approval.requested');
  await waitFor(() => n1.sessions.get(s.id).session.status === 'waiting_approval');
  // The pending approval is persisted with the session.
  const crashSeq = n1.bus.lastSeq(sessionChannel(s.id));
  const peek = new Store(dir.path);
  const crashRow = peek.listSessions().find((r) => r.info.id === s.id)!;
  peek.close();
  assert.deepEqual(crashRow.state.pendingApprovals, [req.data.approvalId]);
  assert.ok(crashRow.state.currentTurnId);
  await n1.close();
  const shutdownEvents = ch.events.filter((e) => e.seq > crashSeq).map((e) => e.type);
  assert.deepEqual(shutdownEvents.slice(0, 2), ['approval.resolved', 'turn.completed']);

  // Crash: roll the database back to the moment the approval was pending, then restart.
  const db = new DatabaseSync(join(dir.path, 'node.db'));
  db.prepare('DELETE FROM events WHERE ch = ? AND seq > ?').run(sessionChannel(s.id), crashSeq);
  db.prepare('UPDATE sessions SET info = ?, state = ? WHERE id = ?').run(
    JSON.stringify(crashRow.info),
    JSON.stringify(crashRow.state),
    s.id,
  );
  db.close();
  const n2 = await makeNode(dir.path, [new FakeAdapter()]);
  t.after(() => n2.close());
  const after = n2.bus.replay(sessionChannel(s.id), crashSeq) as SessionEvent[];
  assert.equal(after[0]?.type, 'approval.resolved');
  assert.deepEqual(after[0]?.data, { approvalId: req.data.approvalId, decision: 'cancelled' });
  assert.equal(after[1]?.type, 'turn.completed');
  assert.equal(n2.sessions.get(s.id).session.status, 'idle');
  const peek2 = new Store(dir.path);
  assert.equal(peek2.listSessions().find((r) => r.info.id === s.id)?.state.pendingApprovals, undefined);
  peek2.close();
});

// --- turn semantics ----------------------------------------------------------------------------------

test('exactly one turn.completed when send() rejects, with or without the adapter completing first', async (t) => {
  for (const afterComplete of [true, false]) {
    const { node, workspace } = await setup(t, [new FakeAdapter({ rejectSend: { message: 'kaput', afterComplete } })]);
    const s = await idleSession(node, workspace.id);
    const ch = record(node, sessionChannel(s.id));
    await assert.rejects(node.call('session.send', { sessionId: s.id, input: text('hi') }), rejectsWith('internal'));
    const started = ch.find('turn.started');
    assert.ok(started);
    const done = turnCompletions(ch.events, started.data.turnId);
    assert.equal(done.length, 1, `afterComplete=${afterComplete}`);
    assert.equal((done[0]?.data as { stopReason: string }).stopReason, 'error');
    assert.equal(node.sessions.get(s.id).session.status, 'idle');
  }
});

test('duplicate turn.completed from an adapter is dropped', async (t) => {
  const fake = new FakeAdapter({
    script: (_input, ctx) => [
      { type: 'emit', event: { type: 'turn.completed', data: { turnId: ctx.turnId, stopReason: 'end_turn' } } },
      { type: 'sleep', ms: 5 },
    ],
  });
  const { node, workspace } = await setup(t, [fake]);
  const s = await idleSession(node, workspace.id);
  const ch = record(node, sessionChannel(s.id));
  const { turnId } = await node.call('session.send', { sessionId: s.id, input: text('x') });
  await ch.waitFor('turn.completed');
  await waitFor(() => fake.last?.currentTurnId === undefined);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(turnCompletions(ch.events, turnId).length, 1);
});

test('session.steer emits turn.steered and the fake echoes it', async (t) => {
  const fake = new FakeAdapter();
  const { node, workspace } = await setup(t, [fake]);
  const s = await idleSession(node, workspace.id);
  const ch = record(node, sessionChannel(s.id));
  const { turnId } = await node.call('session.send', { sessionId: s.id, input: text('/slow 3000') });
  await ch.waitFor('message.delta');
  await node.call('session.steer', { sessionId: s.id, input: text('also add tests') });
  const steered = ch.find('turn.steered');
  assert.deepEqual(steered?.data, { turnId, input: text('also add tests') });
  const echo = await ch.waitFor('message.completed', (e) => e.data.text === 'steered: also add tests');
  assert.equal(echo.data.role, 'assistant');
  assert.ok(steered!.seq < echo.seq);
  assert.deepEqual(fake.last?.steered, [text('also add tests')]);
  await node.call('session.interrupt', { sessionId: s.id });
  await ch.waitFor('turn.completed');
});

test('adapters may report waiting_input with a prompt and then running', async (t) => {
  const fake = new FakeAdapter({
    script: () => [
      { type: 'status', status: 'waiting_input', prompt: 'input' },
      { type: 'sleep', ms: 30 },
      { type: 'status', status: 'running' },
      { type: 'sleep', ms: 30 },
    ],
  });
  const { node, workspace } = await setup(t, [fake]);
  const s = await idleSession(node, workspace.id);
  const ch = record(node, sessionChannel(s.id));
  await node.call('session.send', { sessionId: s.id, input: text('x') });
  const waiting = await ch.waitFor('session.status', (e) => e.data.status === 'waiting_input');
  assert.equal(waiting.data.prompt, 'input');
  await ch.waitFor('session.status', (e) => e.data.status === 'running');
  await ch.waitFor('turn.completed');
  const startSeq = ch.find('turn.started')!.seq;
  const statuses = ch.events.flatMap((e) => (e.type === 'session.status' && e.seq > startSeq ? [e.data.status] : []));
  assert.deepEqual(statuses, ['waiting_input', 'running']);
  assert.equal(node.sessions.get(s.id).session.status, 'idle');
});

// --- term.snapshot ----------------------------------------------------------------------------------

test('term.snapshot from the adapter and from stored events', async (t) => {
  const withSnap = new FakeAdapter({ agent: 'shell', modes: ['terminal'] });
  const noSnap = new FakeAdapter({ agent: 'agy', modes: ['terminal'], terminalSnapshot: false });
  const { node, workspace } = await setup(t, [new FakeAdapter(), withSnap, noSnap]);

  for (const agent of ['shell', 'agy'] as const) {
    const { session } = await node.call('session.create', { workspaceId: workspace.id, agent });
    await waitIdle(node, session.id);
    await node.call('term.input', { sessionId: session.id, dataBase64: Buffer.from('ls -la\r').toString('base64') });
    const snap = await node.call('term.snapshot', { sessionId: session.id });
    assert.equal(snap.seq, node.bus.lastSeq(sessionChannel(session.id)), agent);
    const out = Buffer.from(snap.dataBase64, 'base64').toString();
    assert.ok(out.startsWith('fake terminal ('), agent);
    assert.ok(out.endsWith('ls -la\r'), agent);
  }
  assert.ok(withSnap.last?.snapshotTerminal);
  assert.equal(noSnap.last?.snapshotTerminal, undefined);

  const s = await idleSession(node, workspace.id);
  await assert.rejects(node.call('term.snapshot', { sessionId: s.id }), rejectsWith('unsupported'));
});

test('term.snapshot rebuilt from events is capped and survives a restart', async (t) => {
  const dir = tempDir();
  t.after(dir.cleanup);
  const n1 = await makeNode(dir.path, [new FakeAdapter({ agent: 'agy', modes: ['terminal'], terminalSnapshot: false })]);
  const { workspace } = await n1.call('workspace.create', { path: dir.path + '/ws', create: true });
  const { session } = await n1.call('session.create', { workspaceId: workspace.id, agent: 'agy' });
  await waitIdle(n1, session.id);
  const chunk = 900 * 1024;
  for (let i = 0; i < 3; i++) {
    const data = Buffer.alloc(chunk, 'abc'[i]!);
    await n1.call('term.input', { sessionId: session.id, dataBase64: data.toString('base64') });
  }
  await n1.call('term.input', { sessionId: session.id, dataBase64: Buffer.from('END').toString('base64') });
  const snap = await n1.call('term.snapshot', { sessionId: session.id });
  const out = Buffer.from(snap.dataBase64, 'base64');
  assert.equal(out.length, TERMINAL_SNAPSHOT_MAX_BYTES);
  assert.equal(out.subarray(-3).toString(), 'END');
  assert.equal(out[0], 'a'.charCodeAt(0));
  await n1.close();

  const n2 = await makeNode(dir.path, [new FakeAdapter({ agent: 'agy', modes: ['terminal'], terminalSnapshot: false })]);
  t.after(() => n2.close());
  const snap2 = await n2.call('term.snapshot', { sessionId: session.id });
  assert.equal(Buffer.from(snap2.dataBase64, 'base64').subarray(-3).toString(), 'END');
  assert.equal(snap2.seq, n2.bus.lastSeq(sessionChannel(session.id)));
});

// --- session.create command -------------------------------------------------------------------------

test('session.create command: terminal only, validated, persisted for resumed sessions', async (t) => {
  const dir = tempDir();
  t.after(dir.cleanup);
  const termOpts = { agent: 'claude' as const, modes: ['terminal' as const], capabilities: { resumeAfterNodeRestart: true, resume: true } };
  const term1 = new FakeAdapter(termOpts);
  const n1 = await makeNode(dir.path, [new FakeAdapter(), term1]);
  const { workspace } = await n1.call('workspace.create', { path: dir.path + '/ws', create: true });

  await assert.rejects(
    n1.call('session.create', { workspaceId: workspace.id, agent: 'claude', command: ['claude', 'login'] }),
    rejectsWith('bad_request'),
  );
  await assert.rejects(
    n1.call('session.create', { workspaceId: workspace.id, agent: 'claude', mode: 'terminal', command: [] }),
    rejectsWith('bad_request'),
  );
  await assert.rejects(
    n1.call('session.create', { workspaceId: workspace.id, agent: 'claude', mode: 'terminal', command: 'claude login' as never }),
    rejectsWith('bad_request'),
  );

  const { session } = await n1.call('session.create', {
    workspaceId: workspace.id,
    agent: 'claude',
    mode: 'terminal',
    command: ['claude', 'setup-token'],
    resumeRef: 'term-ref',
  });
  await waitIdle(n1, session.id);
  assert.deepEqual(term1.starts[0]?.command, ['claude', 'setup-token']);
  const ch = record(n1, sessionChannel(session.id));
  assert.ok(ch.events.some((e) => e.type === 'term.output' && Buffer.from(e.data.dataBase64, 'base64').toString().includes('$ claude setup-token')));
  await n1.close();

  const term2 = new FakeAdapter(termOpts);
  const n2 = await makeNode(dir.path, [new FakeAdapter(), term2]);
  t.after(() => n2.close());
  assert.equal(n2.sessions.get(session.id).session.status, 'idle');
  await n2.call('session.send', { sessionId: session.id, input: text('x') });
  assert.deepEqual(term2.starts[0]?.command, ['claude', 'setup-token']);
  assert.equal(term2.starts[0]?.resumeRef, 'term-ref');
});

// --- MachineTarget and hello -------------------------------------------------------------------------

test('machineId: own id accepted, others not_found; hello reports role node', async (t) => {
  const { node, workspace } = await setup(t);
  const own = node.machine.id;
  assert.equal((await node.call('workspaces.list', { machineId: own })).workspaces.length, 1);
  assert.equal((await node.call('sessions.list', { machineId: own })).sessions.length, 0);
  await assert.rejects(node.call('workspaces.list', { machineId: 'm_other' }), rejectsWith('not_found'));
  await assert.rejects(node.call('sessions.list', { machineId: 'm_other', workspaceId: workspace.id }), rejectsWith('not_found'));
  await assert.rejects(node.call('agents.list', { machineId: 'm_other' }), rejectsWith('not_found'));
  await assert.rejects(node.call('workspace.create', { machineId: 'm_other', path: '/tmp' }), rejectsWith('not_found'));
  await assert.rejects(node.call('knowledge.list', { machineId: 'm_other' }), rejectsWith('not_found'));
  await assert.rejects(node.dispatch('workspaces.list', { machineId: 42 }), rejectsWith('bad_request'));
  // Unclaimed protocol methods still answer unsupported.
  await assert.rejects(node.call('knowledge.list', { machineId: own }), rejectsWith('unsupported'));

  const hello = await node.call('hello', { protocol: 'bizzi/1', client: { name: 't', version: '0' } });
  assert.equal(hello.role, 'node');
  assert.equal(hello.machine.id, own);
});

// --- extensions -----------------------------------------------------------------------------------

test('extensions: handlers, context, env provider, lifecycle and adapter dispose', async (t) => {
  const dir = tempDir();
  t.after(dir.cleanup);
  const fake = new FakeAdapter();
  let disposed = 0;
  (fake as FakeAdapter & { dispose(): Promise<void> }).dispose = async () => {
    disposed++;
  };
  const lifecycle: string[] = [];
  let ctxRef: ExtensionContext | undefined;
  const knowledge: NodeExtension = {
    methods: {
      'knowledge.list': (params: { query?: string }, ctx) => {
        assert.equal(ctx, ctxRef);
        return { items: [], echo: params.query };
      },
    },
    start(ctx) {
      ctxRef = ctx;
      lifecycle.push('start:knowledge');
      ctx.setAgentEnvProvider((agent) => ({ BIZZI_AGENT: agent, SHARED: 'knowledge' }));
    },
    stop() {
      lifecycle.push('stop:knowledge');
    },
  };
  let secretsCtx: ExtensionContext | undefined;
  const secrets: NodeExtension = {
    methods: {
      'agent.secrets': async () => ({ secrets: [] }),
      'agent.login': async (params: { workspaceId: string }, ctx) => {
        const { session } = await ctx.node.call('session.create', {
          workspaceId: params.workspaceId,
          agent: 'shell',
          command: ['fake-login'],
        });
        ctx.emitSession(session.id, { type: 'login.prompt', data: { urls: ['https://example.test/device'], codes: ['ABCD-1234'] } });
        return { session };
      },
    },
    async start(ctx) {
      secretsCtx = ctx;
      lifecycle.push('start:secrets');
      ctx.setAgentEnvProvider(async () => ({ ANTHROPIC_API_KEY: 'sk-test', SHARED: 'secrets' }));
    },
    stop() {
      lifecycle.push('stop:secrets');
    },
  };
  const shell = new FakeAdapter({ agent: 'shell', modes: ['terminal'] });
  const node = await createNode({
    dataDir: dir.path,
    adapters: [fake, shell],
    version: '0.0.0-test',
    extensions: [knowledge, secrets],
    prepareStart: () => ({ env: { FROM_PREPARE: '1', SHARED: 'prepare' } }),
  });
  assert.deepEqual(lifecycle, ['start:knowledge', 'start:secrets']);
  const { workspace } = await node.call('workspace.create', { path: dir.path + '/ws', create: true });

  assert.deepEqual(await node.call('knowledge.list', { query: 'auth' }), { items: [], echo: 'auth' });
  assert.deepEqual(await node.call('agent.secrets', { machineId: node.machine.id }), { secrets: [] });
  await assert.rejects(node.call('agent.plan', { agent: 'claude', action: 'install' }), rejectsWith('unsupported'));

  // Env: prepareStart, then providers in registration order (later wins).
  await idleSession(node, workspace.id);
  assert.deepEqual(fake.starts[0]?.env, { FROM_PREPARE: '1', SHARED: 'secrets', BIZZI_AGENT: 'claude', ANTHROPIC_API_KEY: 'sk-test' });

  // emitSession / emitGlobal.
  const { session: login } = await node.call('agent.login', { agent: 'claude', workspaceId: workspace.id });
  assert.deepEqual(shell.starts[0]?.command, ['fake-login']);
  const loginCh = record(node, sessionChannel(login.id));
  assert.deepEqual(loginCh.find('login.prompt')?.data.codes, ['ABCD-1234']);
  const global = record(node, GLOBAL_CHANNEL, node.bus.lastSeq(GLOBAL_CHANNEL));
  secretsCtx!.emitGlobal({ type: 'knowledge.changed', data: { ids: ['k_1'] } });
  assert.deepEqual(global.find('knowledge.changed')?.data, { ids: ['k_1'] });
  assert.throws(() => secretsCtx!.emitSession('s_missing', { type: 'login.completed', data: { ok: true } }), rejectsWith('not_found'));

  await node.close();
  assert.deepEqual(lifecycle, ['start:knowledge', 'start:secrets', 'stop:secrets', 'stop:knowledge']);
  assert.equal(disposed, 1);
  await node.close();
  assert.equal(disposed, 1);
});

test('extensions may not override built-ins, claim twice or claim unknown methods', async (t) => {
  const dir = tempDir();
  t.after(dir.cleanup);
  const make = (extensions: NodeExtension[]) => createNode({ dataDir: dir.path, adapters: [new FakeAdapter()], version: '0', extensions });

  for (const builtin of ['session.get', 'hello', 'session.fork', 'term.snapshot', 'question.respond'] as const) {
    await assert.rejects(make([{ methods: { [builtin]: () => ({}) } }]), rejectsWith('conflict'), builtin);
  }
  await assert.rejects(
    make([{ methods: { 'knowledge.add': () => ({}) } }, { methods: { 'knowledge.add': () => ({}) } }]),
    rejectsWith('conflict'),
  );
  await assert.rejects(make([{ methods: { 'nope.method': () => ({}) } as never }]), rejectsWith('bad_request'));
  await assert.rejects(make([{ methods: { subscribe: () => ({}) } as never }]), rejectsWith('bad_request'));

  // A failing start stops the extensions already started and leaves the data dir usable.
  const stopped: string[] = [];
  await assert.rejects(
    make([
      { methods: {}, stop: () => void stopped.push('a') },
      {
        methods: {},
        start: () => {
          throw new Error('no secrets store');
        },
        stop: () => void stopped.push('b'),
      },
    ]),
    /no secrets store/,
  );
  assert.deepEqual(stopped, ['a']);
  const ok = await make([]);
  await ok.close();
});
