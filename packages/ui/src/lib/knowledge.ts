// Pure helpers for the knowledge screens (docs/knowledge.md): scope labels, retargeting, filters.
import { AGENT_KINDS } from '@bizzi/protocol';
import type {
  AgentKind,
  KnowledgeInboxCard,
  KnowledgeItemInfo,
  KnowledgePreset,
  KnowledgeScope,
  KnowledgeScopeLevel,
  MachineInfo,
  SessionInfo,
  WorkspaceInfo,
} from '@bizzi/protocol';

/** Scope levels a person picks from (session is ephemeral, team is later). */
export const SCOPE_LEVELS: readonly KnowledgeScopeLevel[] = ['global', 'tag', 'machine', 'project', 'workspace'];

/** Scope levels agents can write at: tag rules are yours only (knowledge.md §9.5). */
export const AGENT_SCOPE_LEVELS: readonly KnowledgeScopeLevel[] = ['global', 'machine', 'project', 'workspace'];

/** Agents knowledge can be limited to (plain shells don't read knowledge). */
export const KNOWLEDGE_AGENTS: readonly AgentKind[] = AGENT_KINDS.filter((a) => a !== 'shell');

export const MEMORY_KINDS: readonly string[] = ['fact', 'preference', 'decision', 'gotcha', 'procedure', 'reference', 'todo'];

export const SCOPE_HELP: Record<KnowledgeScopeLevel, string> = {
  global: 'You, everywhere, on every machine',
  tag: 'Every machine with this tag, every project',
  machine: 'One machine, every project on it',
  project: 'One project, on every machine and workspace',
  workspace: 'Only this directory on this machine',
  session: 'This session only',
  team: 'Shared with your team',
};

export const PRESETS: readonly { value: KnowledgePreset; label: string; description: string }[] = [
  { value: 'trusting', label: 'Trusting', description: 'Everything agents write goes live immediately; prune later.' },
  { value: 'balanced', label: 'Balanced', description: 'Narrow scopes go live, global and unprompted rules wait in the inbox.' },
  { value: 'strict', label: 'Strict', description: 'Only what you write goes live; every agent write is a suggestion.' },
];

/** What the scope labels and retargeting need from the store. */
export interface ScopeContext {
  machines: Readonly<Record<string, MachineInfo>>;
  workspaces: Readonly<Record<string, WorkspaceInfo>> | null;
  sessions: Readonly<Record<string, SessionInfo>>;
}

/** Display name of a project id: the workspaces linked to it, else the id without its prefix. */
export function projectName(projectId: string, ctx: ScopeContext): string {
  const names = [...new Set(Object.values(ctx.workspaces ?? {}).filter((w) => w.projectId === projectId).map((w) => w.name))];
  if (names.length) return names.join(', ');
  return projectId.replace(/^p_/, '');
}

/** "global", "machine · server-a", "workspace · acme-shop", "project · acme". */
export function scopeLabel(scope: KnowledgeScope, ctx: ScopeContext): string {
  switch (scope.level) {
    case 'tag':
      return scope.tag ? `tag · ${scope.tag}` : 'tag';
    case 'machine': {
      const id = scope.machineId;
      return id ? `machine · ${ctx.machines[id]?.name ?? id}` : 'machine';
    }
    case 'workspace': {
      const id = scope.workspaceId;
      return id ? `workspace · ${ctx.workspaces?.[id]?.name ?? id}` : 'workspace';
    }
    case 'project':
      return scope.projectId ? `project · ${projectName(scope.projectId, ctx)}` : 'project';
    case 'session': {
      const id = scope.sessionId;
      return id ? `session · ${ctx.sessions[id]?.title ?? id}` : 'session';
    }
    default:
      return scope.level;
  }
}

export function sameScope(a: KnowledgeScope | undefined, b: KnowledgeScope | undefined): boolean {
  if (!a || !b) return a === b;
  return a.level === b.level && a.tag === b.tag && a.machineId === b.machineId && a.projectId === b.projectId && a.workspaceId === b.workspaceId && a.sessionId === b.sessionId;
}

/** Stable key for grouping by scope (`knowledge.accept` takes one scope per call). */
export function scopeKey(scope: KnowledgeScope | undefined): string {
  if (!scope) return '';
  return [scope.level, scope.tag ?? '', scope.machineId ?? '', scope.projectId ?? '', scope.workspaceId ?? '', scope.sessionId ?? ''].join('|');
}

