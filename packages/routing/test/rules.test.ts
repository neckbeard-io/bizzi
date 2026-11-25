import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createNode } from '@bizzi/core';
import { FakeAdapter } from '@bizzi/core/testing';
import type { MachineInfo, RouteDecisionInput, RoutingRule, WorkspaceInfo } from '@bizzi/protocol';
import { RouteStore, Router, createRoutingExtension, parseRules, ruleMatches, type OptionScorer } from '../src/index.ts';

function machine(id: string, name: string, over: Partial<MachineInfo> = {}): MachineInfo {
  return { id, name, hostname: `${name}.local`, os: 'darwin', arch: 'arm64', headful: false, alwaysOn: false, tags: [], online: true, roles: ['node'], bizziVersion: '0.0.0', ...over };
}
function workspace(id: string, machineId: string, name: string): WorkspaceInfo {
  return { id, machineId, name, path: `/src/${name}`, kind: 'git', createdAt: '2026-11-01T00:00:00.000Z' };
}

const LAPTOP = machine('m_L', 'laptop', { tags: ['prod-access'] });
const MINI = machine('m_M', 'mac-mini', { tags: ['gui'] });
const WS = [workspace('w_1', 'm_L', 'acme-shop'), workspace('w_2', 'm_M', 'acme-shop'), workspace('w_3', 'm_L', 'bizzi'), workspace('w_4', 'm_M', 'site')];
const INPUT = { machines: [LAPTOP, MINI], workspaces: WS };
const PROD: RoutingRule = { id: 'r_prod', match: ['production', 'prod*', 'checkout 502s'], tag: 'prod-access', agent: 'codex' };
const UI: RoutingRule = { id: 'r_ui', match: ['screenshot'], workspaceId: 'w_4' };

test('rules match whole words and phrases, case-insensitive; a trailing * matches a prefix', () => {
  assert.equal(ruleMatches(PROD, 'Why are CHECKOUT  502s up?'), 'checkout 502s');
  assert.equal(ruleMatches(PROD, 'look at the prod logs'), 'prod*');
  assert.equal(ruleMatches(PROD, 'production is down'), 'production');
  assert.equal(ruleMatches(PROD, 'the preprod box'), null);
  assert.equal(ruleMatches({ match: ['ui'] }, 'build a uint parser'), null);
  assert.equal(ruleMatches({ match: ['ui'] }, 'fix the UI, please'), 'ui');
});

test('parseRules validates and fills ids', () => {
  const [r] = parseRules({ rules: [{ match: [' Prod  Logs ', 'prod logs', ''], tag: 'prod-access' }] });
  assert.match(r!.id, /^rr_/);
  assert.deepEqual(r!.match, ['prod logs']);
  assert.throws(() => parseRules({ rules: [{ match: ['x'] }] }), /exactly one of tag/);
  assert.throws(() => parseRules({ rules: [{ match: ['x'], tag: 'a', machineId: 'm' }] }), /exactly one of tag/);
  assert.throws(() => parseRules({ rules: [{ match: [], tag: 'a' }] }), /at least one/);
  assert.throws(() => parseRules({ rules: [{ match: ['x'], tag: 'Not A Tag' }] }), /machine tag/);
  assert.throws(() => parseRules({ rules: [{ match: ['x'], tag: 'a', agent: 'gpt' }] }), /agent must be/);
  assert.throws(() => parseRules({ rules: [{ id: 'a', match: ['x'], tag: 'a' }, { id: 'a', match: ['y'], tag: 'b' }] }), /duplicate id/);
  assert.throws(() => parseRules({}), /rules must be an array/);
});

test('route.suggest: a rule narrows before the classifier; tokens beat rules', async () => {
  const router = new Router();
  // One target left: decided by the rule, with the rule's agent.
  const ui = await router.suggest('take a screenshot of the header', INPUT, { rules: [PROD, UI] });
  assert.deepEqual([ui.source, ui.confident, ui.candidates[0]?.workspaceId, ui.rule?.id], ['rule', true, 'w_4', 'r_ui']);
  // Several: no classifier, so the user picks among the rule's targets.
  const prod = await router.suggest('why are checkout 502s up since 14:00?', INPUT, { rules: [PROD, UI] });
  assert.deepEqual([prod.source, prod.confident, prod.agent, prod.candidates.map((c) => c.workspaceId).sort()], ['rule', false, 'codex', ['w_1', 'w_3']]);
  assert.equal(prod.note, 'rule "production, prod*, checkout 502s → prod-access" matches 2 workspaces');
  // `/agent` in the text beats the rule's agent; `@` / `#` tokens skip rules.
  assert.equal((await router.suggest('/claude prod is slow', INPUT, { rules: [PROD] })).agent, 'claude');
  const tok = await router.suggest('@mac-mini #site prod screenshot', INPUT, { rules: [PROD, UI] });
  assert.deepEqual([tok.source, tok.candidates[0]?.workspaceId, tok.rule], ['explicit', 'w_4', undefined]);

  // With a classifier, it only sees the rule's targets.
  const seen: string[][] = [];
  const scorer: OptionScorer = { model: 'fake', limit: 20, score: async (_t, options) => (seen.push(options), { probabilities: options.map((_, i) => (i === 0 ? 0.95 : 0.05)), letterMass: 1, ms: 1 }) };
  const scored = await router.suggest('production checkout errors', INPUT, { rules: [PROD], remote: [scorer] });
  assert.equal(scored.source, 'classifier');
  assert.equal(scored.rule?.id, 'r_prod');
  assert.equal(seen[0]!.length, 2);
  assert.ok(seen[0]!.every((o) => o.startsWith('laptop')));
});

