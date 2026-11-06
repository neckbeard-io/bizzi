import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionEvent, SessionEventBody } from '@bizzi/protocol';
import { emptyTimeline, questionSpecs, reduceTimeline, selectInbox, timelineItems } from '../src/index.ts';
import type { BizziState } from '../src/index.ts';

function script(bodies: SessionEventBody[], start = 1): SessionEvent[] {
  return bodies.map((b, i) => ({ ...b, ch: 'session:s_1', seq: start + i, ts: new Date(Date.UTC(2026, 10, 6, 12, 0, start + i)).toISOString() }) as SessionEvent);
}

const QUESTIONS = [
  { id: 'provider', header: 'Provider', text: 'Which IdP?', options: [{ label: 'Auth0' }, { label: 'Keycloak' }] },
  { id: 'flows', text: 'Which flows?', multiSelect: true, options: [{ label: 'Web' }, { label: 'API' }] },
  { id: 'notes', text: 'Anything else?', allowText: true },
];

test('question.asked keeps the full form; question.resolved records answers and clears it from the inbox', () => {
  let tl = reduceTimeline(
    emptyTimeline('s_1'),
    script([
      { type: 'turn.started', data: { turnId: 't_1', input: [{ type: 'text', text: 'plan it' }] } },
      { type: 'question.asked', data: { questionId: 'q_1', text: 'Which IdP?', options: ['Auth0', 'Keycloak'], questions: QUESTIONS } },
      { type: 'session.status', data: { status: 'waiting_input', prompt: 'input' } },
    ]),
  );
  const q = tl.items['q:q_1'];
  assert.ok(q?.kind === 'question');
  assert.equal(q.status, 'pending');
  assert.equal(q.questions?.length, 3);
  assert.deepEqual(questionSpecs(q).map((x) => x.id), ['provider', 'flows', 'notes']);
  assert.deepEqual(tl.pendingQuestions, ['q_1']);
  assert.equal(tl.prompt, 'input');
  assert.equal(selectInbox({ timelines: { s_1: tl } } as unknown as BizziState).length, 1);

  tl = reduceTimeline(
    tl,
    script(
      [
        { type: 'question.resolved', data: { questionId: 'q_1', answers: { provider: 'Auth0', flows: ['Web', 'API'] } } },
        { type: 'session.status', data: { status: 'running' } },
      ],
      4,
    ),
  );
  const done = tl.items['q:q_1'];
  assert.ok(done?.kind === 'question');
  assert.equal(done.status, 'answered');
  assert.deepEqual(done.answers, { provider: 'Auth0', flows: ['Web', 'API'] });
  assert.deepEqual(tl.pendingQuestions, []);
  assert.equal(tl.prompt, null);
  assert.equal(selectInbox({ timelines: { s_1: tl } } as unknown as BizziState).length, 0);
});

test('a cancelled question is marked declined; a summary-only question gets a synthesized form', () => {
  const tl = reduceTimeline(
    emptyTimeline('s_1'),
    script([
      { type: 'question.asked', data: { questionId: 'q_2', text: 'Proceed?', options: ['Yes', 'No'] } },
      { type: 'question.resolved', data: { questionId: 'q_2', cancelled: true } },
    ]),
  );
  const q = tl.items['q:q_2'];
  assert.ok(q?.kind === 'question');
  assert.equal(q.status, 'cancelled');
  assert.deepEqual(questionSpecs(q), [{ id: 'q_2', text: 'Proceed?', allowText: true, options: [{ label: 'Yes' }, { label: 'No' }] }]);
});

test('turn.steered becomes a steer item inside the running turn', () => {
  const tl = reduceTimeline(
    emptyTimeline('s_1'),
    script([
      { type: 'turn.started', data: { turnId: 't_1', input: [{ type: 'text', text: 'run the tests' }] } },
      { type: 'tool.started', data: { toolId: 'tc_1', kind: 'shell', name: 'Bash', title: 'npm test' } },
      { type: 'turn.steered', data: { turnId: 't_1', input: [{ type: 'text', text: 'only the checkout spec' }] } },
      { type: 'turn.completed', data: { turnId: 't_1', stopReason: 'end_turn' } },
    ]),
  );
  const items = timelineItems(tl);
  assert.deepEqual(items.map((i) => i.kind), ['turn', 'tool', 'steer', 'turn-end']);
  const steer = items[2];
  assert.ok(steer?.kind === 'steer');
  assert.equal(steer.turnId, 't_1');
  assert.deepEqual(steer.input, [{ type: 'text', text: 'only the checkout spec' }]);
});

test("approval.resolved 'cancelled' resolves the approval, unblocks the tool and the status", () => {
  const tl = reduceTimeline(
    emptyTimeline('s_1'),
    script([
      { type: 'turn.started', data: { turnId: 't_1', input: [] } },
      { type: 'tool.started', data: { toolId: 'tc_1', kind: 'web', name: 'webfetch', title: 'https://x' } },
      { type: 'approval.requested', data: { approvalId: 'ap_1', toolId: 'tc_1', kind: 'web', title: 'Fetch', editable: false, options: ['allow', 'deny'] } },
      { type: 'approval.resolved', data: { approvalId: 'ap_1', decision: 'cancelled' } },
    ]),
  );
  const ap = tl.items['ap:ap_1'];
  assert.ok(ap?.kind === 'approval');
  assert.equal(ap.status, 'resolved');
  assert.equal(ap.decision, 'cancelled');
  assert.deepEqual(tl.pendingApprovals, []);
  assert.equal(tl.status, 'running');
  assert.equal(tl.prompt, null);
  const tool = tl.items['tool:tc_1'];
  assert.ok(tool?.kind === 'tool');
  assert.equal(tool.approvalId, undefined);
});

test('session.status prompt and the login flow (login.prompt / login.completed)', () => {
  let tl = reduceTimeline(
    emptyTimeline('s_1'),
    script([
      { type: 'session.status', data: { status: 'running' } },
      { type: 'login.prompt', data: { urls: ['https://claude.ai/oauth?x=1'], codes: [] } },
      { type: 'login.prompt', data: { urls: ['https://claude.ai/oauth?x=1'], codes: ['ABCD-1234'], awaitingCodeInput: true } },
      { type: 'session.status', data: { status: 'waiting_input', prompt: 'login' } },
    ]),
  );
  assert.equal(tl.prompt, 'login');
  assert.deepEqual(tl.login?.urls, ['https://claude.ai/oauth?x=1']);
  assert.deepEqual(tl.login?.codes, ['ABCD-1234']);
  assert.equal(tl.login?.awaitingCodeInput, true);
  assert.equal(tl.login?.result, null);

  tl = reduceTimeline(tl, script([{ type: 'login.completed', data: { ok: true, account: 'dev@example.com' } }], 5));
  assert.deepEqual(tl.login?.result, { ok: true, account: 'dev@example.com' });
  assert.equal(tl.login?.awaitingCodeInput, false);
  assert.equal(tl.prompt, null);

  // waiting_input without an explicit prompt means "input".
  const t2 = reduceTimeline(emptyTimeline('s_2'), script([{ type: 'session.status', data: { status: 'waiting_input' } }]));
  assert.equal(t2.prompt, 'input');
});
