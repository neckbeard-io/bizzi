import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { FakeAdapter } from '@bizzi/core/testing';
import { KnowledgeStore, addKnowledge, claudeMemoryDir } from '@bizzi/knowledge';
import { BizziError, type KnowledgeItemInfo } from '@bizzi/protocol';
import { createKnowledgeExtension, type KnowledgeExtension } from '../src/index.ts';
import { harness, tempDir, waitFor, type Harness } from './helpers.ts';

const isCode = (c: string) => (e: unknown) => e instanceof BizziError && e.code === c;

async function setup(opts: { pollMs?: number; claudeHome?: string; adapters?: FakeAdapter[]; watch?: boolean } = {}) {
  let store: KnowledgeStore | undefined;
  const opened: string[] = [];
  const ext = createKnowledgeExtension({
    // Lazily opened for the node's machine id, like the CLI's shared store.
    store: (machineId) => {
      opened.push(machineId);
      store ??= new KnowledgeStore({ path: ':memory:', machineId });
      return store;
    },
    pollMs: opts.pollMs ?? 0,
    // Never the real ~/.claude in tests.
    claudeHome: opts.claudeHome ?? join(tempDir(), '.claude'),
    watch: opts.watch ?? false,
    watchDebounceMs: 20,
  });
  const h = await harness({ extensions: [ext], ...(opts.adapters ? { adapters: opts.adapters } : {}) });
  after(() => h.close());
  return { ext, h, opened, store: () => store! };
}

function changedIds(h: Harness): string[][] {
  return h.global.filter((e) => e.type === 'knowledge.changed').map((e) => (e.data as { ids: string[] }).ids);
}

