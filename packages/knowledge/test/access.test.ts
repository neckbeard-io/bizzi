// The browse side of bizzi-memory: what a session may list, read and move (access.ts), and the
// knowledge_list / rules_in_effect / knowledge_get / knowledge_promote tools over an in-memory MCP link.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  addKnowledge,
  createKnowledgeMcpServer,
  forgetKnowledge,
  getWithHistory,
  isForgetRequest,
  listForSession,
  listInbox,
  moveToScope,
  originFromContext,
  planScopeMove,
  resolveRules,
  updateKnowledge,
} from '../src/index.ts';
import type { KnowledgeContext, KnowledgeStore } from '../src/index.ts';
import { CTX, M1, M2, P1, P2, S1, S2, W1, W2, memStore } from './helpers.ts';

const USER = { via: 'ui' as const, machineId: M1, projectId: P1, workspaceId: W1 };
/** Another session of the same agent (claude) in the same workspace. */
const SIBLING: KnowledgeContext = { ...CTX, sessionId: S2 };
/** A codex session in the same workspace. */
const CODEX: KnowledgeContext = { ...CTX, agent: 'codex', sessionId: 's_CODEX' };
/** A session in another project on another machine. */
const ELSEWHERE: KnowledgeContext = { agent: 'claude', machineId: M2, projectId: P2, workspaceId: W2, sessionId: 's_ELSE' };

function seed(store: KnowledgeStore) {
  const ids = {
    globalRule: addKnowledge(store, { type: 'rule', title: 'Conventional commits', body: '', scope: 'global' }, USER).item.id,
    projectRule: addKnowledge(store, { type: 'rule', title: 'Use pnpm', body: 'never npm', scope: 'project' }, USER).item.id,
    wsRule: addKnowledge(store, { type: 'rule', title: 'Never touch migrations/', body: '', scope: 'workspace' }, USER).item.id,
    codexRule: addKnowledge(store, { type: 'rule', title: 'Run just fmt', body: '', scope: 'project', appliesTo: ['codex'] }, USER).item.id,
    otherProject: addKnowledge(
      store,
      { type: 'memory', kind: 'fact', title: 'Beta secret path', body: 'elsewhere', scope: 'project', tags: ['db'] },
      { via: 'ui', machineId: M2, projectId: P2 },
    ).item.id,
    otherMachine: addKnowledge(store, { type: 'memory', kind: 'fact', title: 'M2 has docker', body: '', scope: 'machine' }, { via: 'ui', machineId: M2 })
      .item.id,
    mem: addKnowledge(
      store,
      { type: 'memory', kind: 'gotcha', title: 'Staging DB port', body: 'Staging Postgres is on 5433.', scope: 'workspace', tags: ['db'] },
      USER,
    ).item.id,
    procedure: addKnowledge(store, { type: 'memory', kind: 'procedure', title: 'Release steps', body: 'x'.repeat(400), scope: 'project' }, USER).item.id,
    // Unprompted agent rules are suggestions under the balanced preset.
    mine: addKnowledge(store, { type: 'rule', title: 'Use pnpm', body: 'never npm', scope: 'workspace' }, originFromContext(CTX)).item.id,
    sibling: addKnowledge(store, { type: 'rule', title: 'Prefer vitest', body: '', scope: 'project' }, originFromContext(SIBLING)).item.id,
    codexSuggestion: addKnowledge(store, { type: 'rule', title: 'Codex idea', body: '', scope: 'project' }, originFromContext(CODEX)).item.id,
  };
  return ids;
}

