import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { BizziError, DEFAULT_ORCHESTRATION_SETTINGS, GLOBAL_CHANNEL, sessionChannel, type AgentAdapter, type SessionInfo } from '@bizzi/protocol';
import { clampPermission, createNode, type BizziNode } from '../src/index.ts';
import { FakeAdapter, defaultScript } from '../src/testing/index.ts';
import { makeNode, record, tempDir, waitFor } from './helpers.ts';

async function setup(t: import('node:test').TestContext, adapters?: AgentAdapter[]) {
  const tmp = tempDir();
  const node = await makeNode(join(tmp.path, 'data'), adapters);
  t.after(async () => {
    await node.close();
    tmp.cleanup();
  });
  const { workspace } = await node.call('workspace.create', { path: join(tmp.path, 'ws'), create: true });
  return { node, workspace, tmp };
}

async function idle(node: BizziNode, id: string): Promise<SessionInfo> {
  return waitFor(() => {
    const s = node.sessions.get(id).session;
    return s.status === 'idle' && !node.sessions.isBusy(id) ? s : undefined;
  }, 5000, `${id} idle`);
}

async function rejects(p: Promise<unknown> | (() => unknown), code: string, re?: RegExp): Promise<void> {
  const run = typeof p === 'function' ? Promise.resolve().then(p) : p;
  await assert.rejects(run, (err: unknown) => {
    assert.ok(err instanceof BizziError, String(err));
    assert.equal(err.code, code, err.message);
    if (re) assert.match(err.message, re);
    return true;
  });
}

test('session.markSeen is monotonic, clamped to lastSeq, persisted and emits session.updated', async (t) => {
  const { node, workspace, tmp } = await setup(t);
  const { session } = await node.call('session.create', { workspaceId: workspace.id, agent: 'claude' });
  await node.call('session.send', { sessionId: session.id, input: [{ type: 'text', text: 'hi' }] });
  const s = await idle(node, session.id);
  const global = record(node, GLOBAL_CHANNEL, node.bus.lastSeq(GLOBAL_CHANNEL));

  assert.deepEqual(await node.call('session.markSeen', { sessionId: session.id, seq: 2 }), { seenThrough: 2 });
  const upd = await global.waitFor('session.updated', (e) => e.data.session.id === session.id);
  assert.equal(upd.data.session.seenThrough, 2);
  assert.equal(upd.data.session.updatedAt, s.updatedAt, 'markSeen does not bump updatedAt');
  // Backwards: no-op, no event.
  const before = global.events.length;
  assert.deepEqual(await node.call('session.markSeen', { sessionId: session.id, seq: 1 }), { seenThrough: 2 });
  assert.equal(global.events.length, before);
  // Past the end: clamped.
  assert.deepEqual(await node.call('session.markSeen', { sessionId: session.id, seq: 10_000 }), { seenThrough: s.lastSeq });
  await rejects(node.call('session.markSeen', { sessionId: session.id, seq: -1 }), 'bad_request');
  await rejects(node.call('session.markSeen', { sessionId: 's_nope', seq: 1 }), 'not_found');

  await node.close();
  const node2 = await makeNode(join(tmp.path, 'data'));
  t.after(() => node2.close());
  assert.equal(node2.sessions.get(session.id).session.seenThrough, s.lastSeq);
});

