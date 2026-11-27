import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FORGET_TAG,
  acceptItem,
  acceptItems,
  addKnowledge,
  forgetKnowledge,
  listInbox,
  originFromContext,
  rejectItem,
  resolveRules,
  updateKnowledge,
} from '../src/index.ts';
import type { KnowledgeContext } from '../src/index.ts';
import { CTX, M1, P1, S1, S2, W1, memStore } from './helpers.ts';

const USER = { via: 'ui' as const, machineId: M1 };
const OTHER: KnowledgeContext = { ...CTX, agent: 'codex', sessionId: S2 };

test('dedupe: identical content at the same scope returns the existing item', () => {
  const { store } = memStore();
  const o = originFromContext(CTX);
  const a = addKnowledge(store, { type: 'memory', kind: 'fact', title: 'Port', body: 'Staging is   on 5433', scope: 'project' }, o);
  const b = addKnowledge(store, { type: 'memory', kind: 'fact', title: 'port', body: 'staging is on 5433', scope: 'project' }, o);
  assert.equal(b.duplicate, true);
  assert.equal(b.item.id, a.item.id);
  const c = addKnowledge(store, { type: 'memory', kind: 'fact', title: 'Port', body: 'Staging is on 5433', scope: 'workspace' }, o);
  assert.notEqual(c.item.id, a.item.id, 'different scope is a different item');
});

test('update supersedes: new version live, old one superseded, both kept', () => {
  const { store } = memStore();
  const o = originFromContext(CTX);
  const a = addKnowledge(store, { type: 'memory', kind: 'fact', title: 'Port', body: '5433', scope: 'project' }, o).item;
  const b = updateKnowledge(store, a.id, { body: '6543', tags: ['db'] }, o, { context: CTX });
  assert.equal(b.decision, 'live');
  assert.deepEqual(b.item.supersedes, [a.id]);
  assert.equal(b.item.body, '6543');
  assert.deepEqual(b.item.tags, ['db']);
  assert.equal(store.get(a.id)?.status, 'superseded');
  // Tag-only edits aren't swallowed by dedupe.
  const c = updateKnowledge(store, b.item.id, { tags: ['db', 'staging'] }, o, { context: CTX });
  assert.notEqual(c.item.id, b.item.id);
  assert.throws(() => updateKnowledge(store, a.id, { body: 'x' }, o), /superseded/);
});

test('an agent edit of a rule waits for review; the old rule stays live until accepted', () => {
  const { store } = memStore();
  const rule = addKnowledge(store, { type: 'rule', title: 'Use pnpm', body: '', scope: 'project' }, { ...USER, projectId: P1 }).item;
  const edit = updateKnowledge(store, rule.id, { title: 'Use npm' }, originFromContext(CTX), { context: CTX });
  assert.equal(edit.item.status, 'suggested');
  assert.deepEqual(
    resolveRules(store, CTX).map((r) => r.title),
    ['Use pnpm'],
  );
  acceptItem(store, edit.item.id);
  assert.deepEqual(
    resolveRules(store, CTX).map((r) => r.title),
    ['Use npm'],
  );
  assert.equal(store.get(rule.id)?.status, 'superseded');
});

test('forget: trusted writers tombstone; others create a forget request', () => {
  const { store } = memStore();
  const o = originFromContext(CTX);
  const m = addKnowledge(store, { type: 'memory', kind: 'fact', title: 'Old fact', body: 'x', scope: 'project' }, o).item;
  const f = forgetKnowledge(store, m.id, o, { context: CTX });
  assert.equal(f.decision, 'live');
  assert.equal(store.get(m.id)?.status, 'deleted');

  const rule = addKnowledge(store, { type: 'rule', title: 'Use pnpm', body: '', scope: 'project' }, { ...USER, projectId: P1 }).item;
  const req = forgetKnowledge(store, rule.id, o, { context: CTX, reason: 'project moved to npm' });
  assert.equal(req.decision, 'suggest');
  assert.equal(req.item.status, 'suggested');
  assert.deepEqual(req.item.tags, [FORGET_TAG]);
  assert.equal(store.get(rule.id)?.status, 'active', 'still live until accepted');
  acceptItem(store, req.item.id);
  assert.equal(store.get(rule.id)?.status, 'deleted');
  assert.equal(store.get(req.item.id)?.status, 'deleted', 'the request is consumed');

  // userRequested forget of a rule: live with notice; reject = undo.
  const r2 = addKnowledge(store, { type: 'rule', title: 'Be terse', body: '', scope: 'workspace' }, { ...USER, workspaceId: W1 }).item;
  const f2 = forgetKnowledge(store, r2.id, { ...o, userRequested: true }, { context: CTX });
  assert.equal(f2.decision, 'notice');
  assert.equal(store.get(r2.id)?.status, 'deleted');
  rejectItem(store, r2.id);
  assert.equal(store.get(r2.id)?.status, 'active');
});

