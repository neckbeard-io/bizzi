// Step 3 of routing (spec §11.2, knowledge.md §9.3): your routing preferences. "production, prod logs →
// machines tagged prod-access". Deterministic and local: a rule is tried before any classifier sees the
// prompt, and the first rule that matches narrows the targets to its tag, machine or workspace.

import { AGENT_KINDS, BizziError, isMachineTag, ulid, type AgentKind, type MachineInfo, type RoutingRule, type WorkspaceInfo } from '@bizzi/protocol';
import type { RouteTarget } from './catalogue.ts';

export const MAX_RULES = 200;
export const MAX_RULE_WORDS = 50;
const MAX_WORD = 100;

/** Validate `route.rules.set` params. Rules without an id get one; duplicate ids are refused. Throws bad_request. */
export function parseRules(params: unknown): RoutingRule[] {
  const raw = params && typeof params === 'object' ? (params as { rules?: unknown }).rules : undefined;
  if (!Array.isArray(raw)) throw new BizziError('bad_request', 'rules must be an array');
  if (raw.length > MAX_RULES) throw new BizziError('bad_request', `at most ${MAX_RULES} rules`);
  const ids = new Set<string>();
  return raw.map((r, i) => {
    const rule = parseRule(r, i);
    if (ids.has(rule.id)) throw new BizziError('bad_request', `rules[${i}]: duplicate id ${rule.id}`);
    ids.add(rule.id);
    return rule;
  });
}

function parseRule(r: unknown, i: number): RoutingRule {
  const bad = (msg: string) => new BizziError('bad_request', `rules[${i}]: ${msg}`);
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw bad('must be an object');
  const o = r as Record<string, unknown>;
  const id = o.id === undefined || o.id === '' ? `rr_${ulid()}` : o.id;
  if (typeof id !== 'string' || id.length > 64) throw bad('id must be a string of at most 64 characters');
  if (!Array.isArray(o.match)) throw bad('match must be an array of words or phrases');
  const match = [...new Set(o.match.map((w) => (typeof w === 'string' ? w.replace(/\s+/g, ' ').trim().toLowerCase() : '')).filter(Boolean))];
  if (match.length === 0) throw bad('match needs at least one word or phrase');
  if (match.length > MAX_RULE_WORDS || match.some((w) => w.length > MAX_WORD)) throw bad(`at most ${MAX_RULE_WORDS} phrases of ${MAX_WORD} characters`);
  const targets = (['tag', 'machineId', 'workspaceId'] as const).filter((k) => o[k] !== undefined && o[k] !== '');
  if (targets.length !== 1) throw bad('exactly one of tag, machineId, workspaceId is required');
  const key = targets[0]!;
  const value = o[key];
  if (typeof value !== 'string' || value.length > 128) throw bad(`${key} must be a string`);
  if (key === 'tag' && !isMachineTag(value)) throw bad('tag must be a machine tag (lowercase letters, digits, _ . -)');
  const rule: RoutingRule = { id, match, [key]: value };
  if (o.agent !== undefined) {
    if (!(AGENT_KINDS as readonly unknown[]).includes(o.agent)) throw bad(`agent must be one of ${AGENT_KINDS.join(', ')}`);
    rule.agent = o.agent as AgentKind;
  }
  return rule;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether one of the rule's phrases is in `text`: whole words, case-insensitive; `prod*` matches a word prefix. */
export function ruleMatches(rule: Pick<RoutingRule, 'match'>, text: string): string | null {
  const t = text.toLowerCase();
  for (const phrase of rule.match) {
    const prefix = phrase.endsWith('*');
    const body = (prefix ? phrase.slice(0, -1) : phrase).trim();
    if (!body) continue;
    const words = body.split(' ').map(escape).join('\\s+');
    // Word characters plus `-`: `prod` doesn't match inside `preprod` or `prod-like`.
    const re = new RegExp(`(?<![\\w-])${words}${prefix ? '' : '(?![\\w-])'}`, 'u');
    if (re.test(t)) return phrase;
  }
  return null;
}

/** "prod, production → tag prod-access", for notes and the rule list. */
export function ruleLabel(rule: RoutingRule, names: { machines?: MachineInfo[]; workspaces?: WorkspaceInfo[] } = {}): string {
  const words = rule.match.join(', ');
  if (rule.tag) return `${words} → ${rule.tag}`;
  if (rule.machineId) return `${words} → ${names.machines?.find((m) => m.id === rule.machineId)?.name ?? rule.machineId}`;
  const ws = names.workspaces?.find((w) => w.id === rule.workspaceId);
  const m = ws && names.machines?.find((x) => x.id === ws.machineId);
  return `${words} → ${ws ? (m ? `${m.name} · ${ws.name}` : ws.name) : rule.workspaceId}`;
}

export interface RuleRoute {
  rule: RoutingRule;
  label: string;
  /** Online targets the rule allows (may be empty: see `problem`). */
  targets: RouteTarget[];
  problem?: string;
}

/**
 * The first rule that matches `text`, and the targets it leaves. `all` includes offline machines so the
 * problem can say "laptop is offline" rather than routing a prod question somewhere without prod access.
 */
export function applyRules(rules: readonly RoutingRule[], text: string, all: RouteTarget[], machines: MachineInfo[], workspaces: WorkspaceInfo[]): RuleRoute | null {
  for (const rule of rules) {
    if (!ruleMatches(rule, text)) continue;
    const label = ruleLabel(rule, { machines, workspaces });
    const allowed = all.filter((t) => (rule.tag ? t.machine.tags.includes(rule.tag) : rule.machineId ? t.machine.id === rule.machineId : t.workspace.id === rule.workspaceId));
    const online = allowed.filter((t) => t.machine.online);
    if (online.length > 0) return { rule, label, targets: online };
    let problem: string;
    if (allowed.length > 0) {
      const names = [...new Set(allowed.map((t) => t.machine.name))];
      problem = `${names.join(', ')} ${names.length > 1 ? 'are' : 'is'} offline`;
    } else if (rule.tag) {
      problem = machines.some((m) => m.tags.includes(rule.tag!)) ? `no workspace on a machine tagged ${rule.tag}` : `no machine is tagged ${rule.tag}`;
    } else {
      problem = rule.machineId ? 'its machine has no workspaces' : 'its workspace no longer exists';
    }
    return { rule, label, targets: [], problem: `rule "${label}": ${problem}` };
  }
  return null;
}