test('helpers: spawnedBy/scope/depth, sessions.list filter, child cascade on stop and delete, detached survives', async (t) => {
  const { node, workspace } = await setup(t);
  const { session: parent } = await node.call('session.create', { workspaceId: workspace.id, agent: 'claude' });
  await idle(node, parent.id);
  const orch = node.orchestration;
  const child = await orch.startHelper(parent.id, { agent: 'claude', prompt: 'hello child' });
  const detached = await orch.startHelper(parent.id, { agent: 'claude', prompt: 'hello detached', scope: 'detached' });
  assert.equal(child.session.spawnedBy, parent.id);
  assert.equal(child.session.scope, 'child');
  assert.equal(child.session.depth, 1);
  assert.equal(child.session.title, 'hello child');
  assert.equal(detached.session.scope, 'detached');
  assert.equal(child.queued, false);

  const listed = await node.call('sessions.list', { spawnedBy: parent.id });
  assert.deepEqual(listed.sessions.map((s) => s.id).sort(), [child.session.id, detached.session.id].sort());
  assert.equal((await node.call('sessions.list', {})).sessions.length, 3);
  assert.deepEqual(orch.helpers(parent.id).map((s) => s.id).sort(), listed.sessions.map((s) => s.id).sort());

  // Grandchild (depth 2) under the child; stopping the parent cascades down.
  await idle(node, child.session.id);
  const grandchild = await orch.startHelper(child.session.id, { agent: 'claude', prompt: 'deeper' });
  assert.equal(grandchild.session.depth, 2);
  await idle(node, grandchild.session.id);
  await node.call('session.stop', { sessionId: parent.id });
  await waitFor(() => node.sessions.get(child.session.id).session.status === 'ended', 5000, 'child ended');
  await waitFor(() => node.sessions.get(grandchild.session.id).session.status === 'ended', 5000, 'grandchild ended');
  await idle(node, detached.session.id);

  // Delete: child helpers stop.
  const { session: p2 } = await node.call('session.create', { workspaceId: workspace.id, agent: 'claude' });
  await idle(node, p2.id);
  const c2 = await orch.startHelper(p2.id, { agent: 'claude', prompt: 'x' });
  await node.call('session.delete', { sessionId: p2.id });
  await waitFor(() => node.sessions.get(c2.session.id).session.status === 'ended', 5000, 'child of deleted parent ended');

  // Parent that crashes: child stops too.
  const { session: p3 } = await node.call('session.create', { workspaceId: workspace.id, agent: 'claude' });
  await idle(node, p3.id);
  const c3 = await orch.startHelper(p3.id, { agent: 'claude', prompt: '/slow 3000' });
  await node.call('session.send', { sessionId: p3.id, input: [{ type: 'text', text: '/crash' }] });
  await waitFor(() => node.sessions.get(c3.session.id).session.status === 'ended', 5000, 'child of crashed parent ended');
});

test('helpers: only the parent may drive them; wait / read summary', async (t) => {
  const script = (input: Parameters<typeof defaultScript>[0], ctx: Parameters<typeof defaultScript>[1]) => {
    const text = input.find((b) => b.type === 'text')?.text ?? '';
    if (text.startsWith('/edit ')) {
      const path = text.slice(6);
      return [
        { type: 'tool' as const, title: `edit ${path}`, kind: 'edit' as const, name: 'Edit' },
        { type: 'emit' as const, event: { type: 'file.changed' as const, data: { path, change: 'modified' as const, diff: `--- a/${path}\n+++ b/${path}\n` } } },
        { type: 'tool' as const, title: 'npm test', output: 'ok' },
        { type: 'text' as const, text: `Edited ${path}. All good.` },
      ];
    }
    return defaultScript(input, ctx);
  };
  const { node, workspace } = await setup(t, [new FakeAdapter({ script })]);
  const orch = node.orchestration;
  const { session: parent } = await node.call('session.create', { workspaceId: workspace.id, agent: 'claude' });
  const { session: other } = await node.call('session.create', { workspaceId: workspace.id, agent: 'claude' });
  await idle(node, parent.id);
  const h = await orch.startHelper(parent.id, { agent: 'claude', prompt: '/edit src/a.ts' });
  await rejects(orch.wait(other.id, h.session.id, 'done', 100), 'not_found');
  await rejects(orch.read(other.id, h.session.id), 'not_found');
  await rejects(orch.stop(other.id, parent.id), 'not_found');

  const w = await orch.wait(parent.id, h.session.id, 'done', 5000);
  assert.deepEqual(w, { sessionId: h.session.id, state: 'idle', reached: true, reason: 'turn finished (end_turn)' });
  const r = await orch.read(parent.id, h.session.id);
  assert.equal(r.finalMessage, 'Edited src/a.ts. All good.');
  assert.equal(r.stopReason, 'end_turn');
  assert.equal(r.turns, 1);
  assert.deepEqual(r.changedFiles, [{ path: 'src/a.ts', change: 'modified', diffRef: 'src/a.ts' }]);
  assert.deepEqual(r.tools, { total: 2, byKind: { edit: 1, shell: 1 }, failed: 0, denied: 0 });
  assert.deepEqual(r.usage, { usd: 0, tokens: 30, turns: 1 });
  assert.equal(r.transcript, undefined);
  const diff = await orch.read(parent.id, h.session.id, { detail: 'diff', path: 'src/a.ts' });
  assert.match(diff.diff ?? '', /\+\+\+ b\/src\/a\.ts/);
  const full = await orch.read(parent.id, h.session.id, { detail: 'full' });
  assert.deepEqual(full.transcript, ['> /edit src/a.ts', '[edit] edit src/a.ts', '[shell] npm test', 'Edited src/a.ts. All good.']);

  // Cursor: nothing new since.
  const again = await orch.read(parent.id, h.session.id, { since: r.cursor });
  assert.equal(again.turns, 0);
  assert.equal(again.finalMessage, undefined);

  // Approvals go to the user: waiting reports it; the parent can't answer.
  await orch.send(parent.id, h.session.id, [{ type: 'text', text: '/approve rm -rf build' }]);
  const waiting = await orch.wait(parent.id, h.session.id, 'waiting', 5000);
  assert.equal(waiting.state, 'waiting_approval');
  assert.match(waiting.reason, /waiting for the user to approve: Run rm -rf build\?/);
  // A timeout reports the state without reaching it.
  const timedOut = await orch.wait(parent.id, h.session.id, 'done', 50);
  assert.equal(timedOut.reached, false);
  assert.match(timedOut.reason, /still waiting_approval/);
  const approvalId = node.sessions.pending(h.session.id).approvals[0]!.approvalId;
  const done = orch.wait(parent.id, h.session.id, 'done', 5000);
  await node.call('approval.respond', { sessionId: h.session.id, approvalId, decision: 'allow' });
  assert.equal((await done).reached, true);

  await orch.interrupt(parent.id, h.session.id);
  await orch.stop(parent.id, h.session.id);
  const ended = await orch.wait(parent.id, h.session.id, 'ended', 1000);
  assert.deepEqual(ended, { sessionId: h.session.id, state: 'ended', reached: true, reason: 'ended: stopped' });
});

