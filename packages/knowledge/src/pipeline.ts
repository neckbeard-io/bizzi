// The single write pipeline (§3): every write (UI, MCP tool, harvest, extraction) resolves its
// scope, is deduped, and goes through the policy engine, which decides active vs suggested.

import { BizziError } from '@bizzi/protocol';
import type { AgentKind } from '@bizzi/protocol';
import { decide, loadSettings, policySourceOf } from './policy.ts';
import type { KnowledgeSettings, PolicyDecision } from './policy.ts';
import { contextHasLevel, isScopeLevel, isVisible, normalizeScope, scopeEquals, scopeForLevel } from './scope.ts';
import { contentHash } from './store.ts';
import type { KnowledgeStore } from './store.ts';
import type {
  KnowledgeContext,
  KnowledgeItem,
  KnowledgeScope,
  KnowledgeSource,
  KnowledgeType,
  MemoryKind,
  ScopeLevel,
  SessionScopeLevel,
  SourceVia,
} from './types.ts';
import { FORGET_TAG } from './types.ts';

/** Who is writing, and from where. The context ids are used to resolve scope levels. */
export interface WriteOrigin {
  via: SourceVia;
  machineId: string;
  agent?: AgentKind;
  sessionId?: string;
  projectId?: string;
  workspaceId?: string;
  userRequested?: boolean;
  /** Provenance reference (harvest). */
  ref?: string;
}

export function originFromContext(
  ctx: KnowledgeContext,
  via: SourceVia = 'tool',
  extra: Pick<WriteOrigin, 'userRequested' | 'ref'> = {},
): WriteOrigin {
  return {
    via,
    machineId: ctx.machineId,
    agent: ctx.agent,
    ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}),
    ...(ctx.projectId !== undefined ? { projectId: ctx.projectId } : {}),
    ...(ctx.workspaceId !== undefined ? { workspaceId: ctx.workspaceId } : {}),
    ...extra,
  };
}

export interface AddInput {
  type: KnowledgeType;
  title: string;
  body: string;
  kind?: MemoryKind;
  tags?: string[];
  appliesTo?: AgentKind[];
  /** A level (resolved against the origin's ids) or a concrete scope. Omitted: the default scope (§3.3). */
  scope?: ScopeLevel | KnowledgeScope;
  supersedes?: string[];
}

export interface WriteOptions {
  /** Defaults to the settings stored in the database. */
  settings?: KnowledgeSettings;
  /** Never go live, whatever the policy says (e.g. Codex memories harvested at global scope). */
  forceSuggested?: boolean;
}

export interface WriteResult {
  item: KnowledgeItem;
  decision: PolicyDecision;
  /** The scope was not given and came from the default-scope setting. */
  scopeDefaulted: boolean;
  /** Set when an identical item already existed; `item` is then that existing item. */
  duplicate?: boolean;
}

/** Default scope level for writes that omit it (§3.3), falling back when the context lacks the id. */
export function defaultScopeLevel(settings: Pick<KnowledgeSettings, 'defaultAgentScope'>, ctx: Partial<KnowledgeContext>): SessionScopeLevel {
  const chain: SessionScopeLevel[] = [settings.defaultAgentScope, 'workspace', 'machine', 'global'];
  for (const level of chain) if (contextHasLevel(level, ctx)) return level;
  return 'global';
}

function originCtx(origin: WriteOrigin): Partial<KnowledgeContext> {
  return {
    machineId: origin.machineId,
    ...(origin.projectId !== undefined ? { projectId: origin.projectId } : {}),
    ...(origin.workspaceId !== undefined ? { workspaceId: origin.workspaceId } : {}),
    ...(origin.sessionId !== undefined ? { sessionId: origin.sessionId } : {}),
  };
}

