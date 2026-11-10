import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { BizziError } from '@bizzi/protocol';
import { BizziClient, BizziStore, createManualScheduler } from '@bizzi/client';
import { MockCore, createMockSocketFactory } from '../src/mock/mockServer.ts';

async function connect(t: TestContext) {
  const core = new MockCore({ speed: 0, autoplay: false });
  const client = new BizziClient({ createSocket: createMockSocketFactory(core) });
  const store = new BizziStore(client, { scheduler: createManualScheduler() });
  t.after(() => {
    store.dispose();
    client.close();
    core.dispose();
  });
  await client.connect('mock://local', 'demo');
  return store;
}

test('mock fs.browse / fs.complete / fs.suggest', async (t) => {
  const store = await connect(t);
  const home = await store.browseDirs({ machineId: 'm_laptop' });
  assert.equal(home.path, '/Users/dev');
  assert.ok(home.entries.some((e) => e.name === 'src') && !home.entries.some((e) => e.hidden));
  const src = await store.browseDirs({ machineId: 'm_laptop', path: '~/src' });
  const acme = src.entries.find((e) => e.name === 'acme-shop');
  assert.ok(acme?.git && acme.workspaceId === 'w_acme');
  assert.equal(src.parent, '/Users/dev');
  assert.ok((await store.browseDirs({ machineId: 'm_laptop', showHidden: true })).entries.some((e) => e.name === '.config' && e.hidden));

  const done = await store.completePath({ machineId: 'm_laptop', prefix: '~/src/a' });
  assert.equal(done.base, '~/src/');
  assert.deepEqual(done.completions.map((e) => e.name), ['acme-shop', 'acme-shop.worktrees', 'api-gateway']);
  // Case-insensitive like macOS, exact case first.
  assert.deepEqual((await store.completePath({ machineId: 'm_laptop', prefix: '~/src/d' })).completions.map((e) => e.name), ['design-system', 'Data-Pipelines']);
  assert.deepEqual((await store.completePath({ machineId: 'm_laptop', prefix: '~/nope/x' })).completions, []);

  const { entries } = await store.suggestDirs('m_laptop');
  assert.equal(entries[0]?.suggest, 'home');
  assert.ok(entries.some((e) => e.suggest === 'root' && e.name === 'src'));
  assert.ok(entries.some((e) => e.suggest === 'recent' && e.path === '/Users/dev/research'));
  assert.ok(entries.some((e) => e.suggest === 'repo' && e.name === 'website'));
  assert.ok(!entries.some((e) => e.suggest === 'repo' && e.name === 'acme-shop'));

  await assert.rejects(store.browseDirs({ machineId: 'm_laptop', path: '~/private' }), (e: unknown) => e instanceof BizziError && /permission denied/.test(e.message));
  await assert.rejects(store.browseDirs({ machineId: 'm_server' }), (e: unknown) => e instanceof BizziError && e.code === 'machine_offline');

  // workspace.create: an existing repo becomes a git workspace; a missing path needs create.
  const ws = await store.createWorkspace({ machineId: 'm_laptop', path: '/Users/dev/src/website' });
  assert.equal(ws.kind, 'git');
  assert.equal((await store.browseDirs({ machineId: 'm_laptop', path: '~/src' })).entries.find((e) => e.name === 'website')?.workspaceId, ws.id);
  await assert.rejects(store.createWorkspace({ machineId: 'm_laptop', path: '/Users/dev/src/brand-new' }), (e: unknown) => e instanceof BizziError && e.code === 'not_found');
  const made = await store.createWorkspace({ machineId: 'm_laptop', path: '/Users/dev/src/brand-new', create: true });
  assert.equal(made.kind, 'dir');
  assert.ok((await store.browseDirs({ machineId: 'm_laptop', path: '~/src' })).entries.some((e) => e.name === 'brand-new'));
});
