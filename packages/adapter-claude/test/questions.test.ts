// Questions (AskUserQuestion, MCP elicitation), subagent text, server tool results, dispose.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BizziError } from '@bizzi/protocol';
import type { StartSessionOptions } from '@bizzi/protocol';
import { ClaudeAdapter } from '../src/index.ts';
import type { ClaudeSession } from '../src/session.ts';
import { askUserQuestionAnswers, elicitationForm, serverToolResult } from '../src/mapping.ts';
import { assistant, collector, fakeQueryFn, result, silentLogger, streamText, tick, toolResult, toolUse, waitFor } from './fake.ts';
import type { Script } from './fake.ts';

const base: StartSessionOptions = { sessionId: 's_q', mode: 'structured', cwd: '/tmp/ws' };

async function setup(script: Script) {
  const fq = fakeQueryFn(script);
  const adapter = new ClaudeAdapter({ claudePath: null, queryFn: fq.queryFn, hasTranscript: async () => true });
  const c = collector();
  const session = (await adapter.start(base, c.emit, { logger: silentLogger })) as ClaudeSession;
  return { adapter, session, c, fq: fq.last() };
}

// Shape of a real AskUserQuestion tool input (Claude Code 2.1.311).
const ASK = {
  questions: [
    {
      question: 'Which database should we use?',
      header: 'Database',
      multiSelect: false,
      options: [
        { label: 'Postgres', description: 'Relational, needs a server' },
        { label: 'SQLite', description: 'Embedded file database' },
      ],
    },
    {
      question: 'Which features do you want?',
      header: 'Features',
      multiSelect: true,
      options: [
        { label: 'Auth', description: 'Login' },
        { label: 'Search', description: 'Full text' },
        { label: 'Export', description: 'CSV' },
      ],
    },
  ],
};

test('launch options wire questions: onElicitation, forwardSubagentText', async () => {
  const { fq, session } = await setup(() => {});
  assert.equal(typeof fq.options.onElicitation, 'function');
  assert.equal(fq.options.forwardSubagentText, true);
  await session.stop();
});

test('AskUserQuestion -> question.asked with full questions[]; answers go back as updatedInput.answers', async () => {
  let decision: unknown;
  const { session, c } = await setup(async (fq, u) => {
    fq.emit(toolUse('m', 'toolu_q', 'AskUserQuestion', ASK));
    decision = await fq.ask('AskUserQuestion', ASK, { toolUseID: 'toolu_q' });
    fq.emit(toolResult('toolu_q', 'User has answered your questions: ...'), result([u.uuid!], 0));
  });
  await session.send('t', [{ type: 'text', text: 'ask me' }]);
  await waitFor(() => c.of('question.asked').length === 1);
  assert.equal(c.of('approval.requested').length, 0, 'no approval for AskUserQuestion');
  const q = c.of('question.asked')[0]!;
  assert.match(q.questionId, /^q_/);
  assert.deepEqual({ ...q, questionId: 'X' }, {
    questionId: 'X',
    text: 'Which database should we use?',
    options: ['Postgres', 'SQLite'],
    questions: [
      {
        id: 'Which database should we use?',
        text: 'Which database should we use?',
        header: 'Database',
        allowText: true,
        options: [
          { label: 'Postgres', description: 'Relational, needs a server' },
          { label: 'SQLite', description: 'Embedded file database' },
        ],
      },
      {
        id: 'Which features do you want?',
        text: 'Which features do you want?',
        header: 'Features',
        allowText: true,
        multiSelect: true,
        options: [
          { label: 'Auth', description: 'Login' },
          { label: 'Search', description: 'Full text' },
          { label: 'Export', description: 'CSV' },
        ],
      },
    ],
  });
  assert.deepEqual(c.of('session.status').at(-1), { status: 'waiting_input', prompt: 'input' });

  await assert.rejects(session.respondQuestion('q_nope', {}), (e: unknown) => e instanceof BizziError && e.code === 'not_found');
  await assert.rejects(
    session.respondQuestion(q.questionId, { a: 1 as unknown as string }),
    (e: unknown) => e instanceof BizziError && e.code === 'bad_request',
  );
  const answers = { 'Which database should we use?': 'SQLite', 'Which features do you want?': ['Auth', 'Export'] };
  await session.respondQuestion(q.questionId, answers);
  await waitFor(() => c.of('turn.completed').length === 1);
  assert.deepEqual(decision, {
    behavior: 'allow',
    updatedInput: { ...ASK, answers: { 'Which database should we use?': 'SQLite', 'Which features do you want?': 'Auth, Export' } },
  });
  assert.deepEqual(c.of('question.resolved'), [{ questionId: q.questionId, answers }]);
  assert.deepEqual(c.of('tool.completed'), [{ toolId: 'toolu_q', status: 'ok', output: 'User has answered your questions: ...' }]);
  const order = c.events.map((e) => e.type).filter((t) => t.startsWith('question') || t === 'session.status' || t.startsWith('tool'));
  assert.deepEqual(order, ['tool.started', 'question.asked', 'session.status', 'question.resolved', 'session.status', 'tool.completed']);
  assert.deepEqual(c.of('session.status').at(-1), { status: 'running' });
  await assert.rejects(session.respondQuestion(q.questionId, answers), (e: unknown) => e instanceof BizziError && e.code === 'not_found');
  await session.stop();
});

