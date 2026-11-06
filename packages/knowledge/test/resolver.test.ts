import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isVisible, rankMemories, resolveRules } from '../src/index.ts';
import type { KnowledgeContext, KnowledgeScope, KnowledgeStore, NewKnowledgeItem } from '../src/index.ts';
import { DAY, M1, M2, P1, P2, S1, S2, W1, W2, memStore } from './helpers.ts';

function add(store: KnowledgeStore, title: string, scope: KnowledgeScope, over: Partial<NewKnowledgeItem> = {}) {
  return store.insert({
    type: 'memory',
    kind: 'fact',
    scope,
    title,
    body: `${title} body`,
    source: { via: 'ui', machineId: M1 },
    status: 'active',
    ...over,
  });
}

test('scope resolution matrix (§2.2)', () => {
  const { store } = memStore();
  const ids: Record<string, string> = {};
  const put = (label: string, scope: KnowledgeScope, over?: Partial<NewKnowledgeItem>) => {
    ids[label] = add(store, label, scope, over).id;
  };
  put('global', { level: 'global' });
  put('machine-m1', { level: 'machine', machineId: M1 });
  put('machine-m2', { level: 'machine', machineId: M2 });
  put('project-p1', { level: 'project', projectId: P1 });
  put('project-p2', { level: 'project', projectId: P2 });
  put('workspace-w1', { level: 'workspace', workspaceId: W1 });
  put('workspace-w2', { level: 'workspace', workspaceId: W2 });
  put('session-s1', { level: 'session', sessionId: S1 });
  put('team', { level: 'team', teamId: 't_X' });
  put('codex-only', { level: 'global' }, { appliesTo: ['codex'] });
  put('claude-or-codex-p1', { level: 'project', projectId: P1 }, { appliesTo: ['claude', 'codex'] });
  put('suggested', { level: 'global' }, { status: 'suggested' });
  put('superseded', { level: 'global' }, { status: 'superseded' });
  put('deleted', { level: 'global' }, { status: 'deleted' });

  const contexts: Record<string, KnowledgeContext> = {
    'claude M1 P1 W1 S1': { agent: 'claude', machineId: M1, projectId: P1, workspaceId: W1, sessionId: S1 },
    'codex M2 P1 W2 S2': { agent: 'codex', machineId: M2, projectId: P1, workspaceId: W2, sessionId: S2 },
    'opencode M1 P2': { agent: 'opencode', machineId: M1, projectId: P2, workspaceId: 'w_P2', sessionId: 's_3' },
    'claude M1 unregistered dir': { agent: 'claude', machineId: M1 },
  };
  const expected: Record<string, string[]> = {
    'claude M1 P1 W1 S1': ['global', 'machine-m1', 'project-p1', 'workspace-w1', 'session-s1', 'claude-or-codex-p1'],
    'codex M2 P1 W2 S2': ['global', 'machine-m2', 'project-p1', 'workspace-w2', 'codex-only', 'claude-or-codex-p1'],
    'opencode M1 P2': ['global', 'machine-m1', 'project-p2'],
    'claude M1 unregistered dir': ['global', 'machine-m1'],
  };
  for (const [name, ctx] of Object.entries(contexts)) {
    const want = expected[name]!.map((l) => ids[l]).sort();
    const got = store
      .visible(ctx)
      .map((i) => i.id)
      .sort();
    assert.deepEqual(got, want, `SQL visibility for ${name}`);
    const viaJs = store
      .list()
      .filter((i) => isVisible(i, ctx))
      .map((i) => i.id)
      .sort();
    assert.deepEqual(viaJs, want, `isVisible() for ${name}`);
  }
});

test('rules are ordered general → specific, oldest first within a level', () => {
  const { store, clock } = memStore();
  const rule = (title: string, scope: KnowledgeScope) => {
    clock.advance(1000);
    return add(store, title, scope, { type: 'rule', kind: undefined }).title;
  };
  rule('ws: never touch migrations/', { level: 'workspace', workspaceId: W1 });
  rule('global: use pnpm', { level: 'global' });
  rule('session: be terse', { level: 'session', sessionId: S1 });
  rule('project: use npm here', { level: 'project', projectId: P1 });
  rule('machine: scratch is /data', { level: 'machine', machineId: M1 });
  rule('global: no emojis', { level: 'global' });
  rule('other project rule', { level: 'project', projectId: P2 });
  const ctx: KnowledgeContext = { agent: 'claude', machineId: M1, projectId: P1, workspaceId: W1, sessionId: S1 };
  assert.deepEqual(
    resolveRules(store, ctx).map((r) => r.title),
    [
      'global: use pnpm',
      'global: no emojis',
      'machine: scratch is /data',
      'project: use npm here',
      'ws: never touch migrations/',
      'session: be terse',
    ],
  );
  // Memories never show up as rules.
  add(store, 'a memory', { level: 'global' });
  assert.equal(resolveRules(store, ctx).length, 6);
});

test('memory ranking without a query: scope specificity, then recency; capped', () => {
  const { store, clock } = memStore();
  const ctx: KnowledgeContext = { agent: 'claude', machineId: M1, projectId: P1, workspaceId: W1 };
  add(store, 'old global', { level: 'global' });
  clock.advance(10 * DAY);
  add(store, 'project fact', { level: 'project', projectId: P1 });
  add(store, 'workspace fact', { level: 'workspace', workspaceId: W1 });
  clock.advance(1 * DAY);
  add(store, 'newer project fact', { level: 'project', projectId: P1 });
  const titles = rankMemories(store, ctx).map((r) => r.item.title);
  assert.deepEqual(titles, ['workspace fact', 'newer project fact', 'project fact', 'old global']);
  assert.equal(rankMemories(store, ctx, { limit: 2 }).length, 2);
  assert.deepEqual(
    rankMemories(store, ctx, { scopeLevel: 'project' }).map((r) => r.item.title),
    ['newer project fact', 'project fact'],
  );
});

test('memory ranking with a query: relevance first, non-matches dropped unless asked', () => {
  const { store, clock } = memStore();
  const ctx: KnowledgeContext = { agent: 'claude', machineId: M1, projectId: P1, workspaceId: W1 };
  add(store, 'Staging database', { level: 'global' }, { body: 'staging database is on server-a, database port 5433' });
  clock.advance(DAY);
  add(store, 'Deploy notes', { level: 'workspace', workspaceId: W1 }, { body: 'deploys go through the staging step' });
  add(store, 'Unrelated', { level: 'workspace', workspaceId: W1 }, { body: 'lint config lives in biome.json' });
  const ranked = rankMemories(store, ctx, { query: 'staging database port' });
  assert.deepEqual(
    ranked.map((r) => r.item.title),
    ['Staging database', 'Deploy notes'],
  );
  assert.equal(ranked[0]!.relevance, 1);
  assert.ok(ranked[1]!.relevance < 1 && ranked[1]!.relevance > 0);
  const all = rankMemories(store, ctx, { query: 'staging database port', requireMatch: false });
  assert.equal(all.length, 3);
  assert.equal(all[2]!.item.title, 'Unrelated');
  assert.equal(all[2]!.relevance, 0);
});
