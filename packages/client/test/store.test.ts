import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { NO_CAPABILITIES as NO_SESSION, sessionChannel } from '@bizzi/protocol';
import type { SessionInfo } from '@bizzi/protocol';
import { BizziClient, BizziStore, createManualScheduler, selectInbox } from '../src/index.ts';
import { FakeServer, waitFor } from './fake-server.ts';

const SESSION: SessionInfo = {
  id: 's_1',
  machineId: 'm_1',
  workspaceId: 'w_1',
  agent: 'claude',
  mode: 'structured',
  status: 'idle',
  createdAt: '2026-11-05T00:00:00Z',
  updatedAt: '2026-11-05T00:00:00Z',
  lastSeq: 0,
};

async function setup(t: TestContext) {
  const server = await FakeServer.start();
  server.handlers.set('sessions.list', () => ({ sessions: [SESSION] }));
  server.handlers.set('session.get', () => ({ session: SESSION, capabilities: NO_SESSION }));
  const client = new BizziClient({ backoff: { baseMs: 10, maxMs: 20 }, requestTimeoutMs: 1000 });
  const scheduler = createManualScheduler();
  const store = new BizziStore(client, { scheduler });
  t.after(async () => {
    store.dispose();
    client.close();
    await server.stop();
  });
  await client.connect(server.url, 'secret');
  await waitFor(() => server.requests.some((r) => r.method === 'sessions.list'));
  await new Promise((r) => setTimeout(r, 20));
  scheduler.flush();
  return { server, client, store, scheduler };
}

test('store loads lists after the handshake and subscribes to global', async (t) => {
  const { server, store } = await setup(t);
  const s = store.getState();
  assert.equal(s.connection.state, 'open');
  assert.equal(s.machine?.id, 'm_1');
  assert.equal(s.sessions['s_1']?.agent, 'claude');
  assert.ok(s.workspaces);
  assert.ok(server.requests.some((r) => r.method === 'subscribe' && (r.params as { ch: string }).ch === 'global'));
});

test('frame batching: many deltas → one notification; unrelated selectors stay stable', async (t) => {
  const { server, store, scheduler } = await setup(t);
  await store.openSession('s_1');
  scheduler.flush();
  const ch = sessionChannel('s_1');
  server.push(ch, { type: 'turn.started', data: { turnId: 't_1', input: [{ type: 'text', text: 'hi' }] } });
  server.push(ch, { type: 'message.delta', data: { messageId: 'a', role: 'assistant', text: 'A' } });
  server.push(ch, { type: 'message.completed', data: { messageId: 'a', role: 'assistant', text: 'A done' } });
  await waitFor(() => store.client.lastSeq(ch) === 3);
  scheduler.flush();

  const rowA = store.select((s) => s.timelines['s_1']?.items['msg:a']);
  const order = store.select((s) => s.timelines['s_1']?.order);
  const firstA = rowA.getSnapshot();
  const firstOrder = order.getSnapshot();
  assert.ok(firstA);

  let notified = 0;
  store.subscribe(() => notified++);
  server.push(ch, { type: 'message.delta', data: { messageId: 'b', role: 'assistant', text: 'x' } });
  for (let i = 0; i < 199; i++) server.push(ch, { type: 'message.delta', data: { messageId: 'b', role: 'assistant', text: 'x' } });
  await waitFor(() => store.client.lastSeq(ch) === 203);
  assert.equal(notified, 0, 'nothing is notified before the frame');
  assert.equal(scheduler.pending, 1, 'exactly one frame is scheduled');
  scheduler.flush();
  assert.equal(notified, 1, 'one notification for 200 deltas');
  const b = store.getState().timelines['s_1']?.items['msg:b'];
  assert.ok(b?.kind === 'message' && b.text.length === 200);
  assert.equal(rowA.getSnapshot(), firstA, 'row A did not change');
  assert.notEqual(order.getSnapshot(), firstOrder, 'order changed (new item)');

  // A further delta to b leaves both row A and the order untouched.
  const orderAfter = order.getSnapshot();
  server.push(ch, { type: 'message.delta', data: { messageId: 'b', role: 'assistant', text: 'y' } });
  await waitFor(() => store.client.lastSeq(ch) === 204);
  scheduler.flush();
  assert.equal(order.getSnapshot(), orderAfter);
  assert.equal(rowA.getSnapshot(), firstA);
});

