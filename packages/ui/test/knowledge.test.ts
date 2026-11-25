import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BizziClient, BizziStore, createManualScheduler } from '@bizzi/client';
import type { KnowledgeItemInfo, MachineInfo, SessionInfo, WorkspaceInfo } from '@bizzi/protocol';
import { MockCore, createMockSocketFactory } from '../src/mock/mockServer.ts';
import {
  cardSummary,
  filterByAgent,
  groupByScope,
  PROMOTED_TAG,
  knownTags,
  matchesAgent,
  parseTags,
  projectOptions,
  promotionCandidates,
  reachesWorkspace,
  retargetScope,
  sameScope,
  scopeComplete,
  scopeLabel,
} from '../src/lib/knowledge.ts';
import type { ScopeContext } from '../src/lib/knowledge.ts';
import { diffStats, parseUnifiedDiff } from '../src/lib/diff.ts';

const machine = (id: string, name: string): MachineInfo => ({
  id,
  name,
  hostname: `${name}.lan`,
  os: 'linux',
  arch: 'x64',
  headful: false,
  alwaysOn: true,
  tags: [],
  online: true,
  roles: ['node'],
  bizziVersion: '0',
});

const ws = (id: string, name: string, machineId: string, projectId?: string): WorkspaceInfo => {
  const w: WorkspaceInfo = { id, name, machineId, path: `/src/${name}`, kind: 'git', createdAt: 'x' };
  if (projectId) w.projectId = projectId;
  return w;
};

const CTX: ScopeContext = {
  machines: { m_a: machine('m_a', 'laptop'), m_b: machine('m_b', 'server-a') },
  workspaces: { w_1: ws('w_1', 'acme-shop', 'm_a', 'p_acme'), w_2: ws('w_2', 'acme-shop', 'm_b', 'p_acme'), w_3: ws('w_3', 'notes', 'm_a') },
  sessions: {
    s_1: { id: 's_1', machineId: 'm_a', workspaceId: 'w_1', agent: 'claude', mode: 'structured', status: 'idle', title: 'Fix it', createdAt: 'x', updatedAt: 'x', lastSeq: 0 } satisfies SessionInfo,
    s_3: { id: 's_3', machineId: 'm_a', workspaceId: 'w_3', agent: 'codex', mode: 'structured', status: 'idle', createdAt: 'x', updatedAt: 'x', lastSeq: 0 } satisfies SessionInfo,
  },
};

function item(over: Partial<KnowledgeItemInfo>): KnowledgeItemInfo {
  return {
    id: 'k_1',
    type: 'memory',
    scope: { level: 'global' },
    title: 't',
    body: 'b',
    tags: [],
    source: { machineId: 'm_a', via: 'tool', agent: 'claude', sessionId: 's_1' },
    status: 'suggested',
    createdAt: 'x',
    updatedAt: 'x',
    ...over,
  };
}

test('scope labels resolve names and fall back to ids', () => {
  assert.equal(scopeLabel({ level: 'global' }, CTX), 'global');
  assert.equal(scopeLabel({ level: 'machine', machineId: 'm_b' }, CTX), 'machine · server-a');
  assert.equal(scopeLabel({ level: 'machine', machineId: 'm_x' }, CTX), 'machine · m_x');
  assert.equal(scopeLabel({ level: 'workspace', workspaceId: 'w_3' }, CTX), 'workspace · notes');
  assert.equal(scopeLabel({ level: 'project', projectId: 'p_acme' }, CTX), 'project · acme-shop');
  assert.equal(scopeLabel({ level: 'project', projectId: 'p_other' }, CTX), 'project · other');
  assert.equal(scopeLabel({ level: 'session', sessionId: 's_1' }, CTX), 'session · Fix it');
  assert.equal(scopeLabel({ level: 'tag', tag: 'prod-access' }, CTX), 'tag · prod-access');
});

test('tag scope: retarget uses the source machine\'s first tag; known tags across machines', () => {
  const tagged: ScopeContext = { ...CTX, machines: { ...CTX.machines, m_a: { ...machine('m_a', 'laptop'), tags: ['prod-access', 'gui'] } } };
  assert.deepEqual(retargetScope(item({}), 'tag', tagged), { level: 'tag', tag: 'prod-access' });
  assert.equal(retargetScope(item({}), 'tag', CTX), null);
  const own = item({ scope: { level: 'tag', tag: 'gui' } });
  assert.deepEqual(retargetScope(own, 'tag', CTX), { level: 'tag', tag: 'gui' });
  assert.equal(scopeComplete({ level: 'tag' }), false);
  assert.equal(scopeComplete({ level: 'tag', tag: 'gui' }), true);
  assert.equal(sameScope({ level: 'tag', tag: 'a' }, { level: 'tag', tag: 'b' }), false);
  assert.deepEqual(knownTags(tagged, ['zeta', undefined, 'gui']), ['gui', 'prod-access', 'zeta']);
});

