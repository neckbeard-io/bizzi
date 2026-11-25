// Spec §12.5: with parentAnswersApprovals, a helper's parent sees its approvals and questions and may
// answer some of them; the user still sees everything and whoever answers first wins.

import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { BizziError, sessionChannel, type ChannelEvent, type SessionInfo } from '@bizzi/protocol';
import { approvalPaths, isInside, type BizziNode } from '../src/index.ts';
import { FakeAdapter } from '../src/testing/index.ts';
import { makeNode, tempDir, waitFor } from './helpers.ts';

async function setup(t: import('node:test').TestContext, parentMode = 'acceptEdits') {
  const tmp = tempDir();
  const node = await makeNode(join(tmp.path, 'data'), [new FakeAdapter()]);
  t.after(async () => {
    await node.close();
    tmp.cleanup();
  });
  const { workspace } = await node.call('workspace.create', { path: join(tmp.path, 'ws'), create: true });
  const { session: parent } = await node.call('session.create', { workspaceId: workspace.id, agent: 'claude', permissionMode: parentMode });
  await idle(node, parent.id);
  return { node, workspace, parent, tmp };
}

async function idle(node: BizziNode, id: string): Promise<SessionInfo> {
  return waitFor(() => {
    const s = node.sessions.get(id).session;
    return s.status === 'idle' && !node.sessions.isBusy(id) ? s : undefined;
  }, 5000, `${id} idle`);
}

async function waitingApproval(node: BizziNode, id: string): Promise<string> {
  return waitFor(() => node.sessions.pending(id).approvals[0]?.approvalId, 5000, `${id} approval`);
}

function resolvedEvents(node: BizziNode, id: string): Extract<ChannelEvent, { type: 'approval.resolved' | 'question.resolved' }>[] {
  return node.bus.replay(sessionChannel(id), 0).filter((e) => e.type === 'approval.resolved' || e.type === 'question.resolved') as never;
}

async function rejects(p: Promise<unknown>, code: string, re?: RegExp): Promise<BizziError> {
  let caught: BizziError | undefined;
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof BizziError, String(err));
    assert.equal(err.code, code, err.message);
    if (re) assert.match(err.message, re);
    caught = err;
    return true;
  });
  return caught!;
}

test('off by default: approvals stay with the user and the parent cannot answer', async (t) => {
  const { node, parent } = await setup(t);
  const orch = node.orchestration;
  const h = await orch.startHelper(parent.id, { agent: 'claude', prompt: '/approve-edit src/a.ts' });
  assert.equal(h.session.parentAnswersApprovals, undefined);
  const approvalId = await waitingApproval(node, h.session.id);
  assert.equal(orch.pendingFor(parent.id, h.session.id), undefined);
  const w = await orch.wait(parent.id, h.session.id, 'waiting', 1000);
  assert.equal(w.pending, undefined);
  assert.match(w.reason, /waiting for the user to approve/);
  await rejects(orch.answer(parent.id, h.session.id, { id: approvalId, decision: 'allow' }), 'conflict', /started without parentAnswersApprovals/);
  // The user answers as before; only they can, so the event is unchanged.
  await node.call('approval.respond', { sessionId: h.session.id, approvalId, decision: 'allow' });
  await idle(node, h.session.id);
  assert.deepEqual(resolvedEvents(node, h.session.id).map((e) => e.data), [{ approvalId, decision: 'allow' }]);
});

