// Session manager: adapter lifecycle, turn bookkeeping, status derivation, approvals, questions,
// fork/delete, terminal snapshots, restart recovery and agent-process restarts (updates.md §5).

import { existsSync } from 'node:fs';
import {
  AGENT_KINDS,
  BizziError,
  GLOBAL_CHANNEL,
  NO_CAPABILITIES,
  contextFraction,
  newId,
  sessionChannel,
  type AdapterSession,
  type AgentAdapter,
  type AgentCapabilities,
  type AgentKind,
  type AgentListing,
  type ApprovalDecision,
  type ApprovalDecisionKind,
  type ApprovalRequest,
  type BillingClass,
  type InputBlock,
  type Logger,
  type MethodParams,
  type QuestionAnswers,
  type SessionEventBody,
  type SessionBudget,
  type SessionContext,
  type SessionEventMap,
  type SessionInfo,
  type SessionMode,
  type SessionStatus,
  type StartSessionOptions,
  type Usage,
  type WorkspaceInfo,
} from '@bizzi/protocol';
import type { AdapterRegistry } from './agents.ts';
import { addTurn, budgetReached, parseBudget, sumSpent, usd, zeroSpent, type Spent } from './budget.ts';
import { REPLAY_PAGE, type EventBus } from './bus.ts';
import { clampPermission } from './orchestration.ts';
import { installKey, precheckProblem } from './restart.ts';
import type { SessionState, Store } from './store.ts';
import {
  autoTitle,
  cleanSuggestedTitle,
  INTENT_MAX,
  isBizziNote,
  isPlaceholderTitle,
  messageText,
  RECENT_KEPT,
  RETITLE_AT,
  retitlePrompt,
  TITLE_PROMPT_MAX,
  type TitleSuggester,
} from './titles.ts';
import type { Workspaces } from './workspaces.ts';

export type PrepareStartResult = Partial<Pick<StartSessionOptions, 'env' | 'mcpServers' | 'systemPromptAppend' | 'launcher'>>;

/** Extra start options contributed by the host (knowledge injection, env, …). */
export type PrepareStart = (session: SessionInfo, workspace: WorkspaceInfo) => PrepareStartResult | Promise<PrepareStartResult>;

/**
 * Run several hooks in order and merge their results: env and mcpServers are merged (later wins on a
 * key clash), systemPromptAppend texts are joined with a blank line, the last launcher wins.
 */
export function composePrepareStart(hooks: readonly PrepareStart[] | (() => readonly PrepareStart[])): PrepareStart {
  return async (session, workspace) => {
    const list = typeof hooks === 'function' ? hooks() : hooks;
    const out: PrepareStartResult = {};
    const prompts: string[] = [];
    for (const hook of list) {
      const r = await hook({ ...session }, workspace);
      if (!r) continue;
      if (r.env) out.env = { ...out.env, ...r.env };
      if (r.mcpServers) out.mcpServers = { ...out.mcpServers, ...r.mcpServers };
      if (r.systemPromptAppend?.trim()) prompts.push(r.systemPromptAppend.trim());
      if (r.launcher) out.launcher = r.launcher;
    }
    if (prompts.length > 0) out.systemPromptAppend = prompts.join('\n\n');
    return out;
  };
}

/** Agent-to-agent fields for a session started by another session (spec §12.1). */
export interface HelperOptions {
  spawnedBy: string;
  scope: 'child' | 'detached';
  depth: number;
  /** Register the session but don't start it until `startQueued` (concurrency limit, spec §12.2). */
  queued?: boolean;
  queuedReason?: string;
  /** The parent may answer some of this helper's approvals and questions (spec §12.5). */
  parentAnswersApprovals?: boolean;
  /** The parent runs on another machine (spec §12.4): `spawnedBy` is its id there. */
  remoteParent?: { machineId: string; agent: AgentKind; permissionMode?: string };
}

/** Fork bookkeeping for `create` (a fork from another machine, topology.md §6). */
export interface CreateExtras {
  forkedFrom?: string;
  forkedFromMachineId?: string;
}

/** Who answers an approval or question: you (approval.respond / question.respond) or the helper's parent. */
export type Responder = { by: 'user' } | { by: 'parent'; sessionId: string };

/** How an approval or question was resolved, kept so a late second answer gets "already answered". */
export interface Resolution {
  /** allow / allow_always / deny / cancelled for approvals; answered / cancelled for questions. */
  outcome: string;
  by?: string;
  bySessionId?: string;
}

const RESOLUTIONS_KEPT = 200;

/**
 * Environment variables that mean an agent runs on a pay-per-token key (spec §12.3), or on a plan.
 * Anything else is left to the probe or to `account.usage` events.
 */
const BILLING_ENV: Partial<Record<AgentKind, [string, BillingClass][]>> = {
  claude: [
    ['ANTHROPIC_API_KEY', 'metered'],
    ['CLAUDE_CODE_OAUTH_TOKEN', 'plan'],
  ],
  codex: [['CODEX_API_KEY', 'metered']],
};

/** Extra environment for an agent's sessions (e.g. stored secrets). */
export type AgentEnvProvider = (agent: AgentKind) => Record<string, string> | Promise<Record<string, string>>;

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
  /** Merged over prepareStart's env when an adapter session starts. */
  agentEnv?: AgentEnvProvider;
  /** Metered-spend cap for a whole session tree, looked up by the root session's workspace (spec §12.2). */
  treeBudgetUsd?: (workspaceId: string) => number | undefined;
  /** Billing class of an agent's logged-in account, when the probe knows it (spec §12.3). */
  probeBilling?: (agent: AgentKind) => Promise<BillingClass | undefined>;
  /** How long a send (or session.set) arriving during an agent restart waits for it (default 60 s). */
  restartWaitMs?: number;
  /** Replaces the title taken from an untitled session's first message with a short summary (titles.ts). */
  suggestTitle?: TitleSuggester;
}

/** What `restartAgent` did (updates.md §5). Failures are also recorded on the session channel. */
export interface RestartOutcome {
  ok: boolean;
  /** The precheck refused the installed binary; the old process keeps running. */
  precheck?: boolean;
  /** The session was stopped, deleted or the node shut down during the restart. */
  aborted?: boolean;
  fromVersion?: string;
  toVersion?: string;
  error?: string;
  /** The new version failed to start and the session resumed on this (previous) version instead. */
  fallbackVersion?: string;
}

/** The agent process behind a session, as far as the core knows (updates.md §2). */
export interface AgentProcessInfo {
  /** An adapter session is up (or being started). */
  running: boolean;
  version?: string;
  path?: string;
  /** installKey() of the install the last restart failed for (no automatic retry on it). */
  restartFailedFor?: string;
}

/** Cap for `term.snapshot` output. */
export const TERMINAL_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;

// Statuses with no agent process behind them. Only 'ended' is final: someone closed the session.
// 'failed' (the agent crashed or didn't start) stays open, and the next message tries again (spec §4.1).
const TERMINAL_STATUSES: readonly SessionStatus[] = ['ended', 'failed'];
const DECISIONS: readonly ApprovalDecisionKind[] = ['allow', 'allow_always', 'deny'];
const STOP_TIMEOUT_MS = 10_000;
const RESTART_WAIT_MS = 60_000;

/** How an adapter session is started: fresh, resumed, or forked from another agent session. */
interface ResumeOpts {
  resumeRef?: string;
  fork?: boolean;
}

/** How #ensureStarted runs the adapter. */
interface StartOpts {
  /** Part of a restart: a failed start is left to the caller, a changed agentSessionRef isn't adopted. */
  restart?: boolean;
  /** Restart fallback: run this (previous) executable, which ran `version` (AgentAdapter.acceptsExecutable). */
  executable?: string;
  version?: string;
}

/** What an agent process ran before a restart (updates.md §5). */
interface Before {
  ref: string;
  version?: string;
  path?: string;
}

type FromTo = { fromVersion?: string; toVersion?: string };

function fromTo(from: string | undefined, to: string | undefined): FromTo {
  return { ...(from ? { fromVersion: from } : {}), ...(to ? { toVersion: to } : {}) };
}

type QuestionAsked = SessionEventMap['question.asked'];

interface Runtime {
  info: SessionInfo;
  state: SessionState;
  /** The user's latest messages (text), newest last, for re-titling (not persisted). */
  recent?: string[];
  adapter?: AgentAdapter;
  handle?: AdapterSession;
  starting?: Promise<AdapterSession>;
  /** Bumped whenever the adapter session is replaced or stopped; stale emits are dropped. */
  generation: number;
  /** A send() has reserved a turn but not yet emitted turn.started (adapter still starting). */
  reservedTurn?: string;
  stopping: boolean;
  pendingApprovals: Map<string, ApprovalRequest>;
  /** Approvals being answered (approval.respond in flight). */
  responding: Set<string>;
  pendingQuestions: Map<string, QuestionAsked>;
  /** Questions being answered (question.respond in flight). */
  answering: Set<string>;
  /** Approval / question ids the core canceled this turn; a late adapter resolution is dropped. */
  cancelled: Set<string>;
  /** Who is answering each approval / question in flight; stamped on its resolved event. */
  responders: Map<string, Responder>;
  /** Recently resolved approvals / questions (bounded), for a clear "already answered". */
  resolutions: Map<string, Resolution>;
  /** True while #cancelPending runs: per-event status fallback is skipped (the caller settles). */
  settling: boolean;
  interruptTimer?: NodeJS.Timeout;
  /** Set once session.delete starts: nothing more is appended or persisted for this session. */
  deleted: boolean;
  deleting?: Promise<void>;
  /** Set while the agent process is being replaced (updates.md §5); sends wait for it. */
  restarting?: Promise<void>;
  /** bizzi is stopping the agent process (#stopHandle): the core, not the adapter, decides the status. */
  stoppingAgent: boolean;
  /** installKey() of the install the last restart failed on; automatic restarts skip it. */
  restartFailedFor?: string;
}

function newRuntime(info: SessionInfo, state: SessionState, adapter: AgentAdapter | undefined): Runtime {
  return {
    info,
    state,
    adapter,
    generation: 0,
    stopping: false,
    pendingApprovals: new Map(),
    responding: new Set(),
    pendingQuestions: new Map(),
    answering: new Set(),
    cancelled: new Set(),
    responders: new Map(),
    resolutions: new Map(),
    settling: false,
    deleted: false,
    stoppingAgent: false,
  };
}

/** Automatic resumes in a row (no message in between) before bizzi stops continuing a session itself. */
export const MAX_AUTO_RESUMES = 3;
/**
 * The cap for turns bizzi cut off on purpose (a clean stop: an update, a new core, a quit). Higher,
 * since rapid restarts are routine, but still capped: an agent whose turn restarts bizzi (a local
 * install) would otherwise continue into the same restart forever.
 */
export const MAX_PLANNED_RESUMES = 10;

/** What an interrupted agent is told when bizzi continues its turn after a restart. */
export const CONTINUE_AFTER_RESTART =
  '[bizzi] bizzi restarted while you were working, and your last turn was cut off partway. Continue where you left off: check what already got done before redoing anything. If you had already finished, say so briefly.';

export class Sessions {
  readonly #d: SessionsDeps;
  readonly #log: Logger;
  readonly #byId = new Map<string, Runtime>();
  /** Shared agent servers being replaced (updates.md §3); starts on them wait for it. */
  readonly #recycling = new Map<AgentAdapter, Promise<void>>();
  #draining = false;
  #closed = false;
  /** True while load() replays persisted sessions (cascades wait until every session is loaded). */
  #loading = false;

  constructor(deps: SessionsDeps) {
    this.#d = deps;
    this.#log = deps.logger.child({ component: 'sessions' });
  }

  // --- restart recovery ---------------------------------------------------------------------------