export function resolveScope(
  scope: ScopeLevel | KnowledgeScope | undefined,
  origin: WriteOrigin,
  settings: Pick<KnowledgeSettings, 'defaultAgentScope'>,
): { scope: KnowledgeScope; defaulted: boolean } {
  const ctx = originCtx(origin);
  if (scope === undefined) return { scope: scopeForLevel(defaultScopeLevel(settings, ctx), ctx), defaulted: true };
  if (typeof scope === 'string') {
    if (!isScopeLevel(scope)) throw new BizziError('bad_request', `unknown scope level: ${scope}`);
    return { scope: scopeForLevel(scope, ctx), defaulted: false };
  }
  return { scope: normalizeScope(scope), defaulted: false };
}

function sourceOf(origin: WriteOrigin): KnowledgeSource {
  return {
    via: origin.via,
    machineId: origin.machineId,
    ...(origin.agent !== undefined ? { agent: origin.agent } : {}),
    ...(origin.sessionId !== undefined ? { sessionId: origin.sessionId } : {}),
    ...(origin.userRequested ? { userRequested: true } : {}),
    ...(origin.projectId !== undefined ? { projectId: origin.projectId } : {}),
    ...(origin.workspaceId !== undefined ? { workspaceId: origin.workspaceId } : {}),
    ...(origin.ref !== undefined ? { ref: origin.ref } : {}),
  };
}

/**
 * Side effects of an item going live: whatever it supersedes is retired. A forget request
 * (tagged FORGET_TAG) tombstones its targets and is itself consumed.
 */
export function applyActivation(store: KnowledgeStore, item: KnowledgeItem): void {
  if (item.status !== 'active') return;
  const isForget = item.tags.includes(FORGET_TAG);
  for (const id of item.supersedes ?? []) {
    const target = store.get(id);
    if (!target || target.status === 'deleted' || target.status === 'superseded') continue;
    store.setStatus(id, isForget ? 'deleted' : 'superseded');
  }
  if (isForget) store.patch(item.id, { status: 'deleted', noticePending: false });
}

