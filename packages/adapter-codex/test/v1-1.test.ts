// Protocol v1.1 features: questions (requestUserInput, MCP elicitation), fork, cancellation, usage, dispose.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BizziError } from '@bizzi/protocol';
import { CODEX_STRUCTURED_CAPABILITIES, elicitationQuestions, elicitationResponse, userInputQuestions, userInputResponse } from '../src/index.ts';
import { ctx, EventLog, fakeAdapter, startOpts } from './helpers.ts';

const text = (t: string) => [{ type: 'text' as const, text: t }];

test('capabilities advertise fork and questions', () => {
  assert.equal(CODEX_STRUCTURED_CAPABILITIES.fork, true);
  assert.equal(CODEX_STRUCTURED_CAPABILITIES.questions, true);
});

test('requestUserInput -> question.asked; respondQuestion replies with per-question answers', async () => {
  const log = new EventLog();
  const s = await fakeAdapter().start(startOpts(), log.emit, ctx());
  try {
    await s.send('t_q', text('ask'));
    const q = await log.waitFor('question.asked');
    assert.match(q.questionId, /^q_/);
    assert.deepEqual({ ...q, questionId: 'X' }, {
      questionId: 'X',
      text: 'Which database?',
      options: ['Postgres', 'SQLite'],
      questions: [
        {
          id: 'q_db',
          text: 'Which database?',
          header: 'Database',
          options: [{ label: 'Postgres', description: 'server' }, { label: 'SQLite' }],
        },
        { id: 'q_name', text: 'Project name?', header: 'Name', allowText: true },
      ],
    });
    assert.deepEqual(log.ofType('session.status').at(-1), { status: 'waiting_input', prompt: 'input' });

    await s.respondQuestion!(q.questionId, { q_db: 'SQLite', q_name: 'bizzi' });
    const resolved = await log.waitFor('question.resolved');
    assert.deepEqual(resolved, { questionId: q.questionId, answers: { q_db: 'SQLite', q_name: 'bizzi' } });
    assert.deepEqual(log.ofType('session.status').at(-1), { status: 'running' });
    const done = await log.waitFor('turn.completed');
    assert.equal(done.stopReason, 'end_turn');
    assert.equal(
      log.ofType('message.delta').at(-1)?.text,
      `reply:${JSON.stringify({ answers: { q_db: { answers: ['SQLite'] }, q_name: { answers: ['bizzi'] } } })}`,
    );
    await assert.rejects(s.respondQuestion!(q.questionId, {}), (e: unknown) => e instanceof BizziError && e.code === 'not_found');
  } finally {
    await s.stop();
  }
});

test('requestUserInput declined -> empty answers, question.resolved cancelled; bad answers rejected', async () => {
  const log = new EventLog();
  const s = await fakeAdapter().start(startOpts(), log.emit, ctx());
  try {
    await s.send('t_q', text('ask'));
    const q = await log.waitFor('question.asked');
    await assert.rejects(
      s.respondQuestion!(q.questionId, { q_db: 3 } as never),
      (e: unknown) => e instanceof BizziError && e.code === 'bad_request',
    );
    await s.respondQuestion!(q.questionId, undefined);
    assert.deepEqual(await log.waitFor('question.resolved'), { questionId: q.questionId, cancelled: true });
    await log.waitFor('turn.completed');
    assert.equal(log.ofType('message.delta').at(-1)?.text, `reply:${JSON.stringify({ answers: {} })}`);
  } finally {
    await s.stop();
  }
});

test('a question withdrawn by codex (serverRequest/resolved) resolves as cancelled', async () => {
  const log = new EventLog();
  const s = await fakeAdapter().start(startOpts(), log.emit, ctx());
  try {
    await s.send('t_q', text('askauto'));
    const q = await log.waitFor('question.asked');
    assert.deepEqual(await log.waitFor('question.resolved'), { questionId: q.questionId, cancelled: true });
    await log.waitFor('turn.completed');
    await assert.rejects(s.respondQuestion!(q.questionId, {}), (e: unknown) => e instanceof BizziError && e.code === 'not_found');
  } finally {
    await s.stop();
  }
});

