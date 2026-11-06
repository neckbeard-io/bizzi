import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sessionChannel } from '@bizzi/protocol';
import { FakeAdapter } from '../src/testing/index.ts';
import { makeNode, record, tempDir, waitFor } from './helpers.ts';

test('sessions, workspaces and events survive a restart; resumable sessions resume lazily', async (t) => {
  const dir = tempDir();
  t.after(dir.cleanup);

  // --- first run
  const fake1 = new FakeAdapter();
  const shell1 = new FakeAdapter({ agent: 'shell', modes: ['terminal'] });
  const n1 = await makeNode(dir.path, [fake1, shell1]);
  const { workspace } = await n1.call('workspace.create', { path: dir.path + '/ws', create: true, name: 'proj' });
  const { session } = await n1.call('session.create', { workspaceId: workspace.id, agent: 'claude' });
  const { session: term } = await n1.call('session.create', { workspaceId: workspace.id, agent: 'shell' });
  const { session: busy } = await n1.call('session.create', { workspaceId: workspace.id, agent: 'claude' });
  await waitFor(() => n1.sessions.list().every((s) => s.status === 'idle'));
  const ch = record(n1, sessionChannel(session.id));
  await n1.call('session.send', { sessionId: session.id, input: [{ type: 'text', text: 'hello' }] });
  await ch.waitFor('turn.completed');
  const busyTurn = await n1.call('session.send', { sessionId: busy.id, input: [{ type: 'text', text: '/approve deploy' }] });
  await waitFor(() => n1.sessions.get(busy.id).session.status === 'waiting_approval');
  const ref = n1.sessions.get(session.id).session.agentSessionRef;
  assert.ok(ref);
  const before = n1.bus.replay(sessionChannel(session.id));
  await n1.close();
  // The in-flight turn was closed on shutdown.
  assert.ok(fake1.sessions.every((s) => s.stopped));

  // --- second run
  const fake2 = new FakeAdapter();
  const shell2 = new FakeAdapter({ agent: 'shell', modes: ['terminal'] });
  const n2 = await makeNode(dir.path, [fake2, shell2]);
  t.after(() => n2.close());
  assert.equal((await n2.call('workspaces.list', {})).workspaces[0]?.name, 'proj');

  const s = n2.sessions.get(session.id).session;
  assert.equal(s.status, 'idle');
  assert.equal(s.agentSessionRef, ref);
  assert.deepEqual(n2.bus.replay(sessionChannel(session.id)).slice(0, before.length), before);
  assert.equal(s.lastSeq, n2.bus.lastSeq(sessionChannel(session.id)));

  // Terminal session has no agentSessionRef → ended.
  assert.equal(n2.sessions.get(term.id).session.status, 'ended');

  // The session that was mid-approval has its turn closed and is resumable.
  const busyEvents = n2.bus.replay(sessionChannel(busy.id));
  const closed = busyEvents.filter((e) => e.type === 'turn.completed');
  assert.equal(closed.length, 1);
  assert.equal((closed[0]?.data as { turnId: string }).turnId, busyTurn.turnId);
  assert.equal(n2.sessions.get(busy.id).session.status, 'idle');

  // No adapter was started until the next send, which resumes with the stored ref.
  assert.equal(fake2.starts.length, 0);
  const ch2 = record(n2, sessionChannel(session.id), s.lastSeq);
  await n2.call('session.send', { sessionId: session.id, input: [{ type: 'text', text: 'again' }] });
  await ch2.waitFor('turn.completed');
  assert.equal(fake2.starts.length, 1);
  assert.equal(fake2.starts[0]?.resumeRef, ref);
  assert.equal(ch2.events[0]?.seq, s.lastSeq + 1);
});

test('non-resumable sessions end after a restart', async (t) => {
  const dir = tempDir();
  t.after(dir.cleanup);
  const opts = { capabilities: { resumeAfterNodeRestart: false } };
  const n1 = await makeNode(dir.path, [new FakeAdapter(opts)]);
  const { workspace } = await n1.call('workspace.create', { path: dir.path, create: true });
  const { session } = await n1.call('session.create', { workspaceId: workspace.id, agent: 'claude' });
  await waitFor(() => n1.sessions.get(session.id).session.status === 'idle');
  await n1.close();

  const n2 = await makeNode(dir.path, [new FakeAdapter(opts)]);
  t.after(() => n2.close());
  assert.equal(n2.sessions.get(session.id).session.status, 'ended');

  // Without any adapter for the agent, sessions also end.
  await n2.close();
  const n3 = await makeNode(dir.path, []);
  t.after(() => n3.close());
  assert.equal(n3.sessions.get(session.id).session.status, 'ended');
});
