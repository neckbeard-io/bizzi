// Acceptance policy (docs/knowledge.md §3.1) and default scope for agent writes (§3.3).
// Decides, per write source × target scope, whether an item goes live, goes live with an
// inbox notice (undo), or becomes a suggestion waiting in the inbox.

import type { KnowledgeStore } from './store.ts';
import type { KnowledgeSource, KnowledgeType, ScopeLevel, SessionScopeLevel } from './types.ts';

/** Who/what is writing. Derived from the item's source + type, see `policySourceOf`. */
export type PolicySource =
  | 'user' // you, in the UI / CLI
  | 'agentRuleRequested' // agent rule, the user asked for it ("you told me to always…")
  | 'agentRule' // agent rule, unprompted
  | 'agentMemory' // agent memory, explicit save (memory_add or native memory harvest)
  | 'extracted'; // extracted from transcripts
export const POLICY_SOURCES: readonly PolicySource[] = ['user', 'agentRuleRequested', 'agentRule', 'agentMemory', 'extracted'];

export type PolicyDecision = 'live' | 'notice' | 'suggest';
export type PolicyPreset = 'trusting' | 'balanced' | 'strict';
export const POLICY_PRESETS: readonly PolicyPreset[] = ['trusting', 'balanced', 'strict'];

export type PolicyTable = Record<PolicySource, Record<SessionScopeLevel, PolicyDecision>>;
export type PolicyOverrides = Partial<Record<PolicySource, Partial<Record<SessionScopeLevel, PolicyDecision>>>>;

export interface PolicyConfig {
  preset: PolicyPreset;
  /** Cells that differ from the preset. */
  overrides?: PolicyOverrides;
}

export interface KnowledgeSettings {
  policy: PolicyConfig;
  /** Per-project policy (replaces preset, merges overrides over the global ones). */
  projects?: Record<string, Partial<PolicyConfig>>;
  /** Scope used when an agent write omits `scope` (§3.3). Default: project. */
  defaultAgentScope: SessionScopeLevel;
}

export const DEFAULT_SETTINGS: KnowledgeSettings = {
  policy: { preset: 'balanced' },
  defaultAgentScope: 'project',
};

const row = (session: PolicyDecision, workspace: PolicyDecision, project: PolicyDecision, machine: PolicyDecision, global: PolicyDecision) => ({
  session,
  workspace,
  project,
  machine,
  global,
});

const all = (d: PolicyDecision) => row(d, d, d, d, d);

export const PRESETS: Readonly<Record<PolicyPreset, PolicyTable>> = {
  trusting: {
    user: all('live'),
    agentRuleRequested: all('live'),
    agentRule: all('live'),
    agentMemory: all('live'),
    extracted: all('live'),
  },
  // The table in knowledge.md §3.1: the broader the blast radius, the stricter.
  balanced: {
    user: all('live'),
    agentRuleRequested: row('notice', 'notice', 'notice', 'notice', 'suggest'),
    agentRule: all('suggest'),
    agentMemory: row('live', 'live', 'live', 'live', 'suggest'),
    extracted: all('suggest'),
  },
  strict: {
    user: all('live'),
    agentRuleRequested: all('suggest'),
    agentRule: all('suggest'),
    agentMemory: all('suggest'),
    extracted: all('suggest'),
  },
};

export interface PolicyInput {
  source: PolicySource;
  scope: ScopeLevel;
  /** Project of the target item or session, for per-project policy. */
  projectId?: string;
}

export interface PolicyResult {
  decision: PolicyDecision;
  status: 'active' | 'suggested';
  noticePending: boolean;
}

export function policySourceOf(type: KnowledgeType, source: Pick<KnowledgeSource, 'via' | 'userRequested'>): PolicySource {
  switch (source.via) {
    case 'ui':
      return 'user';
    case 'extract':
      return 'extracted';
    case 'tool':
    case 'harvest':
      if (type === 'rule') return source.userRequested ? 'agentRuleRequested' : 'agentRule';
      return 'agentMemory';
  }
}

/** Effective table for a project (or the global one). */
export function policyTable(settings: Pick<KnowledgeSettings, 'policy' | 'projects'>, projectId?: string): PolicyTable {
  const proj = projectId ? settings.projects?.[projectId] : undefined;
  const preset = proj?.preset ?? settings.policy.preset;
  const base = PRESETS[preset];
  const table = Object.fromEntries(POLICY_SOURCES.map((s) => [s, { ...base[s] }])) as PolicyTable;
  for (const ov of [settings.policy.overrides, proj?.overrides]) {
    if (!ov) continue;
    for (const s of POLICY_SOURCES) Object.assign(table[s], ov[s] ?? {});
  }
  return table;
}

export function decide(settings: Pick<KnowledgeSettings, 'policy' | 'projects'>, input: PolicyInput): PolicyResult {
  let decision: PolicyDecision;
  if (input.scope === 'team') {
    // §8: team-scope writes always go to review (even yours, until maintainers exist).
    decision = 'suggest';
  } else {
    // A tag reaches every machine carrying it, so it takes global's row.
    const level = input.scope === 'tag' ? 'global' : input.scope;
    decision = policyTable(settings, input.projectId)[input.source][level];
  }
  return {
    decision,
    status: decision === 'suggest' ? 'suggested' : 'active',
    noticePending: decision === 'notice',
  };
}

const SETTINGS_KEY = 'knowledge.settings';

export function loadSettings(store: KnowledgeStore): KnowledgeSettings {
  const s = store.getSetting<Partial<KnowledgeSettings>>(SETTINGS_KEY);
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    policy: { ...DEFAULT_SETTINGS.policy, ...s?.policy },
  };
}

export function saveSettings(store: KnowledgeStore, patch: Partial<KnowledgeSettings>): KnowledgeSettings {
  const next = { ...loadSettings(store), ...patch };
  store.setSetting(SETTINGS_KEY, next);
  return next;
}
