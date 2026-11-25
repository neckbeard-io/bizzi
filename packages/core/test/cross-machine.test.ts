// Cross-machine building blocks that don't need a hub (spec §5.4, §12.4): the hub port, remote URL
// normalization, budget arithmetic, remote spend in the tree, and the remote-helper records surviving a
// node restart. The end-to-end flows run against a real hub in apps/cli/test/cross-machine.test.ts.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { BizziError, type SessionInfo } from '@bizzi/protocol';
import { HubPort, minBudget, normalizeRemoteUrl } from '../src/index.ts';
import { makeNode, tempDir } from './helpers.ts';

test('HubPort: machine_offline without a link, unsupported with an old hub, requests through the transport', async () => {
  const port = new HubPort();
  const states: string[] = [];
  port.onChange((s) => states.push(s));
  await assert.rejects(port.request('machines.list', {}), (e: unknown) => e instanceof BizziError && e.code === 'machine_offline');
  port.markUnsupported();
  await assert.rejects(port.request('machines.list', {}), (e: unknown) => e instanceof BizziError && e.code === 'unsupported');
  const seen: unknown[] = [];
  const t = { request: async (method: string, params: unknown, timeoutMs: number) => (seen.push([method, params, timeoutMs]), { ok: true }) };
  port.attach(t);
  assert.equal(port.connected, true);
  assert.deepEqual(await port.request('machines.list', { a: 1 }, { timeoutMs: 5 }), { ok: true });
  assert.deepEqual(seen, [['machines.list', { a: 1 }, 5]]);
  port.detach({ request: async () => ({}) });
  assert.equal(port.connected, true, 'a stale transport does not detach the current one');
  port.detach(t);
  assert.deepEqual(states, ['unsupported', 'connected', 'disconnected']);
});

test('normalizeRemoteUrl: one identity for the same repository however it was cloned', () => {
  const same = ['git@github.com:Acme/App.git', 'https://github.com/acme/app', 'https://user@github.com/Acme/app.git/', 'ssh://git@github.com:22/acme/app.git'];
  for (const u of same) assert.equal(normalizeRemoteUrl(u), 'github.com/acme/app', u);
  assert.equal(normalizeRemoteUrl('/srv/git/App.git'), '/srv/git/App');
  assert.notEqual(normalizeRemoteUrl('git@github.com:acme/other.git'), 'github.com/acme/app');
});

test('minBudget takes the stricter value per field', () => {
  assert.equal(minBudget(undefined, undefined), undefined);
  assert.deepEqual(minBudget({ turns: 5 }, undefined), { turns: 5 });
  assert.deepEqual(minBudget(undefined, { usd: 1 }), { usd: 1 });
  assert.deepEqual(minBudget({ turns: 5, usd: 3 }, { turns: 2, tokens: 100 }), { usd: 3, tokens: 100, turns: 2 });
});

test('remainingBudget and remote spend: what a remote helper may use, and its spend in the tree', async (t) => {
  const tmp = tempDir();
  t.after(() => tmp.cleanup());
  const dataDir = join(tmp.path, 'data');
  let node = await makeNode(dataDir);
  const { workspace } = await node.call('workspace.create', { path: join(tmp.path, 'ws'), create: true });
  const { session } = await node.call('session.create', { workspaceId: workspace.id, agent: 'claude', budget: { turns: 4, tokens: 1000 } });
  assert.deepEqual(node.sessions.remainingBudget(session.id), { tokens: 1000, turns: 4 });
  node.sessions.recordRemoteSpent(session.id, 's_remote', { usd: 0, tokens: 300, turns: 3 });
  assert.deepEqual(node.sessions.spent(session.id).tree, { usd: 0, tokens: 300, turns: 3 });
  assert.deepEqual(node.sessions.remainingBudget(session.id), { tokens: 700, turns: 1 });
  node.sessions.recordRemoteSpent(session.id, 's_remote', { usd: 0, tokens: 400, turns: 4 });
  assert.match(node.sessions.overBudget(session.id) ?? '', /4\/4 turns/);

  // Persisted with the session.
  await node.close();
  node = await makeNode(dataDir);
  t.after(() => node.close());
  assert.deepEqual(node.sessions.spent(session.id).tree, { usd: 0, tokens: 400, turns: 4 });
});

test('a helper whose parent is on another machine: no local parent needed, the parent mode still caps it', async (t) => {
  const tmp = tempDir();
  const node = await makeNode(join(tmp.path, 'data'));
  t.after(async () => {
    await node.close();
    tmp.cleanup();
  });
  const { workspace } = await node.call('workspace.create', { path: join(tmp.path, 'ws'), create: true });
  const caller = { machineId: 'm_laptop' };
  const r = (await node.dispatch('helper.start', {
    caller,
    parent: { sessionId: 's_parent_elsewhere', agent: 'claude', permissionMode: 'plan', depth: 0 },
    request: { agent: 'claude', prompt: 'look around', permissionMode: 'bypassPermissions' },
  })) as { session: SessionInfo; notes: string[] };
  assert.equal(r.session.workspaceId, workspace.id, 'the only workspace is the default');
  assert.equal(r.session.spawnedBy, 's_parent_elsewhere');
  assert.equal(r.session.spawnedByMachineId, 'm_laptop');
  assert.equal(r.session.permissionMode, 'plan');
  await assert.rejects(node.call('session.set', { sessionId: r.session.id, permissionMode: 'acceptEdits' }), (e: unknown) => e instanceof BizziError && e.code === 'conflict');
  // Local sessions can't drive it as if they were its parent; only the caller's machine can.
  await assert.rejects(
    node.dispatch('helper.stop', { caller: { machineId: 'm_other' }, sessionId: r.session.id, parentId: 's_parent_elsewhere' }),
    (e: unknown) => e instanceof BizziError && e.code === 'not_found',
  );
  await node.dispatch('helper.stop', { caller, sessionId: r.session.id, parentId: 's_parent_elsewhere' });
  assert.equal(node.sessions.get(r.session.id).session.status, 'ended');
  // Depth beyond this machine's limit is refused.
  await assert.rejects(
    node.dispatch('helper.start', { caller, parent: { sessionId: 's_p', agent: 'claude', depth: 2 }, request: { agent: 'claude', prompt: 'x' } }),
    (e: unknown) => e instanceof BizziError && e.code === 'conflict' && /depth limit/.test(e.message),
  );
});
