// Session manager: adapter lifecycle, turn bookkeeping, status derivation, approvals, restart recovery.

import {
  AGENT_KINDS,
  BizziError,
  GLOBAL_CHANNEL,
  NO_CAPABILITIES,
  newId,
  sessionChannel,
  type AdapterSession,
  type AgentAdapter,
  type AgentCapabilities,
  type ApprovalDecision,
  type ApprovalDecisionKind,
  type ApprovalRequest,
  type InputBlock,
  type Logger,
  type MethodParams,
  type SessionEventBody,
  type SessionInfo,
  type SessionStatus,
  type StartSessionOptions,
  type WorkspaceInfo,
} from '@bizzi/protocol';
import type { AdapterRegistry } from './agents.ts';
import type { EventBus } from './bus.ts';
import type { SessionState, Store } from './store.ts';
import type { Workspaces } from './workspaces.ts';

/** Extra start options contributed by the host (knowledge injection, env, …). */
export type PrepareStart = (
  session: SessionInfo,
  workspace: WorkspaceInfo,
) =>
  | Partial<Pick<StartSessionOptions, 'env' | 'mcpServers' | 'systemPromptAppend'>>
  | Promise<Partial<Pick<StartSessionOptions, 'env' | 'mcpServers' | 'systemPromptAppend'>>>;

export interface SessionsDeps {
  store: Store;
  bus: EventBus;
  workspaces: Workspaces;
  registry: AdapterRegistry;
  machineId: string;
  logger: Logger;
  prepareStart?: PrepareStart;
  /** How long to wait for an adapter to confirm an interrupt before the core completes the turn itself. */
  interruptGraceMs?: number;
}

const TERMINAL_STATUSES: readonly SessionStatus[] = ['ended', 'failed'];
const DECISIONS: readonly ApprovalDecisionKind[] = ['allow', 'allow_always', 'deny'];
const STOP_TIMEOUT_MS = 10_000;

interface Runtime {
  info: SessionInfo;
  state: SessionState & { cols?: number; rows?: number };
  adapter?: AgentAdapter;
  handle?: AdapterSession;
  starting?: Promise<AdapterSession>;
  /** Bumped whenever the adapter session is replaced or stopped; stale emits are dropped. */
  generation: number;
  /** A send() has reserved a turn but not yet emitted turn.started (adapter still starting). */
  reservedTurn?: string;
  stopping: boolean;
  pendingApprovals: Map<string, ApprovalRequest>;
  responding: Set<string>;
  interruptTimer?: NodeJS.Timeout;
}

export class Sessions {
  readonly #d: SessionsDeps;
  readonly #log: Logger;
  readonly #byId = new Map<string, Runtime>();
  #draining = false;
  #closed = false;

  constructor(deps: SessionsDeps) {
    this.#d = deps;
    this.#log = deps.logger.child({ component: 'sessions' });
  }

  // --- restart recovery ---------------------------------------------------------------------------

