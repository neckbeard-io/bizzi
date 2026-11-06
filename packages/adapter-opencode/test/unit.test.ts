import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BizziError } from '@bizzi/protocol';
import {
  approvalKind,
  decisionToReply,
  formQuestion,
  fromFormAnswer,
  parseModel,
  replyToDecision,
  sumUsage,
  toFormAnswer,
  todoItems,
  toolKind,
  toolTitle,
  usageOf,
} from '../src/mapping.ts';
import { parseJsonc } from '../src/probe.ts';
import { SseParser } from '../src/sse.ts';
import { eventSessionId } from '../src/types.ts';

test('SSE parser: frames, comments, CRLF, split chunks, multi-line data', () => {
  const p = new SseParser();
  assert.deepEqual(p.push('data: {"a":1}\n\n: heartbeat\n\n'), [{ data: '{"a":1}' }]);
  assert.deepEqual(p.push('id: 7\r\nevent: x\r\ndata: one\r\n'), []);
  assert.deepEqual(p.push('data: two\r'), []);
  assert.deepEqual(p.push('\n\r\n'), [{ id: '7', event: 'x', data: 'one\ntwo' }]);
  assert.deepEqual(p.push('da'), []);
  assert.deepEqual(p.push('ta:no-space\n\n'), [{ id: '7', data: 'no-space' }]);
});

test('tool kind mapping covers OpenCode v2 and v1 tool names', () => {
  const cases: Record<string, string> = {
    shell: 'shell',
    bash: 'shell',
    read: 'read',
    edit: 'edit',
    patch: 'edit',
    write: 'write',
    grep: 'search',
    glob: 'search',
    list: 'search',
    webfetch: 'web',
    websearch: 'web',
    subagent: 'task',
    task: 'task',
    execute: 'mcp',
    github_create_issue: 'mcp',
    skill: 'other',
    question: 'other',
  };
  for (const [name, kind] of Object.entries(cases)) assert.equal(toolKind(name), kind, name);
});

test('tool titles', () => {
  assert.equal(toolTitle('shell', { command: 'npm   test' }), 'npm test');
  assert.equal(toolTitle('read', { path: '/w/a.ts' }), '/w/a.ts');
  assert.equal(toolTitle('edit', { filePath: 'b.ts' }), 'b.ts');
  assert.equal(toolTitle('grep', { pattern: 'TODO', path: 'src' }), 'TODO in src');
  assert.equal(toolTitle('webfetch', { url: 'https://x.dev' }), 'https://x.dev');
  assert.equal(toolTitle('subagent', { description: 'Look around', prompt: 'ls' }), 'Look around');
  assert.equal(toolTitle('mystery', undefined), 'mystery');
});

test('approval kinds and decisions', () => {
  assert.equal(approvalKind('shell'), 'shell');
  assert.equal(approvalKind('edit'), 'edit');
  assert.equal(approvalKind('read'), 'read');
  assert.equal(approvalKind('webfetch'), 'web');
  assert.equal(approvalKind('execute'), 'mcp');
  assert.equal(approvalKind('external_directory'), 'other');
  assert.equal(approvalKind('doom_loop'), 'other');
  assert.equal(decisionToReply('allow'), 'once');
  assert.equal(decisionToReply('allow_always'), 'always');
  assert.equal(decisionToReply('deny'), 'reject');
  assert.equal(replyToDecision('once'), 'allow');
  assert.equal(replyToDecision('always'), 'allow_always');
  assert.equal(replyToDecision('reject'), 'deny');
});

test('parseModel', () => {
  assert.deepEqual(parseModel('anthropic/claude-sonnet-5'), { providerID: 'anthropic', id: 'claude-sonnet-5' });
  assert.deepEqual(parseModel('openrouter/meta/llama-5', 'high'), { providerID: 'openrouter', id: 'meta/llama-5', variant: 'high' });
  assert.deepEqual(parseModel('opencode/big-pickle#low'), { providerID: 'opencode', id: 'big-pickle', variant: 'low' });
  assert.throws(() => parseModel('gpt-5'), /provider\/model/);
});

test('todo items', () => {
  assert.deepEqual(todoItems({ todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress', id: 'x' }, { content: 'c' }] }), [
    { text: 'a', status: 'completed' },
    { text: 'b', status: 'in_progress', id: 'x' },
    { text: 'c', status: 'pending' },
  ]);
  assert.equal(todoItems({}), undefined);
});

test('eventSessionId', () => {
  assert.equal(eventSessionId({ type: 'session.text.delta', data: { sessionID: 'ses_1' } }), 'ses_1');
  assert.equal(eventSessionId({ type: 'form.created', data: { form: { sessionID: 'ses_2' } } }), 'ses_2');
  assert.equal(eventSessionId({ type: 'shell.created', data: { info: { metadata: { sessionID: 'ses_3' } } } }), 'ses_3');
  assert.equal(eventSessionId({ type: 'server.connected', data: {} }), undefined);
});

test('forms: questions, answers both ways', () => {
  const form = {
    id: 'frm_1',
    sessionID: 'ses_1',
    title: 'Connect',
    fields: [
      { key: 'env', type: 'string', title: 'Env', options: [{ value: 'prod-1', label: 'Production' }], custom: false },
      { key: 'tags', type: 'multiselect', title: 'Tags', options: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }] },
      { key: 'auth', type: 'external', title: 'Sign in', url: 'https://example.com/login' },
      { key: 'secret', type: 'string', hidden: true },
    ],
  };
  const q = formQuestion(form);
  assert.equal(q.text, 'Connect\nEnv');
  assert.deepEqual(q.options, ['Production']);
  assert.deepEqual(q.questions.map((x) => x.id), ['env', 'tags', 'auth']);
  assert.equal(q.questions[0]!.allowText, undefined, 'custom:false → options only');
  assert.equal(q.questions[2]!.text, 'Sign in: https://example.com/login');
  assert.deepEqual(toFormAnswer(form, { env: 'Production', tags: ['Beta', 'zeta'] }), { env: 'prod-1', tags: ['b', 'zeta'] });
  assert.throws(() => toFormAnswer(form, { env: 'staging' }), (e: unknown) => e instanceof BizziError && e.code === 'bad_request');
  assert.throws(() => toFormAnswer(form, { auth: 'x' }), (e: unknown) => e instanceof BizziError && e.code === 'bad_request');
  assert.deepEqual(fromFormAnswer(form, { env: 'prod-1', tags: ['a'] }), { env: 'Production', tags: ['Alpha'] });
});

test('usage helpers', () => {
  const a = usageOf({ input: 10, output: 2, reasoning: 3, cache: { read: 4, write: 1 } }, 0.5);
  assert.deepEqual(a, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 4, cacheWriteTokens: 1, costUsd: 0.5 });
  assert.deepEqual(sumUsage([a, { inputTokens: 1, costUsd: 0.25 }]), { inputTokens: 11, outputTokens: 5, cacheReadTokens: 4, cacheWriteTokens: 1, costUsd: 0.75 });
});

test('parseJsonc handles comments, trailing commas and strings with slashes', () => {
  const v = parseJsonc('{\n // c\n "a": "http://x/*y*/", /* b */ "providers": { "p1": {}, },\n}');
  assert.deepEqual(v, { a: 'http://x/*y*/', providers: { p1: {} } });
});