test('a question asked between turns: status goes waiting_input -> idle when it resolves', async () => {
  const log = new EventLog();
  const s = await fakeAdapter().start(startOpts(), log.emit, ctx());
  try {
    await s.send('t_late', text('lateask'));
    await log.waitFor('turn.completed');
    const q = await log.waitFor('question.asked');
    assert.deepEqual(log.ofType('session.status').at(-1), { status: 'waiting_input', prompt: 'input' });
    await s.respondQuestion!(q.questionId, { confirm: 'Accept' });
    assert.deepEqual(await log.waitFor('question.resolved'), { questionId: q.questionId, answers: { confirm: 'Accept' } });
    assert.deepEqual(log.ofType('session.status').at(-1), { status: 'idle' });
  } finally {
    await s.stop();
  }
  // Cancelled at stop: no status besides 'ended'.
  const log2 = new EventLog();
  const s2 = await fakeAdapter().start(startOpts(), log2.emit, ctx());
  await s2.send('t_late', text('lateask'));
  await log2.waitFor('question.asked');
  await s2.stop();
  assert.deepEqual(log2.ofType('question.resolved').map((r) => r.cancelled), [true]);
  assert.deepEqual(log2.ofType('session.status').map((x) => x.status), ['waiting_input', 'ended']);
});

test('MCP elicitation (form) -> one question per field; answers become typed content', async () => {
  const log = new EventLog();
  const s = await fakeAdapter().start(startOpts(), log.emit, ctx());
  try {
    await s.send('t_e', text('elicit'));
    const q = await log.waitFor('question.asked');
    assert.equal(q.text, 'Deployment settings');
    assert.deepEqual(q.questions, [
      { id: 'env', text: 'Environment', header: 'Environment', options: [{ label: 'Production' }, { label: 'Staging' }] },
      { id: 'replicas', text: 'How many replicas?', header: 'Replicas', allowText: true },
      { id: 'confirm', text: 'Confirm (optional)', header: 'Confirm', options: [{ label: 'Yes' }, { label: 'No' }] },
      { id: 'regions', text: 'Regions (optional)', header: 'Regions', options: [{ label: 'us' }, { label: 'eu' }], multiSelect: true },
      { id: 'note', text: 'Note (optional)', header: 'Note', allowText: true },
    ]);
    await assert.rejects(
      s.respondQuestion!(q.questionId, { env: 'Production', replicas: 'many' }),
      (e: unknown) => e instanceof BizziError && e.code === 'bad_request',
    );
    await s.respondQuestion!(q.questionId, { env: 'Production', replicas: '3', confirm: 'Yes', regions: ['us', 'eu'], note: '' });
    await log.waitFor('turn.completed');
    assert.equal(
      log.ofType('message.delta').at(-1)?.text,
      `reply:${JSON.stringify({ action: 'accept', content: { env: 'prod', replicas: 3, confirm: true, regions: ['us', 'eu'] }, _meta: null })}`,
    );
  } finally {
    await s.stop();
  }
});

test('interrupt with a pending question: question.resolved cancelled, turn interrupted', async () => {
  const log = new EventLog();
  const s = await fakeAdapter().start(startOpts(), log.emit, ctx());
  try {
    await s.send('t_q', text('elicit'));
    const q = await log.waitFor('question.asked');
    await s.interrupt();
    assert.deepEqual(await log.waitFor('question.resolved'), { questionId: q.questionId, cancelled: true });
    const done = await log.waitFor('turn.completed');
    assert.equal(done.stopReason, 'interrupted');
    assert.equal(log.ofType('turn.completed').length, 1);
  } finally {
    await s.stop();
  }
});

test('stop with a pending approval: approval.resolved cancelled, one turn.completed', async () => {
  const log = new EventLog();
  const s = await fakeAdapter().start(startOpts(), log.emit, ctx());
  await s.send('t_ap', text('approve'));
  const req = await log.waitFor('approval.requested');
  await s.stop();
  assert.deepEqual(log.ofType('approval.resolved'), [{ approvalId: req.approvalId, decision: 'cancelled', by: 'bizzi' }]);
  assert.deepEqual(log.ofType('turn.completed'), [{ turnId: 't_ap', stopReason: 'interrupted' }]);
  assert.deepEqual(log.ofType('session.status').at(-1), { status: 'ended' });
});