test('listForSession: visible live items plus own and same-agent suggestions, never other scopes', () => {
  const { store } = memStore();
  const ids = seed(store);
  const all = listForSession(store, CTX, { limit: 100 });
  const got = new Set(all.items.map((i) => i.id));
  for (const id of [ids.globalRule, ids.projectRule, ids.wsRule, ids.mem, ids.procedure, ids.mine, ids.sibling]) assert.ok(got.has(id), id);
  for (const id of [ids.codexRule, ids.otherProject, ids.otherMachine, ids.codexSuggestion]) assert.ok(!got.has(id), id);
  assert.equal(all.total, 7);

  // Newest first.
  assert.equal(all.items[0]!.id, ids.sibling);

  assert.deepEqual(
    listForSession(store, CTX, { status: 'suggested' }).items.map((i) => i.id).sort(),
    [ids.mine, ids.sibling].sort(),
  );
  assert.deepEqual(listForSession(store, CTX, { mine: true }).items.map((i) => i.id), [ids.mine]);
  assert.deepEqual(listForSession(store, SIBLING, { mine: true }).items.map((i) => i.id), [ids.sibling]);
  assert.deepEqual(listForSession(store, CODEX, { status: 'suggested' }).items.map((i) => i.id), [ids.codexSuggestion]);
  assert.ok(listForSession(store, CODEX, { type: 'rule', limit: 100 }).items.some((i) => i.id === ids.codexRule));

  // Filters.
  assert.deepEqual(listForSession(store, CTX, { kind: 'gotcha' }).items.map((i) => i.id), [ids.mem]);
  assert.deepEqual(listForSession(store, CTX, { kind: 'gotcha', type: 'rule' }).items, []);
  assert.deepEqual(listForSession(store, CTX, { tags: ['db'] }).items.map((i) => i.id), [ids.mem]);
  assert.deepEqual(
    listForSession(store, CTX, { type: 'rule', scope: 'workspace' }).items.map((i) => i.id).sort(),
    [ids.wsRule, ids.mine].sort(),
  );
  assert.deepEqual(listForSession(store, CTX, { status: 'active', scope: 'global' }).items.map((i) => i.id), [ids.globalRule]);

  // Paging.
  const p1 = listForSession(store, CTX, { limit: 3 });
  assert.equal(p1.items.length, 3);
  assert.equal(p1.nextOffset, 3);
  const p3 = listForSession(store, CTX, { limit: 3, offset: 6 });
  assert.equal(p3.items.length, 1);
  assert.equal(p3.nextOffset, undefined);

  // The other project's session sees its own items, none of ours.
  const elsewhere = listForSession(store, ELSEWHERE, { limit: 100 }).items.map((i) => i.id);
  assert.deepEqual(elsewhere.sort(), [ids.globalRule, ids.otherProject, ids.otherMachine].sort());
});

test('getWithHistory: versions both ways, hidden versions counted, out-of-scope ids not found', () => {
  const { store } = memStore();
  const ids = seed(store);
  const o = originFromContext(CTX);
  const v2 = updateKnowledge(store, ids.mem, { body: 'Staging Postgres is on 6543.' }, o, { context: CTX }).item;
  const v3 = updateKnowledge(store, v2.id, { body: 'Staging Postgres is on 7000.' }, o, { context: CTX }).item;

  const cur = getWithHistory(store, v3.id, CTX, isForgetRequest);
  assert.equal(cur.item.body, 'Staging Postgres is on 7000.');
  assert.deepEqual(cur.history.map((h) => [h.id, h.relation, h.status]), [
    [v2.id, 'earlier', 'superseded'],
    [ids.mem, 'earlier', 'superseded'],
  ]);

  const old = getWithHistory(store, ids.mem, CTX, isForgetRequest);
  assert.equal(old.item.status, 'superseded');
  assert.deepEqual(old.history.map((h) => [h.id, h.relation]), [
    [v2.id, 'later'],
    [v3.id, 'later'],
  ]);

  // A pending forget request on the live version shows up as a later forget request.
  const forget = forgetKnowledge(store, ids.globalRule, o, { context: CTX }).item;
  assert.equal(forget.status, 'suggested');
  const g = getWithHistory(store, ids.globalRule, CTX, isForgetRequest);
  assert.deepEqual(g.history.map((h) => [h.id, h.forgetRequest]), [[forget.id, true]]);
  // Another agent's view of the same rule hides that pending request.
  assert.equal(getWithHistory(store, ids.globalRule, CODEX, isForgetRequest).hiddenVersions, 1);

  assert.throws(() => getWithHistory(store, ids.otherProject, CTX, isForgetRequest), /not_found|not visible/);
  assert.throws(() => getWithHistory(store, ids.codexSuggestion, CTX, isForgetRequest), /not visible/);
  assert.equal(getWithHistory(store, ids.sibling, CTX, isForgetRequest).item.status, 'suggested');
});

