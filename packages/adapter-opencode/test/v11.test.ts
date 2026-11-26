// Protocol v1.1 features against the fake server: questions (question tool → forms), canceled
// approvals, fork, usage semantics. Question shapes come from a real 2.0.25 capture
// (fixtures/opencode-2.0.25-question.jsonl).

import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { BizziError, type StartSessionOptions } from '@bizzi/protocol';
import { OpenCodeAdapter } from '../src/index.ts';
import type { OpenCodeSession } from '../src/session.ts';
import { FakeOpenCode } from './fake-server.ts';
import { ctx, Recorder, until } from './helpers.ts';

const PASSWORD = 'test-password';
const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'bizzi-oc-v11-')));

let fake: FakeOpenCode;
let adapter: OpenCodeAdapter;

before(async () => {
  fake = new FakeOpenCode({ password: PASSWORD });
  await fake.start();
  adapter = new OpenCodeAdapter({ serverUrl: fake.url, serverPassword: PASSWORD, healthIntervalMs: 0, interruptFallbackMs: 500 });
});

after(async () => {
  await adapter.dispose();
  await adapter.dispose(); // idempotent
  await fake.close();
});

beforeEach(() => {
  fake.requests.length = 0;
});

async function start(extra: Partial<StartSessionOptions> = {}): Promise<{ s: OpenCodeSession; rec: Recorder }> {
  const rec = new Recorder();
  const s = (await adapter.start({ sessionId: 's_v11', mode: 'structured', cwd, ...extra }, rec.emit, ctx)) as OpenCodeSession;
  return { s, rec };
}

function reqs(method: string, re: RegExp) {
  return fake.requests.filter((r) => r.method === method && re.test(r.path));
}

const isCode = (code: string) => (e: unknown) => e instanceof BizziError && e.code === code;