test('AskUserQuestion declined -> deny, question.resolved cancelled, tool denied', async () => {
  let decision: unknown;
  const { session, c } = await setup(async (fq, u) => {
    decision = await fq.ask('AskUserQuestion', ASK, { toolUseID: 'toolu_q' });
    fq.emit(toolResult('toolu_q', 'User declined to answer questions', true), result([u.uuid!], 0));
  });
  await session.send('t', [{ type: 'text', text: 'ask me' }]);
  await waitFor(() => c.of('question.asked').length === 1);
  const q = c.of('question.asked')[0]!;
  await session.respondQuestion(q.questionId, undefined);
  await waitFor(() => c.of('turn.completed').length === 1);
  assert.deepEqual(decision, { behavior: 'deny', message: 'The user declined to answer.' });
  assert.deepEqual(c.of('question.resolved'), [{ questionId: q.questionId, cancelled: true }]);
  assert.deepEqual(c.of('tool.completed').map((t) => t.status), ['denied']);
  await session.stop();
});

test('interrupt cancels a pending question; stop cancels a pending approval', async () => {
  {
    let decision: unknown;
    const { session, c, fq } = await setup(async (fq) => {
      decision = await fq.ask('AskUserQuestion', ASK, { toolUseID: 'toolu_q' });
    });
    fq.onInterrupt = () => fq.emit(result([fq.received[0]!.uuid!], 0, { subtype: 'error_during_execution', is_error: true, errors: [] }));
    await session.send('t', [{ type: 'text', text: 'ask me' }]);
    await waitFor(() => c.of('question.asked').length === 1);
    await session.interrupt();
    await waitFor(() => c.of('turn.completed').length === 1);
    assert.deepEqual(decision, { behavior: 'deny', message: 'The question was cancelled.', interrupt: true });
    assert.deepEqual(c.of('question.resolved'), [{ questionId: c.of('question.asked')[0]!.questionId, cancelled: true }]);
    assert.equal(c.of('turn.completed')[0]!.stopReason, 'interrupted');
    await session.stop();
  }
  {
    let decision: unknown;
    const { session, c } = await setup(async (fq) => {
      decision = await fq.ask('Bash', { command: 'make' }, { toolUseID: 'b' });
    });
    await session.send('t', [{ type: 'text', text: 'build' }]);
    await waitFor(() => c.of('approval.requested').length === 1);
    await session.stop();
    await tick();
    assert.deepEqual(decision, { behavior: 'deny', message: 'Session stopped.', interrupt: true });
    assert.deepEqual(c.of('approval.resolved'), [{ approvalId: c.of('approval.requested')[0]!.approvalId, decision: 'cancelled', by: 'bizzi' }]);
    assert.deepEqual(c.of('turn.completed').map((t) => t.stopReason), ['interrupted']);
  }
});

