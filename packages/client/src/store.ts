import { BizziError, GLOBAL_CHANNEL, parseChannel, sessionChannel } from '@bizzi/protocol';
import type {
  AccountUsage,
  AgentCapabilities,
  AgentKind,
  AgentListing,
  AgentProfile,
  ApprovalDecision,
  ChannelEvent,
  DeviceInfo,
  DeviceKind,
  ErrorObject,
  GlobalEvent,
  GlobalEventMap,
  InputBlock,
  InstallAction,
  InstallPlan,
  KnowledgeInboxCard,
  KnowledgeItemInfo,
  KnowledgePromotePreview,
  KnowledgeScope,
  KnowledgeSettings,
  KeepAwakeSettings,
  LabelColor,
  Logger,
  MachineInfo,
  MachineRole,
  MachineTarget,
  MethodParams,
  ModelOption,
  MethodResult,
  OrchestrationSettings,
  PipelineInfo,
  QuestionAnswers,
  RestartPolicy,
  RouteDecision,
  RouteDecisionInput,
  RouteSuggestion,
  RoutingRule,
  SecretInfo,
  SessionEvent,
  SessionInfo,
  UpdatePolicy,
  UserPrefs,
  WidgetValue,
  WorkspaceInfo,
} from '@bizzi/protocol';
import { base64ToBytes, stringToBase64 } from './base64.ts';
import type { BizziClient, ConnectionInfo, GapInfo } from './client.ts';
import { createFrameScheduler } from './scheduler.ts';
import type { FrameScheduler } from './scheduler.ts';
import { TerminalStreams } from './terminal.ts';
import { emptyTimeline, reduceTimeline } from './timeline.ts';
import type { ApprovalItem, QuestionItem, SessionPrompt, Timeline } from './timeline.ts';

/** What a provisioning job does: an install action, or switching the install method (`agent.migrate`). */
export type JobAction = InstallAction | 'migrate';

/** One provisioning run (`agent.install` / `agent.migrate`), fed by `install.progress` events with its jobId. */
export interface InstallJob {
  jobId: string;
  /** Machine the job runs on; null when it was started elsewhere (global events carry no machine id). */
  machineId: string | null;
  agent: AgentKind;
  tool?: string;
  action: JobAction | null;
  plan: InstallPlan | null;
  stage: string;
  message?: string;
  step?: number;
  total?: number;
  done: boolean;
  ok?: boolean;
  log: readonly { stage: string; message?: string; ts: string }[];
  startedAt: string;
  updatedAt: string;
}

export interface BizziState {
  /** Incremented on every change; cheap staleness check for memoized selectors. */
  version: number;
  connection: ConnectionInfo;
  /** The machine this connection is attached to (from `hello`): the node itself, or the hub's host. */
  machine: MachineInfo | null;
  /** 'hub' (multi-machine) or 'node'; null before the first handshake. */
  role: MachineRole | null;
  /** The machine the UI works on (machine-targeted calls default to it). */
  selectedMachineId: string | null;
  machines: Readonly<Record<string, MachineInfo>>;
  /** Agents per machine id (absent until loaded). */
  agents: Readonly<Record<string, readonly AgentListing[]>>;
  /** Last load failure per machine (e.g. machine_offline); cleared on a successful load. */
  machineErrors: Readonly<Record<string, ErrorObject>>;
  /** null until loaded. */
  workspaces: Readonly<Record<string, WorkspaceInfo>> | null;
  sessions: Readonly<Record<string, SessionInfo>>;
  sessionsLoaded: boolean;
  /** Per session, from `session.get`. */
  capabilities: Readonly<Record<string, AgentCapabilities>>;
  timelines: Readonly<Record<string, Timeline>>;
  jobs: Readonly<Record<string, InstallJob>>;
  /** Hub only; null until loaded (or on a node). */
  devices: Readonly<Record<string, DeviceInfo>> | null;
  /** Knowledge suggestions for the selected machine; null until loaded. */
  knowledgeInbox: readonly KnowledgeInboxCard[] | null;
  knowledgeSettings: KnowledgeSettings | null;
  /** Bumped on every `knowledge.changed`; knowledge views refetch when it changes. */
  knowledgeRev: number;
  /** Last gap per channel (shown as "some events may be missing"). */
  gaps: Readonly<Record<string, GapInfo>>;
  /** Per-login usage (usage.md §3), keyed by `accountKey()`. */
  accounts: Readonly<Record<string, AccountUsage>>;
  /** 'unsupported' when the server has no `usage.list` yet (accounts may still arrive as events). */
  usageState: 'loading' | 'ok' | 'unsupported';
  /** Node-run widget values (usage.md §4), keyed by `widgetKey()`. */
  widgets: Readonly<Record<string, WidgetValue>>;
  /** Repo state per workspace (`git.status`), loaded on demand for the sidebar. */
  gitStatus: Readonly<Record<string, GitSummary>>;
  // ---- pipelines (docs/pipelines.md)
  /** Pipeline runs by id, across machines (`pipelines.list` per machine, then `pipeline.*` events). */
  pipelines: Readonly<Record<string, PipelineInfo>>;
  // ---- agent profiles and models (New session dialog)
  /** User-wide prefs (`prefs.get`, then `prefs.updated`); null until loaded or on a server without them. */
  prefs: UserPrefs | null;
  /** `agents.models` per `modelsKey(machineId, agent)`; absent until loaded. */
  models: Readonly<Record<string, readonly ModelOption[]>>;
}

export function modelsKey(machineId: string | null | undefined, agent: AgentKind): string {
  return `${machineId ?? ''}:${agent}`;
}

/** What the sidebar shows of a workspace's `git.status` (spec §11.1 row 1 and row 3). */
export interface GitSummary {
  isRepo: boolean;
  branch?: string;
  ahead: number;
  behind: number;
  dirty: boolean;
  /** ms epoch of the load. */
  loadedAt: number;
}

export function accountKey(a: { agent: AgentKind; accountId: string }): string {
  return `${a.agent}:${a.accountId}`;
}

export function widgetKey(w: { machineId: string; id: string }): string {
  return `${w.machineId}:${w.id}`;
}

/** What survives a reload, so offline machines still show their last known state. */
export interface StoreSnapshot {
  v: 1;
  machines: Record<string, MachineInfo>;
  agents: Record<string, readonly AgentListing[]>;
  workspaces: Record<string, WorkspaceInfo>;
  sessions: Record<string, SessionInfo>;
  selectedMachineId: string | null;
}

export interface StoreCache {
  load(): StoreSnapshot | null;
  save(snapshot: StoreSnapshot): void;
}

export interface BizziStoreOptions {
  scheduler?: FrameScheduler;
  terminal?: TerminalStreams;
  logger?: Logger;
  /** Load machines/agents/workspaces/sessions after every handshake (default true). */
  autoLoad?: boolean;
  /** Subscribe to sessions that wait for an approval or input (inbox details) or finished unseen (sidebar row 2); default true. */
  watchAttention?: boolean;
  /** Preferred machine to select once machines are known (e.g. the last one used). */
  initialMachineId?: string | null;
  /** Persist a small snapshot (machines, agents, workspaces, sessions) for offline display. */
  cache?: StoreCache;
  /** Debounce for cache writes, ms (default 1500). */
  cacheDelayMs?: number;
}

export type Listener = () => void;
export type Selector<T> = (s: BizziState) => T;
export type Equality<T> = (a: T, b: T) => boolean;

const noopLogger: Logger = {
  log() {},
  child() {
    return noopLogger;
  },
};

export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

const ATTENTION = new Set(['waiting_approval', 'waiting_input']);
const EMPTY_AGENTS: readonly AgentListing[] = [];

function toErrorObject(e: unknown): ErrorObject {
  if (e instanceof BizziError) return e.toObject();
  return { code: 'internal', message: e instanceof Error ? e.message : String(e) };
}

function withoutKey<T>(rec: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const out = { ...rec };
  delete out[key];
  return out;
}

/**
 * Normalized client state built from list calls and channel events. Events are buffered and applied
 * at most once per animation frame; subscribers are notified once per flush. Framework-agnostic:
 * `subscribe` + `getState` plug straight into React's `useSyncExternalStore`.
 *
 * Machine routing: every machine-targeted call (agents, workspaces, sessions lists, provisioning,
 * knowledge) carries a `machineId`, defaulting to the selected machine. A node ignores its own id; a hub
 * routes by it.
 */
