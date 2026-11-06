import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS,
  POLICY_SOURCES,
  SESSION_SCOPE_LEVELS,
  addKnowledge,
  decide,
  defaultScopeLevel,
  loadSettings,
  originFromContext,
  policySourceOf,
  saveSettings,
} from '../src/index.ts';
import type { KnowledgeSettings, PolicyDecision, PolicySource } from '../src/index.ts';
import { CTX, M1, P1, P2, memStore } from './helpers.ts';

const LEVELS = ['session', 'workspace', 'project', 'machine', 'global'] as const;

function table(settings: KnowledgeSettings, projectId?: string): Record<PolicySource, PolicyDecision[]> {
  return Object.fromEntries(
    POLICY_SOURCES.map((s) => [s, LEVELS.map((l) => decide(settings, { source: s, scope: l, ...(projectId ? { projectId } : {}) }).decision)]),
  ) as Record<PolicySource, PolicyDecision[]>;
}

test('balanced preset is the §3.1 table', () => {
  assert.deepEqual(table(DEFAULT_SETTINGS), {
    //                  session   workspace project   machine   global
    user: ['live', 'live', 'live', 'live', 'live'],
    agentRuleRequested: ['notice', 'notice', 'notice', 'notice', 'suggest'],
    agentRule: ['suggest', 'suggest', 'suggest', 'suggest', 'suggest'],
    agentMemory: ['live', 'live', 'live', 'live', 'suggest'],
    extracted: ['suggest', 'suggest', 'suggest', 'suggest', 'suggest'],
  });
});

test('trusting and strict presets', () => {
  const trusting = table({ ...DEFAULT_SETTINGS, policy: { preset: 'trusting' } });
  for (const s of POLICY_SOURCES) assert.deepEqual(trusting[s], ['live', 'live', 'live', 'live', 'live'], s);
  const strict = table({ ...DEFAULT_SETTINGS, policy: { preset: 'strict' } });
  assert.deepEqual(strict.user, ['live', 'live', 'live', 'live', 'live']);
  for (const s of POLICY_SOURCES.filter((x) => x !== 'user')) {
    assert.deepEqual(strict[s], ['suggest', 'suggest', 'suggest', 'suggest', 'suggest'], s);
  }
});

test('team scope always goes to review', () => {
  for (const preset of ['trusting', 'balanced', 'strict'] as const) {
    assert.equal(decide({ policy: { preset } }, { source: 'user', scope: 'team' }).status, 'suggested');
  }
});

test('overrides per cell and per project', () => {
  const settings: KnowledgeSettings = {
    ...DEFAULT_SETTINGS,
    policy: { preset: 'balanced', overrides: { agentMemory: { global: 'live' } } },
    projects: { [P2]: { preset: 'strict', overrides: { agentMemory: { project: 'notice' } } } },
  };
  assert.equal(decide(settings, { source: 'agentMemory', scope: 'global' }).decision, 'live');
  assert.equal(decide(settings, { source: 'agentMemory', scope: 'project', projectId: P1 }).decision, 'live');
  const p2 = decide(settings, { source: 'agentMemory', scope: 'project', projectId: P2 });
  assert.deepEqual(p2, { decision: 'notice', status: 'active', noticePending: true });
  assert.equal(decide(settings, { source: 'agentMemory', scope: 'workspace', projectId: P2 }).decision, 'suggest');
  // Global overrides still apply inside a project unless the project overrides that cell.
  assert.equal(decide(settings, { source: 'agentMemory', scope: 'global', projectId: P2 }).decision, 'live');
});

test('policy source from type + origin, userRequested only matters for agent rules', () => {
  assert.equal(policySourceOf('rule', { via: 'ui' }), 'user');
  assert.equal(policySourceOf('rule', { via: 'tool', userRequested: true }), 'agentRuleRequested');
  assert.equal(policySourceOf('rule', { via: 'tool' }), 'agentRule');
  assert.equal(policySourceOf('memory', { via: 'tool', userRequested: true }), 'agentMemory');
  assert.equal(policySourceOf('memory', { via: 'harvest' }), 'agentMemory');
  assert.equal(policySourceOf('memory', { via: 'extract' }), 'extracted');
});

test('agent writes through the pipeline honor the stored policy', () => {
  const { store } = memStore();
  const origin = originFromContext(CTX, 'tool');
  const mem = addKnowledge(store, { type: 'memory', kind: 'fact', title: 'm1', body: 'b', scope: 'project' }, origin);
  assert.equal(mem.item.status, 'active');
  const memGlobal = addKnowledge(store, { type: 'memory', kind: 'fact', title: 'm2', body: 'b', scope: 'global' }, origin);
  assert.equal(memGlobal.item.status, 'suggested');
  const unprompted = addKnowledge(store, { type: 'rule', title: 'r1', body: '', scope: 'workspace' }, origin);
  assert.equal(unprompted.item.status, 'suggested');
  const asked = addKnowledge(store, { type: 'rule', title: 'r2', body: '', scope: 'workspace' }, { ...origin, userRequested: true });
  assert.equal(asked.item.status, 'active');
  assert.equal(asked.item.noticePending, true);
  assert.equal(asked.item.source.userRequested, true);
  const askedGlobal = addKnowledge(store, { type: 'rule', title: 'r3', body: '', scope: 'global' }, { ...origin, userRequested: true });
  assert.equal(askedGlobal.item.status, 'suggested');
  const user = addKnowledge(store, { type: 'rule', title: 'r4', body: '', scope: 'global' }, { via: 'ui', machineId: M1 });
  assert.equal(user.item.status, 'active');
  assert.equal(user.item.noticePending, undefined);

  saveSettings(store, { policy: { preset: 'strict' } });
  assert.equal(loadSettings(store).policy.preset, 'strict');
  const strictMem = addKnowledge(store, { type: 'memory', kind: 'fact', title: 'm3', body: 'b', scope: 'project' }, origin);
  assert.equal(strictMem.item.status, 'suggested');
});

test('default scope for agent writes: setting, default project, fallback when the context lacks it', () => {
  const { store } = memStore();
  const r = addKnowledge(store, { type: 'memory', kind: 'fact', title: 'no scope', body: 'b' }, originFromContext(CTX));
  assert.equal(r.scopeDefaulted, true);
  assert.deepEqual(r.item.scope, { level: 'project', projectId: P1 });

  assert.equal(defaultScopeLevel(DEFAULT_SETTINGS, { machineId: M1, workspaceId: 'w' }), 'workspace');
  assert.equal(defaultScopeLevel(DEFAULT_SETTINGS, { machineId: M1 }), 'machine');
  assert.equal(defaultScopeLevel({ defaultAgentScope: 'session' }, { machineId: M1, projectId: P1 }), 'machine');
  assert.equal(defaultScopeLevel({ defaultAgentScope: 'global' }, CTX), 'global');

  saveSettings(store, { defaultAgentScope: 'workspace' });
  const w = addKnowledge(store, { type: 'memory', kind: 'fact', title: 'ws', body: 'b' }, originFromContext(CTX));
  assert.deepEqual(w.item.scope, { level: 'workspace', workspaceId: CTX.workspaceId });

  assert.throws(
    () => addKnowledge(store, { type: 'memory', kind: 'fact', title: 'x', body: 'b', scope: 'project' }, originFromContext({ agent: 'codex', machineId: M1 })),
    /no projectId/,
  );
  assert.ok(SESSION_SCOPE_LEVELS.includes('session'));
});