  /** Load persisted sessions. Active ones become idle (resumable) or ended. */
  load(): void {
    for (const row of this.#d.store.listSessions()) {
      const rt: Runtime = {
        info: row.info,
        state: row.state,
        adapter: this.#d.registry.select(row.info.agent, row.info.mode),
        generation: 0,
        stopping: false,
        pendingApprovals: new Map(),
        responding: new Set(),
      };
      rt.info.lastSeq = this.#d.bus.lastSeq(sessionChannel(rt.info.id));
      this.#byId.set(rt.info.id, rt);
      if (TERMINAL_STATUSES.includes(rt.info.status)) continue;

      const turnId = rt.state.currentTurnId;
      if (turnId) {
        this.#append(rt, {
          type: 'turn.completed',
          data: { turnId, stopReason: 'interrupted', error: 'node restarted' },
        });
      }
      const caps = this.#caps(rt);
      const resumable = Boolean(rt.adapter && caps.resumeAfterNodeRestart && rt.info.agentSessionRef);
      const status: SessionStatus = resumable ? 'idle' : 'ended';
      if (rt.info.status !== status) {
        this.#append(rt, {
          type: 'session.status',
          data: { status, reason: resumable ? 'node restarted' : 'node restarted; session cannot be resumed' },
        });
      }
    }
  }

  // --- queries --------------------------------------------------------------------------------------

  list(workspaceId?: string): SessionInfo[] {
    const out: SessionInfo[] = [];
    for (const rt of this.#byId.values()) {
      if (workspaceId === undefined || rt.info.workspaceId === workspaceId) out.push({ ...rt.info });
    }
    return out;
  }

  get(id: string): { session: SessionInfo; capabilities: AgentCapabilities } {
    const rt = this.#get(id);
    return { session: { ...rt.info }, capabilities: this.#caps(rt) };
  }

  has(id: string): boolean {
    return this.#byId.has(id);
  }

  /** Sessions with a turn in flight (or being started). */
  activeTurns(): number {
    let n = 0;
    for (const rt of this.#byId.values()) if (rt.state.currentTurnId || rt.reservedTurn) n++;
    return n;
  }

  // --- lifecycle --------------------------------------------------------------------------------------

  async create(p: MethodParams<'session.create'>): Promise<SessionInfo> {
    this.#assertAccepting();
    const ws = this.#d.workspaces.get(p.workspaceId);
    if (!AGENT_KINDS.includes(p.agent)) throw new BizziError('bad_request', `unknown agent ${String(p.agent)}`);
    const mode = p.mode ?? this.#d.registry.defaultMode(p.agent);
    const adapter = mode && this.#d.registry.select(p.agent, mode);
    if (!mode || !adapter) {
      throw new BizziError('agent_unavailable', `no adapter for ${p.agent}${p.mode ? ` in ${p.mode} mode` : ''}`);
    }
    const now = new Date().toISOString();
    const info: SessionInfo = {
      id: newId('s'),
      machineId: this.#d.machineId,
      workspaceId: ws.id,
      agent: p.agent,
      mode,
      status: 'starting',
      createdAt: now,
      updatedAt: now,
      lastSeq: 0,
    };
    if (p.title) info.title = p.title;
    if (p.model) info.model = p.model;
    if (p.permissionMode) info.permissionMode = p.permissionMode;
    if (p.effort) info.effort = p.effort;
    if (p.resumeRef) info.agentSessionRef = p.resumeRef;
    const rt: Runtime = {
      info,
      state: {},
      adapter,
      generation: 0,
      stopping: false,
      pendingApprovals: new Map(),
      responding: new Set(),
    };
    if (p.cols) rt.state.cols = p.cols;
    if (p.rows) rt.state.rows = p.rows;
    this.#byId.set(info.id, rt);
    this.#persist(rt);
    this.#d.bus.append(GLOBAL_CHANNEL, { type: 'session.created', data: { session: { ...info } } });

    // Start in the background; the session is 'starting' until the adapter is up.
    this.#ensureStarted(rt, p.resumeRef).then(
      () => {
        if (rt.info.status === 'starting') this.#append(rt, { type: 'session.status', data: { status: 'idle' } });
      },
      () => {
        // #ensureStarted already recorded the failure on the session channel.
      },
    );
    return { ...info };
  }

  async send(id: string, input: InputBlock[]): Promise<{ turnId: string }> {
    const rt = this.#get(id);
    validateInput(input);
    this.#assertAccepting();
    this.#assertOpen(rt);
    if (rt.state.currentTurnId || rt.reservedTurn) {
      throw new BizziError('conflict', 'a turn is already in progress (use session.steer or session.interrupt)');
    }
    const turnId = newId('t');
    rt.reservedTurn = turnId;
    let handle: AdapterSession;
    try {
      handle = await this.#ensureStarted(rt, this.#caps(rt).resume ? rt.info.agentSessionRef : undefined);
      this.#assertOpen(rt);
    } finally {
      rt.reservedTurn = undefined;
    }
    this.#append(rt, { type: 'turn.started', data: { turnId, input } });
    try {
      await handle.send(turnId, input);
    } catch (err) {
      this.#log.log('warn', 'adapter send failed', { sessionId: id, turnId, err });
      if (rt.state.currentTurnId === turnId) {
        this.#append(rt, {
          type: 'turn.completed',
          data: { turnId, stopReason: 'error', error: errorMessage(err) },
        });
      }
      throw toBizziError(err, 'internal');
    }
    return { turnId };
  }

  async steer(id: string, input: InputBlock[]): Promise<void> {
    const rt = this.#get(id);
    validateInput(input);
    this.#assertOpen(rt);
    if (!this.#caps(rt).steer || !rt.handle?.steer) throw new BizziError('unsupported', 'this agent does not support steering');
    if (!rt.state.currentTurnId) throw new BizziError('conflict', 'no turn in progress; use session.send');
    await rt.handle.steer(input).catch((err: unknown) => {
      throw toBizziError(err, 'internal');
    });
  }

  async interrupt(id: string): Promise<void> {
    const rt = this.#get(id);
    const turnId = rt.state.currentTurnId;
    if (!turnId) return;
    if (!rt.handle) {
      this.#append(rt, { type: 'turn.completed', data: { turnId, stopReason: 'interrupted' } });
      return;
    }
    if (!this.#caps(rt).interrupt) throw new BizziError('unsupported', 'this agent does not support interrupt');
    await rt.handle.interrupt().catch((err: unknown) => {
      throw toBizziError(err, 'internal');
    });
    // Safety net: the adapter must emit turn.completed; if it doesn't, close the turn ourselves.
    clearTimeout(rt.interruptTimer);
    rt.interruptTimer = setTimeout(() => {
      rt.interruptTimer = undefined;
      if (rt.state.currentTurnId === turnId && !this.#closed) {
        this.#log.log('warn', 'adapter did not complete interrupted turn', { sessionId: id, turnId });
        this.#append(rt, {
          type: 'turn.completed',
          data: { turnId, stopReason: 'interrupted', error: 'adapter did not confirm the interrupt' },
        });
      }
    }, this.#d.interruptGraceMs ?? 15_000);
    rt.interruptTimer.unref();
  }

  async stop(id: string): Promise<void> {
    const rt = this.#get(id);
    if (rt.info.status === 'ended' || rt.stopping) return;
    rt.stopping = true;
    try {
      await this.#stopHandle(rt);
      this.#closeOpenTurn(rt, 'interrupted', 'session stopped');
      this.#append(rt, { type: 'session.status', data: { status: 'ended', reason: 'stopped' } });
    } finally {
      rt.stopping = false;
    }
  }

  async set(p: MethodParams<'session.set'>): Promise<SessionInfo> {
    const rt = this.#get(p.sessionId);
    this.#assertOpen(rt);
    const opts: { model?: string; permissionMode?: string; effort?: string } = {};
    if (p.model !== undefined) opts.model = p.model;
    if (p.permissionMode !== undefined) opts.permissionMode = p.permissionMode;
    if (p.effort !== undefined) opts.effort = p.effort;
    if (Object.keys(opts).length === 0) return { ...rt.info };

    const caps = this.#caps(rt);
    if (rt.handle) {
      if (!rt.handle.set) throw new BizziError('unsupported', 'this agent cannot change settings mid-session');
      if (opts.model !== undefined && !caps.setModelMidSession) {
        throw new BizziError('unsupported', 'this agent cannot switch models mid-session');
      }
      await rt.handle.set(opts).catch((err: unknown) => {
        throw toBizziError(err, 'internal');
      });
    }
    // Not running: recorded now, applied on the next (lazy) start.
    let changed = false;
    for (const k of ['model', 'permissionMode', 'effort'] as const) {
      const v = opts[k];
      if (v !== undefined && rt.info[k] !== v) {
        rt.info[k] = v;
        changed = true;
      }
    }
    if (changed) this.#changed(rt, new Date().toISOString());
    return { ...rt.info };
  }

  async respondApproval(p: MethodParams<'approval.respond'>): Promise<void> {
    const rt = this.#get(p.sessionId);
    const req = rt.pendingApprovals.get(p.approvalId);
    if (!req) throw new BizziError('not_found', `no pending approval ${p.approvalId}`);
    if (!DECISIONS.includes(p.decision)) throw new BizziError('bad_request', `invalid decision ${String(p.decision)}`);
    if (req.options.length > 0 && !req.options.includes(p.decision)) {
      throw new BizziError('bad_request', `decision ${p.decision} is not offered (${req.options.join(', ')})`);
    }
    if (p.editedInput !== undefined && !req.editable) {
      throw new BizziError('bad_request', 'this approval does not accept edited input');
    }
    if (p.message !== undefined && typeof p.message !== 'string') throw new BizziError('bad_request', 'message must be a string');
    if (rt.responding.has(p.approvalId)) throw new BizziError('conflict', 'approval is already being answered');
    if (!rt.handle) throw new BizziError('conflict', 'the agent is not running');
    const decision: ApprovalDecision = { decision: p.decision };
    if (p.message !== undefined) decision.message = p.message;
    if (p.editedInput !== undefined) decision.editedInput = p.editedInput;
    rt.responding.add(p.approvalId);
    try {
      await rt.handle.respondApproval(p.approvalId, decision);
    } catch (err) {
      rt.responding.delete(p.approvalId);
      throw toBizziError(err, 'internal');
    }
  }

  termInput(id: string, data: Uint8Array): void {
    const h = this.#terminalHandle(id);
    if (!h.writeTerminal) throw new BizziError('unsupported', 'terminal input is not supported');
    h.writeTerminal(data);
  }

  termResize(id: string, cols: number, rows: number): void {
    const rt = this.#get(id);
    const h = this.#terminalHandle(id);
    if (!h.resizeTerminal) throw new BizziError('unsupported', 'terminal resize is not supported');
    h.resizeTerminal(cols, rows);
    rt.state.cols = cols;
    rt.state.rows = rows;
    this.#persist(rt);
  }

  /** Non-ended sessions of a workspace that are busy (turn in flight, starting, waiting). */
  busyInWorkspace(workspaceId: string): SessionInfo[] {
    return this.list(workspaceId).filter((s) => {
      const rt = this.#byId.get(s.id)!;
      return Boolean(rt.state.currentTurnId || rt.reservedTurn || rt.starting);
    });
  }

  // --- drain / shutdown -------------------------------------------------------------------------------

  /** Stop accepting new sessions and turns. */
  beginDrain(): void {
    this.#draining = true;
  }

  get draining(): boolean {
    return this.#draining;
  }

  /** Resolves true when no turn is in flight, false on timeout. */
  async waitForTurns(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.activeTurns() > 0) {
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, Math.min(100, Math.max(1, deadline - Date.now()))));
    }
    return true;
  }

  /** Stop every adapter session. Session status is left as-is so a restart can resume them. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#draining = true;
    await Promise.all([...this.#byId.values()].map((rt) => this.#stopHandle(rt)));
    for (const rt of this.#byId.values()) {
      clearTimeout(rt.interruptTimer);
      this.#closeOpenTurn(rt, 'interrupted', 'node shutting down');
    }
    this.#closed = true;
  }

  // --- internals -------------------------------------------------------------------------------------

  #get(id: string): Runtime {
    if (typeof id !== 'string') throw new BizziError('bad_request', 'sessionId must be a string');
    const rt = this.#byId.get(id);
    if (!rt) throw new BizziError('not_found', `session ${id} not found`);
    return rt;
  }

  #caps(rt: Runtime): AgentCapabilities {
    if (!rt.adapter) return NO_CAPABILITIES;
    try {
      return rt.adapter.capabilities(rt.info.mode);
    } catch {
      return NO_CAPABILITIES;
    }
  }

  #assertAccepting(): void {
    if (this.#draining) throw new BizziError('conflict', 'node is shutting down; not accepting new turns');
  }

  #assertOpen(rt: Runtime): void {
    if (rt.info.status === 'ended' || rt.stopping) throw new BizziError('conflict', 'session has ended');
  }

  #terminalHandle(id: string): AdapterSession {
    const rt = this.#get(id);
    if (rt.info.mode !== 'terminal') throw new BizziError('unsupported', 'not a terminal-mode session');
    if (!rt.handle) throw new BizziError('conflict', 'the terminal is not running');
    return rt.handle;
  }

  #ensureStarted(rt: Runtime, resumeRef: string | undefined): Promise<AdapterSession> {
    if (rt.handle) return Promise.resolve(rt.handle);
    if (rt.starting) return rt.starting;
    const adapter = rt.adapter;
    if (!adapter) {
      return Promise.reject(new BizziError('agent_unavailable', `no adapter for ${rt.info.agent} in ${rt.info.mode} mode`));
    }
    const gen = ++rt.generation;
    const sessionId = rt.info.id;
    const logger = this.#d.logger.child({ sessionId, agent: rt.info.agent });

    const start = async (): Promise<AdapterSession> => {
      const ws = this.#d.workspaces.get(rt.info.workspaceId);
      const extra = this.#d.prepareStart ? await this.#d.prepareStart({ ...rt.info }, ws) : {};
      const opts: StartSessionOptions = { ...extra, sessionId, mode: rt.info.mode, cwd: ws.path };
      if (rt.info.model) opts.model = rt.info.model;
      if (rt.info.permissionMode) opts.permissionMode = rt.info.permissionMode;
      if (rt.info.effort) opts.effort = rt.info.effort;
      if (resumeRef) opts.resumeRef = resumeRef;
      if (rt.state.cols) opts.cols = rt.state.cols;
      if (rt.state.rows) opts.rows = rt.state.rows;
      return adapter.start(opts, (body) => this.#onAdapterEvent(rt, gen, body), { logger });
    };

    const p = start().then(
      (handle) => {
        if (rt.starting === p) rt.starting = undefined;
        if (gen !== rt.generation || this.#closed) {
          void handle.stop().catch(() => {});
          throw new BizziError('conflict', 'session was stopped while starting');
        }
        rt.handle = handle;
        const ref = safeRef(handle);
        if (ref && ref !== rt.info.agentSessionRef) this.#append(rt, { type: 'session.info', data: { agentSessionRef: ref } });
        return handle;
      },
      (err: unknown) => {
        if (rt.starting === p) rt.starting = undefined;
        logger.log('warn', 'adapter start failed', { err });
        if (gen === rt.generation && !this.#closed) {
          this.#append(rt, { type: 'error', data: { message: `failed to start ${rt.info.agent}: ${errorMessage(err)}`, fatal: true } });
          this.#append(rt, { type: 'session.status', data: { status: 'failed', reason: errorMessage(err) } });
        }
        throw toBizziError(err, 'agent_unavailable');
      },
    );
    rt.starting = p;
    return p;
  }

  async #stopHandle(rt: Runtime): Promise<void> {
    const starting = rt.starting;
    const handle = rt.handle;
    rt.handle = undefined;
    if (handle) {
      await withTimeout(handle.stop(), STOP_TIMEOUT_MS).catch((err: unknown) => {
        this.#log.log('warn', 'adapter stop failed', { sessionId: rt.info.id, err });
      });
    }
    // Invalidate after stop() so events emitted while stopping (e.g. turn.completed) are kept.
    rt.generation++;
    if (starting) await starting.catch(() => {});
    clearTimeout(rt.interruptTimer);
  }

  #closeOpenTurn(rt: Runtime, stopReason: 'interrupted' | 'error', error: string): void {
    const turnId = rt.state.currentTurnId;
    if (turnId) this.#append(rt, { type: 'turn.completed', data: { turnId, stopReason, error } });
  }

  #onAdapterEvent(rt: Runtime, gen: number, body: SessionEventBody): void {
    if (gen !== rt.generation || !this.#d.store.isOpen || this.#closed) {
      this.#log.log('debug', 'dropping event from a stale adapter session', { sessionId: rt.info.id, type: body?.type });
      return;
    }
    if (!body || typeof body.type !== 'string') {
      this.#log.log('warn', 'adapter emitted a malformed event', { sessionId: rt.info.id });
      return;
    }
    switch (body.type) {
      case 'turn.started':
        this.#log.log('warn', 'adapters must not emit turn.started; dropped', { sessionId: rt.info.id });
        return;
      case 'turn.completed':
        if (body.data.turnId !== rt.state.currentTurnId) {
          this.#log.log('warn', 'turn.completed for a turn that is not in flight; dropped', {
            sessionId: rt.info.id,
            turnId: body.data.turnId,
          });
          return;
        }
        break;
      case 'session.status':
        if (body.data.status === 'ended' || body.data.status === 'failed') {
          // The agent went away: close the turn first so the timeline stays well-formed.
          this.#closeOpenTurn(rt, 'error', body.data.reason ?? `session ${body.data.status}`);
          const handle = rt.handle;
          rt.handle = undefined;
          rt.generation++;
          this.#append(rt, body);
          if (handle) void handle.stop().catch(() => {});
          return;
        }
        break;
    }
    this.#append(rt, body);
  }

  /** Append to the session channel and update derived state (status, info, pending approvals). */
  #append(rt: Runtime, body: SessionEventBody): void {
    const ev = this.#d.bus.append(sessionChannel(rt.info.id), body);
    rt.info.lastSeq = ev.seq;
    const info = rt.info;
    const terminal = TERMINAL_STATUSES.includes(info.status);
    let changed = false;
    const setStatus = (s: SessionStatus) => {
      if (info.status !== s) {
        info.status = s;
        changed = true;
      }
    };

    switch (body.type) {
      case 'turn.started':
        rt.state.currentTurnId = body.data.turnId;
        setStatus('running');
        changed = true;
        break;
      case 'turn.completed':
        if (rt.state.currentTurnId === body.data.turnId) {
          rt.state.currentTurnId = undefined;
          rt.pendingApprovals.clear();
          rt.responding.clear();
          clearTimeout(rt.interruptTimer);
          rt.interruptTimer = undefined;
          if (!terminal) setStatus('idle');
          changed = true;
        }
        break;
      case 'approval.requested':
        rt.pendingApprovals.set(body.data.approvalId, body.data);
        if (!terminal) setStatus('waiting_approval');
        break;
      case 'approval.resolved':
        rt.pendingApprovals.delete(body.data.approvalId);
        rt.responding.delete(body.data.approvalId);
        if (!terminal && info.status === 'waiting_approval' && rt.pendingApprovals.size === 0) {
          setStatus(rt.state.currentTurnId ? 'running' : 'idle');
        }
        break;
      case 'session.status':
        setStatus(body.data.status);
        break;
      case 'session.info':
        for (const k of ['agentSessionRef', 'model', 'permissionMode', 'effort', 'title'] as const) {
          const v = body.data[k];
          if (v !== undefined && info[k] !== v) {
            info[k] = v;
            changed = true;
          }
        }
        break;
    }
    if (changed) this.#changed(rt, ev.ts);
  }

  #changed(rt: Runtime, ts: string): void {
    rt.info.updatedAt = ts;
    this.#persist(rt);
    this.#d.bus.append(GLOBAL_CHANNEL, { type: 'session.updated', data: { session: { ...rt.info } } });
  }

  #persist(rt: Runtime): void {
    const state: Runtime['state'] = {};
    if (rt.state.currentTurnId) state.currentTurnId = rt.state.currentTurnId;
    if (rt.state.cols) state.cols = rt.state.cols;
    if (rt.state.rows) state.rows = rt.state.rows;
    this.#d.store.putSession({ info: rt.info, state });
  }
}

// --- helpers ---------------------------------------------------------------------------------------

export function validateInput(input: unknown): asserts input is InputBlock[] {
  if (!Array.isArray(input) || input.length === 0) throw new BizziError('bad_request', 'input must be a non-empty array');
  for (const b of input as unknown[]) {
    const block = b as Record<string, unknown> | null;
    if (!block || typeof block !== 'object') throw new BizziError('bad_request', 'invalid input block');
    const ok =
      (block.type === 'text' && typeof block.text === 'string') ||
      (block.type === 'image' && typeof block.mediaType === 'string' && typeof block.dataBase64 === 'string') ||
      (block.type === 'file' && typeof block.path === 'string');
    if (!ok) throw new BizziError('bad_request', `invalid input block of type ${String(block.type)}`);
  }
}

function safeRef(h: AdapterSession): string | undefined {
  try {
    return h.agentSessionRef();
  } catch {
    return undefined;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toBizziError(err: unknown, code: 'internal' | 'agent_unavailable'): BizziError {
  return err instanceof BizziError ? err : new BizziError(code, errorMessage(err));
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