describe('questions (question tool → forms)', () => {
  test('single choice: real form shape → question.asked, answer by label, resolved once', async () => {
    const { s, rec } = await start();
    await s.send('t_q1', [{ type: 'text', text: 'scenario:question' }]);
    const asked = await rec.waitFor('question.asked');
    assert.match(asked.questionId, /^frm_/);
    assert.equal(asked.text, 'Do you prefer red or blue?');
    assert.deepEqual(asked.options, ['Red', 'Blue']);
    assert.deepEqual(asked.questions, [
      {
        id: 'q0',
        text: 'Do you prefer red or blue?',
        header: 'Color preference',
        options: [
          { label: 'Red', description: 'You prefer red' },
          { label: 'Blue', description: 'You prefer blue' },
        ],
        allowText: true,
      },
    ]);
    const askedAt = rec.events.findIndex((e) => e.type === 'question.asked');
    assert.deepEqual(rec.events[askedAt + 1], { type: 'session.status', data: { status: 'waiting_input', prompt: 'input' } });
    const questionTool = rec.of('tool.started').find((t) => t.name === 'question');
    assert.ok(questionTool, 'the question tool call is shown');

    await s.respondQuestion!(asked.questionId, { q0: 'Blue' });
    assert.deepEqual(reqs('POST', /\/form\/frm_[^/]+\/reply$/).map((r) => r.body), [{ answer: { q0: 'Blue' } }]);
    const done = await rec.waitFor('turn.completed');
    assert.equal(done.stopReason, 'end_turn');
    assert.deepEqual(rec.of('question.resolved'), [{ questionId: asked.questionId, answers: { q0: 'Blue' } }]);
    assert.deepEqual(rec.of('session.status'), [{ status: 'waiting_input', prompt: 'input' }, { status: 'running' }]);
    assert.equal(rec.of('tool.completed').find((t) => t.toolId === questionTool.toolId)!.status, 'ok');
    assert.match(rec.of('message.completed').at(-1)!.text, /Blue/);
    await assert.rejects(s.respondQuestion!('frm_nope', { q0: 'x' }), isCode('not_found'));
    await assert.rejects(s.respondQuestion!(asked.questionId, { q0: 'Red' }), isCode('not_found')); // forgotten once the turn ended
    assert.equal(rec.of('question.resolved').length, 1);
    await s.stop();
  });

  test('multiselect: bad keys are bad_request; decline cancels the form', async () => {
    const { s, rec } = await start();
    await s.send('t_q2', [{ type: 'text', text: 'scenario:questionmulti' }]);
    const asked = await rec.waitFor('question.asked');
    assert.equal(asked.questions![0]!.multiSelect, true);
    assert.equal(asked.questions![0]!.allowText, true);
    assert.deepEqual(asked.options, ['Apple', 'Pear', 'Plum']);
    await assert.rejects(s.respondQuestion!(asked.questionId, { nope: 'x' }), isCode('bad_request'));
    assert.equal(rec.of('question.resolved').length, 0);
    await s.respondQuestion!(asked.questionId, undefined);
    const del = reqs('DELETE', /\/form\/frm_/);
    assert.equal(del.length, 1);
    assert.equal(del[0]!.query.message, 'The user declined to answer.');
    const done = await rec.waitFor('turn.completed');
    assert.equal(done.stopReason, 'end_turn');
    assert.deepEqual(rec.of('question.resolved'), [{ questionId: asked.questionId, cancelled: true }]);
    assert.equal(rec.of('tool.completed')[0]!.status, 'error');
    await s.stop();
  });

  test('multiselect answer as an array, keyed by question text', async () => {
    const { s, rec } = await start();
    await s.send('t_q3', [{ type: 'text', text: 'scenario:questionmulti' }]);
    const q = await rec.waitFor('question.asked');
    const key = 'Which fruits do you like?';
    await s.respondQuestion!(q.questionId, { [key]: ['Pear', 'Plum'] });
    assert.deepEqual(reqs('POST', /\/form\/.+\/reply$/).at(-1)!.body, { answer: { q0: ['Pear', 'Plum'] } });
    await rec.waitFor('turn.completed');
    assert.equal(rec.of('question.resolved').length, 1);
    await s.stop();
  });

  test('answered elsewhere (form.replied from the server) resolves with option labels', async () => {
    const { s, rec } = await start();
    await s.send('t_q4', [{ type: 'text', text: 'scenario:question' }]);
    const asked = await rec.waitFor('question.asked');
    fake.session(s.agentSessionRef()!).pendingForms.get(asked.questionId)!.settle({ kind: 'reply', answer: { q0: 'Red' } });
    await rec.waitFor('turn.completed');
    assert.deepEqual(rec.of('question.resolved'), [{ questionId: asked.questionId, answers: { q0: 'Red' } }]);
    await s.stop();
  });

  test('interrupt with a pending question: cancelled once, turn interrupted', async () => {
    const { s, rec } = await start();
    await s.send('t_q5', [{ type: 'text', text: 'scenario:question' }]);
    const asked = await rec.waitFor('question.asked');
    await s.interrupt();
    const done = await rec.waitFor('turn.completed');
    assert.equal(done.stopReason, 'interrupted');
    assert.deepEqual(rec.of('question.resolved'), [{ questionId: asked.questionId, cancelled: true }]);
    assert.equal(rec.of('tool.completed')[0]!.status, 'cancelled');
    assert.equal(rec.of('turn.completed').length, 1);
    assert.deepEqual(rec.of('session.status'), [{ status: 'waiting_input', prompt: 'input' }], 'no status after a cancel');
    await s.stop();
  });

  test('stop with a pending question cancels it locally and on the server', async () => {
    const { s, rec } = await start();
    await s.send('t_q6', [{ type: 'text', text: 'scenario:question' }]);
    const asked = await rec.waitFor('question.asked');
    await s.stop();
    assert.deepEqual(rec.of('question.resolved'), [{ questionId: asked.questionId, cancelled: true }]);
    assert.deepEqual(rec.of('turn.completed').map((t) => t.stopReason), ['interrupted']);
  });

  test('a question between turns: answered → status idle', async () => {
    const { s, rec } = await start();
    const ref = s.agentSessionRef()!;
    const form = {
      id: fake.id('frm'),
      sessionID: ref,
      title: 'Setup',
      metadata: {},
      fields: [
        { key: 'go', type: 'boolean', title: 'Proceed?' },
        { key: 'n', type: 'integer', title: 'How many?' },
      ],
    };
    fake.session(ref).pendingForms.set(form.id, {
      form,
      settle: (r) => {
        if (r.kind === 'reply') fake.emit('form.replied', { id: form.id, sessionID: ref, answer: r.answer });
      },
    });
    fake.emit('form.created', { form }, { directory: cwd });
    const asked = await rec.waitFor('question.asked');
    assert.equal(asked.text, 'Setup\nProceed?');
    assert.deepEqual(asked.questions, [
      { id: 'go', text: 'Proceed?', options: [{ label: 'Yes' }, { label: 'No' }] },
      { id: 'n', text: 'How many?', allowText: true },
    ]);
    await assert.rejects(s.respondQuestion!(form.id, { go: 'maybe' }), isCode('bad_request'));
    await assert.rejects(s.respondQuestion!(form.id, { n: '2.5' }), isCode('bad_request'));
    await s.respondQuestion!(form.id, { go: 'Yes', n: '3' });
    assert.deepEqual(reqs('POST', /\/reply$/).at(-1)!.body, { answer: { go: true, n: 3 } });
    assert.deepEqual(rec.of('question.resolved'), [{ questionId: form.id, answers: { go: 'Yes', n: '3' } }]);
    assert.deepEqual(rec.of('session.status'), [{ status: 'waiting_input', prompt: 'input' }, { status: 'idle' }]);
    await s.stop();
  });

  test('stream gap: forms created meanwhile are picked up', async () => {
    const { s, rec } = await start();
    const ref = s.agentSessionRef()!;
    await s.send('t_q7', [{ type: 'text', text: 'scenario:silent' }]);
    await until(() => fake.session(ref).running, 2000, 'running');
    const form = { id: 'frm_gap1', sessionID: ref, title: 'Questions', metadata: { kind: 'question' }, fields: [{ key: 'q0', type: 'boolean', title: 'Proceed?' }] };
    fake.session(ref).pendingForms.set(form.id, { form, settle: () => {} });
    fake.dropStreams();
    const asked = await rec.waitFor('question.asked', undefined, 8000);
    assert.deepEqual(asked, {
      questionId: 'frm_gap1',
      text: 'Proceed?',
      options: ['Yes', 'No'],
      questions: [{ id: 'q0', text: 'Proceed?', options: [{ label: 'Yes' }, { label: 'No' }] }],
    });
    await s.stop();
  });
});

