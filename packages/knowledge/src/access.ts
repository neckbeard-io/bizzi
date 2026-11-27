// What one agent session may read and change (knowledge.md §5): the browse side of the
// bizzi-memory MCP server. Reads never reach outside the scopes the session can see; a session
// may also see the suggestions it (or its agent) proposed, and change only its own.

import { BizziError } from '@bizzi/protocol';
import type { PolicyDecision } from './policy.ts';
import { decide, loadSettings, policySourceOf } from './policy.ts';
import { updateKnowledge } from './pipeline.ts';
import type { WriteOrigin, WriteResult } from './pipeline.ts';
import { contextHasLevel, isOwnSuggestion, isVisible, scopeEquals, scopeForLevel, scopeMatches } from './scope.ts';
import type { KnowledgeStore } from './store.ts';
import type { KnowledgeContext, KnowledgeItem, KnowledgeStatus, KnowledgeType, MemoryKind, ScopeLevel, SessionScopeLevel } from './types.ts';
import { SCOPE_SPECIFICITY } from './types.ts';

function appliesToAgent(item: KnowledgeItem, ctx: KnowledgeContext): boolean {
  return !item.appliesTo || item.appliesTo.length === 0 || item.appliesTo.includes(ctx.agent);
}

/**
 * Suggestions a session can see: its own, and those its agent kind proposed from other sessions,
 * in scopes this session can see. Other agents' suggestions stay between them and the user.
 */
export function canSeeSuggestion(item: KnowledgeItem, ctx: KnowledgeContext): boolean {
  if (item.status !== 'suggested' || !scopeMatches(item.scope, ctx)) return false;
  if (isOwnSuggestion(item, ctx.sessionId)) return true;
  return item.source.agent === ctx.agent && appliesToAgent(item, ctx);
}

/**
 * Can this session read the item by id? Live items it sees, suggestions per `canSeeSuggestion`, and
 * earlier versions (superseded, forgotten) in scopes it sees, so it can follow an item's history.
 */
export function canRead(item: KnowledgeItem, ctx: KnowledgeContext): boolean {
  switch (item.status) {
    case 'active':
      return isVisible(item, ctx);
    case 'suggested':
      return canSeeSuggestion(item, ctx);
    case 'superseded':
    case 'deleted':
      return scopeMatches(item.scope, ctx) && (appliesToAgent(item, ctx) || item.source.sessionId === ctx.sessionId);
  }
}

/** The item if this session may read it; `not_found` otherwise (never says what is out of reach). */
export function readable(store: KnowledgeStore, id: string, ctx: KnowledgeContext): KnowledgeItem {
  const item = store.get(id);
  if (!item || !canRead(item, ctx)) throw new BizziError('not_found', `knowledge item not found or not visible here: ${id}`);
  return item;
}

export { isOwnSuggestion };

// ---- listing ------------------------------------------------------------------------------------

export type ListStatus = 'active' | 'suggested' | 'all';

export interface SessionListFilter {
  type?: KnowledgeType;
  /** Scope level the items are stored at. */
  scope?: Exclude<ScopeLevel, 'team'>;
  kind?: MemoryKind;
  /** Items carrying every one of these tags. */
  tags?: string[];
  /** Default 'all': live items plus the suggestions this session can see. */
  status?: ListStatus;
  /** Only suggestions written by this session. */
  mine?: boolean;
  offset?: number;
  /** Default 20. */
  limit?: number;
}

export interface SessionListPage {
  items: KnowledgeItem[];
  total: number;
  offset: number;
  /** Offset of the next page; absent on the last page. */
  nextOffset?: number;
}

/** Rules and memories this session can see, newest change first, filtered and paged. */
export function listForSession(store: KnowledgeStore, ctx: KnowledgeContext, filter: SessionListFilter = {}): SessionListPage {
  const status = filter.status ?? 'all';
  const type: KnowledgeType | undefined = filter.kind ? 'memory' : filter.type;
  if (filter.kind && filter.type === 'rule') return { items: [], total: 0, offset: filter.offset ?? 0 };
  let items: KnowledgeItem[] = [];
  if (status !== 'suggested' && !filter.mine) items.push(...store.visible(ctx, type));
  if (status !== 'active') {
    const pending = store.list({ status: 'suggested', ...(type ? { type } : {}) });
    items.push(...pending.filter((i) => (filter.mine ? isOwnSuggestion(i, ctx.sessionId) && scopeMatches(i.scope, ctx) : canSeeSuggestion(i, ctx))));
  }
  const tags = filter.tags ?? [];
  items = items.filter(
    (i) =>
      (!filter.scope || i.scope.level === filter.scope) &&
      (!filter.kind || i.kind === filter.kind) &&
      tags.every((t) => i.tags.includes(t)),
  );
  items.sort((a, b) => (a.hlc < b.hlc ? 1 : a.hlc > b.hlc ? -1 : 0));
  const offset = Math.max(0, filter.offset ?? 0);
  const limit = Math.max(1, filter.limit ?? 20);
  const page = items.slice(offset, offset + limit);
  const next = offset + page.length;
  return { items: page, total: items.length, offset, ...(next < items.length ? { nextOffset: next } : {}) };
}