/**
 * The item moved to another scope level, filling ids from what it is attached to: its own scope, then
 * its source session → workspace → project / machine. Null when the needed id cannot be found.
 */
export function retargetScope(item: Pick<KnowledgeItemInfo, 'scope' | 'source'>, level: KnowledgeScopeLevel, ctx: ScopeContext): KnowledgeScope | null {
  if (item.scope.level === level) return item.scope;
  const sessionId = item.scope.sessionId ?? item.source.sessionId;
  const session = sessionId ? ctx.sessions[sessionId] : undefined;
  const workspaceId = item.scope.workspaceId ?? session?.workspaceId;
  const workspace = workspaceId ? ctx.workspaces?.[workspaceId] : undefined;
  switch (level) {
    case 'global':
      return { level: 'global' };
    case 'tag': {
      // The first tag of the machine it came from; null when that machine has none.
      const machineId = item.scope.machineId ?? workspace?.machineId ?? session?.machineId ?? item.source.machineId;
      const tag = machineId ? ctx.machines[machineId]?.tags[0] : undefined;
      return tag ? { level: 'tag', tag } : null;
    }
    case 'machine': {
      const machineId = item.scope.machineId ?? workspace?.machineId ?? session?.machineId ?? item.source.machineId;
      return machineId ? { level: 'machine', machineId } : null;
    }
    case 'workspace':
      return workspaceId ? { level: 'workspace', workspaceId } : null;
    case 'project': {
      const projectId = item.scope.projectId ?? workspace?.projectId;
      return projectId ? { level: 'project', projectId } : null;
    }
    case 'session':
      return sessionId ? { level: 'session', sessionId } : null;
    case 'team':
      return { level: 'team' };
  }
}

/** Whether an item applies to an agent (no `appliesTo` = every agent). */
export function matchesAgent(item: Pick<KnowledgeItemInfo, 'appliesTo'>, agent: AgentKind | 'all'): boolean {
  if (agent === 'all') return true;
  return !item.appliesTo?.length || item.appliesTo.includes(agent);
}

export function filterByAgent<T extends Pick<KnowledgeItemInfo, 'appliesTo'>>(items: readonly T[], agent: AgentKind | 'all'): T[] {
  return agent === 'all' ? [...items] : items.filter((i) => matchesAgent(i, agent));
}

/** "2 suggested memories, 1 rule" (the first count carries "suggested"). */
export function cardSummary(card: Pick<KnowledgeInboxCard, 'items'>): string {
  const rules = card.items.filter((i) => i.type === 'rule').length;
  const memories = card.items.length - rules;
  const parts: [number, string][] = [];
  if (memories) parts.push([memories, memories === 1 ? 'memory' : 'memories']);
  if (rules) parts.push([rules, rules === 1 ? 'rule' : 'rules']);
  if (!parts.length) return 'No suggestions';
  return parts.map(([n, word], i) => `${n} ${i === 0 ? 'suggested ' : ''}${word}`).join(', ');
}

/** A change that is already live (or already forgotten) and can still be undone, with where it came from. */
export interface KnowledgeNotice {
  item: KnowledgeItemInfo;
  sessionId?: string;
  agent?: AgentKind;
}

/**
 * The inbox holds two different things: suggestions waiting for a decision, and changes agents
 * already made (because you asked or your policy allows it) that you can dismiss or undo.
 */
export function splitInbox(cards: readonly KnowledgeInboxCard[]): { suggestions: KnowledgeInboxCard[]; notices: KnowledgeNotice[] } {
  const suggestions: KnowledgeInboxCard[] = [];
  const notices: KnowledgeNotice[] = [];
  for (const c of cards) {
    const pending = c.items.filter((i) => i.status === 'suggested');
    if (pending.length > 0) suggestions.push({ ...c, items: pending });
    for (const item of c.items) {
      if (item.status === 'suggested') continue;
      notices.push({ item, ...(c.sessionId !== undefined ? { sessionId: c.sessionId } : {}), ...(c.agent !== undefined ? { agent: c.agent } : {}) });
    }
  }
  notices.sort((a, b) => (a.item.updatedAt < b.item.updatedAt ? 1 : a.item.updatedAt > b.item.updatedAt ? -1 : 0));
  return { suggestions, notices };
}

