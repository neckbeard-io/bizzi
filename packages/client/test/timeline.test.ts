import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionEvent, SessionEventBody } from '@bizzi/protocol';
import { emptyTimeline, reduceTimeline, timelineItems } from '../src/index.ts';

function script(bodies: SessionEventBody[], ch = 'session:s_1'): SessionEvent[] {
  return bodies.map((b, i) => ({ ...b, ch, seq: i + 1, ts: new Date(Date.UTC(2026, 10, 5, 12, 0, i)).toISOString() }) as SessionEvent);
}

const EVENTS = script([
  { type: 'session.info', data: { model: 'opus', permissionMode: 'default' } },
  { type: 'turn.started', data: { turnId: 't_1', input: [{ type: 'text', text: 'fix the test' }] } },
  { type: 'reasoning.delta', data: { messageId: 'r1', text: 'Let me ' } },
  { type: 'reasoning.delta', data: { messageId: 'r1', text: 'look.' } },
  { type: 'reasoning.completed', data: { messageId: 'r1', text: 'Let me look.' } },
  { type: 'message.delta', data: { messageId: 'm1', role: 'assistant', text: 'Running ' } },
  { type: 'message.delta', data: { messageId: 'm1', role: 'assistant', text: 'tests' } },
  { type: 'tool.started', data: { toolId: 'tc_1', kind: 'shell', name: 'Bash', title: 'npm test', input: { command: 'npm test' } } },
  { type: 'tool.updated', data: { toolId: 'tc_1', output: 'line1\n' } },
  { type: 'tool.updated', data: { toolId: 'tc_1', output: 'line2\n', progress: '50%' } },
  { type: 'tool.completed', data: { toolId: 'tc_1', status: 'error', error: 'exit 1' } },
  { type: 'tool.started', data: { toolId: 'tc_2', kind: 'edit', name: 'Edit', title: 'src/a.ts' } },
  { type: 'approval.requested', data: { approvalId: 'ap_1', toolId: 'tc_2', kind: 'edit', title: 'Edit src/a.ts', editable: true, options: ['allow', 'allow_always', 'deny'], input: { path: 'src/a.ts' } } },
  { type: 'approval.resolved', data: { approvalId: 'ap_1', decision: 'allow' } },
  { type: 'tool.completed', data: { toolId: 'tc_2', status: 'ok', output: 'edited' } },
  { type: 'file.changed', data: { path: 'src/a.ts', change: 'modified', diff: '@@ -1 +1 @@\n-a\n+b\n' } },
  { type: 'plan.updated', data: { items: [{ text: 'find bug', status: 'completed' }, { text: 'fix it', status: 'in_progress' }] } },
  { type: 'usage.updated', data: { inputTokens: 100, outputTokens: 20 } },
  { type: 'question.asked', data: { questionId: 'q_1', text: 'Also update docs?', options: ['yes', 'no'] } },
  { type: 'message.completed', data: { messageId: 'm1', role: 'assistant', text: 'Running tests… fixed.' } },
  { type: 'turn.completed', data: { turnId: 't_1', stopReason: 'end_turn', usage: { costUsd: 0.01 } } },
  { type: 'turn.started', data: { turnId: 't_2', input: [{ type: 'text', text: 'yes' }] } },
  { type: 'tool.started', data: { toolId: 'tc_3', kind: 'shell', name: 'Bash', title: 'sleep 100' } },
  { type: 'approval.requested', data: { approvalId: 'ap_2', kind: 'shell', title: 'Run sleep', editable: false, options: ['allow', 'deny'] } },
  { type: 'turn.completed', data: { turnId: 't_2', stopReason: 'interrupted' } },
  { type: 'error', data: { message: 'boom', fatal: false } },
  { type: 'term.output', data: { dataBase64: 'aGk=' } },
]);