test('guardrails: depth limit, per-parent and per-machine concurrency (fail and queue)', async (t) => {
  const { node, workspace } = await setup(t);
  const orch = node.orchestration;
  const { session: root } = await node.call('session.create', { workspaceId: workspace.id, agent: 'claude' });
  await idle(node, root.id);

  // Depth: per-workspace override.
  await node.call('orchestration.settings.set', { workspaceId: workspace.id, settings: { maxDepth: 1 } });
  const d1 = await orch.startHelper(root.id, { agent: 'claude', prompt: 'one' });
  await rejects(orch.startHelper(d1.session.id, { agent: 'claude', prompt: 'two' }), 'conflict', /depth limit reached \(max 1\)/);
  await orch.stop(root.id, d1.session.id);

  // Per parent, fail.
  await node.call('orchestration.settings.set', { workspaceId: workspace.id, settings: { maxDepth: null as never, maxHelpersPerParent: 1 } });
  assert.equal((await node.call('orchestration.settings.get', { workspaceId: workspace.id })).settings.maxDepth, DEFAULT_ORCHESTRATION_SETTINGS.maxDepth);
  const a = await orch.startHelper(root.id, { agent: 'claude', prompt: 'a' });
  await rejects(orch.startHelper(root.id, { agent: 'claude', prompt: 'b' }), 'conflict', /1 live helper\(s\) \(max 1\)/);

  // Queue: starts once a slot frees.
  await node.call('orchestration.settings.set', { workspaceId: workspace.id, settings: { onLimit: 'queue' } });
  const b = await orch.startHelper(root.id, { agent: 'claude', prompt: 'queued prompt' });
  assert.equal(b.queued, true);
  assert.equal(b.session.status, 'starting');
  assert.match(b.notes.join(' '), /queued/);
  assert.equal(node.sessions.isBusy(b.session.id), true);
  await rejects(node.call('session.send', { sessionId: b.session.id, input: [{ type: 'text', text: 'x' }] }), 'conflict', /queued/);
  const waitB = orch.wait(root.id, b.session.id, 'done', 5000);
  await orch.stop(root.id, a.session.id);
  assert.equal((await waitB).reached, true);
  const rb = await orch.read(root.id, b.session.id);
  assert.equal(rb.finalMessage, 'echo: queued prompt');

  // Per machine (machine-level setting).
  await node.call('orchestration.settings.set', { workspaceId: workspace.id, settings: { maxHelpersPerParent: 10, onLimit: 'fail' } });
  await node.call('orchestration.settings.set', { settings: { maxHelpersPerMachine: 1 } });
  await rejects(orch.startHelper(root.id, { agent: 'claude', prompt: 'c' }), 'conflict', /this machine already runs 1 helper/);
  const machine = (await node.call('orchestration.settings.get', {})).settings;
  assert.deepEqual(machine, { ...DEFAULT_ORCHESTRATION_SETTINGS, maxHelpersPerMachine: 1 });
  await rejects(node.call('orchestration.settings.set', { settings: { maxDepth: -1 } }), 'bad_request');
  await rejects(node.call('orchestration.settings.set', { settings: { nope: 1 } as never }), 'bad_request');
  await rejects(node.call('orchestration.settings.get', { machineId: 'm_other' }), 'not_found');
});

