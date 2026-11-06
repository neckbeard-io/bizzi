import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalKind, toolKind, toolTitle } from '../src/index.ts';
import { trimOutput } from '../src/mapping.ts';

test('tool kinds', () => {
  const cases: [string, string][] = [
    ['Bash', 'shell'],
    ['Read', 'read'],
    ['Edit', 'edit'],
    ['MultiEdit', 'edit'],
    ['NotebookEdit', 'edit'],
    ['Write', 'write'],
    ['Grep', 'search'],
    ['Glob', 'search'],
    ['LS', 'search'],
    ['WebFetch', 'web'],
    ['WebSearch', 'web'],
    ['mcp__github__create_issue', 'mcp'],
    ['Task', 'task'],
    ['Agent', 'task'],
    ['TodoWrite', 'other'],
    ['Skill', 'other'],
  ];
  for (const [name, kind] of cases) assert.equal(toolKind(name), kind, name);
});

test('approval kinds', () => {
  assert.equal(approvalKind('Bash'), 'shell');
  assert.equal(approvalKind('Glob'), 'read');
  assert.equal(approvalKind('ExitPlanMode'), 'plan');
  assert.equal(approvalKind('mcp__x__y'), 'mcp');
  assert.equal(approvalKind('Task'), 'other');
});

test('tool titles', () => {
  assert.equal(toolTitle('Bash', { command: 'git   status\n --short' }), 'git status --short');
  assert.equal(toolTitle('Read', { file_path: '/a/b.ts' }), '/a/b.ts');
  assert.equal(toolTitle('Glob', { pattern: '**/*.ts' }), '**/*.ts');
  assert.equal(toolTitle('WebSearch', { query: 'node 26' }), 'node 26');
  assert.equal(toolTitle('Agent', { description: 'Review', subagent_type: 'reviewer' }), 'Review (reviewer)');
  assert.equal(toolTitle('mcp__bizzi__memory_add', {}), 'bizzi: memory_add');
  assert.equal(toolTitle('Mystery', { description: 'does things' }), 'Mystery: does things');
  assert.equal(toolTitle('Mystery', null), 'Mystery');
  assert.ok(toolTitle('Bash', { command: 'x'.repeat(500) }).length <= 160);
});

test('trimOutput keeps head and tail', () => {
  assert.equal(trimOutput('short', 100), 'short');
  const t = trimOutput('a'.repeat(1000) + 'END', 100);
  assert.ok(t.startsWith('aaa'));
  assert.ok(t.endsWith('END'));
  assert.match(t, /chars trimmed/);
});