describe('cancelled approvals', () => {
  test('interrupt with a pending approval → approval.resolved cancelled', async () => {
    const { s, rec } = await start();
    await s.send('t_pa', [{ type: 'text', text: 'scenario:permission' }]);
    const req = await rec.waitFor('approval.requested');
    await s.interrupt();
    const done = await rec.waitFor('turn.completed');
    assert.equal(done.stopReason, 'interrupted');
    assert.deepEqual(rec.of('approval.resolved'), [{ approvalId: req.approvalId, decision: 'cancelled', by: 'bizzi' }]);
    await s.stop();
  });

  test('stop with a pending approval → cancelled and rejected on the server', async () => {
    const { s, rec } = await start();
    await s.send('t_pb', [{ type: 'text', text: 'scenario:permission' }]);
    const req = await rec.waitFor('approval.requested');
    await s.stop();
    assert.deepEqual(rec.of('approval.resolved'), [{ approvalId: req.approvalId, decision: 'cancelled', by: 'bizzi' }]);
    assert.equal(rec.of('turn.completed').length, 1);
  });

  test('server crash → pending approvals and questions cancelled, turn fails', async () => {
    const { s, rec } = await start();
    await s.send('t_pc', [{ type: 'text', text: 'scenario:question' }]);
    const asked = await rec.waitFor('question.asked');
    s.onGap({ crashed: true, reason: 'opencode serve exited (SIGKILL)' });
    assert.deepEqual(rec.of('question.resolved'), [{ questionId: asked.questionId, cancelled: true }]);
    assert.deepEqual(rec.of('turn.completed').map((t) => t.stopReason), ['error']);
    await s.stop();
  });
});