export class BizziStore {
  readonly client: BizziClient;
  readonly terminal: TerminalStreams;
  private readonly scheduler: FrameScheduler;
  private readonly logger: Logger;
  private readonly autoLoad: boolean;
  private readonly watchAttention: boolean;
  private readonly cache: StoreCache | null;
  private readonly cacheDelayMs: number;
  private preferredMachineId: string | null;
  private state: BizziState;
  private readonly listeners = new Set<Listener>();
  private buffer: ChannelEvent[] = [];
  private cancelFlush: (() => void) | null = null;
  private notifyPending = false;
  private readonly opened = new Set<string>();
  private readonly unsubs: (() => void)[] = [];
  private cacheTimer: ReturnType<typeof setTimeout> | null = null;
  private cached: { machines: unknown; agents: unknown; workspaces: unknown; sessions: unknown; selected: unknown } | null = null;
  private knowledgeTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  /** session.markSeen bookkeeping: highest seq sent per session, sessions with a request in flight. */
  private readonly seenSent = new Map<string, number>();
  private readonly seenInflight = new Set<string>();
  private seenUnsupported = false;
  private readonly gitInflight = new Set<string>();
  private readonly agentsReload = new Set<string>();
  /** Jobs known only from replayed history so far (none of their events arrived live). */
  private readonly replayedJobs = new Set<string>();

  /** Number of notifications sent (handy for perf tests). */
  notifications = 0;

  constructor(client: BizziClient, options: BizziStoreOptions = {}) {
    this.client = client;
    this.scheduler = options.scheduler ?? createFrameScheduler();
    this.terminal = options.terminal ?? new TerminalStreams();
    this.logger = options.logger ?? noopLogger;
    this.autoLoad = options.autoLoad ?? true;
    this.watchAttention = options.watchAttention ?? true;
    this.cache = options.cache ?? null;
    this.cacheDelayMs = options.cacheDelayMs ?? 1500;
    this.preferredMachineId = options.initialMachineId ?? null;
    this.state = {
      version: 0,
      connection: client.getConnection(),
      machine: null,
      role: null,
      selectedMachineId: null,
      machines: {},
      agents: {},
      machineErrors: {},
      workspaces: null,
      sessions: {},
      sessionsLoaded: false,
      capabilities: {},
      timelines: {},
      jobs: {},
      devices: null,
      knowledgeInbox: null,
      knowledgeSettings: null,
      knowledgeRev: 0,
      gaps: {},
      accounts: {},
      usageState: 'loading',
      widgets: {},
      gitStatus: {},
      pipelines: {},
      prefs: null,
      models: {},
    };
    this.hydrate();
    this.unsubs.push(
      client.onEvent((ev) => this.onEvent(ev)),
      client.onConnection((c) => this.onConnection(c)),
      client.onGap((g) => this.patch({ gaps: { ...this.state.gaps, [g.ch]: g } })),
      client.onReset((ch) => {
        const p = parseChannel(ch);
        if (p?.kind === 'session') this.patchTimeline(p.sessionId, emptyTimeline(p.sessionId));
        if (p?.kind === 'session') this.terminal.clear(p.sessionId);
      }),
    );
  }

  dispose(): void {
    this.disposed = true;
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.cancelFlush?.();
    this.cancelFlush = null;
    if (this.cacheTimer) clearTimeout(this.cacheTimer);
    if (this.knowledgeTimer) clearTimeout(this.knowledgeTimer);
    this.saveCache();
    this.listeners.clear();
  }

  // ---------------------------------------------------------------- external store API

  getState = (): BizziState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** A memoized `{ subscribe, getSnapshot }` pair for one selector (useSyncExternalStore-ready). */
  select<T>(selector: Selector<T>, isEqual: Equality<T> = Object.is): { subscribe: (l: Listener) => () => void; getSnapshot: () => T } {
    let version = -1;
    let value: T;
    return {
      subscribe: this.subscribe,
      getSnapshot: () => {
        const s = this.state;
        if (s.version !== version) {
          const next = selector(s);
          if (version === -1 || !isEqual(value, next)) value = next;
          version = s.version;
        }
        return value;
      },
    };
  }

  /** Apply buffered events now (tests, or before reading state synchronously). */
  flush(): void {
    this.cancelFlush?.();
    this.cancelFlush = null;
    const events = this.buffer;
    this.buffer = [];
    if (events.length > 0) this.applyEvents(events);
    if (this.notifyPending) {
      this.notifyPending = false;
      this.notifications++;
      this.scheduleCache();
      for (const l of this.listeners) {
        try {
          l();
        } catch (e) {
          this.logger.log('error', 'store listener threw', { error: String(e) });
        }
      }
    }
  }

  private schedule(): void {
    if (this.cancelFlush) return;
    this.cancelFlush = this.scheduler.schedule(() => {
      this.cancelFlush = null;
      this.flush();
    });
  }

  private patch(p: Partial<BizziState>): void {
    this.state = { ...this.state, ...p, version: this.state.version + 1 };
    this.notifyPending = true;
    this.schedule();
  }

  private patchTimeline(sessionId: string, tl: Timeline): void {
    this.patch({ timelines: { ...this.state.timelines, [sessionId]: tl } });
  }

  private upsertSession(s: SessionInfo): void {
    this.patch({ sessions: { ...this.state.sessions, [s.id]: keepSeen(this.state.sessions[s.id], s) } });
    this.maybeWatch(s);
  }

  private maybeWatch(s: SessionInfo): void {
    // Waiting sessions (inbox details) and finished-but-unseen ones (the sidebar shows their final message).
    const unseen = s.status === 'idle' && s.seenThrough !== undefined && s.lastSeq > s.seenThrough;
    if (this.watchAttention && (ATTENTION.has(s.status) || unseen) && !this.opened.has(s.id)) {
      this.openSession(s.id).catch((e) => this.logger.log('warn', 'watch session failed', { sessionId: s.id, error: String(e) }));
    }
  }

  // ---------------------------------------------------------------- offline cache

  private hydrate(): void {
    if (!this.cache) return;
    let snap: StoreSnapshot | null = null;
    try {
      snap = this.cache.load();
    } catch (e) {
      this.logger.log('warn', 'cache load failed', { error: String(e) });
    }
    if (!snap || snap.v !== 1) return;
    // Cached machines are shown as offline until the server says otherwise.
    const machines: Record<string, MachineInfo> = {};
    for (const [id, m] of Object.entries(snap.machines ?? {})) machines[id] = { ...m, online: false };
    this.state = {
      ...this.state,
      machines,
      agents: snap.agents ?? {},
      workspaces: snap.workspaces ?? null,
      sessions: snap.sessions ?? {},
      selectedMachineId: snap.selectedMachineId ?? null,
    };
    this.preferredMachineId ??= snap.selectedMachineId ?? null;
    const s = this.state;
    this.cached = { machines: s.machines, agents: s.agents, workspaces: s.workspaces, sessions: s.sessions, selected: s.selectedMachineId };
  }

  private scheduleCache(): void {
    if (!this.cache || this.cacheTimer || this.disposed) return;
    const s = this.state;
    const c = this.cached;
    if (c && c.machines === s.machines && c.agents === s.agents && c.workspaces === s.workspaces && c.sessions === s.sessions && c.selected === s.selectedMachineId) return;
    this.cacheTimer = setTimeout(() => {
      this.cacheTimer = null;
      this.saveCache();
    }, this.cacheDelayMs);
  }

  private saveCache(): void {
    if (!this.cache) return;
    const s = this.state;
    const c = this.cached;
    if (c && c.machines === s.machines && c.agents === s.agents && c.workspaces === s.workspaces && c.sessions === s.sessions && c.selected === s.selectedMachineId) return;
    this.cached = { machines: s.machines, agents: s.agents, workspaces: s.workspaces, sessions: s.sessions, selected: s.selectedMachineId };
    try {
      this.cache.save({
        v: 1,
        machines: { ...s.machines },
        agents: { ...s.agents },
        workspaces: { ...(s.workspaces ?? {}) },
        sessions: { ...s.sessions },
        selectedMachineId: s.selectedMachineId,
      });
    } catch (e) {
      this.logger.log('warn', 'cache save failed', { error: String(e) });
    }
  }

  // ---------------------------------------------------------------- machine routing

  isHub(): boolean {
    return this.state.role === 'hub';
  }

  /** The machine a machine-targeted call goes to: the given one, else the selected one, else the node itself. */
  targetMachineId(machineId?: string | null): string | null {
    return machineId ?? this.state.selectedMachineId ?? this.state.machine?.id ?? null;
  }