test('orchestration settings persist across restarts (machine + workspace overrides)', async (t) => {
  const tmp = tempDir();
  const node = await makeNode(join(tmp.path, 'data'));
  t.after(async () => {
    await node.close();
    tmp.cleanup();
  });
  const { workspace } = await node.call('workspace.create', { path: join(tmp.path, 'ws'), create: true });
  await node.call('orchestration.settings.set', { settings: { treeBudgetUsd: 5 } });
  await node.call('orchestration.settings.set', { workspaceId: workspace.id, settings: { maxDepth: 3, parentAnswersApprovals: true } });
  await node.close();
  const node2 = await makeNode(join(tmp.path, 'data'));
  t.after(() => node2.close());
  const s = (await node2.call('orchestration.settings.get', { workspaceId: workspace.id })).settings;
  assert.deepEqual(s, { ...DEFAULT_ORCHESTRATION_SETTINGS, treeBudgetUsd: 5, maxDepth: 3, parentAnswersApprovals: true });
});

test('permission clamping: never looser than the parent, across agents', () => {
  const claudeModes = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk'];
  const clamp = (parentAgent: 'claude' | 'codex' | 'opencode' | 'agy', parentMode: string | undefined, agent: 'claude' | 'codex' | 'opencode' | 'agy', requested?: string, available?: string[]) =>
    clampPermission({ parentAgent, parentMode, agent, requested, ...(available ? { available } : {}) });
  assert.deepEqual(clamp('claude', 'acceptEdits', 'claude', 'acceptEdits', claudeModes), { permissionMode: 'acceptEdits' });
  assert.deepEqual(clamp('claude', 'plan', 'claude', 'bypassPermissions', claudeModes), {
    permissionMode: 'plan',
    note: "permission mode bypassPermissions is looser than the parent's (plan); using plan",
  });
  // No request: the helper agent's default, capped at the parent's level.
  assert.deepEqual(clamp('claude', 'bypassPermissions', 'claude', undefined, claudeModes), { permissionMode: 'default' });
  assert.deepEqual(clamp('claude', 'plan', 'codex'), { permissionMode: 'read-only' });
  assert.deepEqual(clamp('claude', 'default', 'codex', 'full-access').permissionMode, 'untrusted');
  assert.deepEqual(clamp('codex', 'full-access', 'claude', 'bypassPermissions', claudeModes), { permissionMode: 'bypassPermissions' });
  assert.deepEqual(clamp('claude', 'default', 'opencode', 'build').permissionMode, 'plan');
  assert.deepEqual(clamp('claude', 'acceptEdits', 'opencode').permissionMode, 'build');
  // Unknown requested mode: inherit the parent's.
  assert.deepEqual(clamp('claude', 'acceptEdits', 'claude', 'someNewMode', claudeModes).permissionMode, 'acceptEdits');
  // Unknown parent mode counts as "asks".
  assert.equal(clamp('claude', 'weird', 'codex', 'full-access').permissionMode, 'untrusted');
  // Agents without modes: run at their (asking) defaults, refused under a read-only parent.
  assert.deepEqual(clamp('claude', 'default', 'agy'), {});
  assert.throws(() => clamp('claude', 'plan', 'agy'), /read-only/);
  // Adapter restricts the choice.
  assert.equal(clamp('claude', 'bypassPermissions', 'claude', 'bypassPermissions', ['default', 'plan']).permissionMode, 'default');
});

