import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  KnowledgeStore,
  addKnowledge,
  buildSystemPromptAppend,
  decide,
  isVisible,
  mcpServerArgs,
  renderMachineCard,
  resolveRules,
} from '../src/index.ts';
import type { KnowledgeStore as Store, MachineCardFacts, NewKnowledgeItem } from '../src/index.ts';
import { parseServerConfig } from '../src/mcp-tools.ts';
import { CTX, M1, P1, memStore, tempDir } from './helpers.ts';

function rule(store: Store, title: string, scope: NewKnowledgeItem['scope']) {
  return store.insert({ type: 'rule', title, body: '', scope, source: { via: 'ui', machineId: M1 }, status: 'active' });
}

const LAPTOP: MachineCardFacts = {
  name: 'laptop',
  os: 'darwin',
  arch: 'arm64',
  headful: true,
  alwaysOn: false,
  tags: ['prod-access'],
  description: 'Production investigations happen here.',
};

test('tag scope: visible only on machines with the tag, in SQL and in memory', () => {
  const { store } = memStore();
  const prod = rule(store, 'Prod: read-only kubectl', { level: 'tag', tag: 'prod-access' });
  const gui = rule(store, 'Take screenshots', { level: 'tag', tag: 'gui' });
  const tagged = { ...CTX, machineTags: ['prod-access'] };
  assert.deepEqual(store.visible(tagged, 'rule').map((i) => i.id), [prod.id]);
  assert.deepEqual(store.visible(CTX, 'rule'), []);
  assert.equal(isVisible(prod, tagged), true);
  assert.equal(isVisible(gui, tagged), false);
  assert.equal(isVisible(prod, CTX), false);
  assert.equal(store.get(prod.id)?.scope.tag, 'prod-access');
  assert.throws(() => rule(store, 'no tag', { level: 'tag' }), /requires tag/);
});

test('tag rules sit between global and machine, grouped by tag', () => {
  const { store } = memStore();
  rule(store, 'machine rule', { level: 'machine', machineId: M1 });
  rule(store, 'zeta rule', { level: 'tag', tag: 'zeta' });
  rule(store, 'alpha rule', { level: 'tag', tag: 'alpha' });
  rule(store, 'global rule', { level: 'global' });
  const ctx = { ...CTX, machineTags: ['zeta', 'alpha'] };
  assert.deepEqual(
    resolveRules(store, ctx).map((r) => r.title),
    ['global rule', 'alpha rule', 'zeta rule', 'machine rule'],
  );
  const text = buildSystemPromptAppend(ctx, { store, includeToolsNote: false });
  assert.ok(text.includes('### Tag `alpha` (every machine with this tag)'));
  assert.ok(text.indexOf('`alpha`') < text.indexOf('`zeta`'));
});

test('tag writes take the global row of the acceptance policy', () => {
  const settings = { policy: { preset: 'balanced' as const } };
  assert.equal(decide(settings, { source: 'agentMemory', scope: 'tag' }).decision, 'suggest');
  assert.equal(decide(settings, { source: 'user', scope: 'tag' }).decision, 'live');
  const { store } = memStore();
  const res = addKnowledge(store, { type: 'rule', title: 'Prod: read-only', body: '', scope: { level: 'tag', tag: 'prod-access' } }, { via: 'ui', machineId: M1 });
  assert.equal(res.item.status, 'active');
});

test('machine card: facts, tags and description; never claims the machine sleeps', () => {
  const card = renderMachineCard(LAPTOP);
  assert.ok(card.startsWith('## This machine'));
  assert.ok(card.includes('**laptop**: macOS (arm64), has a GUI session'));
  assert.ok(card.includes('Tags: `prod-access`.'));
  assert.ok(card.includes('Production investigations happen here.'));
  assert.ok(!/sleep/i.test(card));
  const server = renderMachineCard({ name: 'vps', os: 'linux', arch: 'x64', headful: false, alwaysOn: true, tags: [] });
  assert.ok(server.includes('Linux (x64), headless (no GUI), always on.'));
  assert.ok(!server.includes('Tags'));
  assert.ok(!server.includes('What the user says'));
});

test('the machine card comes first in the digest, before the rules', () => {
  const { store } = memStore();
  rule(store, 'Use pnpm', { level: 'global' });
  const text = buildSystemPromptAppend({ ...CTX, machineTags: LAPTOP.tags }, { store, machine: LAPTOP });
  assert.ok(text.indexOf('## This machine') > 0);
  assert.ok(text.indexOf('## This machine') < text.indexOf('## Rules'));
  assert.ok(!buildSystemPromptAppend(CTX, { store }).includes('## This machine'));
});

test('machine tags reach the bizzi-memory MCP server', () => {
  const ctx = { ...CTX, machineTags: ['prod-access', 'gui'] };
  const args = mcpServerArgs(ctx, '/tmp/k.db');
  const cfg = parseServerConfig(args.slice(1), {});
  assert.deepEqual(cfg.context.machineTags, ['prod-access', 'gui']);
  assert.equal(cfg.context.projectId, P1);
  assert.deepEqual(parseServerConfig(['--db', 'x', '--agent', 'claude', '--machine-id', M1], { BIZZI_MACHINE_TAGS: 'a,b' }).context.machineTags, ['a', 'b']);
  assert.equal(parseServerConfig(['--db', 'x', '--agent', 'claude', '--machine-id', M1], {}).context.machineTags, undefined);
});

test('a version 1 database gains the machine_tag column and keeps its items', () => {
  const { dir, cleanup } = tempDir();
  try {
    const path = join(dir, 'knowledge.db');
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta VALUES ('schema_version', '1');
      CREATE TABLE items (id TEXT PRIMARY KEY, type TEXT NOT NULL, scope_level TEXT NOT NULL, machine_id TEXT,
        project_id TEXT, workspace_id TEXT, session_id TEXT, team_id TEXT, applies_to TEXT, kind TEXT, title TEXT NOT NULL,
        body TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL, source_session_id TEXT, status TEXT NOT NULL,
        supersedes TEXT, notice_pending INTEGER NOT NULL DEFAULT 0, content_hash TEXT NOT NULL, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, hlc TEXT NOT NULL);
      INSERT INTO items(id, type, scope_level, title, body, source, status, content_hash, created_at, updated_at, hlc)
        VALUES ('k_old', 'rule', 'global', 'Old rule', '', '{"via":"ui","machineId":"${M1}"}', 'active', 'h',
          '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', '000000000000001-000000-${M1}');`);
    old.close();
    const store = new KnowledgeStore({ path, machineId: M1 });
    try {
      assert.equal(store.get('k_old')?.title, 'Old rule');
      const tagged = rule(store, 'Tagged', { level: 'tag', tag: 'gui' });
      assert.deepEqual(store.visible({ ...CTX, machineTags: ['gui'] }, 'rule').map((i) => i.id), ['k_old', tagged.id]);
    } finally {
      store.close();
    }
    const check = new DatabaseSync(path);
    assert.equal((check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value, '2');
    check.close();
  } finally {
    cleanup();
  }
});