  /**
   * Load persisted sessions. Every session nobody closed comes back idle (the next message resumes
   * it, or starts over when the agent can't resume); pending approvals/questions are canceled.
   */
  load(): void {
    this.#loading = true;
    try {
      this.#loadRows();
    } finally {
      this.#loading = false;
    }
    this.#repairTitles();
    // Child helpers of sessions that were closed (before a crash, say) stop too.
    for (const rt of [...this.#byId.values()]) if (rt.info.status === 'ended') this.#cascade(rt.info.id);
  }

  #loadRows(): void {
    for (const row of this.#d.store.listSessions()) {
      const rt = newRuntime(row.info, row.state, this.#d.registry.select(row.info.agent, row.info.mode));
      // Approvals / questions that were pending when the node went down can no longer be answered.
      for (const approvalId of row.state.pendingApprovals ?? []) {
        rt.pendingApprovals.set(approvalId, { approvalId, kind: 'other', title: '', editable: false, options: [] });
      }
      for (const questionId of row.state.pendingQuestions ?? []) rt.pendingQuestions.set(questionId, { questionId, text: '' });
      rt.info.lastSeq = this.#d.bus.lastSeq(sessionChannel(rt.info.id));
      this.#byId.set(rt.info.id, rt);
      const caps = this.#caps(rt);
      const ref = rt.info.agentSessionRef ?? (caps.fork ? rt.state.forkOf : undefined);
      const resumable = Boolean(rt.adapter && caps.resumeAfterNodeRestart && ref);
      // Only a session someone closed stays ended. Older versions also ended sessions whose agent
      // exited, or that bizzi stopped to restart or update; those reopen.
      const reopen = rt.info.status === 'ended' && !this.#closedByUser(rt);
      // No agent process survives a node restart; the next start records the version it runs. A
      // structured agent that was running resumes through the restart sequence on its next start
      // (updates.md §7). Terminal sessions reattach to their PTY supervisor (or start a new process
      // under a new ref when it's gone), so they keep the plain path.
      const ran = rt.info.agentVersion !== undefined || rt.state.agentPath !== undefined;
      const structured = rt.info.mode === 'structured';
      if (ran && structured && resumable && rt.info.agentSessionRef && (reopen || !TERMINAL_STATUSES.includes(rt.info.status))) {
        rt.state.nodeRestarted = rt.info.agentVersion ? { fromVersion: rt.info.agentVersion } : {};
      }
      if (ran) {
        delete rt.info.agentVersion;
        rt.state.agentPath = undefined;
        this.#persist(rt);
      }
      if (TERMINAL_STATUSES.includes(rt.info.status) && !reopen) {
        this.#cancelPending(rt, false);
        continue;
      }

      // A turn still open here means the node died mid-turn (killed, crashed): resume it once we're up.
      this.#markInterrupted(rt, false);
      this.#closeOpenTurn(rt, 'interrupted', 'node restarted');
      const status: SessionStatus = 'idle';
      if (!resumable && rt.info.agentSessionRef && !rt.state.startFresh) {
        rt.state.startFresh = true;
        this.#persist(rt);
      }
      if (rt.state.queued) {
        // Queued helpers were never started; the queue itself doesn't survive a restart.
        rt.state.queued = undefined;
        rt.state.closed = true;
        this.#append(rt, { type: 'session.status', data: { status: 'ended', reason: 'node restarted while the helper was queued' } });
        continue;
      }
      if (rt.info.status !== status) {
        const reason = reopen
          ? 'reopened: it ended without being closed'
          : resumable
            ? 'node restarted'
            : "node restarted; the agent can't resume this conversation, so the next message starts a new one";
        this.#append(rt, { type: 'session.status', data: { status, reason } });
      }
      if (status === 'idle' && rt.state.budgetBlocked) {
        this.#append(rt, { type: 'session.status', data: { status: 'waiting_input', prompt: 'budget', reason: rt.state.budgetBlocked } });
      }
    }
  }

  /**
   * Whether an ended session was closed by someone (`closed`). Sessions from before the marker
   * count as closed when their last status came from session.stop ('stopped'); the answer is kept.
   */
  #closedByUser(rt: Runtime): boolean {
    if (rt.state.closed) return true;
    const last = this.#d.store.lastData(sessionChannel(rt.info.id), 'session.status') as { status?: string; reason?: string } | undefined;
    if (last?.status !== 'ended' || last.reason !== 'stopped') return false;
    rt.state.closed = true;
    this.#persist(rt);
    return true;
  }

  // --- queries --------------------------------------------------------------------------------------

  /** `spawnedBy`: only that parent's helpers. */
  list(workspaceId?: string, filter: { spawnedBy?: string } = {}): SessionInfo[] {
    const out: SessionInfo[] = [];
    for (const rt of this.#byId.values()) {
      if (workspaceId !== undefined && rt.info.workspaceId !== workspaceId) continue;
      if (filter.spawnedBy !== undefined && rt.info.spawnedBy !== filter.spawnedBy) continue;
      out.push({ ...rt.info });
    }
    return out;
  }

  /** A turn is in flight, being started, or the helper is still queued. */
  isBusy(id: string): boolean {
    const rt = this.#get(id);
    return Boolean(rt.state.currentTurnId || rt.reservedTurn || rt.starting || rt.state.queued);
  }

  isQueued(id: string): boolean {
    return Boolean(this.#byId.get(id)?.state.queued);
  }

  /** What the session is waiting on: pending approvals and questions, or a budget stop. */
  pending(id: string): { approvals: ApprovalRequest[]; questions: QuestionAsked[]; budget?: string } {
    const rt = this.#get(id);
    const out: { approvals: ApprovalRequest[]; questions: QuestionAsked[]; budget?: string } = {
      approvals: [...rt.pendingApprovals.values()],
      questions: [...rt.pendingQuestions.values()],
    };
    if (rt.state.budgetBlocked) out.budget = rt.state.budgetBlocked;
    return out;
  }

  /** This session's own usage, and the sum over it and every helper below it. */
  spent(id: string): { own: Spent; tree: Spent } {
    const rt = this.#get(id);
    return { own: { ...(rt.state.spent ?? zeroSpent()) }, tree: this.#treeSpent(rt) };
  }

  /** Why the session may not start another turn because of a budget (its own, an ancestor's, the tree cap). */
  overBudget(id: string): string | undefined {
    return this.#budgetExceeded(this.#get(id));
  }

  /**
   * What the budgets over this session still allow (its own, every ancestor's, the tree cap), field by
   * field; undefined when no cap applies. A helper on another machine gets at most this (spec §12.4).
   */
  remainingBudget(id: string): SessionBudget | undefined {
    const rt = this.#get(id);
    const chain = this.#ancestry(rt);
    const out: SessionBudget = {};
    const min = (k: keyof SessionBudget, v: number) => {
      const left = Math.max(0, v);
      out[k] = out[k] === undefined ? left : Math.min(out[k]!, left);
    };
    for (const a of chain) {
      if (!a.info.budget) continue;
      const spent = this.#treeSpent(a);
      if (a.info.budget.usd !== undefined) min('usd', a.info.budget.usd - spent.usd);
      if (a.info.budget.tokens !== undefined) min('tokens', a.info.budget.tokens - spent.tokens);
      if (a.info.budget.turns !== undefined) min('turns', a.info.budget.turns - spent.turns);
    }
    const root = chain[chain.length - 1]!;
    let cap: number | undefined;
    try {
      cap = this.#d.treeBudgetUsd?.(root.info.workspaceId);
    } catch {
      cap = undefined;
    }
    if (cap !== undefined) min('usd', cap - this.#treeSpent(root).usd);
    return Object.keys(out).length > 0 ? out : undefined;
  }

  /**
   * Record the last known spend of `helperId`, a helper of `parentId` running on another machine
   * (spec §12.4). It counts in the parent's tree from now on (budgets are checked at turn boundaries).
   */
  recordRemoteSpent(parentId: string, helperId: string, spent: Spent): void {
    const rt = this.#byId.get(parentId);
    if (!rt || rt.deleted) return;
    const clean: Spent = { usd: nonNegative(spent.usd), tokens: nonNegative(spent.tokens), turns: nonNegative(spent.turns) };
    const prev = rt.state.remoteSpent?.[helperId];
    if (prev && prev.usd === clean.usd && prev.tokens === clean.tokens && prev.turns === clean.turns) return;
    rt.state.remoteSpent = { ...rt.state.remoteSpent, [helperId]: clean };
    this.#persist(rt);
  }

  /**
   * Record that the user has seen the session through `seq` (spec §4 `seen_through`). Never moves
   * backwards and never past the last event. Emits `session.updated` when it moves.
   */
  markSeen(id: string, seq: number): number {
    const rt = this.#get(id);
    if (rt.deleted) throw new BizziError('not_found', `session ${id} not found`);
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) throw new BizziError('bad_request', 'seq must be a non-negative integer');
    const current = rt.info.seenThrough ?? 0;
    const next = Math.min(seq, rt.info.lastSeq);
    if (next <= current) return current;
    rt.info.seenThrough = next;
    // Not a change to the session itself: updatedAt (list order) stays put.
    this.#persist(rt);
    this.#d.bus.append(GLOBAL_CHANNEL, { type: 'session.updated', data: { session: { ...rt.info } } });
    return next;
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

  // --- agent processes and restarts (updates.md §2–§5) ------------------------------------------------

  /** The running agent process: version and real executable path recorded at spawn. */
  agentProcess(id: string): AgentProcessInfo {
    const rt = this.#get(id);
    const out: AgentProcessInfo = { running: Boolean((rt.handle || rt.starting) && !rt.deleted) };
    if (rt.info.agentVersion) out.version = rt.info.agentVersion;
    if (rt.state.agentPath) out.path = rt.state.agentPath;
    if (rt.restartFailedFor) out.restartFailedFor = rt.restartFailedFor;
    return out;
  }

  /**
   * Why the agent process can't be restarted right now (updates.md §4), or undefined at a safe
   * point. On a shared server every session on it must be at one.
   */
  unsafeReason(id: string): string | undefined {
    return this.#unsafe(this.#get(id));
  }

  /** Why the session can never be restarted without losing its conversation, or undefined. */
  restartBlocker(id: string): string | undefined {
    return this.#restartBlocker(this.#get(id));
  }

  isRestarting(id: string): boolean {
    return Boolean(this.#byId.get(id)?.restarting);
  }

  /**
   * Sessions whose agent processes restart together with this one: itself, plus every other
   * running session on the same shared server (`AgentAdapter.sharedProcess: 'owned'`, updates.md §3).
   */
  restartGroup(id: string): string[] {
    return this.#group(this.#get(id)).map((m) => m.info.id);
  }

  /**
   * Replace the agent process with the installed version and resume the same conversation
   * (updates.md §5). The bizzi session, its event log and seq carry on. On a shared server every
   * session on it restarts together (the outcome returned is this session's). Throws BizziError
   * only when the session can't be restarted now (not resumable, not at a safe point); a failed
   * precheck, spawn or resume is returned as the outcome and recorded on the session channel.
   */
  async restartAgent(id: string, opts: { reason?: string } = {}): Promise<RestartOutcome> {
    const rt = this.#get(id);
    const blocker = this.#restartBlocker(rt);
    if (blocker) throw new BizziError('unsupported', `cannot restart: ${blocker}`);
    const unsafe = this.#unsafe(rt);
    if (unsafe) throw new BizziError('conflict', `cannot restart now: ${unsafe}`);
    const group = this.#group(rt);
    const releases = group.map((m) => {
      let release!: () => void;
      m.restarting = new Promise<void>((r) => {
        release = r;
      });
      return () => {
        m.restarting = undefined;
        release();
      };
    });
    try {
      const outcomes = await this.#restart(group, opts.reason);
      return outcomes.get(rt) ?? { ok: false, aborted: true, error: 'the session stopped' };
    } finally {
      for (const release of releases) release();
    }
  }

  // --- lifecycle --------------------------------------------------------------------------------------

  async create(p: MethodParams<'session.create'>, helper?: HelperOptions, extras?: CreateExtras): Promise<SessionInfo> {
    this.#assertAccepting();
    const ws = this.#d.workspaces.get(p.workspaceId);
    this.#d.workspaces.assertPresent(ws);
    if (!AGENT_KINDS.includes(p.agent)) throw new BizziError('bad_request', `unknown agent ${String(p.agent)}`);
    const mode = p.mode ?? this.#d.registry.defaultMode(p.agent);
    const adapter = mode && this.#d.registry.select(p.agent, mode);
    if (!mode || !adapter) {
      throw new BizziError('agent_unavailable', `no adapter for ${p.agent}${p.mode ? ` in ${p.mode} mode` : ''}`);
    }
    this.#d.registry.assertStartable(p.agent, mode);
    if (p.command !== undefined) {
      if (mode !== 'terminal') throw new BizziError('bad_request', 'command is only supported in terminal mode');
      validateCommand(p.command);
    }
    const info = this.#newInfo(ws.id, p.agent, mode);
    if (p.title) info.title = p.title;
    if (p.group) info.group = p.group;
    if (p.model) info.model = p.model;
    if (p.permissionMode) info.permissionMode = p.permissionMode;
    if (p.effort) info.effort = p.effort;
    if (p.resumeRef) info.agentSessionRef = p.resumeRef;
    const budget = parseBudget(p.budget);
    if (budget) info.budget = budget;
    if (helper) {
      if (!helper.remoteParent && !this.#byId.has(helper.spawnedBy)) throw new BizziError('not_found', `session ${helper.spawnedBy} not found`);
      info.spawnedBy = helper.spawnedBy;
      if (helper.remoteParent) info.spawnedByMachineId = helper.remoteParent.machineId;
      info.scope = helper.scope;
      info.depth = helper.depth;
      if (helper.parentAnswersApprovals) info.parentAnswersApprovals = true;
    }
    if (extras?.forkedFrom) info.forkedFrom = extras.forkedFrom;
    if (extras?.forkedFromMachineId) info.forkedFromMachineId = extras.forkedFromMachineId;
    const rt = newRuntime(info, {}, adapter);
    if (helper?.remoteParent) rt.state.remoteParent = { ...helper.remoteParent };
    if (p.cols) rt.state.cols = p.cols;
    if (p.rows) rt.state.rows = p.rows;
    if (p.command) rt.state.command = [...p.command];
    if (helper?.queued) rt.state.queued = true;
    this.#register(rt);
    if (rt.state.queued) {
      this.#append(rt, { type: 'session.status', data: { status: 'starting', reason: helper?.queuedReason ?? 'queued' } });
    } else {
      this.#startInBackground(rt, p.resumeRef ? { resumeRef: p.resumeRef } : {});
    }
    return { ...rt.info };
  }

  /** A user's rename (`session.set` title): kept over agent-reported titles from now on. Works on ended sessions. */
  #rename(rt: Runtime, raw: string): void {
    if (rt.deleted) throw new BizziError('not_found', `session ${rt.info.id} not found`);
    const title = raw.trim();
    rt.state.titleByUser = true;
    rt.state.titleAuto = undefined;
    if ((rt.info.title ?? '') === title) {
      this.#persist(rt);
      return;
    }
    if (title) rt.info.title = title;
    else delete rt.info.title;
    this.#changed(rt, new Date().toISOString());
  }

  /** Start a helper registered with `queued` (its concurrency slot is free now). */
  startQueued(id: string): void {
    const rt = this.#get(id);
    if (!rt.state.queued) return;
    this.#assertOpen(rt);
    rt.state.queued = undefined;
    this.#persist(rt);
    this.#startInBackground(rt, this.#resumeFor(rt));
  }

  /** Re-check sessions held for budget (e.g. after the tree cap was raised); release those now within budget. */
  recheckBudgets(): void {
    for (const rt of this.#byId.values()) {
      if (!rt.state.budgetBlocked || rt.deleted || TERMINAL_STATUSES.includes(rt.info.status)) continue;
      if (this.#budgetExceeded(rt)) continue;
      rt.state.budgetBlocked = undefined;
      this.#append(rt, { type: 'session.status', data: { status: this.#settledStatus(rt), reason: 'budget raised' } });
      this.#persist(rt);
    }
  }

  /**
   * New session in the same workspace with the same agent, mode and options (`forkedFrom` set). Uses the
   * agent's native fork (resumeRef + fork) when supported; otherwise it starts fresh and says so.
   */
  async fork(sourceId: string, title?: string): Promise<SessionInfo> {
    this.#assertAccepting();
    const src = this.#get(sourceId);
    if (src.deleted) throw new BizziError('not_found', `session ${sourceId} not found`);
    const ws = this.#d.workspaces.get(src.info.workspaceId);
    const adapter = this.#d.registry.select(src.info.agent, src.info.mode);
    if (!adapter) throw new BizziError('agent_unavailable', `no adapter for ${src.info.agent} in ${src.info.mode} mode`);
    this.#d.registry.assertStartable(src.info.agent, src.info.mode);
    const caps = safeCaps(adapter, src.info.mode);
    // A fork of a fork that hasn't started yet forks from the same source conversation.
    const sourceRef = src.info.agentSessionRef ?? src.state.forkOf;
    const native = caps.fork && Boolean(sourceRef);

    const info = this.#newInfo(ws.id, src.info.agent, src.info.mode);
    info.forkedFrom = src.info.id;
    const t = title ?? src.info.title;
    if (t) info.title = t;
    for (const k of ['model', 'permissionMode', 'effort'] as const) {
      const v = src.info[k];
      if (v) info[k] = v;
    }
    const rt = newRuntime(info, {}, adapter);
    if (src.state.cols) rt.state.cols = src.state.cols;
    if (src.state.rows) rt.state.rows = src.state.rows;
    if (src.state.command) rt.state.command = [...src.state.command];
    if (native) rt.state.forkOf = sourceRef;
    this.#register(rt);
    if (!native) {
      const why = caps.fork ? 'the source session has no agent conversation yet' : 'this agent cannot fork sessions';
      this.#append(rt, {
        type: 'agent.raw',
        data: {
          agent: info.agent,
          payload: {
            type: 'bizzi.fork',
            native: false,
            forkedFrom: src.info.id,
            message: `Forked from ${src.info.id} without its conversation (${why}); this session starts fresh.`,
          },
        },
      });
    }
    this.#startInBackground(rt, this.#resumeFor(rt));
    return { ...info };
  }

  /** Stop the session if needed, then remove it and its events (emits `session.removed`). */
  delete(id: string): Promise<void> {
    const rt = this.#get(id);
    rt.deleting ??= (async () => {
      // From here on nothing is appended or persisted for this session (stop events included).
      rt.deleted = true;
      await this.#stopHandle(rt);
      const ch = sessionChannel(id);
      this.#d.store.deleteSession(id, ch);
      this.#byId.delete(id);
      this.#d.bus.forget(ch);
      this.#d.bus.append(GLOBAL_CHANNEL, {
        type: 'session.removed',
        data: { sessionId: id, workspaceId: rt.info.workspaceId },
      });
      // Child helpers stop with their parent; detached ones carry on.
      this.#cascade(id);
    })();
    return rt.deleting;
  }

  async send(id: string, input: InputBlock[]): Promise<{ turnId: string }> {
    return this.#send(id, input, false);
  }

  /**
   * After a node restart, continue every structured session whose turn bizzi cut off (updates.md §7):
   * one at a time, `gapMs` apart, so agents don't all spawn at once. A session interrupted
   * MAX_AUTO_RESUMES times in a row with no message in between gets a notice instead.
   */
  async resumeInterrupted(gapMs = 500): Promise<string[]> {
    const resumed: string[] = [];
    for (const rt of [...this.#byId.values()]) {
      const cut = rt.state.interruptedTurn;
      if (!cut || this.#closed) continue;
      rt.state.interruptedTurn = undefined;
      this.#persist(rt);
      if (rt.deleted || rt.state.closed || rt.info.status === 'ended' || rt.info.mode !== 'structured' || !rt.adapter) continue;
      // Crashes and clean stops are counted apart: a turn that keeps crashing the node stops soon,
      // one that a run of planned restarts keeps cutting off carries on for longer.
      const planned = cut.planned === true;
      const tries = (planned ? rt.state.plannedResumes : rt.state.autoResumes) ?? 0;
      if (tries >= (planned ? MAX_PLANNED_RESUMES : MAX_AUTO_RESUMES)) {
        this.#append(rt, {
          type: 'error',
          data: {
            message: `bizzi restarted during this session's work ${tries + 1} times in a row, so it didn't continue it on its own this time. Send a message to continue.`,
            code: 'resume_skipped',
            fatal: false,
          },
        });
        continue;
      }
      if (planned) rt.state.plannedResumes = tries + 1;
      else rt.state.autoResumes = tries + 1;
      this.#persist(rt);
      try {
        await this.#send(rt.info.id, [{ type: 'text', text: CONTINUE_AFTER_RESTART }], true);
        resumed.push(rt.info.id);
        this.#log.log('info', 'resumed an interrupted turn', { sessionId: rt.info.id, attempt: tries + 1, planned });
      } catch (err) {
        this.#log.log('warn', 'could not resume an interrupted turn', { sessionId: rt.info.id, err });
        if (!this.#closed && !rt.deleted) {
          this.#append(rt, {
            type: 'error',
            data: { message: `bizzi restarted mid-turn and couldn't continue this session (${errorMessage(err)}). Send a message to continue.`, code: 'resume_failed', fatal: false },
          });
        }
      }
      if (gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
    }
    return resumed;
  }

  /** Remember a structured turn bizzi is about to cut off, for resumeInterrupted. */
  #markInterrupted(rt: Runtime, planned: boolean): void {
    if (!rt.state.currentTurnId || rt.info.mode !== 'structured' || rt.state.closed) return;
    rt.state.interruptedTurn = planned ? { at: new Date().toISOString(), planned: true } : { at: new Date().toISOString() };
    this.#persist(rt);
  }