  /** `MachineTarget` params for a call (always names the machine once it is known). */
  target(machineId?: string | null): MachineTarget {
    const id = this.targetMachineId(machineId);
    return id ? { machineId: id } : {};
  }

  selectMachine(machineId: string): void {
    this.preferredMachineId = machineId;
    if (this.state.selectedMachineId === machineId) return;
    this.patch({ selectedMachineId: machineId, knowledgeInbox: null, knowledgeSettings: null });
    if (this.client.isOpen()) void this.loadKnowledgeMeta();
  }

  /** Machines whose data this connection can load: every node behind a hub, or just the node itself. */
  private reachableMachines(): string[] {
    const self = this.state.machine;
    if (!this.isHub()) return self ? [self.id] : [];
    return Object.values(this.state.machines)
      .filter((m) => m.roles.includes('node') || !m.roles.includes('hub'))
      .map((m) => m.id);
  }

  private pickSelection(): string | null {
    const s = this.state;
    if (!this.isHub()) return s.machine?.id ?? null;
    const nodes = this.reachableMachines();
    const pref = this.preferredMachineId;
    if (pref && nodes.includes(pref)) return pref;
    if (s.selectedMachineId && nodes.includes(s.selectedMachineId)) return s.selectedMachineId;
    const online = nodes.find((id) => s.machines[id]?.online);
    return online ?? nodes[0] ?? s.machine?.id ?? null;
  }

  private setMachineError(machineId: string, e: unknown): void {
    this.patch({ machineErrors: { ...this.state.machineErrors, [machineId]: toErrorObject(e) } });
  }

  private clearMachineError(machineId: string): void {
    if (!(machineId in this.state.machineErrors)) return;
    this.patch({ machineErrors: withoutKey(this.state.machineErrors, machineId) });
  }

  // ---------------------------------------------------------------- inbound

  private onConnection(c: ConnectionInfo): void {
    const p: Partial<BizziState> = { connection: c };
    if (c.machine && c.machine !== this.state.machine) p.machine = c.machine;
    if (c.role && c.role !== this.state.role) p.role = c.role;
    this.patch(p);
    if (c.state === 'open') {
      this.client.subscribe(GLOBAL_CHANNEL).catch((e) => this.logger.log('warn', 'subscribe global failed', { error: String(e) }));
      if (this.autoLoad) void this.loadAll();
    }
  }

  private onEvent(ev: ChannelEvent): void {
    if (ev.type === 'term.output') {
      const p = parseChannel(ev.ch);
      if (p?.kind === 'session') this.terminal.write(p.sessionId, base64ToBytes(ev.data.dataBase64));
      return;
    }
    this.buffer.push(ev);
    this.notifyPending = true;
    this.schedule();
  }

  private applyEvents(events: ChannelEvent[]): void {
    const bySession = new Map<string, SessionEvent[]>();
    const globals: GlobalEvent[] = [];
    for (const ev of events) {
      const p = parseChannel(ev.ch);
      if (!p) continue;
      if (p.kind === 'global') globals.push(ev as GlobalEvent);
      else {
        let list = bySession.get(p.sessionId);
        if (!list) bySession.set(p.sessionId, (list = []));
        list.push(ev as SessionEvent);
      }
    }
    for (const ev of globals) this.applyGlobal(ev);
    if (bySession.size === 0) return;
    const timelines = { ...this.state.timelines };
    let sessions: Record<string, SessionInfo> | null = null;
    for (const [sid, evs] of bySession) {
      for (const ev of evs) {
        if (ev.type === 'account.usage') this.upsertAccount(ev.data);
        // A restart changes the machine's stale-session count (updates.md §6): refresh its agent list.
        else if (ev.type === 'session.restarted' && ev.data.ok) this.scheduleAgentsReload(this.state.sessions[sid]?.machineId);
      }
      const prev = timelines[sid] ?? emptyTimeline(sid);
      const next = reduceTimeline(prev, evs);
      timelines[sid] = next;
      // Keep the session list consistent with what the session's own channel says.
      const info = this.state.sessions[sid];
      if (info) {
        let patched: SessionInfo | null = null;
        if (next.status && next.status !== info.status) patched = { ...info, status: next.status };
        if (next.info !== prev.info) {
          const i = next.info;
          patched = { ...(patched ?? info) };
          if (i.model !== undefined) patched.model = i.model;
          if (i.permissionMode !== undefined) patched.permissionMode = i.permissionMode;
          if (i.effort !== undefined) patched.effort = i.effort;
          if (i.title !== undefined) patched.title = i.title;
          if (i.agentSessionRef !== undefined) patched.agentSessionRef = i.agentSessionRef;
        }
        if (next.agentVersion !== prev.agentVersion && next.agentVersion !== undefined) {
          patched = { ...(patched ?? info), agentVersion: next.agentVersion };
        }
        if (patched) {
          if (!sessions) sessions = { ...this.state.sessions };
          sessions[sid] = patched;
        }
      }
    }
    const p: Partial<BizziState> = { timelines };
    if (sessions) p.sessions = sessions;
    this.patch(p);
  }

  private applyGlobal(ev: GlobalEvent): void {
    switch (ev.type) {
      case 'machine.updated': {
        const m = ev.data.machine;
        const prev = this.state.machines[m.id];
        const p: Partial<BizziState> = { machines: { ...this.state.machines, [m.id]: m } };
        if (this.state.machine?.id === m.id) p.machine = m;
        this.patch(p);
        if (this.isHub()) {
          if (!this.state.selectedMachineId) this.patch({ selectedMachineId: this.pickSelection() });
          // A machine that came (back) online: refresh what we know about it.
          if (m.online && prev?.online !== true && this.client.isOpen()) void this.loadMachine(m.id);
        }
        return;
      }
      case 'workspace.created':
      case 'workspace.updated':
        this.patch({ workspaces: { ...this.state.workspaces, [ev.data.workspace.id]: ev.data.workspace } });
        return;
      case 'workspace.removed': {
        if (!this.state.workspaces) return;
        this.patch({ workspaces: withoutKey(this.state.workspaces, ev.data.workspaceId) });
        return;
      }
      case 'session.created':
      case 'session.updated':
        this.upsertSession(ev.data.session);
        return;
      case 'session.removed':
        this.dropSession(ev.data.sessionId);
        return;
      case 'install.progress':
        this.applyProgress(ev.data, ev.ts, ev.seq <= this.client.replayEnd(GLOBAL_CHANNEL));
        return;
      case 'knowledge.changed':
        this.patch({ knowledgeRev: this.state.knowledgeRev + 1 });
        this.scheduleKnowledgeReload();
        return;
      case 'device.updated': {
        const d = ev.data.device;
        this.patch({ devices: { ...(this.state.devices ?? {}), [d.id]: d } });
        return;
      }
      case 'account.usage':
        this.upsertAccount(ev.data.usage);
        return;
      case 'widget.updated': {
        const w = ev.data.widget;
        this.patch({ widgets: { ...this.state.widgets, [widgetKey(w)]: w } });
        return;
      }
      case 'widget.removed': {
        const key = widgetKey({ machineId: ev.data.machineId, id: ev.data.widgetId });
        if (key in this.state.widgets) this.patch({ widgets: withoutKey(this.state.widgets, key) });
        return;
      }
      case 'prefs.updated':
        this.patch({ prefs: ev.data.prefs });
        return;
      case 'pipeline.updated':
        this.putPipeline(ev.data.pipeline);
        return;
      case 'pipeline.removed':
        if (ev.data.pipelineId in this.state.pipelines) this.patch({ pipelines: withoutKey(this.state.pipelines, ev.data.pipelineId) });
        return;
    }
  }

  // ---------------------------------------------------------------- pipelines (docs/pipelines.md)

  /** Replace one machine's pipeline runs with what it lists now. */
  async loadPipelines(machineId?: string | null): Promise<void> {
    const t = this.target(machineId);
    const { pipelines } = await this.client.request('pipelines.list', t);
    const rec: Record<string, PipelineInfo> = {};
    for (const p of Object.values(this.state.pipelines)) if (t.machineId && p.machineId !== t.machineId) rec[p.id] = p;
    for (const p of pipelines) rec[p.id] = p;
    this.patch({ pipelines: rec });
  }

  /** Apply a run from a response or event; an older copy never replaces a newer one. */
  putPipeline(p: PipelineInfo): void {
    const prev = this.state.pipelines[p.id];
    if (prev && prev.updatedAt > p.updatedAt) return;
    this.patch({ pipelines: { ...this.state.pipelines, [p.id]: p } });
  }

