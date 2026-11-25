// Knowledge extension (docs/knowledge.md): the `knowledge.*` methods on top of @bizzi/knowledge,
// `knowledge.changed` events, Claude auto-memory harvest (§8: on node start, when a workspace is
// added, on a watch of each workspace's memory directory, and when a Claude session ends),
// "Add to AGENTS.md" (`knowledge.promote*`, §8), and the `knowledge.sync.*` pair the hub calls to
// replicate the store between machines (§9.4).
//
// The KnowledgeStore is shared with the session-start injection hook (apps/cli/src/knowledge.ts):
// pass the same instance, or a function that opens it lazily for a machine id.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  BizziError,
  GLOBAL_CHANNEL,
  isMachineTag,
  type AgentKind,
  type ChannelEvent,
  type KnowledgeInboxCard,
  type KnowledgeItemInfo,
  type KnowledgePromotePreview,
  type KnowledgeRecord,
  type KnowledgeScope as WireScope,
  type KnowledgeSettings as WireSettings,
  type SessionInfo,
  type WorkspaceInfo,
} from '@bizzi/protocol';
import {
  MEMORY_KINDS,
  MemoryDirWatcher,
  POLICY_PRESETS,
  POLICY_SOURCES,
  SESSION_SCOPE_LEVELS,
  acceptItems,
  addKnowledge,
  applyPromotion,
  claudeMemoryDir,
  forgetKnowledge,
  harvestClaudeMemory,
  isScopeLevel,
  listInbox,
  loadSettings,
  normalizeScope,
  parseRemoteItem,
  planPromotion,
  rejectItems,
  saveSettings,
  updateKnowledge,
  type DirWatchFn,
  type HarvestResult,
  type KnowledgeContext,
  type KnowledgeItem,
  type KnowledgeScope,
  type KnowledgeSettings,
  type KnowledgeStatus,
  type KnowledgeStore,
  type MemoryKind,
  type PolicyOverrides,
  type SessionScopeLevel,
  type UpdateInput,
  type WriteOrigin,
} from '@bizzi/knowledge';
import { asParams, checkMachine, isAgentKind, oneOf, optInt, optString, optStringArray, reqString, reqStringArray, type Params } from './params.ts';
import type { ExtensionContext, NodeExtension } from './types.ts';

const STATUSES = ['active', 'suggested', 'superseded', 'deleted'] as const satisfies readonly KnowledgeStatus[];
const TYPES = ['rule', 'memory'] as const;
const LEVELS = ['global', 'tag', 'machine', 'project', 'workspace', 'session', 'team'] as const;
const DECISIONS = ['live', 'notice', 'suggest'] as const;

export type KnowledgeStoreSource = KnowledgeStore | ((machineId: string) => KnowledgeStore);

export interface KnowledgeExtensionOptions {
  store: KnowledgeStoreSource;
  /**
   * Import Claude auto-memory (default true): on start, when a workspace is added, when its memory
   * directory changes (see `watch`) and when a Claude session ends.
   */
  harvest?: boolean;
  /** Watch each workspace's Claude memory directory and harvest on change (default true; needs `harvest`). */
  watch?: boolean;
  /** Quiet period before a watched change is harvested. Default 1000 ms. */
  watchDebounceMs?: number;
  /** Re-check memory directories that appeared without an event we saw. Default 60 000 ms; 0 disables. */
  watchRearmMs?: number;
  /** `fs.watch`-compatible (tests). */
  watchFn?: DirWatchFn;
  /** Claude's config dir for harvest (default ~/.claude). */
  claudeHome?: string;
  /**
   * Poll the store for changes written by other processes (the bizzi-memory MCP server) and emit
   * `knowledge.changed` for them. Default 5000 ms; 0 disables.
   */
  pollMs?: number;
}

export interface KnowledgeExtension extends NodeExtension {
  /** Harvest Claude auto-memory for a workspace now; emits knowledge.changed when something was imported. */
  harvestWorkspace(workspaceId: string): Promise<HarvestResult | undefined>;
  /** Resolves when no harvest is running. */
  idle(): Promise<void>;
}

// ---- wire mapping ----------------------------------------------------------------------------

export function toWireScope(scope: KnowledgeScope): WireScope {
  const out: WireScope = { level: scope.level };
  if (scope.tag !== undefined) out.tag = scope.tag;
  if (scope.machineId !== undefined) out.machineId = scope.machineId;
  if (scope.projectId !== undefined) out.projectId = scope.projectId;
  if (scope.workspaceId !== undefined) out.workspaceId = scope.workspaceId;
  if (scope.sessionId !== undefined) out.sessionId = scope.sessionId;
  return out;
}