test('timeline reduction of a scripted session', () => {
  const tl = reduceTimeline(emptyTimeline('s_1'), EVENTS);
  assert.equal(tl.lastSeq, EVENTS.length);
  assert.deepEqual(
    timelineItems(tl).map((i) => i.kind),
    ['turn', 'reasoning', 'message', 'tool', 'tool', 'approval', 'file', 'question', 'turn-end', 'turn', 'tool', 'approval', 'turn-end', 'error'],
  );
  assert.equal(tl.info.model, 'opus');

  const r = tl.items['rsn:r1'];
  assert.ok(r?.kind === 'reasoning' && r.text === 'Let me look.' && !r.streaming);

  const m = tl.items['msg:m1'];
  assert.ok(m?.kind === 'message');
  assert.equal(m.text, 'Running tests… fixed.');
  assert.equal(m.streaming, false);
  assert.equal(m.turnId, 't_1');

  const t1 = tl.items['tool:tc_1'];
  assert.ok(t1?.kind === 'tool');
  assert.equal(t1.output, 'line1\nline2\n');
  assert.equal(t1.status, 'error');
  assert.equal(t1.error, 'exit 1');
  assert.equal(t1.progress, undefined);

  const t2 = tl.items['tool:tc_2'];
  assert.ok(t2?.kind === 'tool' && t2.status === 'ok' && t2.output === 'edited' && t2.approvalId === undefined);

  const a1 = tl.items['ap:ap_1'];
  assert.ok(a1?.kind === 'approval' && a1.status === 'resolved' && a1.decision === 'allow');
  // An approval left open by an interrupted turn expires; its tool is canceled.
  const a2 = tl.items['ap:ap_2'];
  assert.ok(a2?.kind === 'approval' && a2.status === 'expired');
  const t3 = tl.items['tool:tc_3'];
  assert.ok(t3?.kind === 'tool' && t3.status === 'cancelled');
  assert.deepEqual(tl.pendingApprovals, []);

  // The next turn answers the open question.
  const q = tl.items['q:q_1'];
  assert.ok(q?.kind === 'question' && q.status === 'answered');
  assert.deepEqual(tl.pendingQuestions, []);

  assert.equal(tl.plan?.length, 2);
  assert.deepEqual(tl.usage, { inputTokens: 100, outputTokens: 20, costUsd: 0.01 });
  assert.equal(tl.files['src/a.ts']?.change, 'modified');
  const end = tl.items['end:t_1'];
  assert.ok(end?.kind === 'turn-end' && end.stopReason === 'end_turn' && typeof end.durationMs === 'number');
  assert.equal(tl.status, 'idle');
  assert.equal(tl.activeTurnId, null);
});

test('incremental reduction equals one-shot reduction, and is idempotent', () => {
  const oneShot = reduceTimeline(emptyTimeline('s_1'), EVENTS);
  let inc = emptyTimeline('s_1');
  for (const ev of EVENTS) inc = reduceTimeline(inc, [ev]);
  assert.deepEqual(inc, oneShot);
  const again = reduceTimeline(oneShot, EVENTS.slice(0, 10));
  assert.equal(again, oneShot);
});

test('structural sharing: a delta replaces only the affected item', () => {
  const evs = EVENTS.slice(0, 7);
  const before = reduceTimeline(emptyTimeline('s_1'), evs);
  const delta: SessionEvent = { ch: 'session:s_1', seq: 100, ts: 'x', type: 'message.delta', data: { messageId: 'm1', role: 'assistant', text: '!' } };
  const after = reduceTimeline(before, [delta]);
  assert.equal(after.order, before.order, 'order unchanged');
  assert.equal(after.items['turn:t_1'], before.items['turn:t_1']);
  assert.equal(after.items['rsn:r1'], before.items['rsn:r1']);
  assert.notEqual(after.items['msg:m1'], before.items['msg:m1']);
  assert.equal(before.items['msg:m1']?.kind === 'message' && before.items['msg:m1'].text, 'Running tests');
});

test('pending approvals are tracked until resolved', () => {
  const tl = reduceTimeline(emptyTimeline('s_1'), EVENTS.slice(0, 13));
  assert.deepEqual(tl.pendingApprovals, ['ap_1']);
  assert.equal(tl.status, 'waiting_approval');
  const tool = tl.items['tool:tc_2'];
  assert.ok(tool?.kind === 'tool' && tool.approvalId === 'ap_1');
});