/** What a live change did: added a new item, replaced an older version, or forgot one. */
export function noticeAction(item: KnowledgeItemInfo): 'added' | 'updated' | 'forgot' {
  if (item.status === 'deleted') return 'forgot';
  return item.supersedes && item.supersedes.length > 0 ? 'updated' : 'added';
}

/** "a, b ,, c" → ["a", "b", "c"] (deduplicated, trimmed). */
export function parseTags(text: string): string[] {
  return [...new Set(text.split(/[,\n]/).map((t) => t.trim().replace(/^#/, '')).filter(Boolean))];
}

export interface ProjectOption {
  projectId: string;
  label: string;
}

/** Every tag set on any known machine, plus extra ones (e.g. the item being edited), sorted. */
export function knownTags(ctx: Pick<ScopeContext, 'machines'>, extra: readonly (string | undefined)[] = []): string[] {
  const tags = new Set<string>();
  for (const m of Object.values(ctx.machines)) for (const t of m.tags) tags.add(t);
  for (const e of extra) if (e) tags.add(e);
  return [...tags].sort();
}

/** Projects known from workspace links, plus any extra ids (e.g. the item being edited). */
export function projectOptions(ctx: ScopeContext, extra: readonly (string | undefined)[] = []): ProjectOption[] {
  const ids = new Set<string>();
  for (const w of Object.values(ctx.workspaces ?? {})) if (w.projectId) ids.add(w.projectId);
  for (const e of extra) if (e) ids.add(e);
  return [...ids].map((projectId) => ({ projectId, label: projectName(projectId, ctx) })).sort((a, b) => a.label.localeCompare(b.label));
}

/** Whether a scope names the id its level needs. */
export function scopeComplete(scope: KnowledgeScope): boolean {
  switch (scope.level) {
    case 'tag':
      return !!scope.tag;
    case 'machine':
      return !!scope.machineId;
    case 'project':
      return !!scope.projectId;
    case 'workspace':
      return !!scope.workspaceId;
    case 'session':
      return !!scope.sessionId;
    default:
      return true;
  }
}

/** Split accept decisions into one call per target scope (undefined = keep each item's own scope). */
export function groupByScope(entries: readonly { id: string; scope?: KnowledgeScope | undefined }[]): { scope?: KnowledgeScope; ids: string[] }[] {
  const groups = new Map<string, { scope?: KnowledgeScope; ids: string[] }>();
  for (const e of entries) {
    const key = scopeKey(e.scope);
    let g = groups.get(key);
    if (!g) {
      g = e.scope ? { scope: e.scope, ids: [] } : { ids: [] };
      groups.set(key, g);
    }
    g.ids.push(e.id);
  }
  return [...groups.values()];
}

// ---- Add to AGENTS.md (knowledge.md §8)

/** Tag the node puts on items written into an AGENTS.md; they aren't offered again. */
export const PROMOTED_TAG = 'promoted';

/** Whether an item's scope reaches sessions in `workspace` (the node checks this again). */
export function reachesWorkspace(item: Pick<KnowledgeItemInfo, 'scope'>, workspace: WorkspaceInfo, machine?: Pick<MachineInfo, 'tags'>): boolean {
  const s = item.scope;
  switch (s.level) {
    case 'global':
      return true;
    case 'tag':
      return !!s.tag && (machine?.tags ?? []).includes(s.tag);
    case 'machine':
      return s.machineId === workspace.machineId;
    case 'project':
      return !!workspace.projectId && s.projectId === workspace.projectId;
    case 'workspace':
      return s.workspaceId === workspace.id;
    default:
      return false;
  }
}

/** Memories "Add to AGENTS.md…" offers for a workspace: active, reaching it, not promoted yet; most specific scope first. */
export function promotionCandidates(items: readonly KnowledgeItemInfo[], workspace: WorkspaceInfo, machine?: Pick<MachineInfo, 'tags'>): KnowledgeItemInfo[] {
  const rank: Partial<Record<KnowledgeScopeLevel, number>> = { workspace: 0, project: 1, machine: 2, tag: 3, global: 4 };
  return items
    .filter((i) => i.type === 'memory' && i.status === 'active' && !i.tags.includes(PROMOTED_TAG) && reachesWorkspace(i, workspace, machine))
    .sort((a, b) => (rank[a.scope.level] ?? 9) - (rank[b.scope.level] ?? 9) || a.title.localeCompare(b.title));
}
