import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BizziError } from '@bizzi/protocol';
import {
  ABSENT_FILE_HASH,
  DEFAULT_PROMOTE_HEADING,
  PROMOTED_TAG,
  addKnowledge,
  appendDiff,
  appendSection,
  applyPromotion,
  normalizeHeading,
  planPromotion,
  renderPromotedItem,
} from '../src/index.ts';
import type { KnowledgeContext, KnowledgeStore } from '../src/index.ts';
import { M1, P1, P2, W1, memStore, tempDir } from './helpers.ts';

const isCode = (c: string) => (e: unknown) => e instanceof BizziError && e.code === c;
const WS_CTX: KnowledgeContext = { agent: 'claude', machineId: M1, projectId: P1, workspaceId: W1 };

function mem(store: KnowledgeStore, title: string, body: string, scope: 'project' | 'workspace' | 'global' = 'project') {
  return addKnowledge(store, { type: 'memory', title, body, scope }, { via: 'ui', machineId: M1, projectId: P1, workspaceId: W1 }).item;
}

test('renderPromotedItem: one bullet, multi-line bodies indented under it', () => {
  assert.equal(renderPromotedItem({ title: 'Build', body: 'Run `make all`.' }), '- **Build**: Run `make all`.');
  assert.equal(renderPromotedItem({ title: 'Just a title', body: '' }), '- Just a title');
  assert.equal(renderPromotedItem({ title: ' Two\nlines ', body: 'First\n\nSecond' }), '- **Two lines**: First\n\n  Second');
  assert.equal(normalizeHeading('  ## Team notes  '), 'Team notes');
  assert.equal(normalizeHeading(''), DEFAULT_PROMOTE_HEADING);
});

test('appendSection: new file, existing file, and joining a trailing section with the same heading', () => {
  const items = [{ title: 'A', body: 'a' }];
  assert.equal(appendSection('', 'Notes', items), '## Notes\n\n- **A**: a\n');
  assert.equal(appendSection('# Repo\n\nIntro.\n', 'Notes', items), '\n## Notes\n\n- **A**: a\n');
  assert.equal(appendSection('# Repo\nIntro.', 'Notes', items), '\n\n## Notes\n\n- **A**: a\n', 'adds the missing final newline');
  assert.equal(appendSection('# Repo\n\n## Notes\n\n- **B**: b\n', 'Notes', items), '- **A**: a\n', 'joins the list');
  assert.equal(appendSection('# Repo\n\n## Notes\n\nSome prose.\n', 'Notes', items), '\n- **A**: a\n');
  assert.equal(appendSection('## Notes\n\n- x\n\n## Other\n\ny\n', 'Notes', items), '\n## Notes\n\n- **A**: a\n', 'only a trailing section is joined');
});

test('appendDiff: unified diff of an append', () => {
  assert.equal(appendDiff(undefined, '## N\n\n- a\n'), '--- /dev/null\n+++ b/AGENTS.md\n@@ -0,0 +1,3 @@\n+## N\n+\n+- a\n');
  assert.equal(appendDiff('', '## N\n'), '--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -0,0 +1,1 @@\n+## N\n');
  assert.equal(appendDiff('l1\nl2\nl3\nl4\n', '\n## N\n'), '--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -2,3 +2,5 @@\n l2\n l3\n l4\n+\n+## N\n');
  assert.equal(
    appendDiff('only', '\n\n## N\n'),
    '--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -1,1 +1,3 @@\n-only\n\\ No newline at end of file\n+only\n+\n+## N\n',
  );
});