test('own suggestions: amend and withdraw them; other sessions\' only by the user', () => {
  const { store } = memStore();
  const ids = seed(store);
  const amended = updateKnowledge(store, ids.mine, { body: 'pnpm only' }, originFromContext(CTX), { context: CTX });
  assert.equal(amended.item.status, 'suggested');
  assert.equal(store.require(ids.mine).status, 'superseded', 'the amended suggestion replaces the old one in the inbox');
  const withdrawn = forgetKnowledge(store, amended.item.id, originFromContext(CTX), { context: CTX });
  assert.equal(withdrawn.item.status, 'deleted');
  assert.equal(withdrawn.decision, 'live');

  // A sibling session (same agent) sees the other's suggestion but can't change it.
  assert.throws(
    () => forgetKnowledge(store, ids.sibling, originFromContext(CTX), { context: CTX }),
    (err: Error) => /conflict|another session/.test(err.message) && /user's/.test(err.message),
  );
  assert.throws(() => updateKnowledge(store, ids.sibling, { body: 'x' }, originFromContext(CTX), { context: CTX }), /another session/);
  // Another agent's suggestion is simply not visible.
  assert.throws(() => forgetKnowledge(store, ids.codexSuggestion, originFromContext(CTX), { context: CTX }), /not visible/);
  assert.equal(store.require(ids.sibling).status, 'suggested');
  assert.equal(store.require(ids.codexSuggestion).status, 'suggested');
});

test('moveToScope: through the policy, wider only, duplicates reported', () => {
  const { store } = memStore();
  const ids = seed(store);
  const o = originFromContext(CTX);

  // Agent memory at project scope is live under the balanced preset.
  const mem = moveToScope(store, ids.mem, 'project', CTX, o);
  assert.equal(mem.result?.decision, 'live');
  assert.equal(mem.result?.item.scope.level, 'project');
  assert.equal(mem.result?.item.scope.projectId, P1);
  assert.equal(store.require(ids.mem).status, 'superseded');

  // An unprompted agent move of a rule waits for review; the original stays live.
  const plan = planScopeMove(store, ids.wsRule, 'project', CTX, o);
  assert.equal(plan.decision, 'suggest');
  const rule = moveToScope(store, ids.wsRule, 'project', CTX, o);
  assert.equal(rule.result?.item.status, 'suggested');
  assert.equal(store.require(ids.wsRule).status, 'active');
  assert.ok(listInbox(store, { sessionId: S1 })[0]!.suggested.some((i) => i.id === rule.result!.item.id));
  assert.deepEqual(resolveRules(store, CTX).map((r) => r.id).includes(ids.wsRule), true);

  // Moving it again finds the pending move at the target and writes nothing.
  assert.equal(moveToScope(store, ids.wsRule, 'project', CTX, o).plan.duplicateOf?.id, rule.result!.item.id);

  // Requested by the user → live with a notice at project scope.
  const ws2 = addKnowledge(store, { type: 'rule', title: 'Tabs not spaces', body: '', scope: 'workspace' }, USER).item;
  const asked = moveToScope(store, ws2.id, 'project', CTX, originFromContext(CTX, 'tool', { userRequested: true }));
  assert.equal(asked.result?.decision, 'notice');
  assert.equal(store.require(ws2.id).status, 'superseded');

  // Wider only; available scopes only.
  assert.throws(() => planScopeMove(store, ids.projectRule, 'workspace', CTX, o), /not wider/);
  assert.throws(() => planScopeMove(store, ids.projectRule, 'project', CTX, o), /not wider/);
  const noProject: KnowledgeContext = { agent: 'claude', machineId: M1, sessionId: S1 };
  const sessionMem = addKnowledge(store, { type: 'memory', kind: 'fact', title: 'scratch', body: '', scope: 'session' }, originFromContext(noProject)).item;
  assert.throws(() => planScopeMove(store, sessionMem.id, 'project', noProject, originFromContext(noProject)), /not available/);
  assert.throws(() => planScopeMove(store, ids.otherProject, 'global', CTX, o), /not visible/);
  assert.throws(() => planScopeMove(store, ids.sibling, 'global', CTX, o), /only live items/);

  // The same rule already at project scope: reported, nothing written.
  const before = store.list().length;
  const dup = moveToScope(store, ids.mine, 'project', CTX, o);
  assert.equal(dup.plan.duplicateOf?.id, ids.projectRule);
  assert.equal(dup.result, undefined);
  assert.equal(store.list().length, before);
});

// ---- the tools ------------------------------------------------------------------------------------

async function connect(store: KnowledgeStore, ctx: KnowledgeContext): Promise<Client> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const server = createKnowledgeMcpServer(store, ctx);
  await server.connect(serverT);
  const client = new Client({ name: 'bizzi-test', version: '0.0.0' });
  await client.connect(clientT);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