test('startHelper clamps the helper permission mode and validates input', async (t) => {
  const { node, workspace } = await setup(t, [new FakeAdapter(), new FakeAdapter({ agent: 'codex', capabilities: { permissionModes: ['read-only', 'untrusted', 'auto', 'full-access'] } })]);
  const { session: parent } = await node.call('session.create', { workspaceId: workspace.id, agent: 'claude', permissionMode: 'plan' });
  await idle(node, parent.id);
  const h = await node.orchestration.startHelper(parent.id, { agent: 'codex', prompt: 'review', permissionMode: 'full-access' });
  assert.equal(h.session.permissionMode, 'read-only');
  assert.match(h.notes[0] ?? '', /looser than the parent's \(plan\)/);
  const c = await node.orchestration.startHelper(parent.id, { agent: 'claude', prompt: 'x' });
  assert.equal(c.session.permissionMode, 'plan');
  await rejects(node.orchestration.startHelper(parent.id, { agent: 'claude', prompt: ' ' }), 'bad_request');
  await rejects(node.orchestration.startHelper(parent.id, { agent: 'opencode', prompt: 'x' }), 'agent_unavailable');
  await rejects(node.orchestration.startHelper(parent.id, { agent: 'claude', prompt: 'x', workspace: '/nowhere' }), 'not_found');
});

test('budgets: turns and tokens stop at the turn boundary; send refused; metered-only usd; tree cap', async (t) => {
  const metered = new FakeAdapter({ agent: 'opencode', probe: { billing: 'metered' }, usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.4 } });
  const plan = new FakeAdapter({ agent: 'codex', probe: { billing: 'plan' }, usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.4 } });
  const { node, workspace } = await setup(t, [new FakeAdapter(), metered, plan]);

  // turns
  const { session } = await node.call('session.create', { workspaceId: workspace.id, agent: 'claude', budget: { turns: 1 } });
  assert.deepEqual(session.budget, { turns: 1 });
  const rec = record(node, sessionChannel(session.id));
  await node.call('session.send', { sessionId: session.id, input: [{ type: 'text', text: 'one' }] });
  const st = await rec.waitFor('session.status', (e) => e.data.prompt === 'budget');
  assert.deepEqual(st.data, { status: 'waiting_input', prompt: 'budget', reason: 'budget reached: 1/1 turns' });
  assert.equal(node.sessions.get(session.id).session.status, 'waiting_input');
  await rejects(node.call('session.send', { sessionId: session.id, input: [{ type: 'text', text: 'two' }] }), 'conflict', /budget reached: 1\/1 turns; raise the budget/);
  await rejects(node.call('session.create', { workspaceId: workspace.id, agent: 'claude', budget: { turns: 1.5 } }), 'bad_request');
  await rejects(node.call('session.create', { workspaceId: workspace.id, agent: 'claude', budget: { usd: -1 } }), 'bad_request');

  // usd counts on metered only; tokens always.
  const { session: m } = await node.call('session.create', { workspaceId: workspace.id, agent: 'opencode', budget: { usd: 0.5 } });
  await waitFor(() => node.sessions.get(m.id).session.billing === 'metered', 5000, 'billing derived');
  await node.call('session.send', { sessionId: m.id, input: [{ type: 'text', text: 'one' }] });
  await idle(node, m.id);
  await node.call('session.send', { sessionId: m.id, input: [{ type: 'text', text: 'two' }] });
  await waitFor(() => node.sessions.pending(m.id).budget, 5000, 'usd budget');
  assert.match(node.sessions.pending(m.id).budget!, /\$0\.8000 of \$0\.5000 metered spend/);

  const { session: p } = await node.call('session.create', { workspaceId: workspace.id, agent: 'codex', budget: { usd: 0.5, tokens: 400 } });
  await waitFor(() => node.sessions.get(p.id).session.billing === 'plan', 5000, 'plan billing');
  for (const text of ['one', 'two']) {
    await node.call('session.send', { sessionId: p.id, input: [{ type: 'text', text }] });
    await idle(node, p.id);
  }
  assert.deepEqual(node.sessions.spent(p.id).own, { usd: 0, tokens: 300, turns: 2 });
  await node.call('session.send', { sessionId: p.id, input: [{ type: 'text', text: 'three' }] });
  await waitFor(() => node.sessions.pending(p.id).budget, 5000, 'token budget');
  assert.equal(node.sessions.pending(p.id).budget, 'budget reached: 450/400 tokens');

  // Tree cap from settings: helper spend counts toward the root; raising the cap releases them.
  await node.call('orchestration.settings.set', { workspaceId: workspace.id, settings: { treeBudgetUsd: 0.3 } });
  const { session: root } = await node.call('session.create', { workspaceId: workspace.id, agent: 'claude' });
  await idle(node, root.id);
  const h = await node.orchestration.startHelper(root.id, { agent: 'opencode', prompt: 'spend' });
  await waitFor(() => node.sessions.pending(h.session.id).budget, 5000, 'tree budget on helper');
  assert.equal(node.sessions.pending(h.session.id).budget, 'tree budget reached: $0.4000 of $0.3000 metered spend');
  await rejects(node.call('session.send', { sessionId: root.id, input: [{ type: 'text', text: 'more' }] }), 'conflict', /tree budget reached/);
  const w = await node.orchestration.wait(root.id, h.session.id, 'done', 1000);
  assert.equal(w.reached, true);
  assert.match(w.reason, /tree budget reached/);
  await node.call('orchestration.settings.set', { workspaceId: workspace.id, settings: { treeBudgetUsd: 10 } });
  await waitFor(() => node.sessions.get(h.session.id).session.status === 'idle', 5000, 'released');
  assert.equal(node.sessions.pending(h.session.id).budget, undefined);
  await node.call('session.send', { sessionId: root.id, input: [{ type: 'text', text: 'more' }] });
  await idle(node, root.id);

  // Helper budget bounds the helper and its own helpers.
  const hb = await node.orchestration.startHelper(root.id, { agent: 'claude', prompt: 'first', budget: { turns: 2 } });
  await idle(node, hb.session.id);
  const gc = await node.orchestration.startHelper(hb.session.id, { agent: 'claude', prompt: 'grandchild' });
  await waitFor(() => node.sessions.pending(gc.session.id).budget, 5000, 'parent budget applies to grandchild');
  assert.equal(node.sessions.pending(gc.session.id).budget, `budget of session ${hb.session.id} reached: 2/2 turns`);
});