test('planPromotion previews without writing; applyPromotion appends, tags `promoted`, and is not offered again', () => {
  const { store } = memStore();
  const { dir, cleanup } = tempDir();
  try {
    writeFileSync(join(dir, 'AGENTS.md'), '# acme\n\nUse pnpm.\n');
    const a = mem(store, 'Staging DB', 'Postgres on server-a:5433.');
    const b = mem(store, 'Flaky test', 'test_upload is flaky on CI.\nRetry once.', 'workspace');
    const other = addKnowledge(store, { type: 'memory', title: 'Elsewhere', body: 'x', scope: 'project' }, { via: 'ui', machineId: M1, projectId: P2 }).item;

    const plan = planPromotion(store, { workspacePath: dir, ids: [a.id, b.id, other.id, 'k_MISSING', a.id], heading: 'From memory', context: WS_CTX });
    assert.equal(plan.exists, true);
    assert.deepEqual(plan.items.map((i) => i.id), [a.id, b.id]);
    assert.deepEqual(plan.skipped, [
      { id: other.id, reason: 'not_visible' },
      { id: 'k_MISSING', reason: 'not_found' },
    ]);
    assert.equal(plan.appended, '\n## From memory\n\n- **Staging DB**: Postgres on server-a:5433.\n- **Flaky test**: test_upload is flaky on CI.\n  Retry once.\n');
    assert.match(plan.diff, /^--- a\/AGENTS\.md\n\+\+\+ b\/AGENTS\.md\n@@ -1,3 \+1,9 @@\n # acme\n \n Use pnpm\.\n\+\n\+## From memory\n/);
    assert.deepEqual(plan.warnings, []);
    assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), '# acme\n\nUse pnpm.\n', 'preview writes nothing');

    const res = applyPromotion(store, { workspacePath: dir, ids: [a.id, b.id], heading: 'From memory', baseHash: plan.baseHash });
    assert.equal(res.created, false);
    assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), plan.content);
    for (const id of [a.id, b.id]) assert.ok(store.require(id).tags.includes(PROMOTED_TAG));
    assert.equal(store.require(a.id).status, 'active', 'the memory stays live');

    // Not offered again; a stale preview conflicts.
    assert.throws(() => planPromotion(store, { workspacePath: dir, ids: [a.id] }), isCode('bad_request'));
    const c = mem(store, 'Deploys', 'Friday deploys need a second reviewer.');
    assert.throws(() => applyPromotion(store, { workspacePath: dir, ids: [c.id], baseHash: plan.baseHash }), isCode('conflict'));
    // Same heading at the end of the file: joins that section.
    const again = applyPromotion(store, { workspacePath: dir, ids: [c.id], heading: 'From memory' });
    assert.deepEqual(again.promoted.map((i) => i.id), [c.id]);
    assert.ok(readFileSync(join(dir, 'AGENTS.md'), 'utf8').endsWith('  Retry once.\n- **Deploys**: Friday deploys need a second reviewer.\n'));
  } finally {
    cleanup();
  }
});

test('promotion creates AGENTS.md when missing and warns about a CLAUDE.md that hides it', () => {
  const { store } = memStore();
  const { dir, cleanup } = tempDir();
  try {
    const a = mem(store, 'Build', 'make all', 'global');
    writeFileSync(join(dir, 'CLAUDE.md'), '# Claude notes\n');
    const plan = planPromotion(store, { workspacePath: dir, ids: [a.id] });
    assert.equal(plan.exists, false);
    assert.equal(plan.baseHash, ABSENT_FILE_HASH);
    assert.equal(plan.heading, DEFAULT_PROMOTE_HEADING);
    assert.match(plan.diff, /^--- \/dev\/null\n/);
    assert.equal(plan.warnings.length, 1);
    assert.match(plan.warnings[0]!, /CLAUDE\.md.*@AGENTS\.md/);
    writeFileSync(join(dir, 'CLAUDE.md'), '# Claude notes\n@AGENTS.md\n');
    assert.deepEqual(planPromotion(store, { workspacePath: dir, ids: [a.id] }).warnings, [], 'imported: no warning');

    const res = applyPromotion(store, { workspacePath: dir, ids: [a.id], baseHash: ABSENT_FILE_HASH });
    assert.equal(res.created, true);
    assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), `## ${DEFAULT_PROMOTE_HEADING}\n\n- **Build**: make all\n`);
    assert.throws(() => planPromotion(store, { workspacePath: dir, ids: [] }), isCode('bad_request'));
  } finally {
    cleanup();
  }
});