describe('fork', () => {
  test('new OpenCode session via the fork route; agent carried over', async () => {
    const { s: first } = await start({ permissionMode: 'plan' });
    const src = first.agentSessionRef()!;
    await first.stop();
    fake.requests.length = 0;
    const { s, rec } = await start({ resumeRef: src, fork: true });
    const ref = s.agentSessionRef()!;
    assert.notEqual(ref, src);
    assert.match(ref, /^ses_/);
    assert.deepEqual(reqs('POST', /\/fork$/).map((r) => [r.path, r.body]), [[`/api/session/${src}/fork`, {}]]);
    assert.deepEqual(reqs('POST', /\/agent$/).map((r) => [r.path, r.body]), [[`/api/session/${ref}/agent`, { agent: 'plan' }]]);
    assert.equal(reqs('POST', /^\/api\/session$/).length, 0, 'no fresh session');
    assert.deepEqual(rec.of('session.info')[0], { agentSessionRef: ref, model: 'fake/fake-model', permissionMode: 'plan', title: 'Session (fork #1)' });
    await s.send('t_f', [{ type: 'text', text: 'scenario:basic' }]);
    assert.equal((await rec.waitFor('turn.completed')).stopReason, 'end_turn');
    await s.stop();
    await assert.rejects(start({ resumeRef: 'ses_missing', fork: true }), isCode('not_found'));
  });

  test('adapter permission rules are applied to the fork', async () => {
    const strict = new OpenCodeAdapter({
      serverUrl: fake.url,
      serverPassword: PASSWORD,
      healthIntervalMs: 0,
      permissions: [{ action: 'shell', resource: '*', effect: 'ask' }],
      allowQuestions: false,
    });
    const rec = new Recorder();
    const first = await strict.start({ sessionId: 's_strict', mode: 'structured', cwd }, rec.emit, ctx);
    const create = reqs('POST', /^\/api\/session$/).at(-1)!;
    const rules = [
      { action: 'shell', resource: '*', effect: 'ask' },
      { action: 'question', resource: '*', effect: 'deny' },
    ];
    assert.deepEqual((create.body as { permissions: unknown }).permissions, rules);
    await first.stop();
    const forked = await strict.start({ sessionId: 's_strict2', mode: 'structured', cwd, resumeRef: first.agentSessionRef(), fork: true }, rec.emit, ctx);
    const patch = reqs('PATCH', new RegExp(`^/api/session/${forked.agentSessionRef()}$`));
    assert.deepEqual(patch.map((r) => r.body), [{ permissions: rules }]);
    await strict.dispose();
  });
});

describe('usage semantics', () => {
  test('turn.completed.usage is per turn; usage.updated is the running session total', async () => {
    const { s, rec } = await start({ model: 'fake/fake-model' });
    await s.send('t_u1', [{ type: 'text', text: 'scenario:basic' }]);
    await rec.waitFor('turn.completed', (d) => d.turnId === 't_u1');
    await s.send('t_u2', [{ type: 'text', text: 'scenario:basic' }]);
    await rec.waitFor('turn.completed', (d) => d.turnId === 't_u2');
    assert.deepEqual(rec.of('turn.completed').map((t) => t.usage!.inputTokens), [100, 100]);
    const totals = rec.of('usage.updated');
    assert.deepEqual(totals.map((u) => u.inputTokens), [100, 200]);
    assert.equal(totals.at(-1)!.contextWindow, 128000);
    assert.ok(Math.abs(totals.at(-1)!.costUsd! - 0.0024) < 1e-9);
    const ref = s.agentSessionRef()!;
    await s.stop();
    // resume reports the stored session total up front
    const resumed = await start({ resumeRef: ref });
    assert.equal(resumed.rec.of('usage.updated')[0]!.inputTokens, 200);
    await resumed.s.stop();
  });
});

describe('dispose', () => {
  test('stops live sessions (turn completed) and is idempotent', async () => {
    const own = new OpenCodeAdapter({ serverUrl: fake.url, serverPassword: PASSWORD, healthIntervalMs: 0 });
    const rec = new Recorder();
    const s = await own.start({ sessionId: 's_disp', mode: 'structured', cwd }, rec.emit, ctx);
    await s.send('t_d', [{ type: 'text', text: 'scenario:silent' }]);
    await own.dispose();
    await own.dispose();
    assert.deepEqual(rec.of('turn.completed').map((t) => t.stopReason), ['interrupted']);
  });
});