test('budget holds survive a restart', async (t) => {
  const tmp = tempDir();
  const dataDir = join(tmp.path, 'data');
  const node = await makeNode(dataDir);
  t.after(async () => {
    await node.close();
    tmp.cleanup();
  });
  const { workspace } = await node.call('workspace.create', { path: join(tmp.path, 'ws'), create: true });
  const { session } = await node.call('session.create', { workspaceId: workspace.id, agent: 'claude', budget: { turns: 1 } });
  await node.call('session.send', { sessionId: session.id, input: [{ type: 'text', text: 'one' }] });
  await waitFor(() => node.sessions.pending(session.id).budget, 5000, 'budget');
  await node.close();
  const node2 = await createNode({ dataDir, adapters: [new FakeAdapter()], version: '0', interruptGraceMs: 200 });
  t.after(() => node2.close());
  const s = node2.sessions.get(session.id).session;
  assert.equal(s.status, 'waiting_input');
  assert.deepEqual(node2.sessions.spent(session.id).own, { usd: 0, tokens: 30, turns: 1 });
  await rejects(node2.call('session.send', { sessionId: session.id, input: [{ type: 'text', text: 'x' }] }), 'conflict', /budget/);
});

test('extensions contribute prepareStart hooks, merged after NodeOptions.prepareStart', async (t) => {
  const tmp = tempDir();
  const fake = new FakeAdapter();
  const node = await createNode({
    dataDir: join(tmp.path, 'data'),
    adapters: [fake],
    version: '0',
    prepareStart: () => ({ env: { A: '1' }, systemPromptAppend: 'first', mcpServers: { one: { type: 'stdio', command: 'x' } } }),
    extensions: [
      { methods: {}, prepareStart: () => ({ env: { B: '2' }, systemPromptAppend: 'second', mcpServers: { two: { type: 'http', url: 'http://127.0.0.1:1/mcp' } } }) },
    ],
  });
  t.after(async () => {
    await node.close();
    tmp.cleanup();
  });
  const { workspace } = await node.call('workspace.create', { path: join(tmp.path, 'ws'), create: true });
  const { session } = await node.call('session.create', { workspaceId: workspace.id, agent: 'claude' });
  await idle(node, session.id);
  const opts = fake.starts[0]!;
  assert.deepEqual(opts.env, { A: '1', B: '2' });
  assert.equal(opts.systemPromptAppend, 'first\n\nsecond');
  assert.deepEqual(Object.keys(opts.mcpServers ?? {}), ['one', 'two']);
});
