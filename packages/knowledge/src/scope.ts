import { BizziError } from '@bizzi/protocol';
import type { KnowledgeContext, KnowledgeItem, KnowledgeScope, ScopeLevel } from './types.ts';
import { SCOPE_LEVELS } from './types.ts';

const ID_FIELD: Readonly<Record<ScopeLevel, keyof KnowledgeScope | null>> = {
  global: null,
  tag: 'tag',
  machine: 'machineId',
  project: 'projectId',
  workspace: 'workspaceId',
  session: 'sessionId',
  team: 'teamId',
};

export function isScopeLevel(v: unknown): v is ScopeLevel {
  return typeof v === 'string' && (SCOPE_LEVELS as readonly string[]).includes(v);
}

/** Keep only the id that matters for the level; throw `bad_request` if it is missing. */
export function normalizeScope(scope: KnowledgeScope): KnowledgeScope {
  if (!isScopeLevel(scope.level)) throw new BizziError('bad_request', `unknown scope level: ${String(scope.level)}`);
  const field = ID_FIELD[scope.level];
  if (field === null) return { level: scope.level };
  const id = scope[field];
  if (typeof id !== 'string' || id === '') {
    throw new BizziError('bad_request', `scope '${scope.level}' requires ${field}`);
  }
  return { level: scope.level, [field]: id };
}

/** Build the concrete scope for `level` from a session context. */
export function scopeForLevel(level: ScopeLevel, ctx: Partial<KnowledgeContext> & { teamId?: string }): KnowledgeScope {
  const field = ID_FIELD[level];
  if (field === null) return { level };
  const id = (ctx as Record<string, unknown>)[field];
  if (typeof id !== 'string' || id === '') {
    throw new BizziError('bad_request', `cannot use scope '${level}': this session has no ${field}`);
  }
  return { level, [field]: id };
}

/** Can this context write/see at `level`? */
export function contextHasLevel(level: ScopeLevel, ctx: Partial<KnowledgeContext>): boolean {
  if (level === 'team' || level === 'tag') return false;
  const field = ID_FIELD[level];
  if (field === null) return true;
  const id = (ctx as Record<string, unknown>)[field];
  return typeof id === 'string' && id !== '';
}

export function scopeMatches(scope: KnowledgeScope, ctx: KnowledgeContext): boolean {
  switch (scope.level) {
    case 'global':
      return true;
    case 'tag':
      return scope.tag !== undefined && (ctx.machineTags ?? []).includes(scope.tag);
    case 'machine':
      return scope.machineId === ctx.machineId;
    case 'project':
      return ctx.projectId !== undefined && scope.projectId === ctx.projectId;
    case 'workspace':
      return ctx.workspaceId !== undefined && scope.workspaceId === ctx.workspaceId;
    case 'session':
      return ctx.sessionId !== undefined && scope.sessionId === ctx.sessionId;
    case 'team':
      return false; // reserved
  }
}

/** Resolution rule (§2.2): active, scope matches the context, and appliesTo includes the agent. */
export function isVisible(item: KnowledgeItem, ctx: KnowledgeContext): boolean {
  if (item.status !== 'active') return false;
  if (item.appliesTo && item.appliesTo.length > 0 && !item.appliesTo.includes(ctx.agent)) return false;
  return scopeMatches(item.scope, ctx);
}

export function scopeEquals(a: KnowledgeScope, b: KnowledgeScope): boolean {
  const na = normalizeScope(a);
  const nb = normalizeScope(b);
  const field = ID_FIELD[na.level];
  return na.level === nb.level && (field === null || na[field] === nb[field]);
}

export function scopeLabel(scope: KnowledgeScope): string {
  return scope.level === 'tag' && scope.tag ? `tag ${scope.tag}` : scope.level;
}
