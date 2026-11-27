import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sessionChannel, type ChannelEvent } from '@bizzi/protocol';
import { Store } from '../src/store.ts';
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

  // The terminal session can't resume (no agentSessionRef) but stays open: the next start is fresh.
  assert.equal(n2.sessions.get(term.id).session.status, 'idle');

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

test('sessions that cannot resume stay open after a restart and start over', async (t) => {
  const dir = tempDir();
  t.after(dir.cleanup);
  const opts = { capabilities: { resumeAfterNodeRestart: false } };
  const n1 = await makeNode(dir.path, [new FakeAdapter(opts)]);
  const { workspace } = await n1.call('workspace.create', { path: dir.path, create: true });
  const { session } = await n1.call('session.create', { workspaceId: workspace.id, agent: 'claude' });
  await waitFor(() => n1.sessions.get(session.id).session.status === 'idle');
  await n1.close();

  const fake2 = new FakeAdapter(opts);
  const n2 = await makeNode(dir.path, [fake2]);
  assert.equal(n2.sessions.get(session.id).session.status, 'idle');
  const ch = record(n2, sessionChannel(session.id), n2.sessions.get(session.id).session.lastSeq);
  await n2.call('session.send', { sessionId: session.id, input: [{ type: 'text', text: 'hi' }] });
  await ch.waitFor('turn.completed');
  assert.equal(fake2.starts.length, 1);
  assert.equal(fake2.starts[0]?.resumeRef, undefined);

  // Without any adapter for the agent the session stays open too; sending fails until one is back.
  await n2.close();
  const n3 = await makeNode(dir.path, []);
  t.after(() => n3.close());
  assert.equal(n3.sessions.get(session.id).session.status, 'idle');
  await assert.rejects(n3.call('session.send', { sessionId: session.id, input: [{ type: 'text', text: 'hi' }] }), /no adapter/);
  assert.equal(n3.sessions.get(session.id).session.status, 'idle');
});

test('a closed session stays ended after a restart; one that ended without being closed reopens', async (t) => {
  const dir = tempDir();
  t.after(dir.cleanup);
  const n1 = await makeNode(dir.path, [new FakeAdapter()]);
  const { workspace } = await n1.call('workspace.create', { path: dir.path, create: true });
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const { session } = await n1.call('session.create', { workspaceId: workspace.id, agent: 'claude' });
    ids.push(session.id);
    await waitFor(() => n1.sessions.get(session.id).session.status === 'idle');
    await n1.call('session.send', { sessionId: session.id, input: [{ type: 'text', text: 'hello' }] });
    await waitFor(() => n1.sessions.get(session.id).session.status === 'idle' && n1.sessions.get(session.id).session.agentSessionRef);
  }
  const [closed, legacyStopped, legacyEnded] = ids as [string, string, string];
  await n1.call('session.stop', { sessionId: closed });
  await n1.call('session.stop', { sessionId: legacyStopped });
  const ref = n1.sessions.get(legacyEnded).session.agentSessionRef;
  await n1.close();

  // What older versions left behind: no `closed` marker, and a session ended by shutting down.
  const store = new Store(dir.path);
  for (const row of store.listSessions()) {
    if (row.info.id === legacyStopped) store.putSession({ info: row.info, state: { ...row.state, closed: undefined } });
    if (row.info.id === legacyEnded) {
      const ch = sessionChannel(legacyEnded);
      store.insertEvent({ ch, seq: store.maxSeq(ch) + 1, ts: new Date().toISOString(), type: 'session.status', data: { status: 'ended' } } as ChannelEvent);
      store.putSession({ info: { ...row.info, status: 'ended' }, state: row.state });
    }
  }
  store.close();

  const fake2 = new FakeAdapter();
  const n2 = await makeNode(dir.path, [fake2]);
  t.after(() => n2.close());
  assert.equal(n2.sessions.get(closed).session.status, 'ended');
  assert.equal(n2.sessions.get(legacyStopped).session.status, 'ended');
  assert.equal(n2.sessions.get(legacyEnded).session.status, 'idle');
  await assert.rejects(n2.call('session.send', { sessionId: closed, input: [{ type: 'text', text: 'hi' }] }), /session has ended/);
  const ch = record(n2, sessionChannel(legacyEnded));
  await n2.call('session.send', { sessionId: legacyEnded, input: [{ type: 'text', text: 'again' }] });
  await ch.waitFor('turn.completed', (e) => e.data.stopReason === 'end_turn');
  assert.equal(fake2.starts[0]?.resumeRef, ref);

  // A closed session reopens on request, resumes its conversation, and stays open across the next restart.
  const closedRef = n2.sessions.get(closed).session.agentSessionRef;
  const { session: reopened } = await n2.call('session.reopen', { sessionId: closed });
  assert.equal(reopened.status, 'idle');
  const chClosed = record(n2, sessionChannel(closed));
  await n2.call('session.send', { sessionId: closed, input: [{ type: 'text', text: 'back again' }] });
  await chClosed.waitFor('turn.completed', (e) => e.data.stopReason === 'end_turn');
  assert.equal(fake2.starts.at(-1)?.resumeRef, closedRef);
  await n2.close();
  const n3 = await makeNode(dir.path, [new FakeAdapter()]);
  t.after(() => n3.close());
  assert.equal(n3.sessions.get(closed).session.status, 'idle');
});
