// Identity colour and icon in the store (spec §11.1): workspace.updated, setWorkspace, setMachine { color }.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GLOBAL_CHANNEL } from '@bizzi/protocol';
import type { MachineInfo, WorkspaceInfo } from '@bizzi/protocol';
import { BizziClient, BizziStore, createManualScheduler } from '../src/index.ts';
import { FakeServer, waitFor } from './fake-server.ts';

const WS: WorkspaceInfo = { id: 'w_1', machineId: 'm_1', name: 'site', path: '/src/site', kind: 'git', createdAt: '2026-11-25T00:00:00Z' };

test('store: workspace.updated replaces the record; setWorkspace and setMachine apply the answer', async (t) => {
  const server = await FakeServer.start();
  server.handlers.set('workspaces.list', () => ({ workspaces: [WS] }));
  server.handlers.set('workspace.set', (p) => {
    const q = p as { workspaceId: string; color?: string; icon?: string };
    const next: WorkspaceInfo = { ...WS, name: 'Website' };
    if (q.color) next.color = q.color as WorkspaceInfo['color'] & string;
    if (q.icon) next.icon = q.icon;
    return { workspace: next };
  });
  server.handlers.set('machine.set', (p) => ({ machine: { ...server.helloMachine, tags: [], color: (p as { color?: string }).color || undefined } as MachineInfo }));
  const client = new BizziClient({ backoff: { baseMs: 10, maxMs: 20 }, requestTimeoutMs: 1000 });
  const scheduler = createManualScheduler();
  const store = new BizziStore(client, { scheduler });
  t.after(async () => {
    store.dispose();
    client.close();
    await server.stop();
  });
  await client.connect(server.url, 'secret');
  await waitFor(() => server.requests.some((r) => r.method === 'subscribe'));
  await new Promise((r) => setTimeout(r, 20));
  scheduler.flush();
  assert.equal(store.getState().workspaces?.['w_1']?.color, undefined);

  server.push(GLOBAL_CHANNEL, { type: 'workspace.updated', data: { workspace: { ...WS, color: 'teal', icon: '🚀' } } });
  await waitFor(() => (scheduler.flush(), store.getState().workspaces?.['w_1']?.color === 'teal'));
  assert.equal(store.getState().workspaces?.['w_1']?.icon, '🚀');

  const w = await store.setWorkspace({ workspaceId: 'w_1', color: 'pink' });
  scheduler.flush();
  assert.equal(w.color, 'pink');
  assert.equal(store.getState().workspaces?.['w_1']?.color, 'pink');
  assert.equal(store.getState().workspaces?.['w_1']?.icon, undefined, 'the answer is the whole record');

  const m = await store.setMachine({ color: 'blue' });
  scheduler.flush();
  assert.equal(m.color, 'blue');
  assert.equal(store.getState().machines[m.id]?.color, 'blue');
  const cleared = await store.setMachine({ color: '' });
  scheduler.flush();
  assert.equal('color' in cleared, false);
  assert.equal(store.getState().machines[m.id]?.color, undefined);
});
