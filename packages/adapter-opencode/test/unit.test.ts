import assert from 'node:assert/strict';
import { test } from 'node:test';
import { approvalKind, decisionToReply, parseModel, replyToDecision, todoItems, toolKind, toolTitle } from '../src/mapping.ts';
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

test('parseJsonc handles comments, trailing commas and strings with slashes', () => {
  const v = parseJsonc('{\n // c\n "a": "http://x/*y*/", /* b */ "providers": { "p1": {}, },\n}');
  assert.deepEqual(v, { a: 'http://x/*y*/', providers: { p1: {} } });
});
