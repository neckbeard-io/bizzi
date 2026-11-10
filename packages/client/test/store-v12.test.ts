import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { GLOBAL_CHANNEL, NO_CAPABILITIES } from '@bizzi/protocol';
import type { AccountUsage, SessionInfo } from '@bizzi/protocol';
import { BizziClient, BizziStore, createManualScheduler, selectWorkspaceRow } from '../src/index.ts';
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
  lastSeq: 7,
  seenThrough: 3,
};

const ACCOUNT: AccountUsage = {
  agent: 'claude',
  accountId: 'dev@example.com',
  label: 'claude · max · dev@…',
  billing: 'plan',
  machines: ['m_1'],
  windows: [{ id: 'five_hour', label: '5-hour', usedPercent: 62 }],
  status: 'ok',
  observedAt: '2026-11-10T09:00:00Z',
};

async function setup(t: TestContext, configure: (server: FakeServer) => void = () => {}) {
  const server = await FakeServer.start();
  server.handlers.set('sessions.list', () => ({ sessions: [SESSION] }));
  server.handlers.set('session.get', () => ({ session: SESSION, capabilities: NO_CAPABILITIES }));
  configure(server);
  const client = new BizziClient({ backoff: { baseMs: 10, maxMs: 20 }, requestTimeoutMs: 1000 });
  const scheduler = createManualScheduler();
  const store = new BizziStore(client, { scheduler });
  t.after(async () => {
    store.dispose();
    client.close();
    await server.stop();
  });
  await client.connect(server.url, 'secret');
  const until = (cond: () => boolean): Promise<void> =>
    waitFor(() => {
      scheduler.flush();
      return cond();
    });
  await until(() => store.getState().sessionsLoaded);
  return { server, store, until };
}

test('usage.list unsupported: usageState says so; account.usage events still fill the meters (newest wins)', async (t) => {
  const { server, store, until } = await setup(t);
  await until(() => store.getState().usageState === 'unsupported');
  server.push(GLOBAL_CHANNEL, { type: 'account.usage', data: { usage: ACCOUNT } });
  await until(() => Object.keys(store.getState().accounts).length === 1);
  // An older snapshot from another machine only adds that machine.
  server.push(GLOBAL_CHANNEL, { type: 'account.usage', data: { usage: { ...ACCOUNT, machines: ['m_2'], observedAt: '2026-11-10T08:00:00Z', windows: [] } } });
  await until(() => (store.getState().accounts['claude:dev@example.com']?.machines.length ?? 0) === 2);
  assert.equal(store.getState().accounts['claude:dev@example.com']?.windows?.[0]?.usedPercent, 62);
});

test('usage.list and widgets.list load on connect; widget events update and remove', async (t) => {
  const { server, store, until } = await setup(t, (s) => {
    s.handlers.set('usage.list', () => ({ accounts: [ACCOUNT] }));
    s.handlers.set('widgets.list', () => ({ widgets: [{ id: 'litellm', machineId: 'm_1', label: 'billed', kind: 'meter', placement: ['bar'], value: 1, max: 10 }] }));
  });
  await until(() => store.getState().usageState === 'ok' && Object.keys(store.getState().widgets).length === 1);
  server.push(GLOBAL_CHANNEL, { type: 'widget.updated', data: { widget: { id: 'litellm', machineId: 'm_1', label: 'billed', kind: 'meter', placement: ['bar'], value: 5, max: 10 } } });
  await until(() => store.getState().widgets['m_1:litellm']?.value === 5);
  server.push(GLOBAL_CHANNEL, { type: 'widget.removed', data: { machineId: 'm_1', widgetId: 'litellm' } });
  await until(() => Object.keys(store.getState().widgets).length === 0);
});

test('markSeen: applied locally, one request in flight, never backwards', async (t) => {
  const { server, store, until } = await setup(t, (s) => {
    s.handlers.set('session.markSeen', (p) => ({ seenThrough: p.seq as number }));
  });
  assert.equal(selectWorkspaceRow(store.getState(), 'w_1').marks[0]?.state, 'done');
  store.markSeen('s_1');
  store.flush();
  assert.equal(store.getState().sessions.s_1?.seenThrough, 7);
  assert.equal(selectWorkspaceRow(store.getState(), 'w_1').marks[0]?.state, 'idle');
  await until(() => server.requests.some((r) => r.method === 'session.markSeen'));
  // Going backwards is a no-op.
  store.markSeen('s_1', 2);
  // A list refresh with an older cursor doesn't move it back either.
  server.push(GLOBAL_CHANNEL, { type: 'session.updated', data: { session: { ...SESSION, seenThrough: 1 } } });
  await new Promise((r) => setTimeout(r, 30));
  store.flush();
  assert.equal(store.getState().sessions.s_1?.seenThrough, 7);
  assert.equal(server.requests.filter((r) => r.method === 'session.markSeen').length, 1);
});

test('markSeen on a server without it keeps the local cursor and stops asking', async (t) => {
  const { server, store } = await setup(t);
  store.markSeen('s_1', 5);
  await new Promise((r) => setTimeout(r, 30));
  store.markSeen('s_1', 6);
  await new Promise((r) => setTimeout(r, 30));
  store.flush();
  assert.equal(store.getState().sessions.s_1?.seenThrough, 6);
  assert.equal(server.requests.filter((r) => r.method === 'session.markSeen').length, 1);
});

test('session.restarted updates the session agentVersion; worktrees and git status land in the store', async (t) => {
  const { server, store, until } = await setup(t, (s) => {
    s.handlers.set('worktree.create', (p) => ({ workspace: { id: 'w_wt', machineId: 'm_1', name: 'wt', path: '/x', kind: 'worktree', parentWorkspaceId: p.workspaceId, branch: p.branch, createdAt: '2026-11-10T00:00:00Z' } }));
    s.handlers.set('worktree.remove', () => ({}));
    s.handlers.set('git.status', () => ({ isRepo: true, branch: 'main', ahead: 2, behind: 0, files: [{ path: 'a', status: ' M' }] }));
  });
  await store.openSession('s_1');
  server.push('session:s_1', { type: 'session.restarted', data: { fromVersion: '1', toVersion: '2', ok: true } });
  await until(() => store.getState().sessions.s_1?.agentVersion === '2');

  const w = await store.createWorktree({ workspaceId: 'w_1', branch: 'feat/x' });
  assert.equal(store.getState().workspaces?.[w.id]?.parentWorkspaceId, 'w_1');
  await store.loadGitStatus('w_wt');
  store.flush();
  assert.deepEqual({ ...store.getState().gitStatus.w_wt, loadedAt: 0 }, { isRepo: true, branch: 'main', ahead: 2, behind: 0, dirty: true, loadedAt: 0 });
  await store.removeWorktree('w_wt', true);
  store.flush();
  assert.equal(store.getState().workspaces?.w_wt, undefined);
  assert.deepEqual(server.requests.find((r) => r.method === 'worktree.remove')?.params, { workspaceId: 'w_wt', force: true });
});