test('retargetScope fills ids from the item scope, then its source session', () => {
  const it = item({ scope: { level: 'workspace', workspaceId: 'w_1' } });
  assert.deepEqual(retargetScope(it, 'workspace', CTX), { level: 'workspace', workspaceId: 'w_1' });
  assert.deepEqual(retargetScope(it, 'global', CTX), { level: 'global' });
  assert.deepEqual(retargetScope(it, 'project', CTX), { level: 'project', projectId: 'p_acme' });
  assert.deepEqual(retargetScope(it, 'machine', CTX), { level: 'machine', machineId: 'm_a' });

  // A global suggestion from session s_1 can be narrowed to that session's workspace / project.
  const g = item({});
  assert.deepEqual(retargetScope(g, 'workspace', CTX), { level: 'workspace', workspaceId: 'w_1' });
  assert.deepEqual(retargetScope(g, 'project', CTX), { level: 'project', projectId: 'p_acme' });

  // No project link: project scope is impossible.
  const n = item({ source: { machineId: 'm_a', via: 'tool', sessionId: 's_3' } });
  assert.equal(retargetScope(n, 'project', CTX), null);
  // No session at all: machine falls back to the source machine, workspace is impossible.
  const bare = item({ source: { machineId: 'm_b', via: 'ui' } });
  assert.deepEqual(retargetScope(bare, 'machine', CTX), { level: 'machine', machineId: 'm_b' });
  assert.equal(retargetScope(bare, 'workspace', CTX), null);
});

test('agent filter: no appliesTo means every agent', () => {
  const all = item({ id: 'a' });
  const codex = item({ id: 'c', appliesTo: ['codex'] });
  assert.equal(matchesAgent(all, 'claude'), true);
  assert.equal(matchesAgent(codex, 'claude'), false);
  assert.equal(matchesAgent(codex, 'all'), true);
  assert.deepEqual(filterByAgent([all, codex], 'codex').map((i) => i.id), ['a', 'c']);
  assert.deepEqual(filterByAgent([all, codex], 'opencode').map((i) => i.id), ['a']);
});

test('card summary, tags, scope helpers', () => {
  assert.equal(cardSummary({ items: [item({}), item({}), item({ type: 'rule' })] }), '2 suggested memories, 1 rule');
  assert.equal(cardSummary({ items: [item({ type: 'rule' })] }), '1 suggested rule');
  assert.equal(cardSummary({ items: [] }), 'No suggestions');
  assert.deepEqual(parseTags(' db, #infra,, db\nci '), ['db', 'infra', 'ci']);
  assert.equal(sameScope({ level: 'workspace', workspaceId: 'w_1' }, { level: 'workspace', workspaceId: 'w_1' }), true);
  assert.equal(sameScope({ level: 'workspace', workspaceId: 'w_1' }, { level: 'workspace', workspaceId: 'w_2' }), false);
  assert.equal(scopeComplete({ level: 'project' }), false);
  assert.equal(scopeComplete({ level: 'global' }), true);
  assert.deepEqual(projectOptions(CTX, ['p_zeta']), [
    { projectId: 'p_acme', label: 'acme-shop' },
    { projectId: 'p_zeta', label: 'zeta' },
  ]);
});

test('groupByScope makes one accept call per target scope', () => {
  const groups = groupByScope([
    { id: 'a' },
    { id: 'b', scope: { level: 'global' } },
    { id: 'c' },
    { id: 'd', scope: { level: 'global' } },
    { id: 'e', scope: { level: 'workspace', workspaceId: 'w_1' } },
  ]);
  assert.deepEqual(groups, [
    { ids: ['a', 'c'] },
    { scope: { level: 'global' }, ids: ['b', 'd'] },
    { scope: { level: 'workspace', workspaceId: 'w_1' }, ids: ['e'] },
  ]);
});

function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (cond()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timed out'));
      setTimeout(tick, 2);
    };
    tick();
  });
}