test('opt-in: the parent allows an edit inside the worktree; the user gets "already answered"', async (t) => {
  const { node, workspace, parent } = await setup(t);
  const orch = node.orchestration;
  await node.call('orchestration.settings.set', { workspaceId: workspace.id, settings: { parentAnswersApprovals: true } });
  const h = await orch.startHelper(parent.id, { agent: 'claude', prompt: '/approve-edit src/a.ts', permissionMode: 'default' });
  const id = h.session.id;
  assert.equal(h.session.parentAnswersApprovals, true);
  assert.ok(h.notes.some((n) => /session_answer/.test(n)));

  // `done` returns early for something the parent may answer, once.
  const w = await orch.wait(parent.id, id, 'done', 5000);
  assert.equal(w.reached, true);
  assert.equal(w.state, 'waiting_approval');
  const approvalId = node.sessions.pending(id).approvals[0]!.approvalId;
  assert.match(w.reason, new RegExp(`waiting for approval \\(${approvalId}\\); you may answer it with session_answer`));
  assert.equal(w.pending?.length, 1);
  assert.deepEqual({ ...w.pending![0], input: undefined }, { type: 'approval', id: approvalId, kind: 'edit', title: 'Run edit src/a.ts?', parentMay: ['allow', 'deny'], input: undefined });
  assert.equal(w.pending![0]!.input, '{"file_path":"src/a.ts"}');
  const again = await orch.wait(parent.id, id, 'done', 100);
  assert.equal(again.reached, false, 'already reported: done keeps waiting');
  assert.equal(again.pending?.length, 1);
  const read = await orch.read(parent.id, id);
  assert.equal(read.waitingOn?.items?.[0]?.id, approvalId);

  // Not what the parent may decide.
  await rejects(orch.answer(parent.id, id, { id: approvalId, decision: 'allow_always' }), 'conflict', /only the user/);
  await rejects(orch.answer(parent.id, id, { id: approvalId, decision: 'allow', editedInput: { file_path: '/etc/hosts' } }), 'conflict', /edit an approval's input/);
  await rejects(orch.answer(parent.id, id, { id: 'ap_nope', decision: 'allow' }), 'not_found');

  const r = await orch.answer(parent.id, id, { id: approvalId, decision: 'allow' });
  assert.deepEqual(r, { sessionId: id, id: approvalId, answered: true, message: 'Allowed: Run edit src/a.ts?' });
  await idle(node, id);
  assert.deepEqual(resolvedEvents(node, id).map((e) => e.data), [{ approvalId, decision: 'allow', by: 'parent', bySessionId: parent.id }]);

  // The user answers second: nothing pending any more, and who was first.
  const late = await rejects(node.call('approval.respond', { sessionId: id, approvalId, decision: 'deny' }), 'not_found', /already answered by the parent session/);
  assert.deepEqual(late.data, { alreadyAnswered: true, outcome: 'allow', by: 'parent', bySessionId: parent.id });
  // And the parent answering twice gets a result, not an error.
  const twice = await orch.answer(parent.id, id, { id: approvalId, decision: 'deny' });
  assert.equal(twice.answered, false);
  assert.match(twice.message, /Already answered by parent session/);
});

test('guardrails: outside the workspace, beyond the parent level, and the user answering first', async (t) => {
  const { node, workspace, parent, tmp } = await setup(t);
  const orch = node.orchestration;
  await node.call('orchestration.settings.set', { workspaceId: workspace.id, settings: { parentAnswersApprovals: true } });
  const h = await orch.startHelper(parent.id, { agent: 'claude', prompt: '/approve-edit ../outside.txt', permissionMode: 'default' });
  const id = h.session.id;
  const approvalId = await waitingApproval(node, id);
  const items = orch.pendingFor(parent.id, id)!;
  assert.deepEqual(items[0]!.parentMay, ['deny']);
  assert.match(items[0]!.note ?? '', /outside the helper's workspace/);
  // Deny-only items don't wake `done`; `waiting` does.
  assert.equal((await orch.wait(parent.id, id, 'done', 100)).reached, false);
  const w = await orch.wait(parent.id, id, 'waiting', 100);
  assert.match(w.reason, /waiting for the user to approve: .* \(you may only deny it: .*outside/);
  await rejects(orch.answer(parent.id, id, { id: approvalId, decision: 'allow' }), 'conflict', /outside the helper's workspace.*stays with the user/);
  // The user answers first; the parent's later deny reports it.
  await node.call('approval.respond', { sessionId: id, approvalId, decision: 'allow' });
  const r = await orch.answer(parent.id, id, { id: approvalId, decision: 'deny' });
  assert.deepEqual(r, { sessionId: id, id: approvalId, answered: false, alreadyAnswered: { outcome: 'allow', by: 'user' }, message: 'Already answered by the user: allow.' });
  await idle(node, id);

  // A shell command needs an unrestricted parent; acceptEdits may only deny it.
  await orch.send(parent.id, id, [{ type: 'text', text: '/approve rm -rf build' }]);
  const shellId = await waitingApproval(node, id);
  await rejects(orch.answer(parent.id, id, { id: shellId, decision: 'allow' }), 'conflict', /needs a parent that runs unrestricted itself/);
  const denied = await orch.answer(parent.id, id, { id: shellId, decision: 'deny', message: 'not now' });
  assert.equal(denied.answered, true);
  await idle(node, id);
  const tool = node.bus.replay(sessionChannel(id), 0).filter((e) => e.type === 'tool.completed').at(-1);
  assert.equal(tool?.type === 'tool.completed' && tool.data.status, 'denied');

  // A symlink out of the workspace counts as outside.
  mkdirSync(join(tmp.path, 'elsewhere'));
  symlinkSync(join(tmp.path, 'elsewhere'), join(workspace.path, 'link'));
  await orch.send(parent.id, id, [{ type: 'text', text: '/approve-edit link/x.ts' }]);
  const linkId = await waitingApproval(node, id);
  assert.match(orch.pendingFor(parent.id, id)![0]!.note ?? '', /link\/x\.ts is outside/);
  // Turning the setting off takes effect at once.
  await node.call('orchestration.settings.set', { workspaceId: workspace.id, settings: { parentAnswersApprovals: false } });
  assert.equal(orch.pendingFor(parent.id, id), undefined);
  await rejects(orch.answer(parent.id, id, { id: linkId, decision: 'deny' }), 'conflict', /off for this workspace/);
});

test('questions: the parent answers or declines; racing answers resolve once', async (t) => {
  const { node, workspace, parent } = await setup(t, 'default');
  const orch = node.orchestration;
  await node.call('orchestration.settings.set', { workspaceId: workspace.id, settings: { parentAnswersApprovals: true } });
  const h = await orch.startHelper(parent.id, { agent: 'claude', prompt: '/ask Use tabs?' });
  const id = h.session.id;
  const w = await orch.wait(parent.id, id, 'done', 5000);
  assert.equal(w.state, 'waiting_input');
  const q = w.pending![0]!;
  assert.equal(q.type, 'question');
  assert.deepEqual(q.parentMay, ['answer', 'cancel']);
  await rejects(orch.answer(parent.id, id, { id: q.id, decision: 'allow' }), 'bad_request');
  await rejects(orch.answer(parent.id, id, { id: q.id }), 'bad_request');
  assert.equal((await orch.answer(parent.id, id, { id: q.id, answers: { q1: 'yes' } })).answered, true);
  await idle(node, id);
  const msgs = node.bus.replay(sessionChannel(id), 0).filter((e) => e.type === 'message.completed');
  assert.equal(msgs.at(-2)?.type === 'message.completed' && msgs.at(-2)!.data.text, 'answer: yes');
  assert.deepEqual(resolvedEvents(node, id).at(-1)?.data, { questionId: q.id, answers: { q1: 'yes' }, by: 'parent', bySessionId: parent.id });

  // A default-mode parent (asks before editing) may only deny an edit.
  await orch.send(parent.id, id, [{ type: 'text', text: '/approve-edit README.md' }]);
  const editId = await waitingApproval(node, id);
  assert.deepEqual(orch.pendingFor(parent.id, id)![0]!.parentMay, ['deny'], 'an edit needs an acceptEdits parent');

  // Race: the parent and the user answer at the same time; exactly one wins.
  const [p, u] = await Promise.allSettled([
    orch.answer(parent.id, id, { id: editId, decision: 'deny' }),
    node.call('approval.respond', { sessionId: id, approvalId: editId, decision: 'allow' }),
  ]);
  assert.equal(p.status, 'fulfilled');
  const parentWon = p.status === 'fulfilled' && p.value.answered;
  if (parentWon) {
    assert.equal(u.status, 'rejected');
    assert.ok(u.status === 'rejected' && u.reason instanceof BizziError && (u.reason.data as { alreadyAnswered?: boolean }).alreadyAnswered, String(u.status === 'rejected' && u.reason));
  } else {
    assert.equal(u.status, 'fulfilled');
  }
  await idle(node, id);
  const last = resolvedEvents(node, id).at(-1)!;
  assert.equal(last.data.by, parentWon ? 'parent' : 'user');
  assert.equal(resolvedEvents(node, id).filter((e) => e.type === 'approval.resolved').length, 1);
});

test('approvalPaths and isInside', (t) => {
  assert.deepEqual(approvalPaths({ file_path: 'a.ts' }), ['a.ts']);
  assert.deepEqual(approvalPaths({ changes: [{ path: '/r/a' }, { path: '/r/b' }], grantRoot: '/r' }).sort(), ['/r', '/r/a', '/r/b']);
  assert.deepEqual(approvalPaths({ fileChanges: { '/r/x': { add: {} } } }), ['/r/x']);
  assert.deepEqual(approvalPaths({ command: ['ls'], cwd: '/tmp' }), ['/tmp']);
  assert.deepEqual(approvalPaths({ action: 'edit', resources: ['src/a.ts'] }), ['src/a.ts']);
  assert.deepEqual(approvalPaths({ plan: 'do it' }), []);
  const tmp = tempDir();
  t.after(() => tmp.cleanup());
  const root = join(tmp.path, 'ws');
  mkdirSync(root);
  assert.equal(isInside(root, 'a/b.ts'), true);
  assert.equal(isInside(root, join(root, 'new', 'file')), true);
  assert.equal(isInside(root, root), true);
  assert.equal(isInside(root, '../x'), false);
  assert.equal(isInside(root, 'a/../../x'), false);
  assert.equal(isInside(root, '/etc/hosts'), false);
  assert.equal(isInside(root, '~/x'), false);
  assert.equal(isInside(`${root}/`, `${root}-sibling/x`), false);
});