test('process death cancels pending approvals and questions', async () => {
  const { session, c, fq } = await setup(async (fq) => {
    void fq.ask('Bash', { command: 'make' }, { toolUseID: 'b' });
    void fq.elicit({ serverName: 'gh', message: 'Pick a repo', mode: 'form', requestedSchema: { type: 'object', properties: { repo: { type: 'string' } } } });
  });
  await session.send('t', [{ type: 'text', text: 'x' }]);
  await waitFor(() => c.of('question.asked').length === 1 && c.of('approval.requested').length === 1);
  fq.crash('boom');
  await waitFor(() => c.of('session.status').some((s) => s.status === 'failed'));
  assert.deepEqual(c.of('approval.resolved').map((r) => r.decision), ['cancelled']);
  assert.deepEqual(c.of('question.resolved').map((r) => r.cancelled), [true]);
  assert.deepEqual(c.of('turn.completed').map((t) => t.stopReason), ['error']);
});

test('SDK abort of a pending permission request -> approval.resolved cancelled by agent', async () => {
  const ac = new AbortController();
  let decision: unknown;
  const { session, c } = await setup(async (fq) => {
    decision = await fq.ask('Bash', { command: 'make' }, { toolUseID: 'b', signal: ac.signal });
  });
  await session.send('t', [{ type: 'text', text: 'x' }]);
  await waitFor(() => c.of('approval.requested').length === 1);
  ac.abort();
  await waitFor(() => decision !== undefined);
  assert.deepEqual(c.of('approval.resolved').map((r) => [r.decision, r.by]), [['cancelled', 'agent']]);
  await session.stop();
});

test('MCP elicitation (form) -> questions; answers become typed content', async () => {
  const { session, c, fq } = await setup(() => {});
  const req = {
    serverName: 'deploy',
    message: 'Configure the deployment',
    mode: 'form',
    requestedSchema: {
      type: 'object',
      properties: {
        env: { type: 'string', title: 'Environment', enum: ['staging', 'prod'] },
        replicas: { type: 'integer', description: 'How many replicas?' },
        confirm: { type: 'boolean', title: 'Run migrations' },
        regions: { type: 'array', items: { enum: ['eu', 'us', 'ap'] } },
        note: { type: 'string' },
      },
      required: ['env', 'replicas'],
    },
  };
  const pending = fq.elicit(req);
  await waitFor(() => c.of('question.asked').length === 1);
  const q = c.of('question.asked')[0]!;
  assert.equal(q.text, 'Environment');
  assert.deepEqual(q.options, ['staging', 'prod']);
  assert.deepEqual(q.questions, [
    { id: 'env', text: 'Environment', header: 'Environment', options: [{ label: 'staging' }, { label: 'prod' }] },
    { id: 'replicas', text: 'How many replicas?', header: 'replicas', allowText: true },
    { id: 'confirm', text: 'Run migrations (optional)', header: 'Run migrations', options: [{ label: 'Yes' }, { label: 'No' }] },
    { id: 'regions', text: 'regions (optional)', header: 'regions', options: [{ label: 'eu' }, { label: 'us' }, { label: 'ap' }], multiSelect: true },
    { id: 'note', text: 'note (optional)', header: 'note', allowText: true },
  ]);
  await session.respondQuestion(q.questionId, { env: 'prod', replicas: '3', confirm: 'No', regions: ['eu', 'ap'] });
  assert.deepEqual(await pending, { action: 'accept', content: { env: 'prod', replicas: 3, confirm: false, regions: ['eu', 'ap'] } });
  assert.equal(c.of('question.resolved').length, 1);
  await session.stop();
});