const textOf = (r: CallToolResult) => r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');

test('browse tools over MCP: list, rules_in_effect, get, promote', async () => {
  const { store } = memStore();
  const ids = seed(store);
  const client = await connect(store, CTX);
  try {
    const tools = (await client.listTools()).tools;
    const names = tools.map((t) => t.name);
    for (const n of ['knowledge_list', 'rules_in_effect', 'knowledge_get', 'knowledge_promote']) assert.ok(names.includes(n), n);
    for (const n of names) assert.doesNotMatch(n, /accept|reject|approve/);
    assert.match(tools.find((t) => t.name === 'knowledge_promote')!.description ?? '', /user's/);
    assert.match(client.getInstructions() ?? '', /rules_in_effect/);
    assert.match(client.getInstructions() ?? '', /Approving or rejecting suggestions is the user's/);

    // knowledge_list: own suggestion included and marked; bodies trimmed.
    const list = await call(client, 'knowledge_list', { limit: 100 });
    assert.equal(list.isError, undefined);
    const items = (list.structuredContent as { items: Array<{ id: string; mine?: boolean; body: string; truncated?: boolean }> }).items;
    assert.equal(items.find((i) => i.id === ids.mine)?.mine, true);
    assert.equal(items.find((i) => i.id === ids.sibling)?.mine, false);
    const proc = items.find((i) => i.id === ids.procedure)!;
    assert.equal(proc.truncated, true);
    assert.ok(proc.body.length <= 280);
    assert.ok(!items.some((i) => i.id === ids.otherProject));
    assert.match(textOf(list), /your suggestion/);
    const page = await call(client, 'knowledge_list', { limit: 2 });
    assert.equal((page.structuredContent as { nextOffset: number }).nextOffset, 2);
    assert.match(textOf(page), /offset: 2/);

    // rules_in_effect: same order as the resolver, general → specific.
    const rules = await call(client, 'rules_in_effect');
    const ruleIds = (rules.structuredContent as { rules: Array<{ id: string }> }).rules.map((r) => r.id);
    assert.deepEqual(ruleIds, resolveRules(store, CTX).map((r) => r.id));
    assert.deepEqual(ruleIds, [ids.globalRule, ids.projectRule, ids.wsRule]);
    assert.match(textOf(rules), /## global[\s\S]*## project[\s\S]*## workspace/);

    // knowledge_get: full body; not visible → error.
    const got = await call(client, 'knowledge_get', { id: ids.procedure });
    assert.equal((got.structuredContent as { item: { body: string } }).item.body.length, 400);
    const hidden = await call(client, 'knowledge_get', { id: ids.otherProject });
    assert.equal(hidden.isError, true);
    assert.match(textOf(hidden), /not_found/);

    // knowledge_promote: dry run changes nothing; then a real move goes to the inbox (agent rule).
    const before = store.list().length;
    const dry = await call(client, 'knowledge_promote', { id: ids.wsRule, scope: 'project', dryRun: true });
    assert.equal((dry.structuredContent as { decision: string }).decision, 'suggest');
    assert.match(textOf(dry), /inbox/);
    assert.equal(store.list().length, before);
    const moved = await call(client, 'knowledge_promote', { id: ids.wsRule, scope: 'project' });
    const ms = moved.structuredContent as { id: string; status: string; moved: boolean };
    assert.equal(ms.status, 'suggested');
    assert.match(textOf(moved), /stays live/);
    const memMove = await call(client, 'knowledge_promote', { id: ids.mem, scope: 'project' });
    assert.match(textOf(memMove), /Moved/);
    const dup = await call(client, 'knowledge_promote', { id: ids.mine, scope: 'project' });
    assert.equal((dup.structuredContent as { moved: boolean }).moved, false);
    assert.match(textOf(dup), /already exists/);
    const narrow = await call(client, 'knowledge_promote', { id: ids.globalRule, scope: 'workspace' });
    assert.equal(narrow.isError, true);

    // knowledge_forget: withdraws its own suggestion; another session's is refused with a clear reason.
    const withdraw = await call(client, 'knowledge_forget', { id: ms.id });
    assert.match(textOf(withdraw), /Forgot/);
    assert.equal(store.require(ms.id).status, 'deleted');
    const refused = await call(client, 'knowledge_forget', { id: ids.sibling });
    assert.equal(refused.isError, true);
    assert.match(textOf(refused), /another session/);
  } finally {
    await client.close();
  }
});