// ---- history ------------------------------------------------------------------------------------

export interface HistoryEntry {
  id: string;
  status: KnowledgeStatus;
  title: string;
  scope: KnowledgeItem['scope'];
  updatedAt: string;
  /** `earlier`: a version this one replaced; `later`: a version that replaced this one. */
  relation: 'earlier' | 'later';
  /** A pending or applied request to forget, rather than an edit. */
  forgetRequest?: boolean;
}

export interface ItemWithHistory {
  item: KnowledgeItem;
  /** Earlier versions, newest first, then later versions, oldest first. Only versions this session can read. */
  history: HistoryEntry[];
  /** Linked versions this session can't read (other scopes, other agents' suggestions). */
  hiddenVersions: number;
}

const MAX_HISTORY = 50;

/** One item by id with its version chain (the `supersedes` links both ways). */
export function getWithHistory(store: KnowledgeStore, id: string, ctx: KnowledgeContext, isForget: (i: KnowledgeItem) => boolean): ItemWithHistory {
  const item = readable(store, id, ctx);
  const history: HistoryEntry[] = [];
  let hidden = 0;
  const seen = new Set<string>([item.id]);
  const entry = (i: KnowledgeItem, relation: HistoryEntry['relation']): HistoryEntry => ({
    id: i.id,
    status: i.status,
    title: i.title,
    scope: i.scope,
    updatedAt: i.updatedAt,
    relation,
    ...(isForget(i) ? { forgetRequest: true } : {}),
  });
  const walk = (start: string[], relation: HistoryEntry['relation'], next: (i: KnowledgeItem) => string[]) => {
    const queue = [...start];
    while (queue.length > 0 && history.length < MAX_HISTORY) {
      const vid = queue.shift()!;
      if (seen.has(vid)) continue;
      seen.add(vid);
      const v = store.get(vid);
      if (!v) continue;
      if (!canRead(v, ctx)) {
        hidden++;
        continue;
      }
      history.push(entry(v, relation));
      queue.push(...next(v));
    }
  };
  walk(item.supersedes ?? [], 'earlier', (v) => v.supersedes ?? []);
  walk(
    store.supersededBy(item.id).map((v) => v.id),
    'later',
    (v) => (isForget(v) ? [] : store.supersededBy(v.id).map((n) => n.id)),
  );
  return { item, history, hiddenVersions: hidden };
}

// ---- moving to a wider scope ----------------------------------------------------------------------

export interface ScopeMovePlan {
  item: KnowledgeItem;
  from: KnowledgeItem['scope'];
  to: KnowledgeItem['scope'];
  /** What the user's policy does with the move: live, live with an inbox notice, or a suggestion. */
  decision: PolicyDecision;
  /** An identical item already exists (live or pending) at the target scope. */
  duplicateOf?: KnowledgeItem;
}

/**
 * Plan moving an item this session sees to a wider scope (e.g. workspace → project). Read-only.
 * Throws `bad_request` when the target isn't wider or isn't available to the session.
 */
export function planScopeMove(
  store: KnowledgeStore,
  id: string,
  level: SessionScopeLevel,
  ctx: KnowledgeContext,
  origin: WriteOrigin,
): ScopeMovePlan {
  const item = readable(store, id, ctx);
  if (item.status !== 'active' && !isOwnSuggestion(item, ctx.sessionId)) {
    throw new BizziError('conflict', `knowledge item ${id} is ${item.status}; only live items and your own suggestions can move`);
  }
  if (!contextHasLevel(level, ctx)) throw new BizziError('bad_request', `scope '${level}' is not available in this session`);
  if (SCOPE_SPECIFICITY[level] >= SCOPE_SPECIFICITY[item.scope.level]) {
    throw new BizziError('bad_request', `'${level}' is not wider than '${item.scope.level}'; use knowledge_update to narrow an item`);
  }
  const to = scopeForLevel(level, ctx);
  const duplicateOf = store
    .findByContentHash(item.contentHash, ['active', 'suggested'])
    .find((i) => i.id !== item.id && i.type === item.type && scopeEquals(i.scope, to) && canRead(i, ctx));
  const projectId = to.projectId ?? origin.projectId;
  const { decision } = decide(loadSettings(store), {
    source: policySourceOf(item.type, origin),
    scope: level,
    ...(projectId !== undefined ? { projectId } : {}),
  });
  return { item, from: item.scope, to, decision, ...(duplicateOf ? { duplicateOf } : {}) };
}

/**
 * Move an item to a wider scope through the write pipeline: a new version at the target scope that
 * supersedes the old one once live. When the policy wants review it waits in the inbox and the old
 * item stays live. An identical item already at the target is reported, not duplicated.
 */
export function moveToScope(
  store: KnowledgeStore,
  id: string,
  level: SessionScopeLevel,
  ctx: KnowledgeContext,
  origin: WriteOrigin,
): { plan: ScopeMovePlan; result?: WriteResult } {
  const plan = planScopeMove(store, id, level, ctx, origin);
  if (plan.duplicateOf) return { plan };
  const result = updateKnowledge(store, id, { scope: plan.to }, origin, { context: ctx });
  return { plan, result };
}