describe('knowledge extension', () => {
  it('tag scope: added by you with a valid tag, listed by level', async () => {
    const { ext, h } = await setup();
    const { item } = await h.call(ext, 'knowledge.add', {
      type: 'rule',
      title: 'Prod clusters: read-only kubectl',
      body: 'Always pass --context.',
      scope: { level: 'tag', tag: 'prod-access' },
    });
    assert.deepEqual(item.scope, { level: 'tag', tag: 'prod-access' });
    assert.equal(item.status, 'active');
    const { items } = await h.call(ext, 'knowledge.list', { scopeLevel: 'tag' });
    assert.deepEqual(items.map((i: KnowledgeItemInfo) => i.id), [item.id]);
    for (const tag of [undefined, '', 'Has Space', 'UPPER']) {
      await assert.rejects(h.call(ext, 'knowledge.add', { type: 'rule', title: 'x', body: '', scope: { level: 'tag', tag } }), isCode('bad_request'));
    }
  });

  it('add / list / update / forget through the methods, emitting knowledge.changed', async () => {
    const { ext, h, opened } = await setup();
    const machineId = h.node.machine.id;

    const { item: rule } = await h.call(ext, 'knowledge.add', {
      type: 'rule',
      title: 'Use pnpm',
      body: 'Always use pnpm, never npm.',
      scope: { level: 'global' },
      appliesTo: ['claude', 'codex'],
    });
    assert.deepEqual(opened, [machineId]);
    assert.match(rule.id, /^k_/);
    assert.equal(rule.status, 'active', 'your own writes go live');
    assert.deepEqual(rule.source, { machineId, via: 'ui' });
    assert.deepEqual(rule.appliesTo, ['claude', 'codex']);
    assert.deepEqual(rule.scope, { level: 'global' });
    assert.deepEqual(changedIds(h), [[rule.id]]);

    const { item: mem } = await h.call(ext, 'knowledge.add', {
      type: 'memory',
      kind: 'gotcha',
      title: 'Staging DB port',
      body: 'Staging Postgres listens on 6543.',
      scope: { level: 'machine' },
      tags: ['db'],
    });
    assert.deepEqual(mem.scope, { level: 'machine', machineId }, 'machine scope defaults to this machine');
    assert.equal(mem.kind, 'gotcha');
    const { item: ws } = await h.call(ext, 'knowledge.add', {
      type: 'memory',
      title: 'Workspace note',
      body: 'Only here.',
      scope: { level: 'workspace', workspaceId: 'w_ONE' },
    });

    const all = (await h.call(ext, 'knowledge.list', {})).items as KnowledgeItemInfo[];
    assert.deepEqual(new Set(all.map((i) => i.id)), new Set([rule.id, mem.id, ws.id]));
    assert.deepEqual((await h.call(ext, 'knowledge.list', { type: 'rule' })).items.map((i: KnowledgeItemInfo) => i.id), [rule.id]);
    assert.deepEqual((await h.call(ext, 'knowledge.list', { scopeLevel: 'machine' })).items.map((i: KnowledgeItemInfo) => i.id), [mem.id]);
    assert.deepEqual((await h.call(ext, 'knowledge.list', { workspaceId: 'w_ONE' })).items.map((i: KnowledgeItemInfo) => i.id), [ws.id]);
    assert.deepEqual((await h.call(ext, 'knowledge.list', { query: 'postgres' })).items.map((i: KnowledgeItemInfo) => i.id), [mem.id]);
    assert.equal((await h.call(ext, 'knowledge.list', { limit: 2 })).items.length, 2);

    // Edits create a new version that supersedes the old one.
    const { item: v2 } = await h.call(ext, 'knowledge.update', { id: mem.id, body: 'Staging Postgres listens on 6544.', appliesTo: [] });
    assert.notEqual(v2.id, mem.id);
    assert.deepEqual(v2.supersedes, [mem.id]);
    assert.equal(v2.kind, 'gotcha');
    assert.deepEqual(changedIds(h).at(-1)!.sort(), [mem.id, v2.id].sort());
    const superseded = (await h.call(ext, 'knowledge.list', { status: 'superseded' })).items as KnowledgeItemInfo[];
    assert.deepEqual(superseded.map((i) => i.id), [mem.id]);

    await h.call(ext, 'knowledge.forget', { id: rule.id });
    assert.deepEqual(changedIds(h).at(-1), [rule.id]);
    const deleted = (await h.call(ext, 'knowledge.list', { status: 'deleted' })).items as KnowledgeItemInfo[];
    assert.deepEqual(deleted.map((i) => i.id), [rule.id]);
    assert.ok(!(await h.call(ext, 'knowledge.list', {})).items.some((i: KnowledgeItemInfo) => i.id === rule.id));

    // Wire items carry no store internals.
    const wire = (await h.call(ext, 'knowledge.list', { type: 'memory' })).items[0];
    for (const k of ['contentHash', 'hlc', 'noticePending']) assert.ok(!(k in wire), k);

    await assert.rejects(h.call(ext, 'knowledge.add', { type: 'rule', title: 'x', body: 'y', scope: { level: 'project' } }), isCode('bad_request'));
    await assert.rejects(h.call(ext, 'knowledge.add', { type: 'rule', title: 'x', body: 'y', scope: { level: 'global' }, kind: 'fact' }), isCode('bad_request'));
    await assert.rejects(h.call(ext, 'knowledge.add', { type: 'memory', title: 'x', body: 'y', scope: { level: 'global' }, appliesTo: ['vim'] }), isCode('bad_request'));
    await assert.rejects(h.call(ext, 'knowledge.update', { id: 'k_missing', title: 'x' }), isCode('not_found'));
    await assert.rejects(h.call(ext, 'knowledge.list', { machineId: 'm_elsewhere' }), isCode('not_found'));
  });

  it('inbox cards, accept (re-scoped) and reject', async () => {
    const { ext, h, store } = await setup();
    const machineId = h.node.machine.id;
    await h.call(ext, 'knowledge.list', {}); // opens the store
    // Agent writes the balanced policy sends to review: an unprompted rule and a global memory.
    const origin = { via: 'tool' as const, machineId, agent: 'claude' as const, sessionId: 's_A', projectId: 'p_X', workspaceId: 'w_X' };
    const rule = addKnowledge(store(), { type: 'rule', title: 'Prefer tabs', body: 'Indent with tabs.', scope: 'project' }, origin).item;
    const mem = addKnowledge(store(), { type: 'memory', title: 'Global thing', body: 'Applies everywhere.', scope: 'global' }, origin).item;
    const other = addKnowledge(store(), { type: 'rule', title: 'Other', body: 'From codex.', scope: 'workspace' }, { ...origin, agent: 'codex', sessionId: 's_B' }).item;
    assert.deepEqual([rule.status, mem.status, other.status], ['suggested', 'suggested', 'suggested']);

    const { cards } = await h.call(ext, 'knowledge.inbox', {});
    assert.equal(cards.length, 2);
    const cardA = cards.find((c: { sessionId?: string }) => c.sessionId === 's_A');
    assert.equal(cardA.agent, 'claude');
    assert.deepEqual(new Set(cardA.items.map((i: KnowledgeItemInfo) => i.id)), new Set([rule.id, mem.id]));
    assert.equal(cardA.items[0].source.via, 'tool');

    // Accept the rule at workspace scope instead of project.
    await h.call(ext, 'knowledge.accept', { ids: [rule.id], scope: { level: 'workspace', workspaceId: 'w_X' } });
    const accepted = store().require(rule.id);
    assert.equal(accepted.status, 'active');
    assert.deepEqual(accepted.scope, { level: 'workspace', workspaceId: 'w_X' });
    assert.deepEqual(changedIds(h).at(-1), [rule.id]);

    await h.call(ext, 'knowledge.reject', { ids: [mem.id, other.id] });
    assert.equal(store().require(mem.id).status, 'deleted');
    assert.deepEqual(changedIds(h).at(-1)!.sort(), [mem.id, other.id].sort());
    assert.deepEqual((await h.call(ext, 'knowledge.inbox', {})).cards, []);
    await assert.rejects(h.call(ext, 'knowledge.accept', { ids: [mem.id] }), isCode('conflict'));
    await assert.rejects(h.call(ext, 'knowledge.accept', {}), isCode('bad_request'));
  });

  it('settings get / set with preset, defaultAgentScope and overrides', async () => {
    const { ext, h, store } = await setup();
    assert.deepEqual((await h.call(ext, 'knowledge.settings.get', {})).settings, { preset: 'balanced', defaultAgentScope: 'project' });
    const { settings } = await h.call(ext, 'knowledge.settings.set', {
      settings: { preset: 'strict', defaultAgentScope: 'workspace', overrides: { agentMemory: { session: 'live' } } },
    });
    assert.deepEqual(settings, { preset: 'strict', defaultAgentScope: 'workspace', overrides: { agentMemory: { session: 'live' } } });
    assert.deepEqual((await h.call(ext, 'knowledge.settings.get', {})).settings, settings);
    // Stored where the MCP server process reads it.
    const { loadSettings } = await import('@bizzi/knowledge');
    assert.equal(loadSettings(store()).policy.preset, 'strict');

    // Partial update keeps the rest; null clears overrides.
    const next = (await h.call(ext, 'knowledge.settings.set', { settings: { preset: 'trusting', overrides: null } })).settings;
    assert.deepEqual(next, { preset: 'trusting', defaultAgentScope: 'workspace' });

    for (const bad of [{ preset: 'yolo' }, { defaultAgentScope: 'team' }, { overrides: { robots: {} } }, { overrides: { user: { global: 'maybe' } } }]) {
      await assert.rejects(h.call(ext, 'knowledge.settings.set', { settings: bad }), isCode('bad_request'), JSON.stringify(bad));
    }
    await assert.rejects(h.call(ext, 'knowledge.settings.set', {}), isCode('bad_request'));
  });

  it('harvests Claude auto-memory when a Claude session in the workspace ends', async () => {
    const claudeHome = join(tempDir(), '.claude');
    const claude = new FakeAdapter({ agent: 'claude' });
    const { ext, h, store } = await setup({ claudeHome, adapters: [claude] });
    const wsPath = tempDir('bizzi-services-ws-');
    const { workspace } = await h.node.call('workspace.create', { path: wsPath });

    const memDir = claudeMemoryDir(wsPath, claudeHome);
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, 'MEMORY.md'), '- [Build command](build.md) — how to build\n');
    writeFileSync(join(memDir, 'build.md'), '---\nname: build\ndescription: How to build\nmetadata:\n  type: project\n---\n\nRun `make all` to build.\n');

    const { session } = await h.node.call('session.create', { workspaceId: workspace.id, agent: 'claude' });
    await waitFor(() => claude.starts.length === 1, 'claude start');
    assert.equal(changedIds(h).length, 0, 'nothing harvested while the session runs');
    await h.node.call('session.stop', { sessionId: session.id });
    await waitFor(() => changedIds(h).length > 0, 'knowledge.changed after harvest');
    await (ext as KnowledgeExtension).idle();

    const harvested = store().list({ status: ['active', 'suggested'] });
    assert.equal(harvested.length, 1);
    const item = harvested[0]!;
    assert.equal(item.title, 'Build command');
    assert.equal(item.source.via, 'harvest');
    assert.equal(item.source.agent, 'claude');
    assert.ok(item.tags.includes('harvest:claude'));
    assert.deepEqual(item.scope, { level: 'workspace', workspaceId: workspace.id }, 'no project: workspace scope');
    assert.deepEqual(changedIds(h), [[item.id]]);

    // Idempotent: harvesting again (e.g. another session ending) imports nothing new.
    const again = await (ext as KnowledgeExtension).harvestWorkspace(workspace.id);
    assert.deepEqual([again?.imported.length, again?.skipped[0]?.reason], [0, 'unchanged']);
    assert.equal(changedIds(h).length, 1);
  });

  it('harvests when a workspace is added and on node start; harvested memories go live without inbox items (§8)', async () => {
    const claudeHome = join(tempDir(), '.claude');
    const { ext, h, store } = await setup({ claudeHome });
    const wsPath = tempDir('bizzi-services-ws-');
    const memDir = claudeMemoryDir(wsPath, claudeHome);
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, 'MEMORY.md'), '- [Ports](ports.md) — dev ports\n');
    writeFileSync(join(memDir, 'ports.md'), '---\nname: ports\ndescription: Dev ports\ntype: project\n---\n\nThe dev server runs on 5173.\n');

    const { workspace } = await h.node.call('workspace.create', { path: wsPath });
    await waitFor(() => changedIds(h).length > 0, 'knowledge.changed after the workspace was added');
    await (ext as KnowledgeExtension).idle();
    const [item, ...rest] = store().list({ status: ['active', 'suggested'] });
    assert.equal(rest.length, 0);
    assert.equal(item?.title, 'Ports');
    assert.equal(item?.type, 'memory', 'mirrored as a memory, never a rule suggestion');
    assert.equal(item?.status, 'active');
    assert.equal(item?.source.workspaceId, workspace.id);
    assert.deepEqual((await h.call(ext, 'knowledge.inbox', {})).cards, [], 'balanced: no inbox items');

    // A node starting later catches up on every workspace it has.
    const fresh = new KnowledgeStore({ path: ':memory:', machineId: h.node.machine.id });
    const ext2 = createKnowledgeExtension({ store: fresh, pollMs: 0, claudeHome, watch: false });
    await ext2.start!(h.ctx);
    await ext2.idle();
    await ext2.stop!();
    assert.deepEqual(fresh.list({ status: 'active' }).map((i) => i.title), ['Ports']);
  });

  it('watches memory directories, so memories saved by a plain `claude` are harvested (§8)', async () => {
    const claudeHome = join(tempDir(), '.claude');
    mkdirSync(claudeHome, { recursive: true });
    const { ext, h, store } = await setup({ claudeHome, watch: true });
    const wsPath = tempDir('bizzi-services-ws-');
    await h.node.call('workspace.create', { path: wsPath });
    await (ext as KnowledgeExtension).idle();
    await h.call(ext, 'knowledge.list', {}); // opens the store
    assert.equal(store().list().length, 0);

    // Claude creates the memory directory on its first memory there.
    const memDir = claudeMemoryDir(wsPath, claudeHome);
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, 'seed.md'), '---\nname: seed\ntype: project\n---\n\nRun `make seed` before the tests.\n');
    await waitFor(() => store().list({ status: 'active' }).length === 1, 'harvest after the memory dir appeared');

    // An edit supersedes the earlier import.
    writeFileSync(join(memDir, 'seed.md'), '---\nname: seed\ntype: project\n---\n\nRun `make seed-all` before the tests.\n');
    await waitFor(() => store().list({ status: 'active' })[0]?.body.includes('seed-all') === true, 'harvest after an edit');
    await (ext as KnowledgeExtension).idle();
    assert.equal(store().list({ status: 'superseded' }).length, 1);
  });

  it('promote.preview / promote: append picked memories to the workspace AGENTS.md and tag them `promoted` (§8)', async () => {
    const { ext, h, store } = await setup();
    const wsPath = tempDir('bizzi-services-ws-');
    writeFileSync(join(wsPath, 'AGENTS.md'), '# acme\n');
    const { workspace } = await h.node.call('workspace.create', { path: wsPath });
    const add = async (title: string, scope: object) => (await h.call(ext, 'knowledge.add', { type: 'memory', title, body: `${title} body`, scope })).item.id as string;
    const a = await add('Staging DB', { level: 'workspace', workspaceId: workspace.id });
    const b = await add('Elsewhere', { level: 'workspace', workspaceId: 'w_OTHER' });

    const { preview } = await h.call(ext, 'knowledge.promote.preview', { workspaceId: workspace.id, ids: [a, b], heading: 'Team notes' });
    assert.equal(preview.path, join(wsPath, 'AGENTS.md'));
    assert.equal(preview.exists, true);
    assert.deepEqual(preview.ids, [a]);
    assert.deepEqual(preview.skipped, [{ id: b, reason: 'not_visible' }]);
    assert.match(preview.diff, /\+## Team notes\n\+\n\+- \*\*Staging DB\*\*: Staging DB body\n$/);

    const before = changedIds(h).length;
    const res = await h.call(ext, 'knowledge.promote', { workspaceId: workspace.id, ids: [a], heading: 'Team notes', baseHash: preview.baseHash });
    assert.deepEqual(res, { path: join(wsPath, 'AGENTS.md'), created: false, promoted: [a] });
    assert.equal(readFileSync(join(wsPath, 'AGENTS.md'), 'utf8'), '# acme\n\n## Team notes\n\n- **Staging DB**: Staging DB body\n');
    assert.ok(store().require(a).tags.includes('promoted'));
    assert.deepEqual(changedIds(h).slice(before), [[a]]);

    await assert.rejects(h.call(ext, 'knowledge.promote.preview', { workspaceId: workspace.id, ids: [a] }), isCode('bad_request'));
    await assert.rejects(h.call(ext, 'knowledge.promote', { workspaceId: 'w_NOPE', ids: [a] }), isCode('not_found'));
    await assert.rejects(h.call(ext, 'knowledge.promote', { workspaceId: workspace.id }), isCode('bad_request'));
  });

  it('polls for changes written by other processes (the MCP server)', async () => {
    const { ext, h, store } = await setup({ pollMs: 30 });
    await h.call(ext, 'knowledge.list', {}); // opens the store
    const { item } = addKnowledge(
      store(),
      { type: 'memory', title: 'From MCP', body: 'Written by the bizzi-memory server.', scope: 'global' },
      { via: 'tool', machineId: h.node.machine.id, agent: 'codex' },
    );
    await waitFor(() => changedIds(h).some((ids) => ids.includes(item.id)), 'knowledge.changed from poll');
    // Our own writes aren't reported twice.
    const { item: own } = await h.call(ext, 'knowledge.add', { type: 'rule', title: 'Mine', body: 'b', scope: { level: 'global' } });
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(changedIds(h).filter((ids) => ids.includes(own.id)).length, 1);
  });
  it('sync.pull pages changes by HLC; sync.push merges newer records and skips bad ones', async () => {
    const { ext, h, store } = await setup();
    const ids: string[] = [];
    for (const title of ['One', 'Two', 'Three']) {
      ids.push((await h.call(ext, 'knowledge.add', { type: 'rule', title, body: 'b', scope: { level: 'global' } })).item.id);
    }
    const p1 = await h.call(ext, 'knowledge.sync.pull', { limit: 2 });
    assert.deepEqual(p1.items.map((i: { id: string }) => i.id), ids.slice(0, 2));
    assert.equal(p1.more, true);
    assert.equal(p1.storeId, store().storeId);
    const p2 = await h.call(ext, 'knowledge.sync.pull', { since: p1.items[1].hlc, limit: 2 });
    assert.deepEqual([p2.items.map((i: { id: string }) => i.id), p2.more], [[ids[2]], false]);

    // A record from another machine: newer than ours wins, older (or the same) doesn't.
    const mine = store().require(ids[0]!);
    const remote = { ...mine, title: 'One (edited elsewhere)', hlc: `${'9'.repeat(15)}-000000-m_OTHER`, source: { machineId: 'm_OTHER', via: 'ui' } };
    const stale = { ...store().require(ids[1]!), title: 'stale', hlc: `${'0'.repeat(15)}-000000-m_OTHER` };
    const before = changedIds(h).length;
    const res = await h.call(ext, 'knowledge.sync.push', { items: [remote, stale, { id: 'k_BAD' }] });
    assert.equal(res.applied, 1);
    assert.equal(store().require(ids[0]!).title, 'One (edited elsewhere)');
    assert.equal(store().require(ids[1]!).title, 'Two');
    assert.deepEqual(changedIds(h).slice(before), [[ids[0]]]);
    // A local write after the merge sorts after it, so the hub's HLC cursor never skips it.
    const { item: later } = await h.call(ext, 'knowledge.add', { type: 'rule', title: 'Later', body: 'b', scope: { level: 'global' } });
    const p3 = await h.call(ext, 'knowledge.sync.pull', { since: remote.hlc });
    assert.deepEqual(p3.items.map((i: { id: string }) => i.id), [later.id]);
    await assert.rejects(h.call(ext, 'knowledge.sync.push', { items: 'nope' }), isCode('bad_request'));
  });
});