test('terminal output bypasses the store', async (t) => {
  const { server, store, scheduler } = await setup(t);
  await store.openSession('s_1');
  scheduler.flush();
  const chunks: string[] = [];
  store.terminal.subscribe('s_1', (c) => chunks.push(new TextDecoder().decode(c)));
  const v = store.getState().version;
  server.push(sessionChannel('s_1'), { type: 'term.output', data: { dataBase64: Buffer.from('hello').toString('base64') } });
  await waitFor(() => chunks.length === 1);
  assert.equal(chunks[0], 'hello');
  assert.equal(scheduler.pending, 0);
  assert.equal(store.getState().version, v);
});

test('inbox collects pending approvals, and sessions waiting for approval are watched automatically', async (t) => {
  const { server, store, scheduler } = await setup(t);
  const ch = sessionChannel('s_2');
  server.push(ch, { type: 'turn.started', data: { turnId: 't', input: [] } }, { send: false });
  server.push(ch, { type: 'approval.requested', data: { approvalId: 'ap_9', kind: 'shell', title: 'rm -rf build', editable: false, options: ['allow', 'deny'] } }, { send: false });
  server.handlers.set('session.get', (p) => ({ session: { ...SESSION, id: p.sessionId, status: 'waiting_approval' }, capabilities: NO_SESSION }));
  server.push('global', { type: 'session.updated', data: { session: { ...SESSION, id: 's_2', status: 'waiting_approval' } } });
  // The global event is applied at the next frame; that triggers the subscription to s_2.
  await waitFor(() => {
    scheduler.flush();
    return store.client.lastSeq(ch) === 2;
  });
  scheduler.flush();
  const inbox = selectInbox(store.getState());
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0]?.sessionId, 's_2');
  assert.equal(inbox[0]?.item.kind, 'approval');
});

test('install jobs that finished before the client connected are not brought back by the replay', async (t) => {
  const server = await FakeServer.start();
  const client = new BizziClient({ backoff: { baseMs: 10, maxMs: 20 }, requestTimeoutMs: 1000 });
  const scheduler = createManualScheduler();
  const store = new BizziStore(client, { scheduler });
  t.after(async () => {
    store.dispose();
    client.close();
    await server.stop();
  });
  // History from before this client: a finished update, a detected version change, and an install still running.
  server.push('global', { type: 'install.progress', data: { agent: 'codex', jobId: 'job_old', stage: 'install', step: 1, total: 2 } });
  server.push('global', { type: 'install.progress', data: { agent: 'codex', jobId: 'job_old', stage: 'done', step: 2, total: 2, done: true, ok: true } });
  server.push('global', { type: 'install.progress', data: { agent: 'codex', jobId: 'watch_1', stage: 'detected', message: 'codex 0.1 → 0.2 installed', done: true, ok: true } });
  server.push('global', { type: 'install.progress', data: { agent: 'opencode', jobId: 'job_run', stage: 'install', step: 1, total: 2 } });
  await client.connect(server.url, 'secret');
  await waitFor(() => client.lastSeq('global') === 4 && client.replayEnd('global') === 4);
  scheduler.flush();
  assert.deepEqual(Object.keys(store.getState().jobs), ['job_run']);

  // Live events still show: the running job finishing, and a new detection.
  server.push('global', { type: 'install.progress', data: { agent: 'opencode', jobId: 'job_run', stage: 'done', step: 2, total: 2, done: true, ok: true } });
  server.push('global', { type: 'install.progress', data: { agent: 'codex', jobId: 'watch_2', stage: 'detected', message: 'codex 0.2 → 0.3 installed', done: true, ok: true } });
  await waitFor(() => client.lastSeq('global') === 6);
  scheduler.flush();
  const jobs = store.getState().jobs;
  assert.deepEqual(Object.keys(jobs).sort(), ['job_run', 'watch_2']);
  assert.equal(jobs.job_run?.done, true);
  assert.equal(jobs.job_run?.log.length, 2);
});