  async #send(id: string, input: InputBlock[], auto: boolean): Promise<{ turnId: string }> {
    const rt = this.#get(id);
    validateInput(input);
    this.#assertAccepting();
    this.#assertOpen(rt);
    if (rt.restarting) {
      // Queued briefly behind the agent restart instead of rejected (updates.md §4).
      await this.#waitForRestart(rt);
      this.#assertAccepting();
      this.#assertOpen(rt);
    }
    if (rt.state.queued) throw new BizziError('conflict', 'this helper is queued until a helper slot frees up');
    if (rt.state.currentTurnId || rt.reservedTurn) {
      throw new BizziError('conflict', 'a turn is already in progress (use session.steer or session.interrupt)');
    }
    const over = this.#budgetExceeded(rt);
    if (over) {
      if (rt.state.budgetBlocked !== over) this.#blockForBudget(rt, over);
      throw new BizziError('conflict', `${over}; raise the budget to continue`, { budget: true });
    }
    if (rt.state.budgetBlocked) {
      // Within budget again (a cap was raised): carry on.
      rt.state.budgetBlocked = undefined;
      this.#persist(rt);
    }
    if (!auto && (rt.state.autoResumes || rt.state.plannedResumes || rt.state.interruptedTurn)) {
      // Someone is driving the session again: the automatic-resume count starts over.
      rt.state.autoResumes = undefined;
      rt.state.plannedResumes = undefined;
      rt.state.interruptedTurn = undefined;
      this.#persist(rt);
    }
    const turnId = newId('t');
    rt.reservedTurn = turnId;
    let handle: AdapterSession;
    try {
      handle = await this.#ensureStarted(rt, this.#resumeFor(rt));
      this.#assertOpen(rt);
    } finally {
      rt.reservedTurn = undefined;
    }
    this.#append(rt, { type: 'turn.started', data: auto ? { turnId, input, auto: true } : { turnId, input } });
    try {
      await handle.send(turnId, input);
    } catch (err) {
      this.#log.log('warn', 'adapter send failed', { sessionId: id, turnId, err });
      // No-op when the adapter already completed this turn (exactly one turn.completed per turnId).
      this.#append(rt, { type: 'turn.completed', data: { turnId, stopReason: 'error', error: errorMessage(err) } });
      throw toBizziError(err, 'internal');
    }
    return { turnId };
  }

  async steer(id: string, input: InputBlock[]): Promise<void> {
    const rt = this.#get(id);
    validateInput(input);
    this.#assertOpen(rt);
    if (!this.#caps(rt).steer || !rt.handle?.steer) throw new BizziError('unsupported', 'this agent does not support steering');
    const turnId = rt.state.currentTurnId;
    if (!turnId) throw new BizziError('conflict', 'no turn in progress; use session.send');
    await rt.handle.steer(input).catch((err: unknown) => {
      throw toBizziError(err, 'internal');
    });
    this.#append(rt, { type: 'turn.steered', data: { turnId, input } });
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
    if (rt.info.status === 'ended' || rt.stopping || rt.deleted) return;
    rt.stopping = true;
    try {
      await this.#stopHandle(rt);
      this.#closeOpenTurn(rt, 'interrupted', 'session stopped');
      rt.state.closed = true;
      this.#append(rt, { type: 'session.status', data: { status: 'ended', reason: 'stopped' } });
    } finally {
      rt.stopping = false;
    }
  }

  /**
   * A fresh conversation in the same bizzi session: stop the agent process, forget its session ref
   * (and an unstarted fork's source) so the next start doesn't resume, then start a new one.
   */
  async clear(id: string): Promise<void> {
    const rt = this.#get(id);
    this.#assertOpen(rt);
    if (rt.info.mode !== 'structured') throw new BizziError('unsupported', "terminal sessions can't be cleared from bizzi; use the agent's own command");
    if (rt.restarting) {
      await this.#waitForRestart(rt);
      this.#assertOpen(rt);
    }
    if (rt.state.queued) throw new BizziError('conflict', 'this helper is queued until a helper slot frees up');
    if (rt.state.currentTurnId || rt.reservedTurn) throw new BizziError('conflict', 'a turn is in progress: wait for it or stop it first');
    const previousRef = rt.info.agentSessionRef;
    // Nothing the old process says while it shuts down belongs to the new conversation.
    rt.generation++;
    await this.#stopHandle(rt);
    this.#assertOpen(rt);
    this.#append(rt, { type: 'context.cleared', data: previousRef ? { previousRef } : {} });
    this.#startInBackground(rt, {});
  }

  /**
   * Change model / permission mode / effort (applied to the running agent when it supports it, else
   * on the next start) and the session's budget. A helper's permission mode can't be loosened beyond
   * its parent's (spec §12.2). `budget` replaces the session's budget (an empty object clears it);
   * a session held for budget is released once it's within budget again.
   */
  async set(p: MethodParams<'session.set'>): Promise<SessionInfo> {
    const rt = this.#get(p.sessionId);
    if (p.title !== undefined) this.#rename(rt, p.title);
    const { title: _title, sessionId: _id, ...rest } = p;
    if (Object.values(rest).every((v) => v === undefined)) return { ...rt.info };
    this.#assertOpen(rt);
    if (rt.restarting) {
      await this.#waitForRestart(rt);
      this.#assertOpen(rt);
    }
    const opts: { model?: string; permissionMode?: string; effort?: string } = {};
    if (p.model !== undefined) opts.model = p.model;
    if (p.permissionMode !== undefined) opts.permissionMode = p.permissionMode;
    if (p.effort !== undefined) opts.effort = p.effort;
    // null = clear; undefined = unchanged.
    const budget: SessionBudget | null | undefined = p.budget === undefined ? undefined : (parseBudget(p.budget) ?? null);
    if (Object.keys(opts).length === 0 && budget === undefined) return { ...rt.info };
    if (opts.permissionMode !== undefined && opts.permissionMode !== rt.info.permissionMode) this.#assertWithinParent(rt, opts.permissionMode);

    const caps = this.#caps(rt);
    if (rt.handle && Object.keys(opts).length > 0) {
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
    if (budget !== undefined && JSON.stringify(budget ?? undefined) !== JSON.stringify(rt.info.budget)) {
      if (budget) rt.info.budget = budget;
      else delete rt.info.budget;
      changed = true;
    }
    if (changed) this.#changed(rt, new Date().toISOString());
    // A raised budget releases this session (and helpers below it) if they were held for budget.
    if (budget !== undefined) this.recheckBudgets();
    return { ...rt.info };
  }

  /** A helper's permission mode stays within its parent's (spec §12.2); refuses a looser one. */
  #assertWithinParent(rt: Runtime, requested: string): void {
    const parentId = rt.info.spawnedBy;
    const local = parentId ? this.#byId.get(parentId)?.info : undefined;
    // A parent on another machine: what it told us when the helper started (spec §12.4).
    const parent = local ? { agent: local.agent, permissionMode: local.permissionMode } : rt.state.remoteParent;
    if (!parent) return;
    const clamp = clampPermission({
      parentAgent: parent.agent,
      parentMode: parent.permissionMode,
      agent: rt.info.agent,
      requested,
      available: this.#caps(rt).permissionModes ?? [],
    });
    if (clamp.permissionMode === undefined || clamp.permissionMode === requested) return;
    throw new BizziError(
      'conflict',
      `permission mode ${requested} is looser than the parent session's (${parent.permissionMode ?? 'default'}); at most ${clamp.permissionMode} is allowed`,
      { parentMode: parent.permissionMode, allowed: clamp.permissionMode },
    );
  }

  /**
   * Answer a pending approval. `responder` defaults to you; the helper's parent passes its own (the
   * Orchestrator checks what it may answer). Whoever answers first wins; the other gets `not_found`
   * (or `conflict` while the first answer is still being delivered) with `data.alreadyAnswered`.
   */
  async respondApproval(p: MethodParams<'approval.respond'>, responder: Responder = { by: 'user' }): Promise<void> {
    const rt = this.#get(p.sessionId);
    const req = rt.pendingApprovals.get(p.approvalId);
    if (!req) throw this.#notPending(rt, 'approval', p.approvalId);
    if (!DECISIONS.includes(p.decision)) throw new BizziError('bad_request', `invalid decision ${String(p.decision)}`);
    if (req.options.length > 0 && !req.options.includes(p.decision)) {
      throw new BizziError('bad_request', `decision ${p.decision} is not offered (${req.options.join(', ')})`);
    }
    if (p.editedInput !== undefined && !req.editable) {
      throw new BizziError('bad_request', 'this approval does not accept edited input');
    }
    if (p.message !== undefined && typeof p.message !== 'string') throw new BizziError('bad_request', 'message must be a string');
    if (rt.responding.has(p.approvalId)) throw inFlight(rt, 'approval', p.approvalId);
    if (!rt.handle) throw new BizziError('conflict', 'the agent is not running');
    const decision: ApprovalDecision = { decision: p.decision };
    if (p.message !== undefined) decision.message = p.message;
    if (p.editedInput !== undefined) decision.editedInput = p.editedInput;
    rt.responding.add(p.approvalId);
    rt.responders.set(p.approvalId, responder);
    try {
      await rt.handle.respondApproval(p.approvalId, decision);
    } catch (err) {
      rt.responding.delete(p.approvalId);
      rt.responders.delete(p.approvalId);
      throw toBizziError(err, 'internal');
    }
  }

  /** How a recently resolved approval or question ended, if it is still remembered. */
  resolution(id: string, itemId: string): Resolution | undefined {
    return this.#get(id).resolutions.get(itemId);
  }

  /** not_found; with `data.alreadyAnswered` and who answered when it was answered recently. */
  #notPending(rt: Runtime, what: 'approval' | 'question', itemId: string): BizziError {
    const r = rt.resolutions.get(itemId);
    if (!r) return new BizziError('not_found', `no pending ${what} ${itemId}`);
    const who = r.by === 'parent' ? `the parent session${r.bySessionId ? ` ${r.bySessionId}` : ''}` : 'the user';
    // Still not_found (nothing pending to answer), with who was first.
    return new BizziError('not_found', `${what} ${itemId} was already answered by ${who} (${r.outcome})`, { alreadyAnswered: true, ...r });
  }

  /** Answer (or, with `cancel`, decline) a pending `question.asked`. */
  async respondQuestion(p: MethodParams<'question.respond'>, responder: Responder = { by: 'user' }): Promise<void> {
    const rt = this.#get(p.sessionId);
    if (typeof p.questionId !== 'string') throw new BizziError('bad_request', 'questionId must be a string');
    const q = rt.pendingQuestions.get(p.questionId);
    if (!q) throw this.#notPending(rt, 'question', p.questionId);
    if (!rt.handle) throw new BizziError('conflict', 'the agent is not running');
    if (!rt.handle.respondQuestion) throw new BizziError('unsupported', 'this agent cannot answer questions');
    let answers: QuestionAnswers | undefined;
    if (p.cancel !== true) {
      if (p.answers === undefined) throw new BizziError('bad_request', 'answers or cancel is required');
      answers = validateAnswers(p.answers, q);
    }
    if (rt.answering.has(p.questionId)) throw inFlight(rt, 'question', p.questionId);
    rt.answering.add(p.questionId);
    rt.responders.set(p.questionId, responder);
    try {
      await rt.handle.respondQuestion(p.questionId, answers);
    } catch (err) {
      rt.answering.delete(p.questionId);
      rt.responders.delete(p.questionId);
      throw toBizziError(err, 'internal');
    }
  }

  /** Recent terminal output and the seq it is current as of (adapter scrollback, else the event log). */
  terminalSnapshot(id: string): { dataBase64: string; seq: number } {
    const rt = this.#get(id);
    if (rt.info.mode !== 'terminal') throw new BizziError('unsupported', 'not a terminal-mode session');
    const ch = sessionChannel(id);
    // Synchronous throughout, so no event can land between reading the output and reading the seq.
    if (rt.handle?.snapshotTerminal) {
      try {
        const bytes = Buffer.from(rt.handle.snapshotTerminal());
        const tail =
          bytes.length > TERMINAL_SNAPSHOT_MAX_BYTES ? bytes.subarray(bytes.length - TERMINAL_SNAPSHOT_MAX_BYTES) : bytes;
        return { dataBase64: tail.toString('base64'), seq: this.#d.bus.lastSeq(ch) };
      } catch (err) {
        this.#log.log('warn', 'adapter terminal snapshot failed; using the event log', { sessionId: id, err });
      }
    }
    const seq = this.#d.bus.lastSeq(ch);
    return { dataBase64: this.#d.store.terminalTail(ch, seq, TERMINAL_SNAPSHOT_MAX_BYTES).toString('base64'), seq };
  }

  /** Append an event from outside the adapter (extensions, e.g. login.prompt). Same rules as adapter events. */
  emit(id: string, body: SessionEventBody): void {
    const rt = this.#get(id);
    if (rt.deleted) throw new BizziError('not_found', `session ${id} not found`);
    this.#onAdapterEvent(rt, rt.generation, body);
  }

  /** Keystrokes. After the process exited, the first one starts it again (resuming when it can) and is dropped. */
  termInput(id: string, data: Uint8Array): void {
    const rt = this.#get(id);
    if (rt.info.mode === 'terminal' && !rt.handle) {
      if (rt.starting) return;
      this.#assertAccepting();
      this.#assertOpen(rt);
      this.#ensureStarted(rt, this.#resumeFor(rt)).catch(() => {
        // #ensureStarted recorded the failure on the session channel.
      });
      return;
    }
    const h = this.#terminalHandle(id);
    if (!h.writeTerminal) throw new BizziError('unsupported', 'terminal input is not supported');
    h.writeTerminal(data);
  }

  termResize(id: string, cols: number, rows: number): void {
    const rt = this.#get(id);
    // No process right now: keep the size for the next start.
    if (rt.info.mode !== 'terminal' || rt.handle) {
      const h = this.#terminalHandle(id);
      if (!h.resizeTerminal) throw new BizziError('unsupported', 'terminal resize is not supported');
      h.resizeTerminal(cols, rows);
    }
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

  /**
   * Resolves true once every session is at a safe point (updates.md §7): no turn in flight, no
   * agent starting or restarting. False on timeout.
   */
  async waitForTurns(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.#unsettled() > 0) {
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, Math.min(100, Math.max(1, deadline - Date.now()))));
    }
    return true;
  }

  /** Sessions not at a safe point for a node restart: a turn in flight, an agent starting or restarting. */
  #unsettled(): number {
    let n = 0;
    for (const rt of this.#byId.values()) if (rt.state.currentTurnId || rt.reservedTurn || rt.starting || rt.restarting) n++;
    return n;
  }

  /** Stop every adapter session. Session status is left as-is so a restart can resume them. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#draining = true;
    // Before stopping: the agent's final turn.completed (interrupted) clears the turn as it goes.
    for (const rt of this.#byId.values()) this.#markInterrupted(rt, true);
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
    return rt.adapter ? safeCaps(rt.adapter, rt.info.mode) : NO_CAPABILITIES;
  }

  #assertAccepting(): void {
    if (this.#draining) throw new BizziError('conflict', 'node is shutting down; not accepting new turns');
  }

  #assertOpen(rt: Runtime): void {
    if (rt.deleted) throw new BizziError('conflict', 'session is being deleted');
    if (rt.info.status === 'ended' || rt.stopping) throw new BizziError('conflict', 'session has ended');
  }

  #terminalHandle(id: string): AdapterSession {
    const rt = this.#get(id);
    if (rt.info.mode !== 'terminal') throw new BizziError('unsupported', 'not a terminal-mode session');
    if (!rt.handle) throw new BizziError('conflict', 'the terminal is not running');
    return rt.handle;
  }

  #newInfo(workspaceId: string, agent: AgentKind, mode: SessionMode): SessionInfo {
    const now = new Date().toISOString();
    return {
      id: newId('s'),
      machineId: this.#d.machineId,
      workspaceId,
      agent,
      mode,
      status: 'starting',
      createdAt: now,
      updatedAt: now,
      lastSeq: 0,
    };
  }

  #register(rt: Runtime): void {
    this.#byId.set(rt.info.id, rt);
    this.#persist(rt);
    this.#d.bus.append(GLOBAL_CHANNEL, { type: 'session.created', data: { session: { ...rt.info } } });
  }

  /** Start in the background; the session is 'starting' until the adapter is up. */
  #startInBackground(rt: Runtime, resume: ResumeOpts): void {
    this.#ensureStarted(rt, resume).then(
      () => {
        if (rt.info.status === 'starting') this.#append(rt, { type: 'session.status', data: { status: 'idle' } });
      },
      () => {
        // #ensureStarted already recorded the failure on the session channel.
      },
    );
  }

  /** How the next (lazy) start continues the conversation: fork (not started yet), resume, or fresh. */
  #resumeFor(rt: Runtime): ResumeOpts {
    if (rt.state.startFresh) return {};
    if (rt.state.forkOf && !rt.info.agentSessionRef) return { resumeRef: rt.state.forkOf, fork: true };
    return this.#caps(rt).resume && rt.info.agentSessionRef ? { resumeRef: rt.info.agentSessionRef } : {};
  }

  /**
   * Start the adapter session unless it's running. With `restart`, a start failure is left to the
   * caller to record, and a changed agentSessionRef isn't adopted (the restart verifies it). The
   * first resume after a node restart goes through the restart sequence itself (updates.md §7).
   */
  #ensureStarted(rt: Runtime, resume: ResumeOpts, o: StartOpts = {}): Promise<AdapterSession> {
    if (rt.handle) return Promise.resolve(rt.handle);
    if (rt.starting) return rt.starting;
    const adapter = rt.adapter;
    if (!adapter) {
      return Promise.reject(new BizziError('agent_unavailable', `no adapter for ${rt.info.agent} in ${rt.info.mode} mode`));
    }
    const gen = ++rt.generation;
    const sessionId = rt.info.id;
    const logger = this.#d.logger.child({ sessionId, agent: rt.info.agent });
    const restart = Boolean(o.restart);
    const oldRef = resume.resumeRef;
    const afterNode = !restart && !resume.fork && oldRef && oldRef === rt.info.agentSessionRef ? rt.state.nodeRestarted : undefined;

    // What is about to be spawned (updates.md §2): the last probe's version and real path, or the
    // previous executable on a restart fallback.
    let spawned: AgentListing | undefined;
    let announced = false;
    /** Close an open node-restart divider when the start is abandoned. */
    const abandon = (error: string) => {
      if (!announced || rt.deleted || this.#closed || !this.#d.store.isOpen) return;
      announced = false;
      this.#append(rt, { type: 'session.restarted', data: { ...fromTo(afterNode?.fromVersion, probedVersion(spawned)), ok: false, error } });
    };
    const start = async (): Promise<AdapterSession> => {
      // A shared server being replaced: start on the new one, not the old (updates.md §3).
      const recycling = restart ? undefined : this.#recycling.get(adapter);
      if (recycling) await recycling;
      spawned = o.executable
        ? { agent: rt.info.agent, installed: true, auth: 'unknown', ...(o.version ? { version: o.version } : {}), realPath: o.executable }
        : this.#d.registry.lastKnown(rt.info.agent);
      if (afterNode) {
        // The divider names the version it resumes on, so ask the registry if nothing probed yet.
        spawned ??= (await this.#d.registry.list().catch(() => [])).find((a) => a.agent === rt.info.agent);
        if (gen === rt.generation && !this.#gone(rt)) {
          const data = { ...fromTo(afterNode.fromVersion, probedVersion(spawned)), reason: 'bizzi restarted' };
          this.#append(rt, { type: 'session.restarting', data });
          announced = true;
        }
      }
      const ws = this.#d.workspaces.get(rt.info.workspaceId);
      this.#d.workspaces.assertPresent(ws);
      const extra = this.#d.prepareStart ? await this.#d.prepareStart({ ...rt.info }, ws) : {};
      const agentEnv = this.#d.agentEnv ? await this.#d.agentEnv(rt.info.agent) : {};
      const opts: StartSessionOptions = { ...extra, sessionId, mode: rt.info.mode, cwd: ws.path };
      const env = { ...extra.env, ...agentEnv };
      if (Object.keys(env).length > 0) opts.env = env;
      this.#deriveBilling(rt, env);
      if (rt.info.model) opts.model = rt.info.model;
      if (rt.info.permissionMode) opts.permissionMode = rt.info.permissionMode;
      if (rt.info.effort) opts.effort = rt.info.effort;
      if (resume.resumeRef) opts.resumeRef = resume.resumeRef;
      if (resume.resumeRef && resume.fork) opts.fork = true;
      if (rt.state.command) opts.command = [...rt.state.command];
      if (rt.state.cols) opts.cols = rt.state.cols;
      if (rt.state.rows) opts.rows = rt.state.rows;
      if (o.executable) opts.executable = o.executable;
      // Container workspaces (topology.md §7): host-side MCP servers may not be reachable from inside.
      if (opts.launcher?.mapMcpServers && opts.mcpServers) {
        const mapped = opts.launcher.mapMcpServers(opts.mcpServers);
        if (Object.keys(mapped).length > 0) opts.mcpServers = mapped;
        else delete opts.mcpServers;
      }
      return adapter.start(opts, (body) => this.#onAdapterEvent(rt, gen, body), { logger });
    };

    const p = start().then(
      (handle) => {
        if (rt.starting === p) rt.starting = undefined;
        if (gen !== rt.generation || this.#closed || rt.deleted) {
          void handle.stop().catch(() => {});
          abandon('the session stopped during the resume');
          throw new BizziError('conflict', 'session was stopped while starting');
        }
        rt.handle = handle;
        if (rt.state.startFresh) {
          rt.state.startFresh = undefined;
          this.#persist(rt);
        }
        this.#recordAgent(rt, handle, spawned);
        if (afterNode && oldRef) return this.#verifyNodeResume(rt, handle, oldRef, afterNode, spawned);
        const ref = safeRef(handle);
        if (ref && ref !== rt.info.agentSessionRef && !restart) this.#append(rt, { type: 'session.info', data: { agentSessionRef: ref } });
        return handle;
      },
      (err: unknown) => {
        if (rt.starting === p) rt.starting = undefined;
        logger.log('warn', 'adapter start failed', { err });
        if (gen === rt.generation && !this.#closed && !restart) {
          if (afterNode) {
            rt.state.nodeRestarted = undefined;
            abandon(errorMessage(err));
          }
          this.#append(rt, { type: 'error', data: { message: `failed to start ${rt.info.agent}: ${errorMessage(err)}`, fatal: true } });
          this.#append(rt, { type: 'session.status', data: { status: 'failed', reason: errorMessage(err) } });
        }
        throw toBizziError(err, 'agent_unavailable');
      },
    );
    rt.starting = p;
    return p;
  }

  /**
   * The first start after a node restart resumed `oldRef` (updates.md §7 through §5 steps 5–6):
   * the agent must continue the same conversation; then the divider closes with the version it
   * runs now. On a mismatch the new process is stopped, the old ref kept and the session failed.
   */
  #verifyNodeResume(rt: Runtime, handle: AdapterSession, oldRef: string, mark: { fromVersion?: string }, spawned: AgentListing | undefined): AdapterSession {
    rt.state.nodeRestarted = undefined;
    this.#persist(rt);
    const v = fromTo(mark.fromVersion, rt.info.agentVersion ?? probedVersion(spawned));
    const ref = safeRef(handle) ?? rt.info.agentSessionRef;
    if (ref !== oldRef) {
      rt.handle = undefined;
      rt.generation++;
      void withTimeout(handle.stop(), STOP_TIMEOUT_MS).catch((err: unknown) => this.#log.log('warn', 'adapter stop failed', { sessionId: rt.info.id, err }));
      const error = `the agent resumed a different conversation (${ref ?? 'none'} instead of ${oldRef})`;
      this.#restartFailed(rt, oldRef, v, error);
      throw new BizziError('agent_unavailable', `resume after the node restart failed: ${error}`);
    }
    this.#append(rt, { type: 'session.restarted', data: { ...v, ok: true } });
    this.#log.log('info', 'agent resumed after a node restart', { sessionId: rt.info.id, agent: rt.info.agent, ...v });
    return handle;
  }

  /**
   * Record the version and real executable path of the process just spawned (updates.md §2). Before
   * the first probe the registry is asked in the background; the path is kept only if it exists.
   * A version the session reports itself (a shared server's own) wins over the probe's; the probe's
   * path is then kept only when both versions agree.
   */
  #recordAgent(rt: Runtime, handle: AdapterSession, spawned: AgentListing | undefined): void {
    const reported = safeAgentVersion(handle);
    const apply = (l: AgentListing | undefined) => {
      if (rt.handle !== handle || rt.deleted || this.#closed || !this.#d.store.isOpen) return;
      const probed = probedVersion(l);
      const version = reported ?? probed;
      const candidate = l?.installed && (!reported || reported === probed) ? (l.realPath ?? l.path) : undefined;
      const path = candidate && existsSync(candidate) ? candidate : undefined;
      if (rt.state.agentPath !== path) {
        rt.state.agentPath = path;
        this.#persist(rt);
      }
      if (rt.info.agentVersion !== version) {
        if (version) rt.info.agentVersion = version;
        else delete rt.info.agentVersion;
        this.#changed(rt, new Date().toISOString());
      }
    };
    if (spawned) {
      apply(spawned);
      return;
    }
    this.#d.registry.list().then(
      (agents) => apply(agents.find((a) => a.agent === rt.info.agent)),
      (err: unknown) => this.#log.log('debug', 'probe for the agent version failed', { sessionId: rt.info.id, err }),
    );
  }

  /** Why the agent process can't be replaced right now (updates.md §4 safe points), group-wide. */
  #unsafe(rt: Runtime): string | undefined {
    const own = this.#unsafeOne(rt);
    if (own) return own;
    for (const m of this.#group(rt)) {
      if (m === rt) continue;
      const why = this.#unsafeOne(m);
      if (why) return `${sessionLabel(m)} on the same ${m.info.agent} server: ${why}`;
    }
    return undefined;
  }

  #unsafeOne(rt: Runtime): string | undefined {
    if (rt.deleted || rt.stopping) return 'the session is stopping';
    if (TERMINAL_STATUSES.includes(rt.info.status)) return `the session has ${rt.info.status}`;
    if (rt.restarting) return 'a restart is already in progress';
    if (rt.state.queued) return 'the helper is queued';
    if (rt.starting) return 'the agent is starting';
    if (!rt.handle) return 'the agent is not running';
    // Adapters don't report background work (background shells, terminals, subagents) yet. Such
    // work runs inside a turn today, so "no turn in flight" stands in for "no background work".
    if (rt.state.currentTurnId || rt.reservedTurn) return 'a turn is in progress';
    if (rt.pendingApprovals.size > 0) return 'an approval is pending';
    if (rt.pendingQuestions.size > 0) return 'a question is waiting for an answer';
    if (rt.info.status !== 'idle' && rt.info.status !== 'waiting_input') return `the session is ${rt.info.status}`;
    return undefined;
  }

  #restartBlocker(rt: Runtime): string | undefined {
    const own = this.#restartBlockerOne(rt);
    if (own) return own;
    for (const m of this.#group(rt)) {
      if (m === rt) continue;
      const why = this.#restartBlockerOne(m);
      if (why) return `${sessionLabel(m)} on the same ${m.info.agent} server: ${why}`;
    }
    return undefined;
  }

  #restartBlockerOne(rt: Runtime): string | undefined {
    if (!this.#caps(rt).resume) return `${rt.info.agent} ${rt.info.mode} sessions cannot be resumed, so a restart would lose the conversation`;
    if (!rt.info.agentSessionRef) return 'the session has no agent conversation to resume yet';
    if (rt.adapter?.sharedProcess === 'external') {
      return `${rt.info.agent} sessions here run on a server bizzi did not start; restart that server instead`;
    }
    return undefined;
  }

  /** This session plus every other running session on the same shared server (updates.md §3). */
  #group(rt: Runtime): Runtime[] {
    const adapter = rt.adapter;
    if (adapter?.sharedProcess !== 'owned') return [rt];
    const out = [rt];
    for (const m of this.#byId.values()) {
      if (m !== rt && m.adapter === adapter && (m.handle || m.starting) && !m.deleted) out.push(m);
    }
    return out;
  }

  /** Wait (bounded) for an agent restart; a send queued behind a failed restart is refused. */
  async #waitForRestart(rt: Runtime): Promise<void> {
    const restarting = rt.restarting;
    if (!restarting) return;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      restarting.then(() => false),
      new Promise<boolean>((r) => {
        timer = setTimeout(() => r(true), this.#d.restartWaitMs ?? RESTART_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
    if (timedOut) throw new BizziError('conflict', 'the agent is restarting; try again shortly');
    if (rt.info.status === 'failed') throw new BizziError('agent_unavailable', 'the agent restart failed; see the session timeline');
  }

  /** True once the session can't be restarted any more (stopped, deleted, node shut down). */
  #gone(rt: Runtime): boolean {
    return rt.deleted || rt.stopping || this.#closed || !this.#d.store.isOpen || rt.info.status === 'ended';
  }

  /**
   * updates.md §5 steps 1–6 for every session in `group` (one, or all sessions on a shared server).
   * The caller holds `restarting` on each.
   */
  async #restart(group: Runtime[], reason: string | undefined): Promise<Map<Runtime, RestartOutcome>> {
    const lead = group[0]!;
    const agent = lead.info.agent;
    const adapter = lead.adapter;
    const out = new Map<Runtime, RestartOutcome>();
    // What each process ran before; the previous executable is the fallback (§5).
    const before = new Map<Runtime, Before>();
    for (const m of group) {
      const b: Before = { ref: m.info.agentSessionRef! };
      if (m.info.agentVersion) b.version = m.info.agentVersion;
      if (m.state.agentPath) b.path = m.state.agentPath;
      before.set(m, b);
    }
    const versions = (m: Runtime, to: string | undefined) => fromTo(before.get(m)!.version, to);

    // 1. Precheck the installed binary: it runs (`--version`) and its login still works. A broken
    //    update must not take the sessions down, so the old processes keep running.
    let probe: AgentListing | undefined;
    try {
      probe = (await this.#d.registry.list(true)).find((a) => a.agent === agent);
    } catch (err) {
      this.#log.log('warn', 'probe before restart failed', { sessionId: lead.info.id, err });
    }
    const live: Runtime[] = [];
    for (const m of group) {
      if (this.#gone(m)) out.set(m, { ok: false, aborted: true, ...versions(m, probe?.version), error: 'the session stopped' });
      else live.push(m);
    }
    if (live.length === 0) return out;
    const problem = precheckProblem(probe);
    if (problem) {
      const error = `not restarting on ${probe?.version ? `${agent} ${probe.version}` : 'the installed version'}: ${problem}`;
      this.#log.log('warn', 'restart precheck failed', { sessionId: lead.info.id, agent, problem, sessions: live.length });
      for (const m of live) {
        m.restartFailedFor = installKey(probe);
        const from = before.get(m)!.version;
        this.#append(m, {
          type: 'error',
          data: { message: `${error}. The session keeps running${from ? ` on ${from}` : ''}.`, code: 'restart_precheck' },
        });
        out.set(m, { ok: false, precheck: true, ...versions(m, probe?.version), error });
      }
      return out;
    }
    const installed = probe!;
    const toVersion = installed.version;

    // 2. Announce, 3. stop the old processes gracefully. A shared server is replaced once every
    //    session on it has stopped; new sessions on it wait for that instead of landing on the old one.
    for (const m of live) {
      this.#append(m, { type: 'session.restarting', data: { ...versions(m, toVersion), ...(reason ? { reason } : {}) } });
    }
    let recycleError: string | undefined;
    const recycle = (async () => {
      await Promise.all(live.map((m) => this.#stopHandle(m)));
      if (adapter?.sharedProcess === 'owned' && adapter.recycle) {
        try {
          await adapter.recycle();
        } catch (err) {
          recycleError = `could not replace the shared ${agent} server: ${errorMessage(err)}`;
          this.#log.log('warn', 'shared agent server recycle failed', { agent, err });
        }
      }
    })();
    if (adapter?.sharedProcess === 'owned') this.#recycling.set(adapter, recycle);
    try {
      await recycle;
    } finally {
      if (adapter && this.#recycling.get(adapter) === recycle) this.#recycling.delete(adapter);
    }

    // 4.–6. per session.
    await Promise.all(
      live.map(async (m) => {
        out.set(m, await this.#resumeOnto(m, before.get(m)!, installed, versions(m, toVersion), recycleError));
      }),
    );
    return out;
  }

  /**
   * updates.md §5 steps 4–6 for one session whose old process was stopped: spawn the installed
   * version and resume, fall back to the previous version on a failed spawn, verify, announce.
   */
  async #resumeOnto(rt: Runtime, prev: Before, probe: AgentListing, v: FromTo, recycleError: string | undefined): Promise<RestartOutcome> {
    const agent = rt.info.agent;
    const aborted = (): RestartOutcome => {
      const error = 'the session stopped during the restart';
      if (!rt.deleted && !this.#closed && this.#d.store.isOpen) {
        this.#append(rt, { type: 'session.restarted', data: { ...v, ok: false, error } });
      }
      return { ok: false, aborted: true, ...v, error };
    };
    if (this.#gone(rt)) return aborted();

    // 4. Spawn the installed version and resume. The prepareStart chain re-injects MCP servers and
    //    instructions; model, effort and permission mode come from the session info.
    let handle: AdapterSession;
    try {
      handle = await this.#ensureStarted(rt, { resumeRef: prev.ref }, { restart: true });
    } catch (err) {
      if (this.#gone(rt)) return aborted();
      const error = `could not start ${agent}${v.toVersion ? ` ${v.toVersion}` : ''}: ${errorMessage(err)}`;
      return this.#fallBack(rt, prev, probe, v, error, aborted);
    }
    if (this.#gone(rt)) return aborted();

    // 5. Verify the resume: the agent must continue the same conversation. TODO: deeper checks
    //    (e.g. the resumed conversation's message count) need an adapter hook.
    const ref = safeRef(handle) ?? rt.info.agentSessionRef;
    if (ref !== prev.ref) {
      await this.#stopHandle(rt);
      return this.#restartFailed(rt, prev.ref, v, `the agent resumed a different conversation (${ref ?? 'none'} instead of ${prev.ref})`);
    }

    // 6. Done. Context usage is re-read by the adapter on its next report (usage.md §1).
    if (recycleError) {
      // Resumed, but on whatever the shared server runs now; report the version it says it runs.
      rt.restartFailedFor = installKey(probe);
      const running = rt.info.agentVersion;
      const data = { ...v, ok: false, error: recycleError, ...(running ? { fallbackVersion: running } : {}) };
      this.#append(rt, { type: 'session.restarted', data });
      return data;
    }
    rt.restartFailedFor = undefined;
    const outcome = fromTo(v.fromVersion, rt.info.agentVersion ?? v.toVersion);
    this.#append(rt, { type: 'session.restarted', data: { ...outcome, ok: true } });
    this.#log.log('info', 'agent restarted', { sessionId: rt.info.id, agent, ...outcome });
    return { ok: true, ...outcome };
  }

  /**
   * The installed version failed to start: resume on the previous executable while it's still on
   * disk (updates.md §5; Claude native and Codex script keep version dirs), and alert. Only for
   * adapters that take an explicit executable; otherwise, or if that fails too, the restart fails.
   */
  async #fallBack(rt: Runtime, prev: Before, probe: AgentListing, v: FromTo, error: string, aborted: () => RestartOutcome): Promise<RestartOutcome> {
    const installed = probe.realPath ?? probe.path;
    if (!rt.adapter?.acceptsExecutable || !prev.path || !prev.version || prev.path === installed || !existsSync(prev.path)) {
      return this.#restartFailed(rt, prev.ref, v, error);
    }
    this.#log.log('warn', 'new agent version failed to start; falling back to the previous one', {
      sessionId: rt.info.id,
      agent: rt.info.agent,
      from: prev.version,
      path: prev.path,
      error,
    });
    let handle: AdapterSession;
    try {
      handle = await this.#ensureStarted(rt, { resumeRef: prev.ref }, { restart: true, executable: prev.path, version: prev.version });
    } catch (err) {
      if (this.#gone(rt)) return aborted();
      return this.#restartFailed(rt, prev.ref, v, `${error}; falling back to ${prev.version} failed too: ${errorMessage(err)}`);
    }
    if (this.#gone(rt)) return aborted();
    const ref = safeRef(handle) ?? rt.info.agentSessionRef;
    if (ref !== prev.ref) {
      await this.#stopHandle(rt);
      return this.#restartFailed(rt, prev.ref, v, `${error}; the fallback onto ${prev.version} resumed a different conversation`);
    }
    // No automatic retry on the install that failed; `session.restart` tries it again.
    rt.restartFailedFor = installKey(probe);
    const running = rt.info.agentVersion ?? prev.version;
    this.#append(rt, { type: 'session.restarted', data: { ...v, ok: false, error, fallbackVersion: running } });
    this.#append(rt, {
      type: 'error',
      data: { message: `${error}. The session resumed on ${running} instead and stays on it until the new version starts.`, code: 'restart_fallback' },
    });
    this.#log.log('info', 'agent resumed on the previous version', { sessionId: rt.info.id, agent: rt.info.agent, version: running });
    return { ok: false, ...v, error, fallbackVersion: running };
  }

  /** A failed spawn or resume: mark the session failed, keep (and show) the old ref, never retry automatically. */
  #restartFailed(rt: Runtime, oldRef: string, versions: FromTo, error: string): RestartOutcome {
    rt.restartFailedFor = installKey(this.#d.registry.lastProbe(rt.info.agent));
    this.#log.log('warn', 'agent restart failed', { sessionId: rt.info.id, agent: rt.info.agent, error });
    if (rt.info.agentSessionRef !== oldRef) this.#append(rt, { type: 'session.info', data: { agentSessionRef: oldRef } });
    this.#append(rt, { type: 'session.restarted', data: { ...versions, ok: false, error } });
    this.#append(rt, { type: 'session.status', data: { status: 'failed', reason: `restart failed: ${error}` } });
    return { ok: false, ...versions, error };
  }

  async #stopHandle(rt: Runtime): Promise<void> {
    const starting = rt.starting;
    const handle = rt.handle;
    rt.handle = undefined;
    if (handle) {
      rt.stoppingAgent = true;
      try {
        await withTimeout(handle.stop(), STOP_TIMEOUT_MS).catch((err: unknown) => {
          this.#log.log('warn', 'adapter stop failed', { sessionId: rt.info.id, err });
        });
      } finally {
        rt.stoppingAgent = false;
      }
    }
    // Invalidate after stop() so events emitted while stopping (e.g. turn.completed) are kept.
    rt.generation++;
    if (starting) await starting.catch(() => {});
    clearTimeout(rt.interruptTimer);
  }

  /** Complete the open turn (if any) and cancel pending approvals / questions. */
  #closeOpenTurn(rt: Runtime, stopReason: 'interrupted' | 'error', error: string): void {
    const turnId = rt.state.currentTurnId;
    if (turnId) this.#append(rt, { type: 'turn.completed', data: { turnId, stopReason, error } });
    else this.#cancelPending(rt, true);
  }

  /**
   * Resolve every pending approval / question as canceled. With `settle`, a waiting status falls back
   * to running/idle; without it the caller sets the final status (turn.completed, session.status).
   */
  #cancelPending(rt: Runtime, settle: boolean): void {
    if (rt.pendingApprovals.size === 0 && rt.pendingQuestions.size === 0) return;
    rt.settling = true;
    try {
      for (const approvalId of [...rt.pendingApprovals.keys()]) {
        rt.cancelled.add(approvalId);
        this.#append(rt, { type: 'approval.resolved', data: { approvalId, decision: 'cancelled' } });
      }
      for (const questionId of [...rt.pendingQuestions.keys()]) {
        rt.cancelled.add(questionId);
        this.#append(rt, { type: 'question.resolved', data: { questionId, cancelled: true } });
      }
    } finally {
      rt.settling = false;
    }
    const status = rt.info.status;
    if (settle && (status === 'waiting_approval' || status === 'waiting_input')) {
      rt.info.status = this.#settledStatus(rt);
      this.#changed(rt, new Date().toISOString());
    }
  }

  /** The status a session in a waiting state falls back to. */
  #settledStatus(rt: Runtime): SessionStatus {
    if (rt.pendingApprovals.size > 0) return 'waiting_approval';
    if (rt.pendingQuestions.size > 0) return 'waiting_input';
    return rt.state.currentTurnId ? 'running' : 'idle';
  }

  /**
   * The agent process exited or crashed on its own. The session stays open: the turn closes, and the
   * next message (or keystroke, in a terminal) starts the agent again, resuming its conversation
   * when it can (spec §4.1). A crash leaves the session 'failed' so it stands out until then.
   */
  #agentExited(rt: Runtime, crashed: boolean, reason: string | undefined): void {
    const why = reason ?? (crashed ? 'it crashed' : 'it exited');
    this.#closeOpenTurn(rt, 'error', `the agent process ended (${why})`);
    const handle = rt.handle;
    rt.handle = undefined;
    rt.generation++;
    if (handle) void handle.stop().catch(() => {});
    const next = rt.info.mode === 'terminal' ? 'Press a key in the terminal to start it again' : 'Your next message resumes the session';
    this.#append(rt, {
      type: 'error',
      data: { message: `${rt.info.agent} ${crashed ? 'stopped unexpectedly' : 'exited'} (${why}). ${next}.`, code: 'agent_exited', fatal: false },
    });
    this.#append(rt, { type: 'session.status', data: crashed ? { status: 'failed', reason: why } : { status: 'idle', reason: `agent exited: ${why}` } });
  }

  #onAdapterEvent(rt: Runtime, gen: number, body: SessionEventBody): void {
    if (gen !== rt.generation || !this.#d.store.isOpen || this.#closed || rt.deleted) {
      this.#log.log('debug', 'dropping event from a stale adapter session', { sessionId: rt.info.id, type: body?.type });
      return;
    }
    if (!body || typeof body.type !== 'string') {
      this.#log.log('warn', 'adapter emitted a malformed event', { sessionId: rt.info.id });
      return;
    }
    switch (body.type) {
      case 'turn.started':
      case 'turn.steered':
        this.#log.log('warn', `adapters must not emit ${body.type}; dropped`, { sessionId: rt.info.id });
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
      case 'approval.resolved':
        if (rt.cancelled.has(body.data.approvalId) && !rt.pendingApprovals.has(body.data.approvalId)) {
          this.#log.log('debug', 'approval already cancelled; dropped', { sessionId: rt.info.id, approvalId: body.data.approvalId });
          return;
        }
        break;
      case 'question.resolved':
        if (rt.cancelled.has(body.data.questionId) && !rt.pendingQuestions.has(body.data.questionId)) {
          this.#log.log('debug', 'question already cancelled; dropped', { sessionId: rt.info.id, questionId: body.data.questionId });
          return;
        }
        break;
      case 'session.status':
        if (body.data.status === 'ended' || body.data.status === 'failed') {
          // The agent process went away. When bizzi stopped it (session.stop, shutdown, a restart),
          // the core sets the status itself; the session doesn't end with the process.
          if (rt.stoppingAgent) return;
          this.#agentExited(rt, body.data.status === 'failed', body.data.reason);
          return;
        }
        break;
    }
    this.#append(rt, body);
  }

  /**
   * On helpers the parent may answer for (spec §12.5), stamp who answered (the responder recorded by
   * respondApproval / respondQuestion) unless the adapter already said, and remember it so a late second
   * answer learns who was first. Other sessions only have you answering; their events stay as they were.
   */
  #stampResolution(rt: Runtime, body: Extract<SessionEventBody, { type: 'approval.resolved' | 'question.resolved' }>): SessionEventBody {
    const itemId = body.type === 'approval.resolved' ? body.data.approvalId : body.data.questionId;
    const pending = body.type === 'approval.resolved' ? rt.pendingApprovals.has(itemId) : rt.pendingQuestions.has(itemId);
    if (!pending) return body;
    const responder = rt.responders.get(itemId);
    rt.responders.delete(itemId);
    // A core cancellation (turn ended, node restart) isn't anyone's answer.
    const coreCancel = body.type === 'approval.resolved' && body.data.decision === 'cancelled';
    if (!responder || coreCancel || body.data.by !== undefined) return body;
    if (responder.by === 'user' && !rt.info.parentAnswersApprovals) return body;
    const stamp = responder.by === 'parent' ? { by: 'parent', bySessionId: responder.sessionId } : { by: 'user' };
    const out: SessionEventBody =
      body.type === 'approval.resolved' ? { type: body.type, data: { ...body.data, ...stamp } } : { type: body.type, data: { ...body.data, ...stamp } };
    const outcome = body.type === 'approval.resolved' ? body.data.decision : body.data.cancelled ? 'cancelled' : 'answered';
    const r: Resolution = { outcome, by: stamp.by };
    if (responder.by === 'parent') r.bySessionId = responder.sessionId;
    rt.resolutions.set(itemId, r);
    if (rt.resolutions.size > RESOLUTIONS_KEPT) rt.resolutions.delete(rt.resolutions.keys().next().value!);
    return out;
  }

  /** Append to the session channel and update derived state (status, info, pending approvals/questions). */
  #append(rt: Runtime, body: SessionEventBody): void {
    if (rt.deleted) return;
    if (body.type === 'approval.resolved' || body.type === 'question.resolved') body = this.#stampResolution(rt, body);
    if (body.type === 'turn.completed') {
      // Exactly one turn.completed per turnId: duplicates and unknown turns are dropped.
      if (body.data.turnId !== rt.state.currentTurnId) return;
      // A turn's approvals and questions end with it; resolve them before the turn closes.
      this.#cancelPending(rt, false);
    }
    const ev = this.#d.bus.append(sessionChannel(rt.info.id), body);
    rt.info.lastSeq = ev.seq;
    const info = rt.info;
    const terminal = TERMINAL_STATUSES.includes(info.status);
    let changed = false;
    let pendingChanged = false;
    const setStatus = (s: SessionStatus) => {
      if (info.status !== s) {
        info.status = s;
        changed = true;
      }
    };

    switch (body.type) {
      case 'turn.started':
        rt.state.currentTurnId = body.data.turnId;
        rt.cancelled.clear();
        setStatus('running');
        changed = true;
        // bizzi's own continue-after-restart isn't the user's request: it never titles the session.
        if (!body.data.auto) this.#noteUserTurn(rt, body.data.input);
        break;
      case 'turn.completed':
        rt.state.currentTurnId = undefined;
        rt.state.spent = addTurn(rt.state.spent ?? zeroSpent(), body.data.usage as Usage | undefined, info.billing);
        rt.responders.clear();
        rt.pendingApprovals.clear();
        rt.responding.clear();
        rt.pendingQuestions.clear();
        rt.answering.clear();
        clearTimeout(rt.interruptTimer);
        rt.interruptTimer = undefined;
        if (!terminal) setStatus('idle');
        changed = true;
        break;
      case 'approval.requested':
        rt.pendingApprovals.set(body.data.approvalId, body.data);
        pendingChanged = true;
        if (!terminal) setStatus('waiting_approval');
        break;
      case 'approval.resolved':
        pendingChanged = rt.pendingApprovals.delete(body.data.approvalId);
        rt.responding.delete(body.data.approvalId);
        if (!terminal && !rt.settling && info.status === 'waiting_approval') setStatus(this.#settledStatus(rt));
        break;
      case 'question.asked':
        rt.pendingQuestions.set(body.data.questionId, body.data);
        pendingChanged = true;
        if (!terminal && info.status !== 'waiting_approval') setStatus('waiting_input');
        break;
      case 'question.resolved':
        pendingChanged = rt.pendingQuestions.delete(body.data.questionId);
        rt.answering.delete(body.data.questionId);
        if (!terminal && !rt.settling && pendingChanged && info.status === 'waiting_input') {
          setStatus(this.#settledStatus(rt));
        }
        break;
      case 'session.status':
        setStatus(body.data.status);
        break;
      case 'session.info':
        for (const k of ['agentSessionRef', 'model', 'permissionMode', 'effort', 'title'] as const) {
          if (k === 'title' && (rt.state.titleByUser || !body.data.title?.trim() || isPlaceholderTitle(body.data.title))) continue;
          const v = body.data[k];
          if (v !== undefined && info[k] !== v) {
            info[k] = v;
            changed = true;
          }
          // The agent named the session: its title stays over a title model's late answer.
          if (k === 'title' && v !== undefined && rt.state.titleAuto) {
            rt.state.titleAuto = undefined;
            changed = true;
          }
        }
        // A forked session continues from its own agent session once it has one.
        if (info.agentSessionRef && rt.state.forkOf) {
          rt.state.forkOf = undefined;
          changed = true;
        }
        break;
      case 'context.cleared':
        if (info.agentSessionRef !== undefined) {
          delete info.agentSessionRef;
          changed = true;
        }
        // A fresh conversation: the old one's context occupancy no longer applies, and the next
        // message says what the session is about now, so it titles the session again.
        if (info.context !== undefined) {
          delete info.context;
          changed = true;
        }
        if (!rt.state.titleByUser && !rt.state.retitleNext) {
          rt.state.retitleNext = true;
          pendingChanged = true;
        }
        if (rt.state.forkOf || rt.state.nodeRestarted) {
          rt.state.forkOf = undefined;
          rt.state.nodeRestarted = undefined;
          pendingChanged = true;
        }
        break;
      case 'context.updated':
      case 'context.compacted':
        this.#noteContext(rt, body);
        break;
      case 'account.usage':
        // The login's billing class, as the agent reports it (spec §12.3).
        if (body.data.billing && info.billing !== body.data.billing) {
          info.billing = body.data.billing;
          changed = true;
        }
        break;
    }
    if (!terminal && TERMINAL_STATUSES.includes(info.status) && rt.state.queued) {
      rt.state.queued = undefined;
      changed = true;
    }
    if (changed) this.#changed(rt, ev.ts);
    else if (pendingChanged) this.#persist(rt);

    if (!terminal && info.status === 'ended') {
      // Child helpers stop when their parent is closed (load() cascades once everything is loaded).
      if (!this.#loading) this.#cascade(info.id);
    } else if (body.type === 'turn.completed' && !terminal) {
      // Budgets are enforced at turn boundaries (usage.md §2).
      const over = this.#budgetExceeded(rt);
      if (over) this.#blockForBudget(rt, over);
    }
  }

  // --- helpers and budgets ---------------------------------------------------------------------------

  /** Stop every child-scope helper of `parentId` that is still open. Detached helpers outlive it. */
  #cascade(parentId: string): void {
    for (const child of this.#byId.values()) {
      if (child.info.spawnedBy !== parentId || child.info.scope !== 'child') continue;
      if (child.deleted || child.info.status === 'ended') continue;
      this.#log.log('debug', 'stopping child helper with its parent', { sessionId: child.info.id, parentId });
      this.stop(child.info.id).catch((err: unknown) => {
        this.#log.log('warn', 'failed to stop child helper', { sessionId: child.info.id, parentId, err });
      });
    }
  }

  /** Hold the session at this turn boundary: waiting_input with prompt 'budget'; send() refuses until raised. */
  #blockForBudget(rt: Runtime, reason: string): void {
    rt.state.budgetBlocked = reason;
    this.#append(rt, { type: 'session.status', data: { status: 'waiting_input', prompt: 'budget', reason } });
    this.#persist(rt);
  }

  /** Why the session may not start another turn, or undefined while every applicable cap has room. */
  #budgetExceeded(rt: Runtime): string | undefined {
    const chain = this.#ancestry(rt);
    for (const a of chain) {
      if (!a.info.budget) continue;
      const hit = budgetReached(a.info.budget, this.#treeSpent(a));
      if (hit) return a === rt ? `budget reached: ${hit}` : `budget of session ${a.info.id} reached: ${hit}`;
    }
    const root = chain[chain.length - 1]!;
    let cap: number | undefined;
    try {
      cap = this.#d.treeBudgetUsd?.(root.info.workspaceId);
    } catch {
      cap = undefined;
    }
    if (cap !== undefined) {
      const spent = this.#treeSpent(root).usd;
      if (spent >= cap) return `tree budget reached: ${usd(spent)} of ${usd(cap)} metered spend`;
    }
    return undefined;
  }

  /** The session, then its parent, grandparent… (stops at a missing or repeated id). */
  #ancestry(rt: Runtime): Runtime[] {
    const out = [rt];
    const seen = new Set([rt.info.id]);
    let cur = rt;
    while (cur.info.spawnedBy && !seen.has(cur.info.spawnedBy)) {
      const parent = this.#byId.get(cur.info.spawnedBy);
      if (!parent) break;
      seen.add(parent.info.id);
      out.push(parent);
      cur = parent;
    }
    return out;
  }

  /** Spend of a session plus every helper below it (child and detached). */
  #treeSpent(rt: Runtime): Spent {
    const children = new Map<string, Runtime[]>();
    for (const r of this.#byId.values()) {
      const p = r.info.spawnedBy;
      if (!p) continue;
      let list = children.get(p);
      if (!list) children.set(p, (list = []));
      list.push(r);
    }
    const all: Spent[] = [];
    const seen = new Set<string>();
    const walk = (r: Runtime) => {
      if (seen.has(r.info.id)) return;
      seen.add(r.info.id);
      all.push(r.state.spent ?? zeroSpent());
      // Helpers on other machines, as last reported (spec §12.4).
      for (const remote of Object.values(r.state.remoteSpent ?? {})) all.push(remote);
      for (const c of children.get(r.info.id) ?? []) walk(c);
    };
    walk(rt);
    return sumSpent(all);
  }

  /**
   * Billing class (spec §12.3): an API key in the session's environment means metered, a plan token
   * means plan; otherwise ask the probe in the background. Unknown stays undefined (usd isn't counted).
   */
  #deriveBilling(rt: Runtime, env: Record<string, string>): void {
    const agent = rt.info.agent;
    for (const [name, billing] of BILLING_ENV[agent] ?? []) {
      if (env[name] || process.env[name]) {
        this.#setBilling(rt, billing);
        return;
      }
    }
    if (rt.info.billing || !this.#d.probeBilling) return;
    this.#d.probeBilling(agent).then(
      (billing) => {
        if (billing && !rt.info.billing) this.#setBilling(rt, billing);
      },
      (err: unknown) => this.#log.log('debug', 'billing probe failed', { agent, err }),
    );
  }

  /**
   * A message from the user (not bizzi's own): titles an untitled session (or one just cleared with
   * `/clear`) from it, and otherwise counts toward re-titling an automatic title as the conversation
   * drifts (titles.ts `RETITLE_AT`, title model only). The caller publishes the change.
   */
  #noteUserTurn(rt: Runtime, input: InputBlock[]): void {
    const text = messageText(input);
    // Older nodes sent the continue-after-restart message without `auto`.
    if (isBizziNote(text) || rt.state.titleByUser) return;
    rt.recent = [...(rt.recent ?? []), text].filter(Boolean).slice(-RECENT_KEPT);
    if (!rt.info.title || rt.state.retitleNext) {
      if (!autoTitle(input)) return;
      rt.state.retitleNext = undefined;
      rt.state.intent = text.slice(0, INTENT_MAX) || undefined;
      rt.state.userTurns = 0;
      rt.recent = [];
      this.#autoTitle(rt, input);
      return;
    }
    if (!rt.state.titleAuto) return;
    rt.state.userTurns = (rt.state.userTurns ?? 0) + 1;
    if (RETITLE_AT.includes(rt.state.userTurns)) this.#retitle(rt);
  }

  /**
   * Title a session from a message (titles.ts), then ask the title model, when there is one, for a
   * better one. The model's answer is dropped if the user or the agent named the session meanwhile.
   * `quiet`: publish the model's answer without bumping `updatedAt` (titles repaired at load). The
   * caller publishes the first change.
   */
  #autoTitle(rt: Runtime, input: InputBlock[], opts: { quiet?: boolean } = {}): void {
    const title = autoTitle(input);
    if (!title) return;
    rt.info.title = title;
    rt.state.titleAuto = true;
    const text = messageText(input).slice(0, TITLE_PROMPT_MAX);
    if (text) this.#suggest(rt, text, title, opts.quiet ?? false);
  }

  /** Re-title an automatic title from the original request and the latest messages (title model only). */
  #retitle(rt: Runtime): void {
    const title = rt.info.title;
    if (!this.#d.suggestTitle || !title) return;
    const intent = rt.state.intent ?? messageText(this.#firstUserInput(rt) ?? []);
    if (!intent || !rt.recent?.length) return;
    this.#suggest(rt, retitlePrompt(intent, rt.recent), title, true);
  }

  #suggest(rt: Runtime, prompt: string, title: string, quiet: boolean): void {
    const suggest = this.#d.suggestTitle;
    if (!suggest) return;
    suggest(prompt).then(
      (raw) => {
        const better = raw === undefined ? undefined : cleanSuggestedTitle(raw);
        if (!better || rt.deleted || this.#closed || !this.#d.store.isOpen) return;
        if (!rt.state.titleAuto || rt.state.titleByUser || rt.info.title !== title || better === title) return;
        rt.info.title = better;
        if (quiet) this.#publish(rt);
        else this.#changed(rt, new Date().toISOString());
      },
      (err: unknown) => this.#log.log('debug', 'title suggestion failed', { sessionId: rt.info.id, err }),
    );
  }

  /** The user's first message in the session's history (bizzi's own messages skipped), if any. */
  #firstUserInput(rt: Runtime): InputBlock[] | undefined {
    const ch = sessionChannel(rt.info.id);
    let since = 0;
    // Bounded: the first message is near the start; a session without one in 5000 events has none worth it.
    for (let page = 0; page < 10; page++) {
      const evs = this.#d.bus.replay(ch, since, REPLAY_PAGE);
      for (const ev of evs) {
        if (ev.type === 'turn.started' && !ev.data.auto && !isBizziNote(messageText(ev.data.input)) && autoTitle(ev.data.input)) return ev.data.input;
      }
      if (evs.length < REPLAY_PAGE) return undefined;
      since = evs[evs.length - 1]!.seq;
    }
    return undefined;
  }

  /**
   * At load: sessions titled from bizzi's own continue-after-restart message (before bizzi marked it),
   * and sessions never titled, take their title from the user's first message in their history.
   * Publishes without bumping `updatedAt`, so lists keep their order.
   */
  #repairTitles(): void {
    for (const rt of this.#byId.values()) {
      if (rt.state.titleByUser || rt.info.lastSeq === 0) continue;
      const bad = rt.info.title !== undefined && isBizziNote(rt.info.title);
      if (rt.info.title !== undefined && !bad) continue;
      const input = this.#firstUserInput(rt);
      if (!input) {
        if (!bad) continue;
        delete rt.info.title;
        rt.state.titleAuto = undefined;
      } else {
        rt.state.intent = messageText(input).slice(0, INTENT_MAX) || undefined;
        this.#autoTitle(rt, input, { quiet: true });
      }
      this.#publish(rt);
    }
  }

  /** Persist and broadcast the session's info without bumping `updatedAt` (not activity). */
  #publish(rt: Runtime): void {
    if (rt.deleted) return;
    this.#persist(rt);
    this.#d.bus.append(GLOBAL_CHANNEL, { type: 'session.updated', data: { session: { ...rt.info } } });
  }

  #setBilling(rt: Runtime, billing: BillingClass): void {
    if (rt.deleted || rt.info.billing === billing || this.#closed || !this.#d.store.isOpen) return;
    rt.info.billing = billing;
    this.#changed(rt, new Date().toISOString());
  }

  /**
   * Keep the latest context occupancy on the session info for lists. Broadcast only when the rounded
   * percentage moves (agents report often), and without bumping `updatedAt`: context isn't activity.
   */
  #noteContext(rt: Runtime, body: Extract<SessionEventBody, { type: 'context.updated' | 'context.compacted' }>): void {
    const prev = rt.info.context;
    let next: SessionContext | undefined;
    if (body.type === 'context.updated') {
      const { used, window, usable, compactAt } = body.data;
      if (!(window > 0)) return;
      next = { used, window };
      if (usable !== undefined) next.usable = usable;
      if (compactAt !== undefined) next.compactAt = compactAt;
    } else {
      if (!prev || body.data.after === undefined) return;
      next = { ...prev, used: body.data.after };
    }
    rt.info.context = next;
    const same = (a: SessionContext, b: SessionContext): boolean =>
      Math.round(contextFraction(a) * 100) === Math.round(contextFraction(b) * 100) && a.window === b.window && a.usable === b.usable && a.compactAt === b.compactAt;
    if (prev && same(prev, next)) return;
    this.#persist(rt);
    this.#d.bus.append(GLOBAL_CHANNEL, { type: 'session.updated', data: { session: { ...rt.info } } });
  }

  #changed(rt: Runtime, ts: string): void {
    if (rt.deleted) return;
    rt.info.updatedAt = ts;
    this.#persist(rt);
    this.#d.bus.append(GLOBAL_CHANNEL, { type: 'session.updated', data: { session: { ...rt.info } } });
  }

  #persist(rt: Runtime): void {
    if (rt.deleted) return;
    const state: SessionState = {};
    if (rt.state.currentTurnId) state.currentTurnId = rt.state.currentTurnId;
    if (rt.state.command) state.command = rt.state.command;
    if (rt.state.forkOf) state.forkOf = rt.state.forkOf;
    if (rt.pendingApprovals.size > 0) state.pendingApprovals = [...rt.pendingApprovals.keys()];
    if (rt.pendingQuestions.size > 0) state.pendingQuestions = [...rt.pendingQuestions.keys()];
    if (rt.state.cols) state.cols = rt.state.cols;
    if (rt.state.rows) state.rows = rt.state.rows;
    if (rt.state.spent) state.spent = rt.state.spent;
    if (rt.state.budgetBlocked) state.budgetBlocked = rt.state.budgetBlocked;
    if (rt.state.queued) state.queued = true;
    if (rt.state.agentPath) state.agentPath = rt.state.agentPath;
    if (rt.state.nodeRestarted) state.nodeRestarted = rt.state.nodeRestarted;
    if (rt.state.titleByUser) state.titleByUser = true;
    if (rt.state.titleAuto) state.titleAuto = true;
    if (rt.state.intent) state.intent = rt.state.intent;
    if (rt.state.userTurns) state.userTurns = rt.state.userTurns;
    if (rt.state.retitleNext) state.retitleNext = true;
    if (rt.state.closed) state.closed = true;
    if (rt.state.startFresh) state.startFresh = true;
    if (rt.state.interruptedTurn) state.interruptedTurn = rt.state.interruptedTurn;
    if (rt.state.autoResumes) state.autoResumes = rt.state.autoResumes;
    if (rt.state.plannedResumes) state.plannedResumes = rt.state.plannedResumes;
    if (rt.state.remoteParent) state.remoteParent = rt.state.remoteParent;
    if (rt.state.remoteSpent) state.remoteSpent = rt.state.remoteSpent;
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

