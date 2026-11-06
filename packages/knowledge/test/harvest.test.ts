import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CLAUDE_HARVEST_TAG,
  claudeMemoryDir,
  claudeProjectSlug,
  forgetKnowledge,
  harvestClaudeMemory,
  harvestCodexMemories,
  listInbox,
  localPaths,
  parseFrontmatter,
  parseMemoryIndex,
  readClaudeMemoryDir,
  saveSettings,
} from '../src/index.ts';
import type { ClaudeHarvestOptions, KnowledgeStore } from '../src/index.ts';
import { M1, P1, W1, memStore, tempDir } from './helpers.ts';

const FIXTURE = new URL('./fixtures/claude-memory/', import.meta.url).pathname;

function withCopy<T>(fn: (dir: string, root: string) => T): T {
  const tmp = tempDir();
  try {
    const dir = join(tmp.dir, 'memory');
    cpSync(FIXTURE, dir, { recursive: true });
    return fn(dir, tmp.dir);
  } finally {
    tmp.cleanup();
  }
}

const opts = (dir: string): ClaudeHarvestOptions => ({
  dir,
  machineId: M1,
  projectId: P1,
  workspaceId: W1,
  workspacePath: '/Users/dev/src/alpha',
});

function snapshot(dir: string): string {
  return readdirSync(dir)
    .sort()
    .map((n) => `${n}:${statSync(join(dir, n)).mtimeMs}:${readFileSync(join(dir, n), 'utf8').length}`)
    .join('|');
}

test('frontmatter parser: top-level and nested keys, quoted values', () => {
  const { data, content } = parseFrontmatter('---\nname: x\ndescription: "a: \\"b\\""\nmetadata:\n  type: user\n  n: 1\nafter: y\n---\nbody\n');
  assert.deepEqual(data, { name: 'x', description: 'a: "b"', metadata: { type: 'user', n: '1' }, after: 'y' });
  assert.equal(content, 'body\n');
  assert.deepEqual(parseFrontmatter('no frontmatter').data, {});
});

test('MEMORY.md index and memory files are read into entries', () => {
  const idx = parseMemoryIndex(readFileSync(join(FIXTURE, 'MEMORY.md'), 'utf8'));
  assert.equal(idx.length, 5);
  assert.deepEqual(idx[0], { title: 'Staging database', file: 'staging-db.md', hook: 'staging Postgres host and port' });

  const entries = readClaudeMemoryDir(FIXTURE);
  const byTitle = Object.fromEntries(entries.map((e) => [e.title, e]));
  assert.deepEqual(Object.keys(byTitle).sort(), [
    'Homebrew postgres',
    'Prefers small PRs',
    'Seed script location',
    'Staging database',
    'The e2e suite needs `REDIS_URL` set or it hangs',
  ]);
  assert.equal(byTitle['Staging database']!.kind, 'reference');
  assert.equal(byTitle['Prefers small PRs']!.kind, 'preference', 'old top-level `type: feedback`');
  assert.equal(byTitle['Seed script location']!.kind, 'fact');
  assert.ok(byTitle['Staging database']!.body.startsWith('Staging Postgres runs on db-staging.example.test:5433\n\n'));
  assert.equal(byTitle['Staging database']!.originSessionId, '00000000-0000-4000-8000-000000000001');
  assert.deepEqual(readClaudeMemoryDir(join(FIXTURE, 'missing')), []);
});

test('path helpers', () => {
  assert.equal(claudeProjectSlug('/Users/dev/.claude'), '-Users-dev--claude');
  assert.equal(claudeMemoryDir('/Users/dev/src/alpha', '/h/.claude'), '/h/.claude/projects/-Users-dev-src-alpha/memory');
  assert.deepEqual(localPaths('run `/Users/dev/x.sh` then ~/bin/y and C:\\tools\\z.exe; not a/b'), ['/Users/dev/x.sh', '~/bin/y', 'C:\\tools\\z.exe']);
});

