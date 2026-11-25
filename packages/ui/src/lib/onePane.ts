// One-pane mode (spec §11.2): the pure parts of the composer. Autocomplete for `@machine`, `#workspace` and
// `/agent`, token insertion, whether a follow-up continues the open session (step 2), and turning a
// `route.suggest` answer into "send" or "ask". Everything here works from the store's machines,
// workspaces and agents; nothing calls the server.
import { AGENT_KINDS } from '@bizzi/protocol';
import type { AgentKind, AgentListing, MachineInfo, RouteCandidate, RouteDecisionInput, RouteSuggestion, SessionInfo, WorkspaceInfo } from '@bizzi/protocol';

export type Sigil = '@' | '#' | '/';

/** The routing token the caret is in: `start`–`end` is the whole word, `query` what's typed before the caret. */
export interface ActiveToken {
  sigil: Sigil;
  query: string;
  start: number;
  end: number;
}

/** What the server consumes as a token name (packages/routing explicit.ts): no spaces, no trailing dot. */
const TOKEN_NAME = /^[\w-]+(?:\.[\w-]+)*$/;
const PARTIAL_NAME = /^[\w.-]*$/;
const TOKEN = /(^|\s)([@#/])([\w-]+(?:\.[\w-]+)*)(?=\s|$|[,.;:!?)\]])/g;
const MAX_COMPLETIONS = 8;
/** Agents a one-pane prompt can start: structured ones (a shell is a terminal, not a prompt). */
export const ROUTABLE_AGENTS: readonly AgentKind[] = AGENT_KINDS.filter((a) => a !== 'shell');

const norm = (s: string): string => s.toLowerCase();

export function tokenAt(text: string, caret: number): ActiveToken | null {
  let start = caret;
  while (start > 0 && !/\s/.test(text[start - 1]!)) start--;
  let end = caret;
  while (end < text.length && !/\s/.test(text[end]!)) end++;
  const sigil = text[start];
  if (caret <= start || (sigil !== '@' && sigil !== '#' && sigil !== '/')) return null;
  if (!PARTIAL_NAME.test(text.slice(start + 1, end))) return null;
  return { sigil, query: text.slice(start + 1, caret), start, end };
}

/** How to write a machine as `@token`: its name if it's typeable, else its hostname; null when neither is. */
export function machineToken(m: Pick<MachineInfo, 'name' | 'hostname'>): string | null {
  if (TOKEN_NAME.test(m.name)) return m.name;
  if (TOKEN_NAME.test(m.hostname)) return m.hostname;
  return null;
}

export interface ParsedTokens {
  /** Machines named with `@` (name or hostname). */
  machines: MachineInfo[];
  /** Workspace names used with `#` that exist somewhere. */
  workspaces: string[];
  agent?: AgentKind;
  /** Whether any token names something real (it changes the target, so it ends a continuation). */
  any: boolean;
}

/**
 * The routing tokens in `text` that name real things, as the server reads them. `skip` leaves out the
 * token being typed (so `@mac` while typing doesn't count yet).
 */
export function parseTokens(text: string, machines: readonly MachineInfo[], workspaces: readonly WorkspaceInfo[], skip?: { start: number; end: number }): ParsedTokens {
  const out: ParsedTokens = { machines: [], workspaces: [], any: false };
  for (const m of text.matchAll(TOKEN)) {
    const [, lead = '', sigil, name = ''] = m;
    const start = (m.index ?? 0) + lead.length;
    if (skip && start === skip.start) continue;
    const n = norm(name);
    if (sigil === '/') {
      if ((AGENT_KINDS as readonly string[]).includes(n)) {
        out.agent = n as AgentKind;
        out.any = true;
      }
    } else if (sigil === '@') {
      const named = machines.filter((x) => norm(x.name) === n || norm(x.hostname) === n);
      for (const x of named) if (!out.machines.includes(x)) out.machines.push(x);
      if (named.length) out.any = true;
    } else if (workspaces.some((w) => norm(w.name) === n)) {
      if (!out.workspaces.includes(n)) out.workspaces.push(n);
      out.any = true;
    }
  }
  return out;
}

export interface Completion {
  key: string;
  label: string;
  detail?: string;
  /** Replaces the token being typed. */
  insert: string;
  disabled?: boolean;
  /** Why it's disabled ("offline", "not installed on mac-mini"). */
  reason?: string;
}

export interface CompletionInput {
  machines: readonly MachineInfo[];
  workspaces: readonly WorkspaceInfo[];
  /** Agents per machine id; a machine missing here hasn't been loaded (its agents count as unknown). */
  agents: Readonly<Record<string, readonly AgentListing[]>>;
  online: (machineId: string) => boolean;
}

/** 0: prefix · 1: prefix of a later word (`shop` in `acme-shop`) · 2: anywhere · -1: no match. */
function rank(name: string, q: string): number {
  if (!q) return 0;
  const n = norm(name);
  const query = norm(q);
  if (n.startsWith(query)) return 0;
  if (n.split(/[\s._-]+/).some((w) => w.startsWith(query))) return 1;
  return n.includes(query) ? 2 : -1;
}

function sorted<T>(items: { item: T; rank: number; online: boolean; name: string }[]): T[] {
  return items
    .filter((x) => x.rank >= 0)
    .sort((a, b) => a.rank - b.rank || (a.online === b.online ? a.name.localeCompare(b.name) : a.online ? -1 : 1))
    .slice(0, MAX_COMPLETIONS)
    .map((x) => x.item);
}

/** Suggestions for the token being typed, from the store's machines, workspaces and agents. */
export function completions(text: string, token: ActiveToken, input: CompletionInput): Completion[] {
  const parsed = parseTokens(text, input.machines, input.workspaces, token);
  const byId = new Map(input.machines.map((m) => [m.id, m]));

  if (token.sigil === '@') {
    return sorted(
      input.machines.map((m) => {
        const tok = machineToken(m);
        const online = input.online(m.id);
        const c: Completion = { key: m.id, label: m.name, insert: `@${tok ?? m.name}` };
        if (m.tags.length) c.detail = m.tags.join(' ');
        if (!online) Object.assign(c, { disabled: true, reason: 'offline' });
        else if (!tok) Object.assign(c, { disabled: true, reason: 'name has spaces: rename it to use @' });
        return { item: c, rank: Math.max(rank(m.name, token.query), tok && tok !== m.name ? rank(tok, token.query) : -1), online, name: m.name };
      }),
    );
  }

  if (token.sigil === '#') {
    const pool = input.workspaces.filter((w) => w.kind !== 'worktree' && TOKEN_NAME.test(w.name) && byId.has(w.machineId));
    const machinesByName = new Map<string, Set<string>>();
    for (const w of pool) machinesByName.set(norm(w.name), (machinesByName.get(norm(w.name)) ?? new Set()).add(w.machineId));
    const chosen = parsed.machines.length ? new Set(parsed.machines.map((m) => m.id)) : null;
    return sorted(
      pool
        .filter((w) => !chosen || chosen.has(w.machineId))
        .map((w) => {
          const m = byId.get(w.machineId)!;
          const online = input.online(m.id);
          const dup = (machinesByName.get(norm(w.name))?.size ?? 0) > 1;
          const mt = machineToken(m);
          // A name on several machines needs the machine too, unless the prompt already names one.
          const insert = dup && !chosen && mt ? `@${mt} #${w.name}` : `#${w.name}`;
          const c: Completion = { key: w.id, label: w.name, insert };
          if (dup) c.detail = m.name;
          if (!online) Object.assign(c, { disabled: true, reason: `${m.name} is offline` });
          return { item: c, rank: rank(w.name, token.query), online, name: `${w.name} ${m.name}` };
        }),
    );
  }

  // `/agent`: the agents installed on the target machine (named with `@`, or hosting the `#workspace`), else on any online machine.
  let targets = parsed.machines;
  if (!targets.length && parsed.workspaces.length) {
    const ids = new Set(input.workspaces.filter((w) => parsed.workspaces.includes(norm(w.name))).map((w) => w.machineId));
    targets = [...ids].map((id) => byId.get(id)).filter((m): m is MachineInfo => !!m);
  }
  const scope = targets.length ? targets : input.machines.filter((m) => input.online(m.id));
  return ROUTABLE_AGENTS.filter((a) => rank(a, token.query) >= 0)
    .sort((a, b) => rank(a, token.query) - rank(b, token.query))
    .map((a) => {
      const known = scope.filter((m) => input.agents[m.id] !== undefined);
      const has = known.filter((m) => input.agents[m.id]!.some((x) => x.agent === a && x.installed));
      const c: Completion = { key: a, label: a, insert: `/${a}` };
      // Unknown (not loaded yet) counts as possible: the server checks when the session starts.
      if (known.length === scope.length && has.length === 0 && scope.length > 0) {
        Object.assign(c, { disabled: true, reason: scope.length === 1 ? `not installed on ${scope[0]!.name}` : 'not installed on an online machine' });
      } else if (scope.length > 1 && has.length) c.detail = has.map((m) => m.name).join(', ');
      return c;
    })
    .slice(0, MAX_COMPLETIONS);
}

/** Put a completion in place of the token being typed, followed by one space; the caret goes after it. */
export function applyCompletion(text: string, token: ActiveToken, c: Pick<Completion, 'insert'>): { text: string; caret: number } {
  const before = text.slice(0, token.start);
  const after = text.slice(token.end);
  const next = `${before}${c.insert}${/^\s/.test(after) ? '' : ' '}${after}`;
  return { text: next, caret: before.length + c.insert.length + 1 };
}

// ---------------------------------------------------------------- routing decisions

export type RoutePlan =
  /** Confident and online: Enter sends here. */
  | { kind: 'send'; target: RouteCandidate }
  /** Not sure, or nothing decided: confirm or pick (`choices` may be empty: "other…" only). */
  | { kind: 'ask'; choices: RouteCandidate[]; note: string };

/** Send only when the server is confident and its top target is online; otherwise ask (spec §11.2 "Confirm, don't guess"). */
export function planRoute(s: RouteSuggestion, online: (machineId: string) => boolean): RoutePlan {
  const top = s.candidates[0];
  if (s.confident && top && online(top.machineId)) return { kind: 'send', target: top };
  const choices = s.candidates.filter((c) => online(c.machineId));
  return { kind: 'ask', choices, note: askNote(s, top !== undefined && !online(top.machineId)) };
}

function askNote(s: RouteSuggestion, topOffline: boolean): string {
  if (s.note) return s.note;
  if (topOffline) return `${s.candidates[0]!.label.split(' · ')[0]} is offline`;
  if (s.source === 'classifier') {
    const [a, b] = s.candidates;
    return b ? `not sure: ${pct(a!.probability)} ${a!.label}, ${pct(b.probability)} ${b.label}` : `not sure (confidence ${pct(s.confidence)})`;
  }
  return 'pick where this should run';
}

const pct = (p: number): string => `${Math.round(p * 100)}%`;

/** Why the target was chosen, for the target line: "@mac-mini", "rule: prod → prod-access", "qwen 94%". */
export function routeReason(s: RouteSuggestion): string {
  switch (s.source) {
    case 'explicit':
      return 'as named';
    case 'single':
      return 'the only workspace online';
    case 'rule':
      return s.rule ? `rule: ${s.rule.label}` : 'rule';
    case 'classifier': {
      const p = s.candidates[0]?.probability ?? 0;
      return `${s.classifier?.model ?? 'classifier'} ${pct(p)}${s.rule ? ` · rule: ${s.rule.label}` : ''}`;
    }
    case 'none':
      return s.note ?? 'not decided';
  }
}

/** Every workspace on an online machine (worktrees left out), for "other…". */
export function otherTargets(machines: readonly MachineInfo[], workspaces: readonly WorkspaceInfo[], online: (machineId: string) => boolean): RouteCandidate[] {
  const byId = new Map(machines.map((m) => [m.id, m]));
  return workspaces
    .filter((w) => w.kind !== 'worktree' && byId.has(w.machineId) && online(w.machineId))
    .map((w) => ({ machineId: w.machineId, workspaceId: w.id, label: `${byId.get(w.machineId)!.name} · ${w.name}`, probability: 0 }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * The agent for a routed prompt: `/agent` (or a rule's agent) if it's installed there; else the agent of
 * the workspace's most recent session (its de facto default); else a logged-in structured agent; else
 * the first installed one.
 */
export function chooseAgent(o: {
  explicit?: AgentKind | undefined;
  agents: readonly AgentListing[] | undefined;
  sessions: readonly SessionInfo[];
  workspaceId: string;
  machineName: string;
}): { agent: AgentKind } | { error: string } {
  if (o.agents === undefined) {
    if (o.explicit) return { agent: o.explicit };
    return { error: `can't tell which agents ${o.machineName} has yet` };
  }
  const installed = o.agents.filter((a) => a.installed && a.agent !== 'shell' && (a.capabilities?.modes.includes('structured') ?? true));
  if (o.explicit) return installed.some((a) => a.agent === o.explicit) ? { agent: o.explicit } : { error: `${o.explicit} isn't installed on ${o.machineName}` };
  const last = o.sessions
    .filter((s) => s.workspaceId === o.workspaceId && !s.spawnedBy && s.mode === 'structured' && installed.some((a) => a.agent === s.agent))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
  if (last) return { agent: last.agent };
  const pick = installed.find((a) => a.auth === 'ok') ?? installed[0];
  return pick ? { agent: pick.agent } : { error: `no agent is installed on ${o.machineName}` };
}

/**
 * Step 2: a follow-up goes to the open session while it's live, unless the prompt changes the target
 * with a token. "Live" = not ended or failed, structured, and its machine online.
 */
export function continues(session: SessionInfo | undefined, tokens: ParsedTokens, online: boolean): boolean {
  if (!session || !online || session.mode !== 'structured') return false;
  if (session.status === 'ended' || session.status === 'failed') return false;
  return !tokens.any;
}

/** What `route.record` gets: the prompt, what was offered, where it went, and whether that overrode the top pick. */
export function decisionFor(
  text: string,
  s: RouteSuggestion,
  chosen: RouteCandidate,
  agent: AgentKind | undefined,
  sessionId?: string,
): RouteDecisionInput {
  const top = s.candidates[0];
  const via: RouteDecisionInput['via'] = top?.workspaceId === chosen.workspaceId ? 'suggested' : s.candidates.some((c) => c.workspaceId === chosen.workspaceId) ? 'picked' : 'other';
  const d: RouteDecisionInput = {
    text,
    source: s.source,
    candidates: s.candidates,
    confidence: s.confidence,
    chosen: { machineId: chosen.machineId, workspaceId: chosen.workspaceId, label: chosen.label, ...(agent ? { agent } : {}) },
    via,
    overridden: top !== undefined && via !== 'suggested',
  };
  if (s.classifier) d.classifier = { model: s.classifier.model, ...(s.classifier.via ? { via: s.classifier.via } : {}) };
  if (s.rule) d.rule = s.rule;
  if (sessionId) d.sessionId = sessionId;
  return d;
}

/** A session title from the prompt: its first line, at most 60 characters. */
export function titleFor(text: string): string {
  const line = text.trim().split('\n')[0]!.replace(/\s+/g, ' ');
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

/** Comma-separated words of a rule form → its `match` list. */
export function parseRuleWords(s: string): string[] {
  return [...new Set(s.split(',').map((w) => w.replace(/\s+/g, ' ').trim().toLowerCase()).filter(Boolean))];
}