test('route.suggest: a rule whose machines are offline says so instead of routing elsewhere', async () => {
  const router = new Router();
  const off = await router.suggest('prod is down', { machines: [{ ...LAPTOP, online: false }, MINI], workspaces: WS }, { rules: [PROD] });
  assert.deepEqual([off.source, off.candidates.length], ['none', 0]);
  assert.equal(off.note, 'rule "production, prod*, checkout 502s → prod-access": laptop is offline');
  const untagged = await router.suggest('prod is down', { machines: [{ ...LAPTOP, tags: [] }, MINI], workspaces: WS }, { rules: [PROD] });
  assert.match(untagged.note ?? '', /no machine is tagged prod-access/);
});

function decision(over: Partial<RouteDecisionInput> = {}): RouteDecisionInput {
  return {
    text: 'fix the flaky checkout test',
    source: 'classifier',
    candidates: [
      { machineId: 'm_L', workspaceId: 'w_1', label: 'laptop · acme-shop', probability: 0.55 },
      { machineId: 'm_M', workspaceId: 'w_2', label: 'mac-mini · acme-shop', probability: 0.45 },
    ],
    confidence: 0.4,
    classifier: { model: 'vllm/qwen' },
    chosen: { machineId: 'm_M', workspaceId: 'w_2', label: 'mac-mini · acme-shop', agent: 'claude' },
    via: 'picked',
    overridden: true,
    ...over,
  };
}

test('RouteStore records decisions newest first, filters overrides, pages, and keeps rules', () => {
  const db = new DatabaseSync(':memory:');
  let t = Date.parse('2026-11-25T10:00:00Z');
  const store = new RouteStore(db, () => new Date((t += 1000)));
  const a = store.record({ decision: decision() });
  const b = store.record({ decision: decision({ via: 'suggested', overridden: false, chosen: { machineId: 'm_L', workspaceId: 'w_1', label: 'laptop · acme-shop' } }) });
  const c = store.record({ decision: { ...decision(), extra: 'dropped' } });
  assert.match(a.id, /^rd_/);
  assert.equal((c as unknown as Record<string, unknown>).extra, undefined);
  const all = store.list({});
  assert.deepEqual([all.total, all.decisions.map((d) => d.id)], [3, [c.id, b.id, a.id]]);
  const over = store.list({ overridden: true, limit: 1 });
  assert.deepEqual([over.total, over.decisions.map((d) => d.id)], [2, [c.id]]);
  assert.deepEqual(store.list({ overridden: true, before: c.id }).decisions.map((d) => d.id), [a.id]);
  assert.throws(() => store.record({ decision: decision({ via: 'guessed' as never }) }), /via must be/);
  assert.throws(() => store.record({ decision: decision({ confidence: 2 }) }), /confidence/);
  assert.throws(() => store.list({ limit: 0 }), /limit/);

  assert.deepEqual(store.rules(), []);
  store.setRules({ rules: [PROD] });
  assert.deepEqual(store.rules(), [PROD]);
  db.close();
});

test('the node extension keeps rules and decisions in its own database and routes with the rules', async (t) => {
  const dir = mkdtempSync(join(os.tmpdir(), 'bizzi-routing-'));
  const node = await createNode({
    dataDir: dir,
    adapters: [new FakeAdapter()],
    version: '0.0.0-test',
    machineName: 'laptop',
    extensions: [createRoutingExtension({}, { dbPath: join(dir, 'routing.db') })],
  });
  const bare = await createNode({ dataDir: join(dir, 'bare'), adapters: [new FakeAdapter()], version: '0.0.0-test', extensions: [createRoutingExtension()] });
  t.after(async () => {
    await node.close();
    await bare.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const a = await node.call('workspace.create', { path: join(dir, 'acme'), create: true, name: 'acme' });
  await node.call('workspace.create', { path: join(dir, 'notes'), create: true, name: 'notes' });
  await node.call('route.rules.set', { rules: [{ id: 'r1', match: ['checkout'], workspaceId: a.workspace.id }] });
  const { suggestion } = (await node.call('route.suggest', { text: 'the checkout is slow' })) as { suggestion: any };
  assert.deepEqual([suggestion.source, suggestion.candidates[0].workspaceId, suggestion.rule.id], ['rule', a.workspace.id, 'r1']);

  const { decision: saved } = (await node.call('route.record', { decision: decision() })) as { decision: any };
  const { decisions, total } = (await node.call('route.decisions', {})) as { decisions: any[]; total: number };
  assert.deepEqual([total, decisions[0].id], [1, saved.id]);
  await assert.rejects(bare.call('route.record', { decision: decision() }), (e: any) => e.code === 'unsupported');
});