test('MCP elicitation: URL mode confirm, decline, and SDK abort', async () => {
  const { session, c, fq } = await setup(() => {});
  const url = fq.elicit({ serverName: 'gh', message: 'Sign in to GitHub', mode: 'url', url: 'https://github.com/login/device', elicitationId: 'e1' });
  await waitFor(() => c.of('question.asked').length === 1);
  const q1 = c.of('question.asked')[0]!;
  assert.deepEqual(q1.questions, [
    { id: 'confirm', text: 'Sign in to GitHub\nhttps://github.com/login/device', header: 'gh', options: [{ label: 'Accept' }, { label: 'Decline' }] },
  ]);
  await session.respondQuestion(q1.questionId, { confirm: 'Accept' });
  assert.deepEqual(await url, { action: 'accept' });

  const declined = fq.elicit({ serverName: 'gh', message: 'Pick', mode: 'form', requestedSchema: { type: 'object', properties: { x: { type: 'string' } } } });
  await waitFor(() => c.of('question.asked').length === 2);
  await session.respondQuestion(c.of('question.asked')[1]!.questionId, undefined);
  assert.deepEqual(await declined, { action: 'decline' });

  const viaOption = fq.elicit({ serverName: 'gh', message: 'Allow?', mode: 'form', requestedSchema: { type: 'object', properties: {} } });
  await waitFor(() => c.of('question.asked').length === 3);
  await session.respondQuestion(c.of('question.asked')[2]!.questionId, { confirm: 'Decline' });
  assert.deepEqual(await viaOption, { action: 'decline' });

  const ac = new AbortController();
  const aborted = fq.elicit({ serverName: 'gh', message: 'Allow?' }, ac.signal);
  await waitFor(() => c.of('question.asked').length === 4);
  ac.abort();
  assert.deepEqual(await aborted, { action: 'cancel' });
  assert.deepEqual(c.of('question.resolved').at(-1), { questionId: c.of('question.asked')[3]!.questionId, cancelled: true });
  await session.stop();
});

test('subagent text and thinking carry parentToolId (forwardSubagentText)', async () => {
  const sub = (o: object) => ({ ...o, parent_tool_use_id: 'ta' });
  const { session, c } = await setup((fq, u) => {
    fq.emit(
      toolUse('m1', 'ta', 'Agent', { description: 'Look around', prompt: 'List files', subagent_type: 'Explore' }),
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'List files' }] }, parent_tool_use_id: 'ta', session_id: 's', uuid: 'sub-u1' },
      ...streamText('sm1', 0, ['Fou', 'nd']).map(sub),
      assistant('sm1', { type: 'thinking', thinking: 'hmm', signature: 's' }, { parent_tool_use_id: 'ta' }),
      assistant('sm1', { type: 'text', text: 'Found 2 files' }, { parent_tool_use_id: 'ta' }),
      toolResult('ta', 'Found 2 files'),
      assistant('m2', { type: 'text', text: 'Done' }),
      result([u.uuid!], 0),
    );
  });
  await session.send('t', [{ type: 'text', text: 'go' }]);
  await waitFor(() => c.of('turn.completed').length === 1);
  assert.deepEqual(c.of('message.delta').map((d) => [d.messageId, d.text, d.parentToolId]), [
    ['sm1:t0', 'Fou', 'ta'],
    ['sm1:t0', 'nd', 'ta'],
  ]);
  assert.deepEqual(c.of('reasoning.completed'), [{ messageId: 'sm1:r0', text: 'hmm', parentToolId: 'ta' }]);
  assert.deepEqual(c.of('message.completed'), [
    { messageId: 'sub-u1', role: 'user', text: 'List files', parentToolId: 'ta' },
    { messageId: 'sm1:t0', role: 'assistant', text: 'Found 2 files', parentToolId: 'ta' },
    { messageId: 'm2:t0', role: 'assistant', text: 'Done' },
  ]);
  await session.stop();
});