  async startPipeline(params: MethodParams<'pipeline.start'>): Promise<PipelineInfo> {
    const { pipeline } = await this.client.request('pipeline.start', params);
    this.putPipeline(pipeline);
    return pipeline;
  }

  async gatePipeline(p: Pick<PipelineInfo, 'id' | 'machineId'>, decision: 'approve' | 'reject', message?: string): Promise<PipelineInfo> {
    const params: MethodParams<'pipeline.gate'> = { machineId: p.machineId, pipelineId: p.id, decision };
    if (message?.trim()) params.message = message.trim();
    const { pipeline } = await this.client.request('pipeline.gate', params);
    this.putPipeline(pipeline);
    return pipeline;
  }

  async cancelPipeline(p: Pick<PipelineInfo, 'id' | 'machineId'>): Promise<PipelineInfo> {
    const { pipeline } = await this.client.request('pipeline.cancel', { machineId: p.machineId, pipelineId: p.id });
    this.putPipeline(pipeline);
    return pipeline;
  }

  async deletePipeline(p: Pick<PipelineInfo, 'id' | 'machineId'>): Promise<void> {
    await this.client.request('pipeline.delete', { machineId: p.machineId, pipelineId: p.id });
    if (p.id in this.state.pipelines) this.patch({ pipelines: withoutKey(this.state.pipelines, p.id) });
  }

  /** Newest observation per login wins; the machine lists are merged. */
  private upsertAccount(a: AccountUsage): void {
    const key = accountKey(a);
    const prev = this.state.accounts[key];
    let next: AccountUsage;
    if (!prev || a.observedAt >= prev.observedAt) next = prev ? { ...a, machines: mergeLists(a.machines, prev.machines) } : a;
    else next = { ...prev, machines: mergeLists(prev.machines, a.machines) };
    this.patch({ accounts: { ...this.state.accounts, [key]: next } });
  }

  /**
   * `replayed`: the event is history caught up on (re)subscribing, not live. A job that started and
   * finished entirely in that history is dropped: it ended before this client was around, and
   * showing it again would bring back every past install or detected version change (already
   * dismissed or not) on each restart or reload. Jobs still running, or finishing live, are kept.
   */
  private applyProgress(data: GlobalEventMap['install.progress'], ts: string, replayed = false): void {
    const jobId = data.jobId ?? `${data.agent}:${data.tool ?? 'agent'}`;
    const prev = this.state.jobs[jobId];
    if (!replayed) this.replayedJobs.delete(jobId);
    else if (!prev) this.replayedJobs.add(jobId);
    if (replayed && (data.done ?? false) && this.replayedJobs.has(jobId)) {
      this.replayedJobs.delete(jobId);
      if (prev) this.patch({ jobs: withoutKey(this.state.jobs, jobId) });
      return;
    }
    const job: InstallJob = prev
      ? { ...prev }
      : {
          jobId,
          machineId: null,
          agent: data.agent,
          action: null,
          plan: null,
          stage: data.stage,
          done: false,
          log: [],
          startedAt: ts,
          updatedAt: ts,
        };
    if (data.tool !== undefined) job.tool = data.tool;
    job.stage = data.stage;
    if (data.message !== undefined) job.message = data.message;
    else delete job.message;
    if (data.step !== undefined) job.step = data.step;
    if (data.total !== undefined) job.total = data.total;
    job.done = data.done ?? false;
    if (data.ok !== undefined) job.ok = data.ok;
    job.updatedAt = ts;
    const entry: { stage: string; message?: string; ts: string } = { stage: data.stage, ts };
    if (data.message !== undefined) entry.message = data.message;
    job.log = [...job.log.slice(-199), entry];
    this.patch({ jobs: { ...this.state.jobs, [jobId]: job } });
    if (job.done && !prev?.done) {
      // The probe changed (installed / version / removed): refresh the agent list of that machine.
      const mid = job.machineId ?? this.targetMachineId();
      if (mid && this.client.isOpen()) this.loadAgents(mid, true).catch((e) => this.logger.log('warn', 'reload agents failed', { error: String(e) }));
    }
  }

  private scheduleAgentsReload(machineId: string | undefined): void {
    if (!machineId || this.agentsReload.has(machineId) || this.disposed) return;
    this.agentsReload.add(machineId);
    setTimeout(() => {
      this.agentsReload.delete(machineId);
      if (this.client.isOpen() && !this.disposed) this.loadAgents(machineId).catch((e) => this.logger.log('debug', 'agents reload failed', { error: String(e) }));
    }, 250);
  }

  private scheduleKnowledgeReload(): void {
    if (this.knowledgeTimer || this.disposed) return;
    this.knowledgeTimer = setTimeout(() => {
      this.knowledgeTimer = null;
      if (this.client.isOpen()) this.loadKnowledgeInbox().catch((e) => this.logger.log('debug', 'knowledge inbox reload failed', { error: String(e) }));
    }, 250);
  }

  // ---------------------------------------------------------------- loading

  async loadAll(): Promise<void> {
    try {
      await this.loadMachines();
    } catch (e) {
      this.logger.log('warn', 'machines.list failed', { error: String(e) });
      if (!this.state.selectedMachineId) this.patch({ selectedMachineId: this.pickSelection() });
    }
    const tasks: Promise<unknown>[] = this.reachableMachines().map((id) => this.loadMachine(id));
    if (this.isHub()) tasks.push(this.loadDevices());
    tasks.push(this.loadKnowledgeMeta(), this.loadUsage(), this.loadWidgets(), this.loadPrefs());
    const results = await Promise.allSettled(tasks);
    for (const r of results) {
      if (r.status === 'rejected') this.logger.log('warn', 'initial load failed', { error: String(r.reason) });
    }
    if (!this.state.sessionsLoaded) this.patch({ sessionsLoaded: true });
  }