test('agents can only edit or forget items they can see (or their own pending ones)', () => {
  const { store } = memStore();
  const other = addKnowledge(store, { type: 'memory', kind: 'fact', title: 'Other project', body: 'x', scope: { level: 'project', projectId: 'p_ZZ' } }, USER).item;
  assert.throws(() => forgetKnowledge(store, other.id, originFromContext(CTX), { context: CTX }), /not visible/);
  assert.throws(() => updateKnowledge(store, other.id, { body: 'y' }, originFromContext(CTX), { context: CTX }), /not visible/);
  // Own pending suggestion: can be revised (replaces it) or withdrawn.
  const mine = addKnowledge(store, { type: 'rule', title: 'Maybe rule', body: '', scope: 'project' }, originFromContext(CTX)).item;
  assert.equal(mine.status, 'suggested');
  const rev = updateKnowledge(store, mine.id, { title: 'Better rule' }, originFromContext(CTX), { context: CTX });
  assert.equal(store.get(mine.id)?.status, 'superseded');
  assert.equal(rev.item.status, 'suggested');
  forgetKnowledge(store, rev.item.id, originFromContext(CTX), { context: CTX });
  assert.equal(store.get(rev.item.id)?.status, 'deleted');
  // ...but another session's pending item is off limits.
  const theirs = addKnowledge(store, { type: 'rule', title: 'Their rule', body: '', scope: 'project' }, originFromContext(OTHER)).item;
  assert.throws(() => forgetKnowledge(store, theirs.id, originFromContext(CTX), { context: CTX }), /not visible/);
});

test('inbox: grouped per session, accept with scope edit, reject, notice undo', () => {
  const { store, clock } = memStore();
  const o1 = originFromContext(CTX);
  const o2 = originFromContext(OTHER);
  const g1 = addKnowledge(store, { type: 'memory', kind: 'preference', title: 'Prefers tabs', body: '', scope: 'global' }, o1).item;
  const r1 = addKnowledge(store, { type: 'rule', title: 'Run tests first', body: '', scope: 'project' }, o1).item;
  const n1 = addKnowledge(store, { type: 'rule', title: 'Never push to main', body: '', scope: 'project' }, { ...o1, userRequested: true }).item;
  clock.advance(60_000);
  const g2 = addKnowledge(store, { type: 'memory', kind: 'fact', title: 'Codex fact', body: '', scope: 'global' }, o2).item;
  addKnowledge(store, { type: 'memory', kind: 'fact', title: 'Live memory', body: '', scope: 'project' }, o2);

  const inbox = listInbox(store);
  assert.deepEqual(
    inbox.map((g) => g.sessionId),
    [S2, S1],
    'newest session first',
  );
  const card1 = inbox[1]!;
  assert.deepEqual(card1.suggested.map((i) => i.id).sort(), [g1.id, r1.id].sort());
  assert.deepEqual(card1.notices.map((i) => i.id), [n1.id]);
  assert.deepEqual(card1.counts, { memories: 1, rules: 2, forgets: 0 });
  assert.equal(card1.agent, 'claude');
  assert.equal(inbox[0]!.suggested.length, 1, 'live memories are not in the inbox');
  assert.equal(listInbox(store, { sessionId: S2 }).length, 1);

  // Accept with an edited scope: global → project (project id taken from the writer's context).
  const accepted = acceptItem(store, g1.id, { scope: 'project' });
  assert.equal(accepted.status, 'active');
  assert.deepEqual(accepted.scope, { level: 'project', projectId: P1 });
  // Acknowledge the notice; reject the unprompted rule; bulk-accept the rest.
  assert.equal(acceptItem(store, n1.id).noticePending, undefined);
  assert.equal(rejectItem(store, r1.id).status, 'deleted');
  acceptItems(store, [g2.id]);
  assert.deepEqual(listInbox(store), []);
  assert.throws(() => acceptItem(store, r1.id), /not in the inbox/);
});

test('rejecting a "live + notice" edit restores the version it replaced', () => {
  const { store } = memStore();
  const rule = addKnowledge(store, { type: 'rule', title: 'Use pnpm', body: '', scope: 'project' }, { ...USER, projectId: P1 }).item;
  const edit = updateKnowledge(store, rule.id, { title: 'Use bun' }, { ...originFromContext(CTX), userRequested: true }, { context: CTX });
  assert.equal(edit.decision, 'notice');
  assert.equal(store.get(rule.id)?.status, 'superseded');
  rejectItem(store, edit.item.id);
  assert.equal(store.get(rule.id)?.status, 'active');
  assert.equal(store.get(edit.item.id)?.status, 'deleted');
  assert.equal(store.get(edit.item.id)?.source.sessionId, S1);
});

test('inbox: an edited "live + notice" rule shows once, as its newest version', () => {
  const { store } = memStore();
  const asked = { ...originFromContext(CTX), userRequested: true };
  const v1 = addKnowledge(store, { type: 'rule', title: 'Run install after a change', body: '', scope: 'project' }, asked).item;
  const v2 = updateKnowledge(store, v1.id, { title: 'Run install after each PR' }, asked, { context: CTX }).item;
  const v3 = updateKnowledge(store, v2.id, { title: 'Run install after each merged PR' }, asked, { context: CTX }).item;
  assert.equal(store.get(v1.id)?.noticePending, true);
  assert.equal(store.get(v2.id)?.noticePending, true);

  const [card] = listInbox(store);
  assert.deepEqual(card!.notices.map((i) => i.id), [v3.id], 'replaced versions are folded into the newest');
  assert.deepEqual(card!.counts, { memories: 0, rules: 1, forgets: 0 });

  // Undo steps back one version, which is itself still an undoable notice.
  rejectItem(store, v3.id);
  assert.equal(store.get(v2.id)?.status, 'active');
  assert.deepEqual(listInbox(store)[0]!.notices.map((i) => i.id), [v2.id]);

  // Dismissing the newest version dismisses the whole chain.
  acceptItem(store, v2.id);
  assert.equal(store.get(v1.id)?.noticePending, undefined);
  assert.deepEqual(listInbox(store), []);
});