export function toItemInfo(item: KnowledgeItem): KnowledgeItemInfo {
  const s = item.source;
  return {
    id: item.id,
    type: item.type,
    scope: toWireScope(item.scope),
    ...(item.appliesTo && item.appliesTo.length > 0 ? { appliesTo: [...item.appliesTo] } : {}),
    ...(item.kind !== undefined ? { kind: item.kind } : {}),
    title: item.title,
    body: item.body,
    tags: [...item.tags],
    source: {
      machineId: s.machineId,
      via: s.via,
      ...(s.agent !== undefined ? { agent: s.agent } : {}),
      ...(s.sessionId !== undefined ? { sessionId: s.sessionId } : {}),
      ...(s.userRequested ? { userRequested: true } : {}),
    },
    status: item.status,
    ...(item.supersedes && item.supersedes.length > 0 ? { supersedes: [...item.supersedes] } : {}),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

export function toWireSettings(s: KnowledgeSettings): WireSettings {
  return {
    preset: s.policy.preset,
    defaultAgentScope: s.defaultAgentScope,
    ...(s.policy.overrides && Object.keys(s.policy.overrides).length > 0 ? { overrides: s.policy.overrides } : {}),
  };
}

function parseScope(v: unknown, machineId: string): KnowledgeScope {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new BizziError('bad_request', 'scope must be an object');
  const raw = v as Record<string, unknown>;
  if (!isScopeLevel(raw.level)) throw new BizziError('bad_request', `scope.level must be one of ${LEVELS.join(', ')}`);
  const scope: KnowledgeScope = { level: raw.level };
  if (scope.level === 'tag' && !isMachineTag(raw.tag)) {
    throw new BizziError('bad_request', 'scope.tag must be a machine tag (lowercase letters, digits, ".", "_" or "-")');
  }
  for (const k of ['tag', 'machineId', 'projectId', 'workspaceId', 'sessionId'] as const) {
    const x = raw[k];
    if (x === undefined || x === null) continue;
    if (typeof x !== 'string') throw new BizziError('bad_request', `scope.${k} must be a string`);
    scope[k] = x;
  }
  // "This machine" is the natural default for machine scope written from a client.
  if (scope.level === 'machine' && !scope.machineId) scope.machineId = machineId;
  return normalizeScope(scope);
}

function parseAppliesTo(p: Params): AgentKind[] | undefined {
  const v = optStringArray(p, 'appliesTo');
  if (!v) return undefined;
  for (const a of v) if (!isAgentKind(a)) throw new BizziError('bad_request', `appliesTo: unknown agent ${a}`);
  return v as AgentKind[];
}

function parseOverrides(v: unknown): PolicyOverrides | undefined {
  if (v === null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v)) throw new BizziError('bad_request', 'settings.overrides must be an object');
  const out: PolicyOverrides = {};
  for (const [source, row] of Object.entries(v as Record<string, unknown>)) {
    if (!(POLICY_SOURCES as readonly string[]).includes(source)) {
      throw new BizziError('bad_request', `settings.overrides: unknown source ${source} (${POLICY_SOURCES.join(', ')})`);
    }
    if (typeof row !== 'object' || row === null || Array.isArray(row)) throw new BizziError('bad_request', `settings.overrides.${source} must be an object`);
    const cells: Partial<Record<SessionScopeLevel, (typeof DECISIONS)[number]>> = {};
    for (const [level, decision] of Object.entries(row as Record<string, unknown>)) {
      if (!(SESSION_SCOPE_LEVELS as readonly string[]).includes(level)) {
        throw new BizziError('bad_request', `settings.overrides.${source}: unknown scope ${level}`);
      }
      if (!(DECISIONS as readonly unknown[]).includes(decision)) {
        throw new BizziError('bad_request', `settings.overrides.${source}.${level} must be one of ${DECISIONS.join(', ')}`);
      }
      cells[level as SessionScopeLevel] = decision as (typeof DECISIONS)[number];
    }
    out[source as keyof PolicyOverrides] = cells;
  }
  return out;
}

const isEnded = (s: SessionInfo) => s.status === 'ended' || s.status === 'failed';

// ---- extension -------------------------------------------------------------------------------

export function createKnowledgeExtension(opts: KnowledgeExtensionOptions): KnowledgeExtension {
  let store: KnowledgeStore | undefined;
  let ctxRef: ExtensionContext | undefined;
  let lastHlc: string | undefined;
  let pollTimer: NodeJS.Timeout | undefined;
  let globalSub: { unsubscribe(): void } | undefined;
  let watcher: MemoryDirWatcher | undefined;
  let rearmTimer: NodeJS.Timeout | undefined;
  const lastStatus = new Map<string, SessionInfo['status']>();
  const harvests = new Set<Promise<unknown>>();
  const claudeHome = opts.claudeHome ?? join(homedir(), '.claude');

  function getStore(ctx: ExtensionContext): KnowledgeStore {
    if (!store) {
      store = typeof opts.store === 'function' ? opts.store(ctx.node.machine.id) : opts.store;
      lastHlc = store.maxHlc();
    }
    return store;
  }

  /** Emit knowledge.changed for our own write and move the poll cursor past it. */
  function changed(ctx: ExtensionContext, items: (KnowledgeItem | string | undefined)[]): void {
    const st = getStore(ctx);
    const ids = new Set<string>();
    for (const i of items) {
      if (!i) continue;
      const item = typeof i === 'string' ? st.get(i) : i;
      if (typeof i === 'string') ids.add(i);
      if (!item) continue;
      ids.add(item.id);
      for (const s of item.supersedes ?? []) ids.add(s);
    }
    lastHlc = st.maxHlc();
    if (ids.size > 0) ctx.emitGlobal({ type: 'knowledge.changed', data: { ids: [...ids] } });
  }

  function poll(): void {
    const ctx = ctxRef;
    if (!ctx || !store) return;
    try {
      const fresh = store.changesSince(lastHlc);
      if (fresh.length === 0) return;
      lastHlc = store.maxHlc();
      ctx.emitGlobal({ type: 'knowledge.changed', data: { ids: [...new Set(fresh.map((i) => i.id))] } });
    } catch (err) {
      ctx.logger.log('warn', 'knowledge poll failed', { err: String(err) });
    }
  }

  function origin(ctx: ExtensionContext, scope?: KnowledgeScope): WriteOrigin {
    return {
      via: 'ui',
      machineId: ctx.node.machine.id,
      ...(scope?.projectId ? { projectId: scope.projectId } : {}),
      ...(scope?.workspaceId ? { workspaceId: scope.workspaceId } : {}),
    };
  }

  async function workspaceById(ctx: ExtensionContext, id: string): Promise<WorkspaceInfo | undefined> {
    const { workspaces } = await ctx.node.call('workspaces.list', {});
    return workspaces.find((w) => w.id === id);
  }

  async function harvestWorkspace(ctx: ExtensionContext, workspaceId: string): Promise<HarvestResult | undefined> {
    const ws = await workspaceById(ctx, workspaceId);
    if (!ws) return undefined;
    const dir = claudeMemoryDir(ws.path, claudeHome);
    if (!existsSync(dir)) return undefined;
    const st = getStore(ctx);
    const res = harvestClaudeMemory(st, {
      dir,
      machineId: ctx.node.machine.id,
      workspaceId: ws.id,
      workspacePath: ws.path,
      ...(ws.projectId ? { projectId: ws.projectId } : {}),
    });
    const items = [...res.imported, ...res.updated];
    ctx.logger.log(items.length ? 'info' : 'debug', 'harvested Claude memory', {
      workspaceId,
      imported: res.imported.length,
      updated: res.updated.length,
      skipped: res.skipped.length,
    });
    changed(ctx, items);
    return res;
  }

  function track<T>(p: Promise<T>): Promise<T> {
    harvests.add(p);
    void p.finally(() => harvests.delete(p)).catch(() => {});
    return p;
  }

  /** Run a harvest outside the current call stack (bus listeners, watch callbacks), logging failures. */
  function harvestLater(ctx: ExtensionContext, workspaceId: string, why: string): void {
    track(
      new Promise<void>((resolve) => setImmediate(resolve))
        .then(() => harvestWorkspace(ctx, workspaceId))
        .catch((err) => ctx.logger.log('warn', 'Claude memory harvest failed', { workspaceId, why, err: String(err) })),
    );
  }

  /** Point the memory-directory watch at the node's current workspaces. */
  async function syncWatches(ctx: ExtensionContext): Promise<WorkspaceInfo[]> {
    const { workspaces } = await ctx.node.call('workspaces.list', {});
    watcher?.update(new Map(workspaces.map((ws) => [ws.id, claudeMemoryDir(ws.path, claudeHome)])));
    return workspaces;
  }

  /** On start: watch every workspace's memory directory, then harvest each one (catches up on what changed while the node was down). */
  async function harvestAll(ctx: ExtensionContext): Promise<void> {
    const workspaces = await syncWatches(ctx);
    for (const ws of workspaces) {
      try {
        await harvestWorkspace(ctx, ws.id);
      } catch (err) {
        ctx.logger.log('warn', 'Claude memory harvest failed', { workspaceId: ws.id, why: 'start', err: String(err) });
      }
    }
  }

  function onGlobal(ctx: ExtensionContext, ev: ChannelEvent): void {
    if (ev.type === 'workspace.created' || ev.type === 'workspace.removed') {
      // Watch first, then harvest, so a memory saved in between isn't missed.
      track(syncWatches(ctx).catch((err) => ctx.logger.log('warn', 'memory watch update failed', { err: String(err) })));
      if (ev.type === 'workspace.created') harvestLater(ctx, ev.data.workspace.id, 'workspace added');
      return;
    }
    if (ev.type !== 'session.updated' && ev.type !== 'session.created') return;
    const s = ev.data.session;
    const prev = lastStatus.get(s.id);
    lastStatus.set(s.id, s.status);
    if (s.agent !== 'claude' || !isEnded(s) || (prev !== undefined && (prev === 'ended' || prev === 'failed'))) return;
    // Run outside the bus listener (harvest writes and emits).
    harvestLater(ctx, s.workspaceId, 'session ended');
  }

  /** Workspace + the context its sessions resolve knowledge in (for the promote scope check). */
  async function promoteTarget(ctx: ExtensionContext, p: Params): Promise<{ ws: WorkspaceInfo; context: KnowledgeContext }> {
    const workspaceId = reqString(p, 'workspaceId');
    const ws = await workspaceById(ctx, workspaceId);
    if (!ws) throw new BizziError('not_found', `workspace ${workspaceId} not found`);
    const machine = ctx.node.machine;
    const context: KnowledgeContext = {
      agent: 'claude',
      machineId: machine.id,
      ...(machine.tags.length > 0 ? { machineTags: [...machine.tags] } : {}),
      workspaceId: ws.id,
      ...(ws.projectId ? { projectId: ws.projectId } : {}),
    };
    return { ws, context };
  }

  function promoteParams(p: Params): { ids: string[]; heading?: string } {
    const ids = reqStringArray(p, 'ids');
    const heading = optString(p, 'heading');
    return { ids, ...(heading !== undefined ? { heading } : {}) };
  }

  const w = <T>(fn: (p: Params, ctx: ExtensionContext, st: KnowledgeStore) => T) => (raw: unknown, ctx: ExtensionContext) => {
    const p = asParams(raw);
    checkMachine(p, ctx.node.machine.id);
    return fn(p, ctx, getStore(ctx));
  };

  return {
    methods: {
      'knowledge.list': w((p, _ctx, st) => {
        const type = oneOf(p, 'type', TYPES);
        const status = oneOf(p, 'status', STATUSES);
        const scopeLevel = oneOf(p, 'scopeLevel', LEVELS);
        const workspaceId = optString(p, 'workspaceId');
        const projectId = optString(p, 'projectId');
        const query = optString(p, 'query')?.trim();
        const limit = optInt(p, 'limit', 1, 10_000);
        const statuses: KnowledgeStatus[] = status ? [status] : ['active', 'suggested'];
        let items: KnowledgeItem[];
        if (query) {
          items = st.search(query, { statuses, ...(type ? { type } : {}), limit: 1000 }).map((h) => h.item);
        } else {
          items = st.list({ status: statuses, ...(type ? { type } : {}), ...(scopeLevel ? { scopeLevel } : {}) });
          items.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
        }
        items = items.filter(
          (i) =>
            (!scopeLevel || i.scope.level === scopeLevel) &&
            (!workspaceId || i.scope.workspaceId === workspaceId) &&
            (!projectId || i.scope.projectId === projectId),
        );
        if (limit !== undefined) items = items.slice(0, limit);
        return { items: items.map(toItemInfo) };
      }),

      'knowledge.add': w((p, ctx, st) => {
        const type = oneOf(p, 'type', TYPES);
        if (!type) throw new BizziError('bad_request', 'type is required');
        const scope = parseScope(p.scope, ctx.node.machine.id);
        const kind = oneOf(p, 'kind', MEMORY_KINDS as readonly MemoryKind[]);
        if (kind && type !== 'memory') throw new BizziError('bad_request', 'kind applies to memories only');
        const appliesTo = parseAppliesTo(p);
        const tags = optStringArray(p, 'tags');
        const body = p.body;
        if (typeof body !== 'string') throw new BizziError('bad_request', 'body must be a string');
        const res = addKnowledge(
          st,
          {
            type,
            title: reqString(p, 'title'),
            body,
            scope,
            ...(kind ? { kind } : {}),
            ...(appliesTo && appliesTo.length > 0 ? { appliesTo } : {}),
            ...(tags ? { tags } : {}),
          },
          origin(ctx, scope),
        );
        if (!res.duplicate) changed(ctx, [res.item]);
        return { item: toItemInfo(res.item) };
      }),

      'knowledge.update': w((p, ctx, st) => {
        const id = reqString(p, 'id');
        const patch: UpdateInput = {};
        const title = optString(p, 'title');
        const body = optString(p, 'body');
        const tags = optStringArray(p, 'tags');
        if (title !== undefined) {
          if (title === '') throw new BizziError('bad_request', 'title must not be empty');
          patch.title = title;
        }
        if (body !== undefined) patch.body = body;
        if (tags !== undefined) patch.tags = tags;
        if (p.appliesTo !== undefined) {
          const a = parseAppliesTo(p);
          patch.appliesTo = a && a.length > 0 ? a : null;
        }
        if (p.scope !== undefined) patch.scope = parseScope(p.scope, ctx.node.machine.id);
        const res = updateKnowledge(st, id, patch, origin(ctx, patch.scope as KnowledgeScope | undefined));
        changed(ctx, [res.item, id]);
        return { item: toItemInfo(res.item) };
      }),

      'knowledge.forget': w((p, ctx, st) => {
        const id = reqString(p, 'id');
        const res = forgetKnowledge(st, id, origin(ctx));
        if (!res.duplicate) changed(ctx, [res.item, id]);
        return {};
      }),

      'knowledge.inbox': w((_p, _ctx, st) => {
        const cards: KnowledgeInboxCard[] = listInbox(st).map((g) => ({
          ...(g.sessionId !== null ? { sessionId: g.sessionId } : {}),
          ...(g.agent !== undefined ? { agent: g.agent } : {}),
          items: [...g.suggested, ...g.notices].map(toItemInfo),
        }));
        return { cards };
      }),

      'knowledge.accept': w((p, ctx, st) => {
        const ids = reqStringArray(p, 'ids');
        const scope = p.scope !== undefined && p.scope !== null ? parseScope(p.scope, ctx.node.machine.id) : undefined;
        const items = acceptItems(st, ids, scope ? { scope } : {});
        changed(ctx, [...items, ...ids]);
        return {};
      }),

      'knowledge.reject': w((p, ctx, st) => {
        const ids = reqStringArray(p, 'ids');
        const items = rejectItems(st, ids);
        changed(ctx, [...items, ...ids]);
        return {};
      }),

      'knowledge.settings.get': w((_p, _ctx, st) => ({ settings: toWireSettings(loadSettings(st)) })),

      'knowledge.settings.set': w((p, _ctx, st) => {
        const raw = p.settings;
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new BizziError('bad_request', 'settings must be an object');
        const s = raw as Params;
        const preset = oneOf(s, 'preset', POLICY_PRESETS);
        const defaultAgentScope = oneOf(s, 'defaultAgentScope', SESSION_SCOPE_LEVELS);
        const cur = loadSettings(st);
        const policy = { ...cur.policy };
        if (preset) policy.preset = preset;
        if ('overrides' in s) {
          const ov = parseOverrides(s.overrides);
          if (ov && Object.keys(ov).length > 0) policy.overrides = ov;
          else delete policy.overrides;
        }
        const next = saveSettings(st, { policy, ...(defaultAgentScope ? { defaultAgentScope } : {}) });
        return { settings: toWireSettings(next) };
      }),

      'knowledge.promote.preview': async (raw: unknown, ctx: ExtensionContext) => {
        const p = asParams(raw);
        checkMachine(p, ctx.node.machine.id);
        const { ws, context } = await promoteTarget(ctx, p);
        const plan = planPromotion(getStore(ctx), { workspacePath: ws.path, context, ...promoteParams(p) });
        const preview: KnowledgePromotePreview = {
          path: plan.path,
          exists: plan.exists,
          baseHash: plan.baseHash,
          heading: plan.heading,
          ids: plan.items.map((i) => i.id),
          skipped: plan.skipped,
          diff: plan.diff,
          warnings: plan.warnings,
        };
        return { preview };
      },

      'knowledge.promote': async (raw: unknown, ctx: ExtensionContext) => {
        const p = asParams(raw);
        checkMachine(p, ctx.node.machine.id);
        const { ws, context } = await promoteTarget(ctx, p);
        const baseHash = optString(p, 'baseHash');
        const res = applyPromotion(getStore(ctx), {
          workspacePath: ws.path,
          context,
          ...promoteParams(p),
          ...(baseHash !== undefined ? { baseHash } : {}),
        });
        ctx.logger.log('info', 'added memories to AGENTS.md', { workspaceId: ws.id, path: res.path, count: res.promoted.length, created: res.created });
        changed(ctx, res.promoted);
        return { path: res.path, created: res.created, promoted: res.promoted.map((i) => i.id) };
      },

      'knowledge.sync.pull': w((p, _ctx, st) => {
        const since = optString(p, 'since');
        const limit = optInt(p, 'limit', 1, 5000) ?? 500;
        const page = st.changesSince(since, limit + 1);
        const items: KnowledgeRecord[] = page.slice(0, limit);
        return { items, more: page.length > limit, storeId: st.storeId };
      }),

      'knowledge.sync.push': w((p, ctx, st) => {
        if (!Array.isArray(p.items)) throw new BizziError('bad_request', 'items must be an array');
        const parsed: KnowledgeItem[] = [];
        for (const raw of p.items) {
          try {
            parsed.push(parseRemoteItem(raw));
          } catch (err) {
            // One bad record mustn't stall replication of the rest.
            ctx.logger.log('warn', 'skipping invalid replicated knowledge record', { id: (raw as { id?: unknown })?.id, err: String(err) });
          }
        }
        const applied = st.transaction(() => parsed.filter((item) => st.applyRemote(item)));
        if (applied.length > 0) changed(ctx, applied);
        return { applied: applied.length };
      }),
    },

    start(ctx) {
      ctxRef = ctx;
      if (opts.harvest !== false) {
        // Only live events: skip what's already in the log (the bus replays synchronously).
        let replaying = true;
        const since = (ctx.node as { bus?: { lastSeq?(ch: string): number } }).bus?.lastSeq?.(GLOBAL_CHANNEL) ?? 0;
        globalSub = ctx.node.subscribe(GLOBAL_CHANNEL, since, (ev) => {
          if (replaying) {
            if (ev.type === 'session.updated' || ev.type === 'session.created') lastStatus.set(ev.data.session.id, ev.data.session.status);
            return;
          }
          onGlobal(ctx, ev);
        });
        replaying = false;
        if (opts.watch !== false) {
          watcher = new MemoryDirWatcher({
            root: claudeHome,
            debounceMs: opts.watchDebounceMs ?? 1000,
            ...(opts.watchFn ? { watchFn: opts.watchFn } : {}),
            logger: ctx.logger,
            onChange: (workspaceId) => harvestLater(ctx, workspaceId, 'memory changed'),
          });
          const rearmMs = opts.watchRearmMs ?? 60_000;
          if (rearmMs > 0) {
            rearmTimer = setInterval(() => watcher?.rearm(), rearmMs);
            rearmTimer.unref();
          }
        }
        // After start returns: the node answers workspaces.list once it is up.
        track(
          new Promise<void>((resolve) => setImmediate(resolve))
            .then(() => (ctxRef === ctx ? harvestAll(ctx) : undefined))
            .catch((err) => ctx.logger.log('warn', 'Claude memory harvest on start failed', { err: String(err) })),
        );
      }
      const pollMs = opts.pollMs ?? 5000;
      if (pollMs > 0) {
        pollTimer = setInterval(() => {
          if (store) poll();
        }, pollMs);
        pollTimer.unref();
      }
    },

    async stop() {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = undefined;
      if (rearmTimer) clearInterval(rearmTimer);
      rearmTimer = undefined;
      watcher?.close();
      watcher = undefined;
      globalSub?.unsubscribe();
      globalSub = undefined;
      await Promise.allSettled([...harvests]);
      ctxRef = undefined;
    },

    harvestWorkspace(workspaceId) {
      if (!ctxRef) return Promise.reject(new BizziError('internal', 'knowledge extension is not started'));
      return track(harvestWorkspace(ctxRef, workspaceId));
    },

    idle: async () => {
      while (harvests.size > 0) await Promise.allSettled([...harvests]);
    },
  };
}