  /** Agents, workspaces and sessions of one machine. Failures are recorded in `machineErrors`; cached data stays. */
  async loadMachine(machineId: string): Promise<void> {
    // Pipelines are optional (older nodes answer `unsupported`) and never mark the machine as failed.
    this.loadPipelines(machineId).catch((e) => this.logger.log('debug', 'pipelines.list failed', { machineId, error: String(e) }));
    const results = await Promise.allSettled([this.loadAgents(machineId), this.loadWorkspaces(machineId), this.loadSessions({ machineId })]);
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) this.setMachineError(machineId, failed.reason);
    else this.clearMachineError(machineId);
  }

  async loadMachines(): Promise<void> {
    const { machines } = await this.client.request('machines.list', {});
    const rec: Record<string, MachineInfo> = {};
    for (const m of machines) rec[m.id] = m;
    const p: Partial<BizziState> = { machines: rec };
    const self = this.state.machine && rec[this.state.machine.id];
    if (self) p.machine = self;
    this.patch(p);
    const sel = this.pickSelection();
    if (sel !== this.state.selectedMachineId) this.patch({ selectedMachineId: sel });
  }

  async loadAgents(machineId?: string | null, refresh = false): Promise<void> {
    const t = this.target(machineId);
    const params: MethodParams<'agents.list'> = refresh ? { ...t, refresh: true } : t;
    const { agents } = await this.client.request('agents.list', params, refresh ? { timeoutMs: 60_000 } : {});
    const key = t.machineId ?? '';
    this.patch({ agents: { ...this.state.agents, [key]: agents } });
  }

  /**
   * The models an agent offers on a machine (`agents.models`). Never throws: a failure (an older node,
   * an offline machine) records an empty list, which the UI shows as a free-text model field.
   */
  loadModels(machineId: string | null | undefined, agent: AgentKind, refresh = false): Promise<readonly ModelOption[]> {
    const key = modelsKey(machineId, agent);
    const running = this.modelsInflight.get(key);
    if (running && !refresh) return running;
    const p = this.fetchModels(machineId, agent, refresh).finally(() => {
      if (this.modelsInflight.get(key) === p) this.modelsInflight.delete(key);
    });
    this.modelsInflight.set(key, p);
    return p;
  }

  private readonly modelsInflight = new Map<string, Promise<readonly ModelOption[]>>();

  private async fetchModels(machineId: string | null | undefined, agent: AgentKind, refresh: boolean): Promise<readonly ModelOption[]> {
    const t = this.target(machineId);
    let models: ModelOption[] = [];
    try {
      const params: MethodParams<'agents.models'> = refresh ? { ...t, agent, refresh: true } : { ...t, agent };
      models = (await this.client.request('agents.models', params, { timeoutMs: 60_000 })).models;
    } catch (e) {
      this.logger.log('debug', 'agents.models failed', { machineId: t.machineId, agent, error: String(e) });
    }
    this.patch({ models: { ...this.state.models, [modelsKey(machineId, agent)]: models } });
    return models;
  }

  /** User-wide prefs; an older server without `prefs.*` leaves them null. */
  async loadPrefs(): Promise<void> {
    try {
      const { prefs } = await this.client.request('prefs.get', {});
      this.patch({ prefs });
    } catch (e) {
      if (!isUnsupported(e)) throw e;
    }
  }

  /**
   * Replace one agent's saved profiles (the others are kept) and, when given, which one is preselected
   * (`null` clears it back to Default). Returns the stored prefs.
   */
  async saveAgentProfiles(agent: AgentKind, profiles: readonly AgentProfile[], preferred?: string | null): Promise<UserPrefs> {
    const current = this.state.prefs ?? {};
    const others = (current.agentProfiles ?? []).filter((p) => p.agent !== agent);
    const patch: Partial<UserPrefs> = { agentProfiles: [...others, ...profiles.map((p) => ({ ...p, agent }))] };
    if (preferred !== undefined) {
      const next = { ...current.preferredProfiles };
      if (preferred === null) delete next[agent];
      else next[agent] = preferred;
      patch.preferredProfiles = next;
    }
    const { prefs } = await this.client.request('prefs.set', { prefs: patch });
    this.patch({ prefs });
    return prefs;
  }

  async loadWorkspaces(machineId?: string | null): Promise<void> {
    const t = this.target(machineId);
    const { workspaces } = await this.client.request('workspaces.list', t);
    const rec: Record<string, WorkspaceInfo> = {};
    // Replace only this machine's workspaces.
    for (const w of Object.values(this.state.workspaces ?? {})) if (t.machineId && w.machineId !== t.machineId) rec[w.id] = w;
    for (const w of workspaces) rec[w.id] = w;
    this.patch({ workspaces: rec });
  }

  async loadSessions(opts: { machineId?: string | null; workspaceId?: string } = {}): Promise<void> {
    const t = this.target(opts.machineId);
    const params: MethodParams<'sessions.list'> = opts.workspaceId ? { ...t, workspaceId: opts.workspaceId } : t;
    const { sessions } = await this.client.request('sessions.list', params);
    const rec: Record<string, SessionInfo> = {};
    for (const s of Object.values(this.state.sessions)) {
      const replaced = opts.workspaceId ? s.workspaceId === opts.workspaceId : !t.machineId || s.machineId === t.machineId;
      if (!replaced) rec[s.id] = s;
    }
    for (const s of sessions) rec[s.id] = keepSeen(this.state.sessions[s.id], s);
    this.patch({ sessions: rec });
    for (const s of sessions) this.maybeWatch(s);
  }

  /** Per-login usage; servers without `usage.list` leave `usageState` 'unsupported' (accounts may still come as events). */
  async loadUsage(): Promise<void> {
    try {
      const { accounts } = await this.client.request('usage.list', {});
      for (const a of accounts) this.upsertAccount(a);
      this.patch({ usageState: 'ok' });
    } catch (e) {
      if (isUnsupported(e)) this.patch({ usageState: 'unsupported' });
      else throw e;
    }
  }

  /** Every widget this connection can see (a hub answers for all online machines). */
  async loadWidgets(): Promise<void> {
    let widgets: WidgetValue[];
    try {
      ({ widgets } = await this.client.request('widgets.list', {}));
    } catch (e) {
      if (isUnsupported(e)) return;
      throw e;
    }
    const rec: Record<string, WidgetValue> = {};
    for (const w of widgets) rec[widgetKey(w)] = w;
    this.patch({ widgets: rec });
  }

  async refreshWidget(machineId: string, widgetId: string): Promise<WidgetValue> {
    const { widget } = await this.client.request('widget.refresh', { machineId, widgetId });
    this.patch({ widgets: { ...this.state.widgets, [widgetKey(widget)]: widget } });
    return widget;
  }

  /**
   * Repo state of a workspace for the sidebar. Skipped while a load is in flight or the last one is
   * younger than `maxAgeMs`; failures (offline machine) keep the previous value.
   */
  async loadGitStatus(workspaceId: string, maxAgeMs = 30_000): Promise<void> {
    const prev = this.state.gitStatus[workspaceId];
    if (this.gitInflight.has(workspaceId) || (prev && Date.now() - prev.loadedAt < maxAgeMs)) return;
    this.gitInflight.add(workspaceId);
    try {
      const r = await this.client.request('git.status', { workspaceId });
      const g: GitSummary = { isRepo: r.isRepo, ahead: r.ahead ?? 0, behind: r.behind ?? 0, dirty: r.files.length > 0, loadedAt: Date.now() };
      if (r.branch !== undefined) g.branch = r.branch;
      this.patch({ gitStatus: { ...this.state.gitStatus, [workspaceId]: g } });
    } finally {
      this.gitInflight.delete(workspaceId);
    }
  }

  async loadDevices(): Promise<void> {
    const { devices } = await this.client.request('devices.list', {});
    const rec: Record<string, DeviceInfo> = {};
    for (const d of devices) rec[d.id] = d;
    this.patch({ devices: rec });
  }

  /** Knowledge goes to the selected machine, or any online one (knowledge replicates to every node). */
  knowledgeTarget(): MachineTarget {
    const s = this.state;
    const sel = this.targetMachineId();
    if (!this.isHub() || (sel && s.machines[sel]?.online)) return this.target(sel);
    const online = this.reachableMachines().find((id) => s.machines[id]?.online);
    return this.target(online ?? sel);
  }

  async loadKnowledgeMeta(): Promise<void> {
    await Promise.allSettled([this.loadKnowledgeInbox(), this.loadKnowledgeSettings()]);
  }

  async loadKnowledgeInbox(): Promise<void> {
    const { cards } = await this.client.request('knowledge.inbox', this.knowledgeTarget());
    this.patch({ knowledgeInbox: cards });
  }

  async loadKnowledgeSettings(): Promise<void> {
    const { settings } = await this.client.request('knowledge.settings.get', this.knowledgeTarget());
    this.patch({ knowledgeSettings: settings });
  }

  // ---------------------------------------------------------------- workspaces & sessions

  async createWorkspace(params: MethodParams<'workspace.create'>): Promise<WorkspaceInfo> {
    const { workspace } = await this.client.request('workspace.create', { ...this.target(params.machineId), ...params });
    this.patch({ workspaces: { ...this.state.workspaces, [workspace.id]: workspace } });
    return workspace;
  }

  /** Workspace picker: directories in `path` (default home) on a machine. */
  browseDirs(params: MethodParams<'fs.browse'>): Promise<MethodResult<'fs.browse'>> {
    return this.client.request('fs.browse', { ...params, ...this.target(params.machineId) });
  }

  /** Workspace picker: directory completions for a partially typed path. */
  completePath(params: MethodParams<'fs.complete'>): Promise<MethodResult<'fs.complete'>> {
    return this.client.request('fs.complete', { ...params, ...this.target(params.machineId) });
  }

  /** Workspace picker: home, source roots, recent parents and repos that aren't workspaces yet. */
  suggestDirs(machineId?: string | null): Promise<MethodResult<'fs.suggest'>> {
    return this.client.request('fs.suggest', this.target(machineId));
  }

  async removeWorkspace(workspaceId: string): Promise<void> {
    await this.client.request('workspace.remove', { workspaceId });
    if (!this.state.workspaces) return;
    this.patch({ workspaces: withoutKey(this.state.workspaces, workspaceId) });
  }

  /** Rename a workspace or set its identity color and icon (spec §11.1; `''` clears); `workspace.updated` follows. */
  async setWorkspace(params: MethodParams<'workspace.set'>): Promise<WorkspaceInfo> {
    const { workspace } = await this.client.request('workspace.set', params);
    this.patch({ workspaces: { ...this.state.workspaces, [workspace.id]: workspace } });
    return workspace;
  }

  /** `git worktree add` + a workspace of kind 'worktree' under the repo workspace. */
  async createWorktree(params: MethodParams<'worktree.create'>): Promise<WorkspaceInfo> {
    const { workspace } = await this.client.request('worktree.create', params);
    this.patch({ workspaces: { ...this.state.workspaces, [workspace.id]: workspace } });
    return workspace;
  }

  /** Removes the worktree and its workspace (never the branch). Fails with `conflict` on uncommitted changes unless `force`. */
  async removeWorktree(workspaceId: string, force = false): Promise<void> {
    await this.client.request('worktree.remove', force ? { workspaceId, force: true } : { workspaceId });
    if (!this.state.workspaces) return;
    this.patch({ workspaces: withoutKey(this.state.workspaces, workspaceId), gitStatus: withoutKey(this.state.gitStatus, workspaceId) });
  }

  async createSession(params: MethodParams<'session.create'>): Promise<SessionInfo> {
    const { session } = await this.client.request('session.create', params);
    this.upsertSession(session);
    return session;
  }

  async forkSession(sessionId: string, title?: string): Promise<SessionInfo> {
    const { session } = await this.client.request('session.fork', title ? { sessionId, title } : { sessionId });
    this.upsertSession(session);
    return session;
  }

  /** Fork onto another machine through the hub (topology.md §6); the new session lives on `params.toMachineId`. */
  async forkSessionTo(params: MethodParams<'session.forkTo'>): Promise<MethodResult<'session.forkTo'>> {
    const res = await this.client.request('session.forkTo', params);
    this.upsertSession(res.session);
    return res;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.client.request('session.delete', { sessionId });
    this.dropSession(sessionId);
  }

  private dropSession(sessionId: string): void {
    const wasOpen = this.opened.delete(sessionId);
    if (wasOpen) this.client.unsubscribe(sessionChannel(sessionId)).catch(() => {});
    this.client.resetChannel(sessionChannel(sessionId));
    this.terminal.clear(sessionId);
    const s = this.state;
    if (!(sessionId in s.sessions) && !(sessionId in s.timelines)) return;
    this.patch({
      sessions: withoutKey(s.sessions, sessionId),
      timelines: withoutKey(s.timelines, sessionId),
      capabilities: withoutKey(s.capabilities, sessionId),
    });
  }

  /**
   * Subscribe to a session's channel (replay + live) and fetch its capabilities. Idempotent.
   * Terminal sessions joined late start from `term.snapshot` and subscribe from its seq, instead of
   * replaying every output chunk since the session started.
   */
  async openSession(sessionId: string): Promise<void> {
    if (this.opened.has(sessionId)) return;
    this.opened.add(sessionId);
    if (!this.state.timelines[sessionId]) this.patchTimeline(sessionId, emptyTimeline(sessionId));
    const ch = sessionChannel(sessionId);
    try {
      const get = this.client.request('session.get', { sessionId }).then(({ session, capabilities }) => {
        this.patch({ capabilities: { ...this.state.capabilities, [sessionId]: capabilities } });
        this.upsertSession(session);
        return session;
      });
      const info = this.state.sessions[sessionId] ?? (await get);
      const fresh = this.client.lastSeq(ch) === 0 && !this.client.isSubscribed(ch);
      const sub = info.mode === 'terminal' && fresh ? this.lateJoinTerminal(sessionId) : this.client.subscribe(ch);
      await Promise.all([sub, get]);
    } catch (e) {
      this.opened.delete(sessionId);
      throw e;
    }
  }

  private async lateJoinTerminal(sessionId: string): Promise<void> {
    const ch = sessionChannel(sessionId);
    let snap: MethodResult<'term.snapshot'>;
    try {
      snap = await this.client.request('term.snapshot', { sessionId });
    } catch (e) {
      // Older nodes: replay the channel from the start instead.
      if (e instanceof BizziError && (e.code === 'unsupported' || e.code === 'bad_request')) return this.client.subscribe(ch);
      throw e;
    }
    this.terminal.clear(sessionId);
    if (snap.dataBase64) this.terminal.write(sessionId, base64ToBytes(snap.dataBase64));
    const tl = this.state.timelines[sessionId] ?? emptyTimeline(sessionId);
    if (tl.lastSeq < snap.seq) this.patchTimeline(sessionId, { ...tl, lastSeq: snap.seq });
    await this.client.subscribe(ch, { since: snap.seq });
  }

  /** Stop receiving live events for a session (its timeline stays cached; reopening resumes from the cursor). */
  async closeSession(sessionId: string): Promise<void> {
    if (!this.opened.delete(sessionId)) return;
    await this.client.unsubscribe(sessionChannel(sessionId));
  }

  isOpen(sessionId: string): boolean {
    return this.opened.has(sessionId);
  }

  send(sessionId: string, input: string | InputBlock[]): Promise<{ turnId: string }> {
    return this.client.request('session.send', { sessionId, input: toInput(input) });
  }

  async steer(sessionId: string, input: string | InputBlock[]): Promise<void> {
    await this.client.request('session.steer', { sessionId, input: toInput(input) });
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.client.request('session.interrupt', { sessionId });
  }

  async stop(sessionId: string): Promise<void> {
    await this.client.request('session.stop', { sessionId });
  }

  /** Reopen an ended session: it takes messages again and keeps its history. */
  async reopenSession(sessionId: string): Promise<SessionInfo> {
    const { session } = await this.client.request('session.reopen', { sessionId });
    this.upsertSession(session);
    return session;
  }

  /** A fresh conversation in the same session (`/clear`): the agent forgets everything so far. */
  async clearSession(sessionId: string): Promise<void> {
    await this.client.request('session.clear', { sessionId });
  }

  /** Restart the agent process on the installed version at the next safe point (updates.md §5). */
  async restartSession(sessionId: string): Promise<void> {
    await this.client.request('session.restart', { sessionId });
  }

  /**
   * Record that the user has seen a session through `seq` (default: everything loaded). Applied locally at
   * once (so "done, not yet seen" clears), sent as `session.markSeen` with at most one request in flight per
   * session. Never moves backwards. Servers without the method keep the local value only.
   */
  markSeen(sessionId: string, seq?: number): void {
    const s = this.state.sessions[sessionId];
    if (!s) return;
    const target = seq ?? Math.max(s.lastSeq, this.state.timelines[sessionId]?.lastSeq ?? 0);
    if (target <= (s.seenThrough ?? 0)) return;
    this.patch({ sessions: { ...this.state.sessions, [sessionId]: { ...s, seenThrough: target } } });
    this.sendSeen(sessionId);
  }

  private sendSeen(sessionId: string): void {
    if (this.seenUnsupported || this.seenInflight.has(sessionId) || !this.client.isOpen()) return;
    const want = this.state.sessions[sessionId]?.seenThrough ?? 0;
    if (want <= (this.seenSent.get(sessionId) ?? 0)) return;
    this.seenInflight.add(sessionId);
    this.seenSent.set(sessionId, want);
    this.client
      .request('session.markSeen', { sessionId, seq: want })
      .then(
        ({ seenThrough }) => {
          const cur = this.state.sessions[sessionId];
          if (cur && seenThrough > (cur.seenThrough ?? 0)) this.patch({ sessions: { ...this.state.sessions, [sessionId]: { ...cur, seenThrough } } });
        },
        (e: unknown) => {
          if (isUnsupported(e)) this.seenUnsupported = true;
          else this.logger.log('debug', 'session.markSeen failed', { sessionId, error: String(e) });
        },
      )
      .finally(() => {
        this.seenInflight.delete(sessionId);
        this.sendSeen(sessionId);
      });
  }

  async setSession(sessionId: string, opts: { model?: string; permissionMode?: string; effort?: string; title?: string }): Promise<SessionInfo> {
    const { session } = await this.client.request('session.set', { sessionId, ...opts });
    this.upsertSession(session);
    return session;
  }

  async respondApproval(sessionId: string, approvalId: string, decision: ApprovalDecision): Promise<void> {
    await this.client.request('approval.respond', { sessionId, approvalId, ...decision });
  }

  /**
   * Answer a `question.asked` with `question.respond` (or decline it with `cancel`). Agents that predate
   * `question.respond` get the answer as user input instead (steer while a turn runs, else a new turn).
   */
  async respondQuestion(sessionId: string, questionId: string, reply: { answers: QuestionAnswers } | { cancel: true }): Promise<void> {
    const params: MethodParams<'question.respond'> = 'cancel' in reply ? { sessionId, questionId, cancel: true } : { sessionId, questionId, answers: reply.answers };
    try {
      await this.client.request('question.respond', params);
    } catch (e) {
      if (!(e instanceof BizziError && e.code === 'unsupported') || 'cancel' in reply) throw e;
      const text = Object.values(reply.answers)
        .map((v) => (Array.isArray(v) ? v.join(', ') : v))
        .filter(Boolean)
        .join('\n');
      await this.answerQuestion(sessionId, text);
    }
  }

  /** Send a free-text answer as user input (legacy question flow). */
  async answerQuestion(sessionId: string, answer: string): Promise<void> {
    const tl = this.state.timelines[sessionId];
    const caps = this.state.capabilities[sessionId];
    if (tl?.activeTurnId && caps?.steer) await this.steer(sessionId, answer);
    else await this.send(sessionId, answer);
  }

  termInput(sessionId: string, data: string): Promise<unknown> {
    return this.client.request('term.input', { sessionId, dataBase64: stringToBase64(data) });
  }

  termResize(sessionId: string, cols: number, rows: number): Promise<unknown> {
    return this.client.request('term.resize', { sessionId, cols, rows });
  }

  // ---------------------------------------------------------------- provisioning

  async planAgent(params: { machineId?: string | null; agent: AgentKind; action: InstallAction; method?: string; version?: string; remedy?: string }): Promise<InstallPlan> {
    const { machineId, ...rest } = params;
    const { plan } = await this.client.request('agent.plan', { ...this.target(machineId), ...rest });
    return plan;
  }

  /** Start an install/update/uninstall; progress lands in `jobs[jobId]`. */
  async installAgent(params: { machineId?: string | null; agent: AgentKind; action: InstallAction; method?: string; version?: string; remedy?: string }): Promise<InstallJob> {
    const { machineId, ...rest } = params;
    const t = this.target(machineId);
    const { jobId, plan } = await this.client.request('agent.install', { ...t, ...rest });
    return this.registerJob(jobId, t.machineId ?? null, params.agent, params.action, plan);
  }

  /**
   * Switch an adopted install to the preferred method (spec §7). `dryRun` only returns the plan; otherwise
   * the job's progress lands in `jobs[jobId]` like an install.
   */
  async migrateAgent(params: { machineId?: string | null; agent: AgentKind; toMethod?: string; dryRun?: boolean }): Promise<{ plan: InstallPlan; job: InstallJob | null }> {
    const { machineId, ...rest } = params;
    const t = this.target(machineId);
    const { jobId, plan } = await this.client.request('agent.migrate', { ...t, ...rest });
    if (params.dryRun) return { plan, job: null };
    return { plan, job: this.registerJob(jobId, t.machineId ?? null, params.agent, 'migrate', plan) };
  }

  /** Update / restart policy for one agent on one machine (updates.md §6). */
  async setAgentPolicy(params: { machineId?: string | null; agent: AgentKind; update?: UpdatePolicy; restart?: RestartPolicy }): Promise<AgentListing> {
    const { machineId, ...rest } = params;
    const t = this.target(machineId);
    const { agent } = await this.client.request('agent.policy.set', { ...t, ...rest });
    const key = t.machineId ?? '';
    const list = this.state.agents[key];
    if (list) this.patch({ agents: { ...this.state.agents, [key]: list.map((a) => (a.agent === agent.agent ? agent : a)) } });
    return agent;
  }

  private registerJob(jobId: string, machineId: string | null, agent: AgentKind, action: JobAction, plan: InstallPlan): InstallJob {
    const now = new Date().toISOString();
    const prev = this.state.jobs[jobId];
    const job: InstallJob = prev
      ? { ...prev, machineId, action, plan }
      : { jobId, machineId, agent, action, plan, stage: 'starting', done: false, log: [], startedAt: now, updatedAt: now };
    this.patch({ jobs: { ...this.state.jobs, [jobId]: job } });
    return job;
  }

  // ---------------------------------------------------------------- orchestration (spec §12.2)

  async getOrchestrationSettings(params: { machineId?: string | null; workspaceId?: string } = {}): Promise<OrchestrationSettings> {
    const t = this.target(params.machineId);
    const { settings } = await this.client.request('orchestration.settings.get', params.workspaceId ? { ...t, workspaceId: params.workspaceId } : t);
    return settings;
  }

  /**
   * Set a machine's tags, description, identity color (knowledge.md §9, spec §11.1) and/or keep-awake
   * setting (spec §8.1); `machine.updated` follows.
   */
  async setMachine(params: { machineId?: string | null; tags?: string[]; description?: string; color?: LabelColor | ''; keepAwake?: Partial<KeepAwakeSettings> }): Promise<MachineInfo> {
    const { machineId, ...rest } = params;
    const { machine } = await this.client.request('machine.set', { ...this.target(machineId), ...rest });
    // Keep the hub's view of presence; only the user fields changed.
    const prev = this.state.machines[machine.id];
    const next: MachineInfo = prev ? { ...prev, tags: machine.tags } : machine;
    if (prev) {
      if (machine.description) next.description = machine.description;
      else delete next.description;
      if (machine.color) next.color = machine.color;
      else delete next.color;
      if (machine.keepAwake) next.keepAwake = machine.keepAwake;
    }
    const p: Partial<BizziState> = { machines: { ...this.state.machines, [machine.id]: next } };
    if (this.state.machine?.id === machine.id) p.machine = next;
    this.patch(p);
    return next;
  }

  async setOrchestrationSettings(params: { machineId?: string | null; workspaceId?: string; settings: Partial<OrchestrationSettings> }): Promise<OrchestrationSettings> {
    const t = this.target(params.machineId);
    const base = params.workspaceId ? { ...t, workspaceId: params.workspaceId } : t;
    const { settings } = await this.client.request('orchestration.settings.set', { ...base, settings: params.settings });
    return settings;
  }

  dismissJob(jobId: string): void {
    this.replayedJobs.delete(jobId);
    if (!(jobId in this.state.jobs)) return;
    this.patch({ jobs: withoutKey(this.state.jobs, jobId) });
  }

  /** Start a login flow; returns its terminal-mode session (watch `timelines[id].login`). */
  async loginAgent(params: MethodParams<'agent.login'>): Promise<SessionInfo> {
    const { session } = await this.client.request('agent.login', { ...this.target(params.machineId), ...params });
    this.upsertSession(session);
    return session;
  }

  async listSecrets(machineId?: string | null, agent?: AgentKind): Promise<SecretInfo[]> {
    const t = this.target(machineId);
    const { secrets } = await this.client.request('agent.secrets', agent ? { ...t, agent } : t);
    return secrets;
  }

  async setSecret(params: { machineId?: string | null; agent: AgentKind; name: string; value: string }): Promise<void> {
    const { machineId, ...rest } = params;
    await this.client.request('agent.setSecret', { ...this.target(machineId), ...rest });
  }

  async deleteSecret(params: { machineId?: string | null; agent: AgentKind; name: string }): Promise<void> {
    const { machineId, ...rest } = params;
    await this.client.request('agent.deleteSecret', { ...this.target(machineId), ...rest });
  }

  // ---------------------------------------------------------------- routing

  /** One-pane mode (spec §11.2): where `text` should run. Through a hub: across every online machine. */
  async suggestRoute(text: string): Promise<RouteSuggestion> {
    const { suggestion } = await this.client.request('route.suggest', { text });
    return suggestion;
  }

  // ---- one-pane mode (spec §11.2): recorded decisions (the labeled eval set) and routing rules

  async recordRoute(decision: RouteDecisionInput): Promise<RouteDecision> {
    const { decision: saved } = await this.client.request('route.record', { decision });
    return saved;
  }

  listRouteDecisions(params: MethodParams<'route.decisions'> = {}): Promise<MethodResult<'route.decisions'>> {
    return this.client.request('route.decisions', params);
  }

  async getRouteRules(): Promise<RoutingRule[]> {
    const { rules } = await this.client.request('route.rules.get', {});
    return rules;
  }

  async setRouteRules(rules: RoutingRule[]): Promise<RoutingRule[]> {
    const { rules: saved } = await this.client.request('route.rules.set', { rules });
    return saved;
  }

  // ---------------------------------------------------------------- knowledge

  async listKnowledge(params: Omit<MethodParams<'knowledge.list'>, 'machineId'> = {}): Promise<KnowledgeItemInfo[]> {
    const { items } = await this.client.request('knowledge.list', { ...this.knowledgeTarget(), ...params });
    return items;
  }

  async addKnowledge(params: Omit<MethodParams<'knowledge.add'>, 'machineId'>): Promise<KnowledgeItemInfo> {
    const { item } = await this.client.request('knowledge.add', { ...this.knowledgeTarget(), ...params });
    this.patch({ knowledgeRev: this.state.knowledgeRev + 1 });
    return item;
  }

  async updateKnowledge(params: Omit<MethodParams<'knowledge.update'>, 'machineId'>): Promise<KnowledgeItemInfo> {
    const { item } = await this.client.request('knowledge.update', { ...this.knowledgeTarget(), ...params });
    this.patch({ knowledgeRev: this.state.knowledgeRev + 1 });
    return item;
  }

  async forgetKnowledge(id: string): Promise<void> {
    await this.client.request('knowledge.forget', { ...this.knowledgeTarget(), id });
    this.patch({ knowledgeRev: this.state.knowledgeRev + 1 });
  }

  /** Accept suggestions (optionally moving them all to `scope`). Updates the inbox optimistically. */
  async acceptKnowledge(ids: string[], scope?: KnowledgeScope): Promise<void> {
    await this.client.request('knowledge.accept', scope ? { ...this.knowledgeTarget(), ids, scope } : { ...this.knowledgeTarget(), ids });
    this.removeFromInbox(ids);
  }

  async rejectKnowledge(ids: string[]): Promise<void> {
    await this.client.request('knowledge.reject', { ...this.knowledgeTarget(), ids });
    this.removeFromInbox(ids);
  }

  private removeFromInbox(ids: string[]): void {
    const inbox = this.state.knowledgeInbox;
    if (!inbox) return;
    const drop = new Set(ids);
    const next = inbox.map((c) => ({ ...c, items: c.items.filter((i) => !drop.has(i.id)) })).filter((c) => c.items.length > 0);
    this.patch({ knowledgeInbox: next, knowledgeRev: this.state.knowledgeRev + 1 });
  }

  async setKnowledgeSettings(settings: Partial<KnowledgeSettings>): Promise<KnowledgeSettings> {
    const res = await this.client.request('knowledge.settings.set', { ...this.knowledgeTarget(), settings });
    this.patch({ knowledgeSettings: res.settings });
    return res.settings;
  }

  // ---- knowledge: Add to AGENTS.md (knowledge.md §8). Runs on the workspace's machine (it writes the file there).

  /** The workspace's machine when known; otherwise nothing, and a hub routes the call by `workspaceId`. */
  private workspaceTarget(workspaceId: string): MachineTarget {
    const machineId = this.state.workspaces?.[workspaceId]?.machineId;
    return machineId ? { machineId } : {};
  }

  async previewPromotion(params: { workspaceId: string; ids: string[]; heading?: string }): Promise<KnowledgePromotePreview> {
    const { preview } = await this.client.request('knowledge.promote.preview', { ...this.workspaceTarget(params.workspaceId), ...params });
    return preview;
  }

  async promoteKnowledge(params: { workspaceId: string; ids: string[]; heading?: string; baseHash?: string }): Promise<MethodResult<'knowledge.promote'>> {
    const res = await this.client.request('knowledge.promote', { ...this.workspaceTarget(params.workspaceId), ...params });
    this.patch({ knowledgeRev: this.state.knowledgeRev + 1 });
    return res;
  }

  // ---------------------------------------------------------------- hub: devices

  async createPairing(kind: DeviceKind, name?: string): Promise<MethodResult<'pairing.create'>> {
    return this.client.request('pairing.create', name ? { kind, name } : { kind });
  }

  async revokeDevice(deviceId: string): Promise<void> {
    await this.client.request('device.revoke', { deviceId });
    const d = this.state.devices?.[deviceId];
    if (d) this.patch({ devices: { ...this.state.devices, [deviceId]: { ...d, revoked: true } } });
  }
}

