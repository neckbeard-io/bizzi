import { BizziError, GLOBAL_CHANNEL, parseChannel, sessionChannel } from '@bizzi/protocol';
import type {
  AgentCapabilities,
  AgentKind,
  AgentListing,
  ApprovalDecision,
  ChannelEvent,
  GlobalEvent,
  InputBlock,
  Logger,
  MachineInfo,
  MethodParams,
  SessionEvent,
  SessionInfo,
  WorkspaceInfo,
} from '@bizzi/protocol';
import { base64ToBytes, stringToBase64 } from './base64.ts';
import type { BizziClient, ConnectionInfo, GapInfo } from './client.ts';
import { createFrameScheduler } from './scheduler.ts';
import type { FrameScheduler } from './scheduler.ts';
import { TerminalStreams } from './terminal.ts';
import { emptyTimeline, reduceTimeline } from './timeline.ts';
import type { ApprovalItem, QuestionItem, Timeline } from './timeline.ts';

export interface InstallProgress {
  agent: AgentKind;
  stage: string;
  message?: string;
  done?: boolean;
  ok?: boolean;
}

export interface BizziState {
  /** Incremented on every change; cheap staleness check for memoized selectors. */
  version: number;
  connection: ConnectionInfo;
  /** The machine this connection is attached to (from `hello`). */
  machine: MachineInfo | null;
  machines: Readonly<Record<string, MachineInfo>>;
  /** null until loaded. */
  agents: readonly AgentListing[] | null;
  /** null until loaded. */
  workspaces: Readonly<Record<string, WorkspaceInfo>> | null;
  sessions: Readonly<Record<string, SessionInfo>>;
  sessionsLoaded: boolean;
  /** Per session, from `session.get`. */
  capabilities: Readonly<Record<string, AgentCapabilities>>;
  timelines: Readonly<Record<string, Timeline>>;
  install: Readonly<Partial<Record<AgentKind, InstallProgress>>>;
  /** Last gap per channel (shown as "some events may be missing"). */
  gaps: Readonly<Record<string, GapInfo>>;
}

export interface BizziStoreOptions {
  scheduler?: FrameScheduler;
  terminal?: TerminalStreams;
  logger?: Logger;
  /** Load machines/agents/workspaces/sessions after every handshake (default true). */
  autoLoad?: boolean;
  /** Subscribe to sessions that wait for an approval or input, so the inbox has details (default true). */
  watchAttention?: boolean;
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

/**
 * Normalized client state built from list calls and channel events. Events are buffered and applied
 * at most once per animation frame; subscribers are notified once per flush. Framework-agnostic:
 * `subscribe` + `getState` plug straight into React's `useSyncExternalStore`.
 */
export class BizziStore {
  readonly client: BizziClient;
  readonly terminal: TerminalStreams;
  private readonly scheduler: FrameScheduler;
  private readonly logger: Logger;
  private readonly autoLoad: boolean;
  private readonly watchAttention: boolean;
  private state: BizziState;
  private readonly listeners = new Set<Listener>();
  private buffer: ChannelEvent[] = [];
  private cancelFlush: (() => void) | null = null;
  private notifyPending = false;
  private readonly opened = new Set<string>();
  private readonly unsubs: (() => void)[] = [];

  /** Number of notifications sent (handy for perf tests). */
  notifications = 0;

  constructor(client: BizziClient, options: BizziStoreOptions = {}) {
    this.client = client;
    this.scheduler = options.scheduler ?? createFrameScheduler();
    this.terminal = options.terminal ?? new TerminalStreams();
    this.logger = options.logger ?? noopLogger;
    this.autoLoad = options.autoLoad ?? true;
    this.watchAttention = options.watchAttention ?? true;
    this.state = {
      version: 0,
      connection: client.getConnection(),
      machine: null,
      machines: {},
      agents: null,
      workspaces: null,
      sessions: {},
      sessionsLoaded: false,
      capabilities: {},
      timelines: {},
      install: {},
      gaps: {},
    };
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
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.cancelFlush?.();
    this.cancelFlush = null;
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
    this.patch({ sessions: { ...this.state.sessions, [s.id]: s } });
    this.maybeWatch(s);
  }

  private maybeWatch(s: SessionInfo): void {
    if (this.watchAttention && ATTENTION.has(s.status) && !this.opened.has(s.id)) {
      this.openSession(s.id).catch((e) => this.logger.log('warn', 'watch session failed', { sessionId: s.id, error: String(e) }));
    }
  }

  // ---------------------------------------------------------------- inbound

