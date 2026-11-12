// Read side (§2.2): what a session of agent A in workspace W on machine M in project P sees.
// Rules are ordered general → specific (more specific overrides); memories are ranked and capped.

import { compareHlc } from './hlc.ts';
import type { KnowledgeStore } from './store.ts';
import type { KnowledgeContext, KnowledgeItem, SessionScopeLevel } from './types.ts';
import { SCOPE_SPECIFICITY } from './types.ts';

/**
 * Visible active rules, general first: global, tag, machine, project, workspace, session; tag rules
 * grouped by tag name; oldest first within a group.
 */
export function resolveRules(store: KnowledgeStore, ctx: KnowledgeContext): KnowledgeItem[] {
  return orderRules(store.visible(ctx, 'rule'));
}

export function orderRules(rules: KnowledgeItem[]): KnowledgeItem[] {
  const tag = (i: KnowledgeItem) => i.scope.tag ?? '';
  return [...rules].sort(
    (a, b) =>
      SCOPE_SPECIFICITY[a.scope.level] - SCOPE_SPECIFICITY[b.scope.level] ||
      (tag(a) < tag(b) ? -1 : tag(a) > tag(b) ? 1 : 0) ||
      compareHlc(a.hlc, b.hlc),
  );
}

export interface RankOptions {
  /** Free text (a search query, or the session's first prompt). Enables relevance ranking. */
  query?: string;
  /** Max results. Default 20. */
  limit?: number;
  /** With a query: drop memories that don't match it. Default true. */
  requireMatch?: boolean;
  /** Only memories at this scope level. */
  scopeLevel?: SessionScopeLevel;
  /** Recency half-life in days. Default 30. */
  halfLifeDays?: number;
  /** Clock for recency (tests). Default: the store's clock. */
  now?: number;
}

export interface RankedMemory {
  item: KnowledgeItem;
  score: number;
  /** 0..1, relative to the best match (0 without a query or when unmatched). */
  relevance: number;
  /** 0..1, scope specificity (global 0 … session 1). */
  specificity: number;
  /** 0..1, exponential decay on updatedAt. */
  recency: number;
}

const WEIGHTS_WITH_QUERY = { relevance: 0.6, specificity: 0.25, recency: 0.15 };
const WEIGHTS_NO_QUERY = { relevance: 0, specificity: 0.6, recency: 0.4 };
const MAX_SPECIFICITY = SCOPE_SPECIFICITY.session;

/** Visible memories ranked by relevance (when a query is given), scope specificity and recency. */
export function rankMemories(store: KnowledgeStore, ctx: KnowledgeContext, opts: RankOptions = {}): RankedMemory[] {
  const limit = opts.limit ?? 20;
  const now = opts.now ?? store.nowMs();
  const halfLifeMs = (opts.halfLifeDays ?? 30) * 86_400_000;
  const query = opts.query?.trim() ? opts.query : undefined;
  const relevanceById = new Map<string, number>();
  let candidates: KnowledgeItem[];
  if (query) {
    const hits = store.search(query, { context: ctx, type: 'memory', limit: 500 });
    const max = hits.reduce((m, h) => Math.max(m, h.relevance), 0);
    for (const h of hits) relevanceById.set(h.item.id, max > 0 ? h.relevance / max : 0);
    candidates = hits.map((h) => h.item);
    if (opts.requireMatch === false) {
      for (const item of store.visible(ctx, 'memory')) if (!relevanceById.has(item.id)) candidates.push(item);
    }
  } else {
    candidates = store.visible(ctx, 'memory');
  }
  if (opts.scopeLevel) candidates = candidates.filter((i) => i.scope.level === opts.scopeLevel);
  const w = query ? WEIGHTS_WITH_QUERY : WEIGHTS_NO_QUERY;
  const ranked = candidates.map((item): RankedMemory => {
    const relevance = relevanceById.get(item.id) ?? 0;
    const specificity = SCOPE_SPECIFICITY[item.scope.level] / MAX_SPECIFICITY;
    const age = Math.max(0, now - Date.parse(item.updatedAt));
    const recency = Number.isFinite(age) ? 0.5 ** (age / halfLifeMs) : 0;
    const score = w.relevance * relevance + w.specificity * specificity + w.recency * recency;
    return { item, score, relevance, specificity, recency };
  });
  ranked.sort((a, b) => b.score - a.score || compareHlc(b.item.hlc, a.item.hlc));
  return ranked.slice(0, limit);
}

export interface ResolvedKnowledge {
  rules: KnowledgeItem[];
  memories: RankedMemory[];
}

export function resolveKnowledge(store: KnowledgeStore, ctx: KnowledgeContext, opts: RankOptions = {}): ResolvedKnowledge {
  return { rules: resolveRules(store, ctx), memories: rankMemories(store, ctx, opts) };
}