test('mock knowledge: list filters, inbox, accept with scope, forget, settings', async (t) => {
  const core = new MockCore({ speed: 0, autoplay: false });
  const client = new BizziClient({ createSocket: createMockSocketFactory(core) });
  const scheduler = createManualScheduler();
  const store = new BizziStore(client, { scheduler });
  t.after(() => {
    store.dispose();
    client.close();
  });
  await client.connect('mock://local');
  const flushUntil = (cond: () => boolean): Promise<void> =>
    waitFor(() => {
      scheduler.flush();
      return cond();
    });
  await flushUntil(() => store.getState().knowledgeInbox !== null && store.getState().knowledgeSettings !== null);

  const all = await store.listKnowledge();
  assert.ok(all.length >= 12);
  assert.ok(all.every((i) => i.status === 'active'));
  const rules = await store.listKnowledge({ type: 'rule', scopeLevel: 'workspace' });
  assert.ok(rules.length > 0 && rules.every((i) => i.type === 'rule' && i.scope.level === 'workspace'));
  assert.deepEqual((await store.listKnowledge({ query: 'YARN' })).map((i) => i.id), ['k_pnpm']);

  const cards = store.getState().knowledgeInbox ?? [];
  assert.equal(cards.length, 2);
  const demo = cards.find((c) => c.sessionId === 's_demo');
  assert.equal(demo?.items.length, 3);
  assert.equal(demo?.agent, 'claude');

  const rev = store.getState().knowledgeRev;
  await store.acceptKnowledge(['k_sug_mock'], { level: 'workspace', workspaceId: 'w_acme' });
  await flushUntil(() => store.getState().knowledgeRev > rev + 1);
  const accepted = (await store.listKnowledge({ scopeLevel: 'workspace', workspaceId: 'w_acme' })).find((i) => i.id === 'k_sug_mock');
  assert.ok(accepted);
  await store.rejectKnowledge(['k_sug_sandbox']);
  await flushUntil(() => (store.getState().knowledgeInbox ?? []).length === 1);

  const item = await store.addKnowledge({ type: 'memory', title: 'New fact', body: 'x', scope: { level: 'global' }, kind: 'fact', appliesTo: ['codex'] });
  assert.deepEqual(item.appliesTo, ['codex']);
  await store.forgetKnowledge(item.id);
  assert.equal((await store.listKnowledge()).some((i) => i.id === item.id), false);

  const s = await store.setKnowledgeSettings({ preset: 'strict' });
  assert.deepEqual(s, { preset: 'strict', defaultAgentScope: 'project' });
});

test('promotion candidates: active memories that reach the workspace, not promoted yet, most specific first', () => {
  const w1 = CTX.workspaces!.w_1!;
  const items = [
    item({ id: 'g', status: 'active', title: 'Global', scope: { level: 'global' } }),
    item({ id: 'p', status: 'active', title: 'Project', scope: { level: 'project', projectId: 'p_acme' } }),
    item({ id: 'w', status: 'active', title: 'Workspace', scope: { level: 'workspace', workspaceId: 'w_1' } }),
    item({ id: 'w2', status: 'active', title: 'Other workspace', scope: { level: 'workspace', workspaceId: 'w_2' } }),
    item({ id: 'mb', status: 'active', title: 'Other machine', scope: { level: 'machine', machineId: 'm_b' } }),
    item({ id: 't', status: 'active', title: 'Tagged', scope: { level: 'tag', tag: 'gui' } }),
    item({ id: 'done', status: 'active', title: 'Done', tags: [PROMOTED_TAG] }),
    item({ id: 'sug', title: 'Suggested' }),
    item({ id: 'r', status: 'active', type: 'rule', title: 'A rule' }),
  ];
  assert.deepEqual(promotionCandidates(items, w1).map((i) => i.id), ['w', 'p', 'g']);
  assert.deepEqual(promotionCandidates(items, w1, { tags: ['gui'] }).map((i) => i.id), ['w', 'p', 't', 'g']);
  assert.equal(reachesWorkspace({ scope: { level: 'machine', machineId: 'm_a' } }, w1), true);
});

test('mock knowledge: Add to AGENTS.md preview and write', async (t) => {
  const core = new MockCore({ speed: 0, autoplay: false });
  const client = new BizziClient({ createSocket: createMockSocketFactory(core) });
  const scheduler = createManualScheduler();
  const store = new BizziStore(client, { scheduler });
  t.after(() => {
    store.dispose();
    client.close();
  });
  await client.connect('mock://local');
  await waitFor(() => {
    scheduler.flush();
    return store.getState().knowledgeInbox !== null && store.getState().workspaces !== null;
  });
  const memories = promotionCandidates(await store.listKnowledge({ type: 'memory' }), store.getState().workspaces!.w_acme!);
  const ids = memories.slice(0, 2).map((i) => i.id);
  assert.equal(ids.length, 2);
  const preview = await store.previewPromotion({ workspaceId: 'w_acme', ids, heading: '## Team notes' });
  assert.equal(preview.exists, false);
  assert.equal(preview.heading, 'Team notes');
  assert.deepEqual(preview.ids, ids);
  const files = parseUnifiedDiff(preview.diff, 'AGENTS.md');
  assert.equal(files.length, 1);
  assert.equal(diffStats(files).additions, 4);
  const res = await store.promoteKnowledge({ workspaceId: 'w_acme', ids, heading: preview.heading, baseHash: preview.baseHash });
  assert.deepEqual(res.promoted, ids);
  assert.equal(res.created, true);
  const after = await store.listKnowledge({ type: 'memory' });
  assert.ok(ids.every((id) => after.find((i) => i.id === id)?.tags.includes(PROMOTED_TAG)));
  await assert.rejects(store.previewPromotion({ workspaceId: 'w_acme', ids }), /none of the picked/);
});