function isUnsupported(e: unknown): boolean {
  return e instanceof BizziError && e.code === 'unsupported';
}

function mergeLists(a: readonly string[], b: readonly string[]): string[] {
  const out = [...a];
  for (const x of b) if (!out.includes(x)) out.push(x);
  return out;
}

/** A fresh copy of a session from the server never moves `seenThrough` backwards. */
function keepSeen(prev: SessionInfo | undefined, next: SessionInfo): SessionInfo {
  const p = prev?.seenThrough;
  if (p === undefined || (next.seenThrough !== undefined && next.seenThrough >= p)) return next;
  return { ...next, seenThrough: p };
}

function toInput(input: string | InputBlock[]): InputBlock[] {
  if (typeof input === 'string') {
    if (!input.trim()) throw new BizziError('bad_request', 'empty input');
    return [{ type: 'text', text: input }];
  }
  return input;
}

// ---------------------------------------------------------------- selectors

export interface InboxEntry {
  sessionId: string;
  item: ApprovalItem | QuestionItem;
}

/** Pending approvals and questions across every watched session, oldest first. */
export function selectInbox(s: BizziState): InboxEntry[] {
  const out: InboxEntry[] = [];
  for (const [sessionId, tl] of Object.entries(s.timelines)) {
    for (const id of tl.pendingApprovals) {
      const item = tl.items[`ap:${id}`];
      if (item && item.kind === 'approval') out.push({ sessionId, item });
    }
    for (const id of tl.pendingQuestions) {
      const item = tl.items[`q:${id}`];
      if (item && item.kind === 'question') out.push({ sessionId, item });
    }
  }
  out.sort((a, b) => (a.item.ts < b.item.ts ? -1 : a.item.ts > b.item.ts ? 1 : 0));
  return out;
}