/** Add a rule or memory through the policy engine. */
export function addKnowledge(store: KnowledgeStore, input: AddInput, origin: WriteOrigin, opts: WriteOptions = {}): WriteResult {
  const settings = opts.settings ?? loadSettings(store);
  const { scope, defaulted } = resolveScope(input.scope, origin, settings);
  return store.transaction(() => {
    // Dedupe: an identical live or pending item at the same scope is returned as-is
    // (not for edits, which may change only tags/appliesTo).
    const hash = contentHash(input.type, input.title, input.body);
    const dup = input.supersedes?.length
      ? undefined
      : store.findByContentHash(hash, ['active', 'suggested']).find((i) => i.type === input.type && scopeEquals(i.scope, scope));
    if (dup) {
      return { item: dup, decision: dup.status === 'active' ? 'live' : 'suggest', scopeDefaulted: defaulted, duplicate: true };
    }
    const source = policySourceOf(input.type, origin);
    const projectId = scope.projectId ?? origin.projectId;
    const res = decide(settings, { source, scope: scope.level, ...(projectId !== undefined ? { projectId } : {}) });
    const decision: PolicyDecision = opts.forceSuggested ? 'suggest' : res.decision;
    const item = store.insert({
      type: input.type,
      scope,
      ...(input.appliesTo ? { appliesTo: input.appliesTo } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      title: input.title,
      body: input.body,
      tags: input.tags ?? [],
      source: sourceOf(origin),
      status: decision === 'suggest' ? 'suggested' : 'active',
      ...(input.supersedes ? { supersedes: input.supersedes } : {}),
      noticePending: decision === 'notice',
    });
    applyActivation(store, item);
    return { item: store.require(item.id), decision, scopeDefaulted: defaulted };
  });
}

export interface UpdateInput {
  title?: string;
  body?: string;
  kind?: MemoryKind;
  tags?: string[];
  appliesTo?: AgentKind[] | null;
  scope?: ScopeLevel | KnowledgeScope;
}

function assertAccess(item: KnowledgeItem, ctx: KnowledgeContext | undefined): void {
  if (!ctx) return;
  const ownPending = item.status === 'suggested' && item.source.sessionId !== undefined && item.source.sessionId === ctx.sessionId;
  if (!isVisible(item, ctx) && !ownPending) {
    throw new BizziError('not_found', `knowledge item not found or not visible here: ${item.id}`);
  }
}

/**
 * Edit an item: writes a new item that `supersedes` the old one (auditable, reversible).
 * The new version goes through the policy engine; the old one is retired only once it is live.
 * `ctx` restricts edits to items the session can see.
 */
export function updateKnowledge(
  store: KnowledgeStore,
  id: string,
  patch: UpdateInput,
  origin: WriteOrigin,
  opts: WriteOptions & { context?: KnowledgeContext } = {},
): WriteResult {
  const cur = store.require(id);
  assertAccess(cur, opts.context);
  if (cur.status === 'deleted' || cur.status === 'superseded') {
    throw new BizziError('conflict', `knowledge item ${id} is ${cur.status}`);
  }
  const settings = opts.settings ?? loadSettings(store);
  const scope = patch.scope === undefined ? cur.scope : resolveScope(patch.scope, origin, settings).scope;
  const appliesTo = patch.appliesTo === undefined ? cur.appliesTo : patch.appliesTo ?? undefined;
  const kind = patch.kind ?? cur.kind;
  const ownPending = cur.status === 'suggested' && cur.source.sessionId !== undefined && cur.source.sessionId === origin.sessionId;
  const res = addKnowledge(
    store,
    {
      type: cur.type,
      title: patch.title ?? cur.title,
      body: patch.body ?? cur.body,
      ...(kind !== undefined ? { kind } : {}),
      tags: patch.tags ?? cur.tags,
      ...(appliesTo && appliesTo.length > 0 ? { appliesTo } : {}),
      scope,
      supersedes: [id],
    },
    origin,
    { ...opts, settings },
  );
  // Revising your own pending suggestion replaces it in the inbox right away.
  if (ownPending && store.require(id).status === 'suggested') store.setStatus(id, 'superseded');
  return res;
}

/**
 * Retire an item. Writers the policy trusts at that scope tombstone it directly (with an inbox
 * notice when the policy says so); otherwise a suggested forget request goes to the inbox.
 */
export function forgetKnowledge(
  store: KnowledgeStore,
  id: string,
  origin: WriteOrigin,
  opts: WriteOptions & { context?: KnowledgeContext; reason?: string } = {},
): WriteResult {
  const cur = store.require(id);
  assertAccess(cur, opts.context);
  if (cur.status === 'deleted') return { item: cur, decision: 'live', scopeDefaulted: false, duplicate: true };
  const settings = opts.settings ?? loadSettings(store);
  const projectId = cur.scope.projectId ?? origin.projectId;
  const res = decide(settings, {
    source: policySourceOf(cur.type, origin),
    scope: cur.scope.level,
    ...(projectId !== undefined ? { projectId } : {}),
  });
  // Withdrawing your own pending suggestion never needs review.
  const ownPending = cur.status === 'suggested' && cur.source.sessionId !== undefined && cur.source.sessionId === origin.sessionId;
  const decision: PolicyDecision = ownPending ? 'live' : opts.forceSuggested ? 'suggest' : res.decision;
  return store.transaction(() => {
    if (decision !== 'suggest') {
      const item = store.patch(id, { status: 'deleted', noticePending: decision === 'notice' });
      return { item, decision, scopeDefaulted: false };
    }
    const item = store.insert({
      type: cur.type,
      scope: cur.scope,
      title: `Forget: ${cur.title}`,
      body: opts.reason ?? '',
      tags: [FORGET_TAG],
      source: sourceOf(origin),
      status: 'suggested',
      supersedes: [id],
    });
    return { item, decision, scopeDefaulted: false };
  });
}