test('stop with a pending question: question.resolved cancelled', async () => {
  const log = new EventLog();
  const s = await fakeAdapter().start(startOpts(), log.emit, ctx());
  await s.send('t_q', text('ask'));
  const q = await log.waitFor('question.asked');
  await s.stop();
  assert.deepEqual(log.ofType('question.resolved'), [{ questionId: q.questionId, cancelled: true }]);
  assert.equal(log.ofType('turn.completed').length, 1);
});

test('interrupt with a pending approval answers cancel and reports it cancelled', async () => {
  const log = new EventLog();
  const s = await fakeAdapter().start(startOpts(), log.emit, ctx());
  try {
    await s.send('t_ap', text('approve'));
    const req = await log.waitFor('approval.requested');
    await s.interrupt();
    await log.waitFor('turn.completed');
    assert.deepEqual(log.ofType('approval.resolved'), [{ approvalId: req.approvalId, decision: 'cancelled', by: 'bizzi' }]);
    assert.equal(log.ofType('turn.completed').length, 1);
  } finally {
    await s.stop();
  }
});

test('process crash with a pending question: cancelled, turn completed with error', async () => {
  const log = new EventLog();
  const s = await fakeAdapter().start(startOpts(), log.emit, ctx());
  await s.send('t_crash', text('askcrash'));
  const q = await log.waitFor('question.asked');
  await log.waitFor('session.status', (d) => d.status === 'failed');
  assert.deepEqual(log.ofType('question.resolved'), [{ questionId: q.questionId, cancelled: true }]);
  assert.deepEqual(log.ofType('turn.completed').map((t) => t.stopReason), ['error']);
  const types = log.events.map((e) => e.type);
  assert.ok(types.indexOf('question.resolved') < types.indexOf('turn.completed'));
  await s.stop();
});

test('fork: thread/fork with resumeRef; new thread id; first-turn usage from per-request usage', async () => {
  const log = new EventLog();
  const s = await fakeAdapter().start(startOpts({ resumeRef: 'thr_fake_1', fork: true, permissionMode: 'auto' }), log.emit, ctx());
  try {
    assert.equal(s.agentSessionRef(), 'thr_fork_1');
    const p = log.received('thread/fork')[0] as Record<string, any>;
    assert.equal(p.threadId, 'thr_fake_1');
    assert.equal(p.excludeTurns, true);
    assert.equal(p.sandbox, 'workspace-write');
    assert.equal(log.received('thread/resume').length, 0);
    assert.equal(log.received('thread/start').length, 0);
    assert.equal((await log.waitFor('session.info')).agentSessionRef, 'thr_fork_1');

    // Turn 1: the thread total before the turn is unknown (inherited history), so usage = sum of `last`.
    await s.send('t_1', text('stream'));
    const t1 = await log.waitFor('turn.completed', (d) => d.turnId === 't_1');
    assert.deepEqual(t1.usage, { inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, contextWindow: 200000 });
    // Turn 2: delta of the thread total.
    await s.send('t_2', text('stream'));
    const t2 = await log.waitFor('turn.completed', (d) => d.turnId === 't_2');
    assert.deepEqual(t2.usage, { inputTokens: 100, outputTokens: 100, cacheReadTokens: 100, contextWindow: 200000 });
    // usage.updated is the cumulative thread total.
    assert.deepEqual(log.ofType('usage.updated').at(-1), { inputTokens: 200, outputTokens: 200, cacheReadTokens: 200, contextWindow: 200000 });
  } finally {
    await s.stop();
  }

  await assert.rejects(
    fakeAdapter().start(startOpts({ resumeRef: 'thr_missing', fork: true }), new EventLog().emit, ctx()),
    (e: unknown) => e instanceof BizziError && e.code === 'not_found' && /cannot fork/.test(e.message),
  );
});