export function inboxEqual(a: InboxEntry[], b: InboxEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i]?.item !== b[i]?.item) return false;
  return true;
}

/** Number of suggested knowledge items waiting for a decision (live changes with an undo don't count). */
export function selectKnowledgeSuggestionCount(s: BizziState): number {
  let n = 0;
  for (const c of s.knowledgeInbox ?? []) for (const i of c.items) if (i.status === 'suggested') n++;
  return n;
}

/** Number of knowledge changes that are already live (or forgotten) and can still be undone. */
export function selectKnowledgeNoticeCount(s: BizziState): number {
  let n = 0;
  for (const c of s.knowledgeInbox ?? []) for (const i of c.items) if (i.status !== 'suggested') n++;
  return n;
}

/** Best-known status: the session's own channel when watched, else the list. */
export function selectSessionStatus(s: BizziState, sessionId: string): SessionInfo['status'] | null {
  return s.timelines[sessionId]?.status ?? s.sessions[sessionId]?.status ?? null;
}

/** What a waiting session waits on, when known. */
export function selectSessionPrompt(s: BizziState, sessionId: string): SessionPrompt | null {
  const tl = s.timelines[sessionId];
  if (tl?.prompt) return tl.prompt;
  const st = selectSessionStatus(s, sessionId);
  return st === 'waiting_approval' ? 'approval' : st === 'waiting_input' ? 'input' : null;
}