export function validateCommand(command: unknown): asserts command is string[] {
  if (!Array.isArray(command) || command.length === 0 || !command.every((a) => typeof a === 'string')) {
    throw new BizziError('bad_request', 'command must be a non-empty array of strings');
  }
  if (command[0] === '') throw new BizziError('bad_request', 'command[0] must be a program name');
}

/** A second answer while the first is still being delivered to the agent. */
function inFlight(rt: Runtime, what: 'approval' | 'question', itemId: string): BizziError {
  const r = rt.responders.get(itemId);
  const who = r?.by === 'parent' ? `the parent session ${r.sessionId}` : r?.by === 'user' ? 'the user' : 'someone else';
  return new BizziError('conflict', `${what} ${itemId} is already being answered by ${who}`, {
    alreadyAnswered: true,
    outcome: 'in_flight',
    ...(r ? { by: r.by } : {}),
    ...(r?.by === 'parent' ? { bySessionId: r.sessionId } : {}),
  });
}

function validateAnswers(answers: unknown, q: QuestionAsked): QuestionAnswers {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    throw new BizziError('bad_request', 'answers must be an object keyed by question id');
  }
  const known = q.questions ? new Set(q.questions.map((x) => x.id)) : undefined;
  const out: QuestionAnswers = {};
  for (const [id, v] of Object.entries(answers as Record<string, unknown>)) {
    if (known && !known.has(id)) throw new BizziError('bad_request', `unknown question id ${id}`);
    if (typeof v === 'string') out[id] = v;
    else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) out[id] = [...(v as string[])];
    else throw new BizziError('bad_request', `answer for ${id} must be a string or an array of strings`);
  }
  return out;
}

function safeCaps(adapter: AgentAdapter, mode: SessionMode): AgentCapabilities {
  try {
    return adapter.capabilities(mode);
  } catch {
    return NO_CAPABILITIES;
  }
}

/** How another session is named in a message ("session \"title\"" or its id). */
function sessionLabel(rt: { info: SessionInfo }): string {
  return rt.info.title ? `session "${rt.info.title}"` : `session ${rt.info.id}`;
}

/** The version a probe reports for an installed agent. */
function probedVersion(l: AgentListing | undefined): string | undefined {
  return l?.installed ? l.version : undefined;
}

function safeAgentVersion(h: AdapterSession): string | undefined {
  try {
    const v = h.agentVersion?.();
    return typeof v === 'string' && v ? v : undefined;
  } catch {
    return undefined;
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

function nonNegative(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}