  private onConnection(c: ConnectionInfo): void {
    const p: Partial<BizziState> = { connection: c };
    if (c.machine && c.machine !== this.state.machine) p.machine = c.machine;
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
        const p: Partial<BizziState> = { machines: { ...this.state.machines, [m.id]: m } };
        if (this.state.machine?.id === m.id) p.machine = m;
        this.patch(p);
        return;
      }
      case 'workspace.created':
        this.patch({ workspaces: { ...this.state.workspaces, [ev.data.workspace.id]: ev.data.workspace } });
        return;
      case 'workspace.removed': {
        if (!this.state.workspaces) return;
        const ws = { ...this.state.workspaces };
        delete ws[ev.data.workspaceId];
        this.patch({ workspaces: ws });
        return;
      }
      case 'session.created':
      case 'session.updated':
        this.upsertSession(ev.data.session);
        return;
      case 'install.progress':
        this.patch({ install: { ...this.state.install, [ev.data.agent]: ev.data } });
        return;
    }
  }

  // ---------------------------------------------------------------- loading

  async loadAll(): Promise<void> {
    const tasks = [this.loadMachines(), this.loadAgents(), this.loadWorkspaces(), this.loadSessions()];
    const results = await Promise.allSettled(tasks);
    for (const r of results) {
      if (r.status === 'rejected') this.logger.log('warn', 'initial load failed', { error: String(r.reason) });
    }
  }

  async loadMachines(): Promise<void> {
    const { machines } = await this.client.request('machines.list', {});
    const rec: Record<string, MachineInfo> = {};
    for (const m of machines) rec[m.id] = m;
    const p: Partial<BizziState> = { machines: rec };
    const self = this.state.machine && rec[this.state.machine.id];
    if (self) p.machine = self;
    this.patch(p);
  }

  async loadAgents(refresh = false): Promise<void> {
    const { agents } = await this.client.request('agents.list', refresh ? { refresh: true } : {}, refresh ? { timeoutMs: 60_000 } : {});
    this.patch({ agents });
  }

  async loadWorkspaces(): Promise<void> {
    const { workspaces } = await this.client.request('workspaces.list', {});
    const rec: Record<string, WorkspaceInfo> = {};
    for (const w of workspaces) rec[w.id] = w;
    this.patch({ workspaces: rec });
  }

  async loadSessions(workspaceId?: string): Promise<void> {
    const { sessions } = await this.client.request('sessions.list', workspaceId ? { workspaceId } : {});
    const rec: Record<string, SessionInfo> = workspaceId ? { ...this.state.sessions } : {};
    for (const s of sessions) rec[s.id] = s;
    this.patch(workspaceId ? { sessions: rec } : { sessions: rec, sessionsLoaded: true });
    for (const s of sessions) this.maybeWatch(s);
  }

  // ---------------------------------------------------------------- actions

  async createWorkspace(params: MethodParams<'workspace.create'>): Promise<WorkspaceInfo> {
    const { workspace } = await this.client.request('workspace.create', params);
    this.patch({ workspaces: { ...this.state.workspaces, [workspace.id]: workspace } });
    return workspace;
  }

  async removeWorkspace(workspaceId: string): Promise<void> {
    await this.client.request('workspace.remove', { workspaceId });
    if (!this.state.workspaces) return;
    const ws = { ...this.state.workspaces };
    delete ws[workspaceId];
    this.patch({ workspaces: ws });
  }

  async createSession(params: MethodParams<'session.create'>): Promise<SessionInfo> {
    const { session } = await this.client.request('session.create', params);
    this.upsertSession(session);
    return session;
  }

  /** Subscribe to a session's channel (replay + live) and fetch its capabilities. Idempotent. */
  async openSession(sessionId: string): Promise<void> {
    if (!this.opened.has(sessionId)) {
      this.opened.add(sessionId);
      if (!this.state.timelines[sessionId]) this.patchTimeline(sessionId, emptyTimeline(sessionId));
      const sub = this.client.subscribe(sessionChannel(sessionId));
      const get = this.client.request('session.get', { sessionId }).then(({ session, capabilities }) => {
        this.patch({ capabilities: { ...this.state.capabilities, [sessionId]: capabilities } });
        this.upsertSession(session);
      });
      try {
        await Promise.all([sub, get]);
      } catch (e) {
        this.opened.delete(sessionId);
        throw e;
      }
    }
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

  async setSession(sessionId: string, opts: { model?: string; permissionMode?: string; effort?: string }): Promise<SessionInfo> {
    const { session } = await this.client.request('session.set', { sessionId, ...opts });
    this.upsertSession(session);
    return session;
  }

  async respondApproval(sessionId: string, approvalId: string, decision: ApprovalDecision): Promise<void> {
    await this.client.request('approval.respond', { sessionId, approvalId, ...decision });
  }

  /**
   * Answer a `question.asked`. The protocol has no dedicated method yet, so the answer is sent as user
   * input (steer while a turn runs, otherwise a new turn).
   */
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

/** Best-known status: the session's own channel when watched, else the list. */
export function selectSessionStatus(s: BizziState, sessionId: string): SessionInfo['status'] | null {
  return s.timelines[sessionId]?.status ?? s.sessions[sessionId]?.status ?? null;
}

export function selectWorkspaceSessions(s: BizziState, workspaceId: string): SessionInfo[] {
  return Object.values(s.sessions)
    .filter((x) => x.workspaceId === workspaceId)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}