test('server-side tool results -> tool.completed', async () => {
  const { session, c } = await setup((fq, u) => {
    fq.emit(
      assistant('m', { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'bizzi' } }),
      assistant('m', {
        type: 'web_search_tool_result',
        tool_use_id: 'srvtoolu_1',
        content: [
          { type: 'web_search_result', title: 'Bizzi', url: 'https://example.com/b', encrypted_content: 'x', page_age: null },
          { type: 'web_search_result', title: 'Other', url: 'https://example.com/o', encrypted_content: 'y', page_age: null },
        ],
      }),
      assistant('m', { type: 'server_tool_use', id: 'srvtoolu_2', name: 'web_search', input: { query: 'x' } }),
      assistant('m', { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_2', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } }),
      assistant('m', { type: 'server_tool_use', id: 'srvtoolu_3', name: 'code_execution', input: { code: 'print(1)' } }),
      assistant('m', { type: 'code_execution_tool_result', tool_use_id: 'srvtoolu_3', content: { type: 'code_execution_result', stdout: '1\n', stderr: '', return_code: 0, content: [] } }),
      result([u.uuid!], 0),
    );
  });
  await session.send('t', [{ type: 'text', text: 'search' }]);
  await waitFor(() => c.of('turn.completed').length === 1);
  assert.deepEqual(c.of('tool.started').map((t) => [t.toolId, t.name]), [
    ['srvtoolu_1', 'web_search'],
    ['srvtoolu_2', 'web_search'],
    ['srvtoolu_3', 'code_execution'],
  ]);
  assert.deepEqual(c.of('tool.completed'), [
    { toolId: 'srvtoolu_1', status: 'ok', output: 'Bizzi — https://example.com/b\nOther — https://example.com/o' },
    { toolId: 'srvtoolu_2', status: 'error', error: 'max_uses_exceeded' },
    { toolId: 'srvtoolu_3', status: 'ok', output: '1\n' },
  ]);
  assert.equal(c.of('agent.raw').length, 0);
  await session.stop();
});

test('usage: turn.completed carries per-turn usage, usage.updated the session total', async () => {
  let n = 0;
  const { session, c } = await setup((fq, u) => {
    n++;
    const total = { inputTokens: 10 * n, outputTokens: 5 * n, cacheReadInputTokens: 100 * n, cacheCreationInputTokens: 20 * n, webSearchRequests: 0, costUSD: 0.01 * n, contextWindow: 200000, maxOutputTokens: 64000 };
    fq.emit(result([u.uuid!], 0.01 * n, { modelUsage: { 'claude-haiku-5-5': total } }));
  });
  await session.send('t1', [{ type: 'text', text: 'a' }]);
  await waitFor(() => c.of('turn.completed').length === 1);
  await session.send('t2', [{ type: 'text', text: 'b' }]);
  await waitFor(() => c.of('turn.completed').length === 2);
  const [u1, u2] = c.of('usage.updated');
  assert.equal(u1!.inputTokens, 10);
  assert.equal(u2!.inputTokens, 20, 'usage.updated is cumulative');
  const [d1, d2] = c.of('turn.completed');
  assert.equal(d1!.usage?.inputTokens, 10);
  assert.equal(d2!.usage?.inputTokens, 10, 'turn.completed usage is per turn');
  assert.ok(Math.abs((d2!.usage?.costUsd ?? 0) - 0.01) < 1e-9);
  await session.stop();
});

test('usage after resume: the first turn omits cost (cumulative cost is restored), later turns get the delta', async () => {
  const fq = fakeQueryFn((fq, u) => {
    // The CLI restores the conversation's cumulative cost (0.05 before this process) on resume.
    fq.emit(result([u.uuid!], fq.received.length === 1 ? 0.06 : 0.08));
  });
  const adapter = new ClaudeAdapter({ claudePath: null, queryFn: fq.queryFn, hasTranscript: async () => true });
  const c = collector();
  const session = await adapter.start({ ...base, resumeRef: 'abc' }, c.emit, { logger: silentLogger });
  await session.send('t1', [{ type: 'text', text: 'a' }]);
  await waitFor(() => c.of('turn.completed').length === 1);
  await session.send('t2', [{ type: 'text', text: 'b' }]);
  await waitFor(() => c.of('turn.completed').length === 2);
  const [d1, d2] = c.of('turn.completed');
  assert.equal(d1!.usage?.costUsd, undefined);
  assert.equal(d1!.usage?.inputTokens, 10);
  assert.ok(Math.abs((d2!.usage?.costUsd ?? 0) - 0.02) < 1e-9);
  assert.equal(c.of('usage.updated').at(-1)?.costUsd, 0.08);
  await session.stop();
});

test('an elicitation between turns returns the session to idle once answered', async () => {
  const { session, c, fq } = await setup(() => {});
  const p = fq.elicit({ serverName: 'gh', message: 'Allow?' });
  await waitFor(() => c.of('question.asked').length === 1);
  await session.respondQuestion(c.of('question.asked')[0]!.questionId, { confirm: 'Accept' });
  assert.deepEqual(await p, { action: 'accept', content: {} });
  assert.deepEqual(c.of('session.status'), [{ status: 'waiting_input', prompt: 'input' }, { status: 'idle' }]);
  await session.stop();
});

test('dispose stops every live session', async () => {
  const fq = fakeQueryFn(() => {});
  const adapter = new ClaudeAdapter({ claudePath: null, queryFn: fq.queryFn, hasTranscript: async () => true });
  const c1 = collector();
  const c2 = collector();
  const s1 = await adapter.start({ ...base, sessionId: 'a' }, c1.emit, { logger: silentLogger });
  await adapter.start({ ...base, sessionId: 'b' }, c2.emit, { logger: silentLogger });
  await s1.send('t', [{ type: 'text', text: 'x' }]);
  await adapter.dispose();
  await adapter.dispose();
  assert.deepEqual(c1.of('session.status'), [{ status: 'ended' }]);
  assert.deepEqual(c2.of('session.status'), [{ status: 'ended' }]);
  assert.deepEqual(c1.of('turn.completed').map((t) => t.stopReason), ['interrupted']);
});

test('mapping: answers keyed by header or index; elicitation edge cases; server result shapes', () => {
  assert.deepEqual(askUserQuestionAnswers(ASK, { Database: 'Postgres', 1: ['Search'] }), {
    'Which database should we use?': 'Postgres',
    'Which features do you want?': 'Search',
  });
  assert.deepEqual(askUserQuestionAnswers(ASK, {}), {});
  const one = elicitationForm({ message: 'Name the branch', requestedSchema: { type: 'object', properties: { name: { type: 'string', description: 'Branch name' } } } });
  assert.deepEqual(one.items, [{ id: 'name', text: 'Name the branch\nBranch name', header: 'name', allowText: true }]);
  assert.deepEqual(one.content({ name: 'feat/x' }), { name: 'feat/x' });
  const oneOf = elicitationForm({ message: 'm', requestedSchema: { properties: { size: { type: 'string', oneOf: [{ const: 's', title: 'Small' }, { const: 'l', title: 'Large' }] } } } });
  assert.deepEqual(oneOf.items[0]!.options, [{ label: 'Small' }, { label: 'Large' }]);
  assert.deepEqual(oneOf.content({ size: 'Large' }), { size: 'l' });
  assert.deepEqual(serverToolResult({ type: 'mcp_tool_result', tool_use_id: 'x', is_error: true, content: [{ type: 'text', text: 'nope' }] }), { status: 'error', text: 'nope' });
  assert.deepEqual(serverToolResult({ type: 'web_fetch_tool_result', tool_use_id: 'x', content: { type: 'web_fetch_result', url: 'https://a.b' } }), { status: 'ok', text: 'https://a.b' });
  assert.deepEqual(serverToolResult({ type: 'bash_code_execution_tool_result', tool_use_id: 'x', content: { type: 'bash_code_execution_result', stdout: '', stderr: '', return_code: 2 } }), { status: 'error', text: 'exit code 2' });
});