test('harvest maps to project scope by default, workspace/machine for local paths, through the policy', () => {
  withCopy((dir) => {
    const { store } = memStore();
    const before = snapshot(dir);
    const r = harvestClaudeMemory(store, opts(dir));
    assert.equal(r.imported.length, 5);
    assert.equal(snapshot(dir), before, 'never writes into the native memory directory');
    const scope = (title: string) => r.imported.find((i) => i.title === title)!.scope;
    assert.deepEqual(scope('Staging database'), { level: 'project', projectId: P1 });
    assert.deepEqual(scope('Prefers small PRs'), { level: 'project', projectId: P1 });
    assert.deepEqual(scope('Seed script location'), { level: 'workspace', workspaceId: W1 });
    assert.deepEqual(scope('Homebrew postgres'), { level: 'machine', machineId: M1 });
    for (const item of r.imported) {
      assert.equal(item.status, 'active', 'explicit native saves are live under balanced');
      assert.equal(item.source.via, 'harvest');
      assert.equal(item.source.agent, 'claude');
      assert.ok(item.source.ref?.startsWith(`claude:${dir}`));
      assert.ok(item.tags.includes(CLAUDE_HARVEST_TAG));
    }
  });
});

test('harvest is idempotent and dedupes by content hash + provenance; edits supersede', () => {
  withCopy((dir, root) => {
    const { store } = memStore();
    const first = harvestClaudeMemory(store, opts(dir));
    assert.equal(first.imported.length, 5);

    const again = harvestClaudeMemory(store, opts(dir));
    assert.deepEqual(again.imported, []);
    assert.deepEqual(
      again.skipped.map((s) => s.reason),
      ['unchanged', 'unchanged', 'unchanged', 'unchanged', 'unchanged'],
    );

    // Same content from another location (another worktree / machine copy): duplicates.
    const copy = join(root, 'copy');
    cpSync(dir, copy, { recursive: true });
    const dup = harvestClaudeMemory(store, opts(copy));
    assert.equal(dup.imported.length, 0);
    assert.equal(dup.skipped.filter((s) => s.reason === 'duplicate').length, 5);

    // Edit one file: a new version supersedes the earlier import.
    const file = join(dir, 'staging-db.md');
    writeFileSync(file, readFileSync(file, 'utf8').replace('port 5433', 'port 6543'));
    const edited = harvestClaudeMemory(store, opts(dir));
    assert.equal(edited.updated.length, 1);
    const old = first.imported.find((i) => i.title === 'Staging database')!;
    assert.deepEqual(edited.updated[0]!.supersedes, [old.id]);
    assert.equal(store.get(old.id)?.status, 'superseded');
    assert.equal(countActive(store), 5);
  });
});

test('forgotten harvested memories are not revived', () => {
  withCopy((dir, root) => {
    const { store } = memStore();
    const r = harvestClaudeMemory(store, opts(dir));
    const prefs = r.imported.find((i) => i.title === 'Prefers small PRs')!;
    forgetKnowledge(store, prefs.id, { via: 'ui', machineId: M1 });
    const copy = join(root, 'copy2');
    cpSync(dir, copy, { recursive: true });
    harvestClaudeMemory(store, opts(copy));
    assert.equal(store.get(prefs.id)?.status, 'deleted');
    assert.equal(countActive(store), 4);
  });
});

test('strict policy sends harvested memories to the inbox', () => {
  withCopy((dir) => {
    const { store } = memStore();
    saveSettings(store, { policy: { preset: 'strict' } });
    const r = harvestClaudeMemory(store, opts(dir));
    assert.ok(r.imported.every((i) => i.status === 'suggested'));
    const inbox = listInbox(store);
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0]!.sessionId, null);
    assert.equal(inbox[0]!.counts.memories, 5);
  });
});

test('Codex importer is a documented stub', () => {
  const { store } = memStore();
  const r = harvestCodexMemories(store, { machineId: M1 });
  assert.equal(r.supported, false);
  assert.deepEqual(r.imported, []);
});

function countActive(store: KnowledgeStore): number {
  return store.list({ status: 'active', type: 'memory' }).length;
}