export function selectWorkspaceSessions(s: BizziState, workspaceId: string): SessionInfo[] {
  return Object.values(s.sessions)
    .filter((x) => x.workspaceId === workspaceId)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

/** The machine machine-targeted calls default to. */
export function selectTargetMachineId(s: BizziState): string | null {
  return s.selectedMachineId ?? s.machine?.id ?? null;
}

export function selectAgents(s: BizziState, machineId: string | null): readonly AgentListing[] | null {
  if (!machineId) return null;
  return s.agents[machineId] ?? null;
}

/** Whether requests to a machine can reach it right now. */
export function selectMachineOnline(s: BizziState, machineId: string | null | undefined): boolean {
  if (!machineId) return s.connection.state === 'open';
  if (s.connection.state !== 'open') return false;
  if (s.role !== 'hub') return machineId === s.machine?.id;
  return s.machines[machineId]?.online ?? false;
}

/** Machines in the switcher: every node behind a hub, or the node itself first then the others it knows. */
export function selectMachineList(s: BizziState): MachineInfo[] {
  const all = Object.values(s.machines).filter((m) => s.role !== 'hub' || m.roles.includes('node') || !m.roles.includes('hub'));
  if (s.role !== 'hub' && s.machine && !s.machines[s.machine.id]) all.push(s.machine);
  return all.sort((a, b) => (a.id === s.machine?.id ? -1 : b.id === s.machine?.id ? 1 : a.online === b.online ? a.name.localeCompare(b.name) : a.online ? -1 : 1));
}

/** The most recent job for an agent on a machine (jobs started elsewhere match any machine). */
export function selectAgentJob(s: BizziState, machineId: string | null, agent: AgentKind): InstallJob | null {
  let best: InstallJob | null = null;
  for (const j of Object.values(s.jobs)) {
    if (j.agent !== agent || j.tool !== undefined) continue;
    if (j.machineId !== null && j.machineId !== machineId) continue;
    if (!best || j.startedAt > best.startedAt) best = j;
  }
  return best;
}

export function selectAgentList(s: BizziState, machineId: string | null): readonly AgentListing[] {
  return (machineId && s.agents[machineId]) || EMPTY_AGENTS;
}