test('fresh thread: per-turn usage is the delta of the cumulative total', async () => {
  const log = new EventLog();
  const s = await fakeAdapter().start(startOpts(), log.emit, ctx());
  try {
    await s.send('t_1', text('stream'));
    await log.waitFor('turn.completed', (d) => d.turnId === 't_1');
    await s.send('t_2', text('stream'));
    const t2 = await log.waitFor('turn.completed', (d) => d.turnId === 't_2');
    assert.deepEqual(t2.usage, { inputTokens: 100, outputTokens: 100, cacheReadTokens: 100, contextWindow: 200000 });
    assert.deepEqual(log.ofType('usage.updated').map((u) => u.outputTokens), [100, 200]);
  } finally {
    await s.stop();
  }
});

test('dispose stops every session the adapter started; idempotent', async () => {
  const adapter = fakeAdapter();
  const a = new EventLog();
  const b = new EventLog();
  await adapter.start(startOpts(), a.emit, ctx());
  const sb = await adapter.start(startOpts(), b.emit, ctx());
  await sb.send('t_b', text('hang'));
  await adapter.dispose();
  await adapter.dispose();
  assert.deepEqual(a.ofType('session.status').at(-1), { status: 'ended' });
  assert.deepEqual(b.ofType('session.status').at(-1), { status: 'ended' });
  assert.deepEqual(b.ofType('turn.completed'), [{ turnId: 't_b', stopReason: 'interrupted' }]);
});

test('elicitation mapping: url mode, confirm-only form, legacy enumNames, decline/cancel', () => {
  const base = { threadId: 't', turnId: null, serverName: 'auth', _meta: null };
  const url = elicitationQuestions({ ...base, mode: 'url', message: 'Sign in', url: 'https://x.test/login', elicitationId: 'e1' });
  assert.equal(url.form.text, 'Sign in\nhttps://x.test/login');
  assert.deepEqual(url.form.options, ['Done', 'Cancel']);
  assert.deepEqual(elicitationResponse(url.plan, { url: 'Done' }), { action: 'accept', content: null, _meta: null });
  assert.deepEqual(elicitationResponse(url.plan, { url: 'Cancel' }), { action: 'decline', content: null, _meta: null });

  const confirm = elicitationQuestions({ ...base, mode: 'form', message: 'Proceed?', requestedSchema: { type: 'object', properties: {} } });
  assert.deepEqual(confirm.form.questions.map((q) => q.options?.map((o) => o.label)), [['Accept', 'Decline']]);
  assert.deepEqual(elicitationResponse(confirm.plan, { confirm: 'Accept' }), { action: 'accept', content: {}, _meta: null });
  assert.deepEqual(elicitationResponse(confirm.plan, { confirm: 'Decline' }), { action: 'decline', content: null, _meta: null });

  const legacy = elicitationQuestions({
    ...base,
    mode: 'form',
    message: 'Pick',
    requestedSchema: { type: 'object', properties: { size: { type: 'string', enum: ['s', 'l'], enumNames: ['Small', 'Large'] } }, required: ['size'] },
  });
  assert.deepEqual(legacy.form.questions[0]?.options, [{ label: 'Small' }, { label: 'Large' }]);
  assert.deepEqual(elicitationResponse(legacy.plan, { size: 'Large' }).content, { size: 'l' });
  assert.deepEqual(elicitationResponse(legacy.plan, undefined), { action: 'decline', content: null, _meta: null });
  assert.deepEqual(elicitationResponse(legacy.plan, undefined, true), { action: 'cancel', content: null, _meta: null });
});

test('requestUserInput mapping: multi-answer lists and empty strings', () => {
  assert.deepEqual(userInputResponse({ a: ['x', 'y'], b: '' }), { answers: { a: { answers: ['x', 'y'] }, b: { answers: [] } } });
  const form = userInputQuestions({
    threadId: 't',
    turnId: 'u',
    itemId: 'i',
    isBlocking: true,
    autoResolutionMs: null,
    questions: [{ id: 'k', header: '', question: 'Key?', isOther: false, isSecret: true, options: [] }],
  });
  assert.deepEqual(form, { text: 'Key?', questions: [{ id: 'k', text: 'Key?', allowText: true }] });
});
