// Review inbox (§3.2): suggested items and "live + notice" items, batched one card per session.
// Accept (optionally re-scoped) / reject; for notice items, reject means undo.

import { BizziError } from '@bizzi/protocol';
import type { AgentKind } from '@bizzi/protocol';
import { applyActivation } from './pipeline.ts';
import { isScopeLevel, normalizeScope, scopeForLevel } from './scope.ts';
import type { KnowledgeStore } from './store.ts';
import type { KnowledgeItem, KnowledgeScope, ScopeLevel } from './types.ts';
import { FORGET_TAG } from './types.ts';

export interface InboxGroup {
  /** Session that produced the items; null for items without one (harvest, UI). */
  sessionId: string | null;
  agent?: AgentKind;
  /** Waiting for a decision. */
  suggested: KnowledgeItem[];
  /** Already live (or already forgotten) with an undo. */
  notices: KnowledgeItem[];
  counts: { memories: number; rules: number; forgets: number };
  /** Newest change in the group (ISO). Groups are sorted newest first. */
  latestAt: string;
}

export interface InboxFilter {
  projectId?: string;
  sessionId?: string;
}

export function isForgetRequest(item: KnowledgeItem): boolean {
  return item.tags.includes(FORGET_TAG);
}

export function listInbox(store: KnowledgeStore, filter: InboxFilter = {}): InboxGroup[] {
  const pending = store.list({ status: 'suggested' });
  const notices = store.list({ noticePending: true });
  const groups = new Map<string, InboxGroup>();
  const keep = (i: KnowledgeItem) =>
    (filter.sessionId === undefined || i.source.sessionId === filter.sessionId) &&
    (filter.projectId === undefined || i.scope.projectId === filter.projectId || i.source.projectId === filter.projectId);
  const groupFor = (i: KnowledgeItem): InboxGroup => {
    const key = i.source.sessionId ?? '';
    let g = groups.get(key);
    if (!g) {
      g = {
        sessionId: i.source.sessionId ?? null,
        ...(i.source.agent !== undefined ? { agent: i.source.agent } : {}),
        suggested: [],
        notices: [],
        counts: { memories: 0, rules: 0, forgets: 0 },
        latestAt: i.updatedAt,
      };
      groups.set(key, g);
    }
    if (i.updatedAt > g.latestAt) g.latestAt = i.updatedAt;
    if (isForgetRequest(i)) g.counts.forgets++;
    else if (i.type === 'rule') g.counts.rules++;
    else g.counts.memories++;
    return g;
  };
  for (const i of pending) if (keep(i)) groupFor(i).suggested.push(i);
  for (const i of notices) if (keep(i)) groupFor(i).notices.push(i);
  return [...groups.values()].sort((a, b) => (a.latestAt < b.latestAt ? 1 : a.latestAt > b.latestAt ? -1 : 0));
}

function rescope(item: KnowledgeItem, scope: ScopeLevel | KnowledgeScope): KnowledgeScope {
  if (typeof scope !== 'string') return normalizeScope(scope);
  if (!isScopeLevel(scope)) throw new BizziError('bad_request', `unknown scope level: ${scope}`);
  const ids = {
    machineId: item.scope.machineId ?? item.source.machineId,
    ...(item.scope.projectId ?? item.source.projectId ? { projectId: item.scope.projectId ?? item.source.projectId } : {}),
    ...(item.scope.workspaceId ?? item.source.workspaceId ? { workspaceId: item.scope.workspaceId ?? item.source.workspaceId } : {}),
    ...(item.scope.sessionId ?? item.source.sessionId ? { sessionId: item.scope.sessionId ?? item.source.sessionId } : {}),
    ...(item.scope.teamId ? { teamId: item.scope.teamId } : {}),
  };
  return scopeForLevel(scope, ids);
}

export interface AcceptOptions {
  /** Edit the scope while accepting: a level (ids taken from the item's origin) or a full scope. */
  scope?: ScopeLevel | KnowledgeScope;
}

/** Accept a suggestion (it goes live) or acknowledge a notice. */
export function acceptItem(store: KnowledgeStore, id: string, opts: AcceptOptions = {}): KnowledgeItem {
  return store.transaction(() => {
    const item = store.require(id);
    const scope = opts.scope !== undefined ? rescope(item, opts.scope) : undefined;
    if (item.status === 'suggested') {
      const live = store.patch(id, { status: 'active', noticePending: false, ...(scope ? { scope } : {}) });
      applyActivation(store, live);
      return store.require(id);
    }
    if (item.noticePending) return store.patch(id, { noticePending: false, ...(scope ? { scope } : {}) });
    throw new BizziError('conflict', `knowledge item ${id} is not in the inbox (status ${item.status})`);
  });
}

/** Reject a suggestion, or undo a "live + notice" change. */
export function rejectItem(store: KnowledgeStore, id: string): KnowledgeItem {
  return store.transaction(() => {
    const item = store.require(id);
    if (item.status === 'suggested') return store.patch(id, { status: 'deleted', noticePending: false });
    if (item.noticePending && item.status === 'active') {
      // Undo: retire it and bring back what it replaced.
      for (const prev of item.supersedes ?? []) {
        const p = store.get(prev);
        if (p && p.status === 'superseded') store.setStatus(prev, 'active');
      }
      return store.patch(id, { status: 'deleted', noticePending: false });
    }
    if (item.noticePending && item.status === 'deleted') {
      // Undo a forget.
      return store.patch(id, { status: 'active', noticePending: false });
    }
    throw new BizziError('conflict', `knowledge item ${id} is not in the inbox (status ${item.status})`);
  });
}

export function acceptItems(store: KnowledgeStore, ids: string[], opts: AcceptOptions = {}): KnowledgeItem[] {
  return store.transaction(() => ids.map((id) => acceptItem(store, id, opts)));
}

export function rejectItems(store: KnowledgeStore, ids: string[]): KnowledgeItem[] {
  return store.transaction(() => ids.map((id) => rejectItem(store, id)));
}
