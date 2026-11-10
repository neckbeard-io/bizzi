// Agent-to-agent orchestration on one machine (spec §12): guardrail settings, permission clamping,
// and the helper manager behind the bizzi-agents MCP tools (start / send / wait / read / stop).
//
// The MCP transport lives in @bizzi/orchestration; everything that decides what a helper may do is here
// so it applies however the request arrives.

import {
  BizziError,
  DEFAULT_ORCHESTRATION_SETTINGS,
  GLOBAL_CHANNEL,
  sessionChannel,
  type AgentKind,
  type ChannelEvent,
  type InputBlock,
  type Logger,
  type OrchestrationSettings,
  type SessionBudget,
  type SessionInfo,
  type SessionMode,
  type SessionStatus,
  type WorkspaceInfo,
} from '@bizzi/protocol';
import type { AdapterRegistry } from './agents.ts';
import type { Spent } from './budget.ts';
import type { EventBus } from './bus.ts';
import type { Sessions } from './sessions.ts';
import type { Store } from './store.ts';
import { gitDiff } from './tools.ts';
import type { Workspaces } from './workspaces.ts';

// --- settings --------------------------------------------------------------------------------------

const MACHINE_KEY = 'orchestration.settings';
const workspaceKey = (id: string) => `orchestration.settings.workspace.${id}`;

const SETTING_KEYS = ['maxDepth', 'maxHelpersPerParent', 'maxHelpersPerMachine', 'onLimit', 'parentAnswersApprovals', 'treeBudgetUsd'] as const;

type Overrides = Partial<OrchestrationSettings>;

/**
 * Guardrail settings: machine-wide values over DEFAULT_ORCHESTRATION_SETTINGS, then per-workspace
 * overrides. A worktree workspace inherits its repo workspace's overrides before its own.
 */
export class OrchestrationSettingsStore {
  readonly #store: Store;
  readonly #workspaces: Workspaces;

  constructor(store: Store, workspaces: Workspaces) {
    this.#store = store;
    this.#workspaces = workspaces;
  }

  get(workspaceId?: string): OrchestrationSettings {
    const out: OrchestrationSettings = { ...DEFAULT_ORCHESTRATION_SETTINGS, ...this.#read(MACHINE_KEY) };
    if (workspaceId !== undefined) {
      const ws = this.#workspaces.get(workspaceId);
      if (ws.kind === 'worktree' && ws.parentWorkspaceId) Object.assign(out, this.#read(workspaceKey(ws.parentWorkspaceId)));
      Object.assign(out, this.#read(workspaceKey(ws.id)));
    }
    return out;
  }

  /** Same as get(), but falls back to machine settings when the workspace is gone. */
  effective(workspaceId: string | undefined): OrchestrationSettings {
    try {
      return this.get(workspaceId);
    } catch {
      return this.get();
    }
  }

  /** Merge `patch` into the machine (or workspace) overrides. `null` clears a field. Returns the effective settings. */
  set(workspaceId: string | undefined, patch: unknown): OrchestrationSettings {
    if (workspaceId !== undefined) this.#workspaces.get(workspaceId);
    const key = workspaceId === undefined ? MACHINE_KEY : workspaceKey(workspaceId);
    const next: Overrides = { ...this.#read(key), ...parseOverrides(patch) };
    for (const k of SETTING_KEYS) if ((patch as Record<string, unknown>)[k] === null) delete next[k];
    if (Object.keys(next).length === 0) this.#store.deleteMeta(key);
    else this.#store.setMeta(key, JSON.stringify(next));
    return this.get(workspaceId);
  }

  /** Drop a removed workspace's overrides. */
  forget(workspaceId: string): void {
    this.#store.deleteMeta(workspaceKey(workspaceId));
  }

  #read(key: string): Overrides {
    const raw = this.#store.getMeta(key);
    if (!raw) return {};
    try {
      return parseOverrides(JSON.parse(raw));
    } catch {
      return {};
    }
  }
}

function parseOverrides(v: unknown): Overrides {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new BizziError('bad_request', 'settings must be an object');
  const o = v as Record<string, unknown>;
  const out: Overrides = {};
  for (const [k, val] of Object.entries(o)) {
    if (!(SETTING_KEYS as readonly string[]).includes(k)) throw new BizziError('bad_request', `unknown orchestration setting ${k}`);
    if (val === null || val === undefined) continue;
    switch (k) {
      case 'maxDepth':
        out.maxDepth = int(k, val, 0, 16);
        break;
      case 'maxHelpersPerParent':
        out.maxHelpersPerParent = int(k, val, 0, 256);
        break;
      case 'maxHelpersPerMachine':
        out.maxHelpersPerMachine = int(k, val, 0, 1024);
        break;
      case 'onLimit':
        if (val !== 'queue' && val !== 'fail') throw new BizziError('bad_request', "onLimit must be 'queue' or 'fail'");
        out.onLimit = val;
        break;
      case 'parentAnswersApprovals':
        if (typeof val !== 'boolean') throw new BizziError('bad_request', 'parentAnswersApprovals must be a boolean');
        out.parentAnswersApprovals = val;
        break;
      case 'treeBudgetUsd':
        if (typeof val !== 'number' || !Number.isFinite(val) || val < 0) throw new BizziError('bad_request', 'treeBudgetUsd must be a non-negative number');
        out.treeBudgetUsd = val;
        break;
    }
  }
  return out;
}

function int(key: string, v: unknown, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new BizziError('bad_request', `${key} must be an integer in [${min}, ${max}]`);
  }
  return v;
}

// --- permissions -----------------------------------------------------------------------------------

/**
 * How loose each agent's permission modes are, on one shared scale so a helper of another agent can be
 * compared with its parent: 0 read-only · 1 asks before acting · 2 edits the workspace without asking ·
 * 3 no sandbox, no prompts. Within a level, modes are listed in order of preference when clamping.
 */
export const PERMISSION_LEVELS: Partial<Record<AgentKind, Record<string, number>>> = {
  claude: { plan: 0, default: 1, dontAsk: 1, acceptEdits: 2, bypassPermissions: 3 },
  codex: { 'read-only': 0, untrusted: 1, auto: 2, 'full-access': 3 },
  opencode: { plan: 0, build: 2 },
};

/** The mode an agent runs in when none is given. */
export const DEFAULT_PERMISSION_MODE: Partial<Record<AgentKind, string>> = { claude: 'default', codex: 'auto', opencode: 'build' };

/** Level of a mode, or undefined when the agent or mode isn't known. */
export function permissionLevel(agent: AgentKind, mode: string | undefined): number | undefined {
  const m = mode ?? DEFAULT_PERMISSION_MODE[agent];
  return m === undefined ? undefined : PERMISSION_LEVELS[agent]?.[m];
}

export interface ClampResult {
  /** Mode to start the helper with (undefined: the agent has no modes bizzi knows). */
  permissionMode?: string;
  note?: string;
}

/**
 * A helper's permission mode is never looser than its parent's (spec §12.2). An unknown parent mode
 * counts as level 1 (asks). An unknown requested mode inherits the parent's. Agents without a known
 * permission model (agy, shell) run at their own defaults, which ask, so they are refused under a
 * read-only parent.
 */
export function clampPermission(o: {
  parentAgent: AgentKind;
  parentMode: string | undefined;
  agent: AgentKind;
  requested: string | undefined;
  /** Modes the helper's adapter accepts (capabilities.permissionModes); empty = no restriction. */
  available?: readonly string[];
}): ClampResult {
  const parentLevel = permissionLevel(o.parentAgent, o.parentMode) ?? 1;
  const order = PERMISSION_LEVELS[o.agent];
  if (!order) {
    if (parentLevel < 1) {
      throw new BizziError('conflict', `the parent session is read-only (${o.parentMode}) and ${o.agent} has no read-only mode`);
    }
    return o.requested ? { note: `${o.agent} has no permission modes bizzi can set; ignored ${o.requested}` } : {};
  }
  const candidates = Object.entries(order).filter(([m]) => !o.available?.length || o.available.includes(m));
  let wanted = o.requested ?? DEFAULT_PERMISSION_MODE[o.agent];
  let wantedLevel = wanted === undefined ? undefined : order[wanted];
  let note: string | undefined;
  if (wanted !== undefined && wantedLevel === undefined) {
    // Unknown mode: inherit the parent's (same agent), else its level.
    if (o.agent === o.parentAgent && o.parentMode && candidates.some(([m]) => m === o.parentMode)) {
      return { permissionMode: o.parentMode, note: `unknown permission mode ${wanted}; using the parent's (${o.parentMode})` };
    }
    note = `unknown permission mode ${wanted}; matching the parent's level`;
    wanted = undefined;
    wantedLevel = parentLevel;
  }
  const limit = Math.min(wantedLevel ?? parentLevel, parentLevel);
  if (wanted !== undefined && wantedLevel !== undefined && wantedLevel <= parentLevel && candidates.some(([m]) => m === wanted)) {
    return { permissionMode: wanted };
  }
  let best: [string, number] | undefined;
  for (const c of candidates) if (c[1] <= limit && (!best || c[1] > best[1])) best = c;
  if (!best) throw new BizziError('conflict', `no ${o.agent} permission mode is as strict as the parent's (${o.parentMode ?? 'default'})`);
  if (o.requested && !note && best[0] !== o.requested) {
    note = `permission mode ${o.requested} is looser than the parent's (${o.parentMode ?? 'default'}); using ${best[0]}`;
  }
  return note ? { permissionMode: best[0], note } : { permissionMode: best[0] };
}

// --- helpers ---------------------------------------------------------------------------------------

export type WaitUntil = 'idle' | 'waiting' | 'done' | 'ended';
export const WAIT_UNTIL: readonly WaitUntil[] = ['idle', 'waiting', 'done', 'ended'];

export interface StartHelperRequest {
  agent: AgentKind;
  /** Workspace id or path of a registered workspace on this machine. Default: the parent's. */
  workspace?: string;
  /** Run in a worktree of the workspace's repo on this branch (created when missing). */
  worktree?: string;
  prompt: string;
  model?: string;
  permissionMode?: string;
  effort?: string;
  mode?: SessionMode;
  scope?: 'child' | 'detached';
  budget?: SessionBudget;
  title?: string;
}

export interface StartHelperResult {
  session: SessionInfo;
  workspace: WorkspaceInfo;
  queued: boolean;
  notes: string[];
}

export interface WaitResult {
  sessionId: string;
  state: SessionStatus;
  /** The `until` condition was met (false: timed out). */
  reached: boolean;
  reason: string;
}

export interface ReadOptions {
  /** Only events after this seq (the `cursor` of an earlier read). Default 0. */
  since?: number;
  /** Rough cap on the size of what comes back (~4 characters per token). Default 4000. */
  maxTokens?: number;
  /** summary (default) · full: messages and tool calls in order · diff: one file's diff (`path`). */
  detail?: 'summary' | 'full' | 'diff';
  path?: string;
}

export interface ChangedFile {
  path: string;
  change: 'created' | 'modified' | 'deleted';
  /** Pass to session_read `{ detail: 'diff', path }` for the diff. */
  diffRef: string;
}

export interface ReadResult {
  sessionId: string;
  agent: AgentKind;
  state: SessionStatus;
  /** Pass as `since` next time to read only what's new. */
  cursor: number;
  turns: number;
  stopReason?: string;
  error?: string;
  finalMessage?: string;
  changedFiles: ChangedFile[];
  tools: { total: number; byKind: Record<string, number>; failed: number; denied: number };
  waitingOn?: { approvals: string[]; questions: string[]; budget?: string };
  usage: Spent;
  /** detail 'full': the transcript in order (oldest entries dropped first to fit). */
  transcript?: string[];
  /** detail 'diff'. */
  diff?: string;
  truncated: boolean;
}

export const DEFAULT_READ_TOKENS = 4000;
export const MAX_READ_TOKENS = 32_000;
export const DEFAULT_WAIT_MS = 45_000;
export const MAX_WAIT_MS = 600_000;

const TERMINAL: readonly SessionStatus[] = ['ended', 'failed'];

interface Queued {
  sessionId: string;
  parentId: string;
  prompt: string;
}

export interface OrchestratorDeps {
  sessions: Sessions;
  workspaces: Workspaces;
  registry: AdapterRegistry;
  settings: OrchestrationSettingsStore;
  bus: EventBus;
  logger: Logger;
}

/**
 * Helper sessions started by other sessions (spec §12.1). Every call names the calling session; a
 * session may only drive its own helpers.
 */
export class Orchestrator {
  readonly settings: OrchestrationSettingsStore;
  readonly #d: OrchestratorDeps;
  readonly #log: Logger;
  readonly #queue: Queued[] = [];
  #pumping = false;
  readonly #off: () => void;

  constructor(deps: OrchestratorDeps) {
    this.#d = deps;
    this.settings = deps.settings;
    this.#log = deps.logger.child({ component: 'orchestration' });
    this.#off = deps.bus.on(GLOBAL_CHANNEL, (ev) => {
      if (this.#queue.length > 0 && (ev.type === 'session.updated' || ev.type === 'session.removed')) setImmediate(() => this.#pump());
    });
  }

  close(): void {
    this.#off();
    this.#queue.length = 0;
  }

  /** Helpers started by `parentId`. */
  helpers(parentId: string): SessionInfo[] {
    this.#d.sessions.get(parentId);
    return this.#d.sessions.list(undefined, { spawnedBy: parentId });
  }

  /** Throws unless `helperId` is a helper started by `parentId`. */
  assertHelper(parentId: string, helperId: string): SessionInfo {
    if (typeof helperId !== 'string' || !helperId) throw new BizziError('bad_request', 'sessionId is required');
    let s: SessionInfo;
    try {
      s = this.#d.sessions.get(helperId).session;
    } catch {
      throw new BizziError('not_found', `no helper ${helperId}`);
    }
    if (s.spawnedBy !== parentId) throw new BizziError('not_found', `no helper ${helperId} (only helpers this session started can be used)`);
    return s;
  }

  async startHelper(parentId: string, req: StartHelperRequest): Promise<StartHelperResult> {
    const sessions = this.#d.sessions;
    const parent = sessions.get(parentId).session;
    if (TERMINAL.includes(parent.status)) throw new BizziError('conflict', 'the calling session has ended');
    if (typeof req.prompt !== 'string' || !req.prompt.trim()) throw new BizziError('bad_request', 'prompt is required');
    const settings = this.settings.effective(parent.workspaceId);
    const depth = (parent.depth ?? 0) + 1;
    if (depth > settings.maxDepth) {
      throw new BizziError('conflict', `helper depth limit reached (max ${settings.maxDepth}); finish this work yourself`, {
        maxDepth: settings.maxDepth,
      });
    }
    const over = sessions.overBudget(parentId);
    if (over) throw new BizziError('conflict', `${over}; no new helpers until the budget is raised`, { budget: true });
    const scope = req.scope ?? 'child';
    if (scope !== 'child' && scope !== 'detached') throw new BizziError('bad_request', "scope must be 'child' or 'detached'");

    const notes: string[] = [];
    const mode = req.mode ?? this.#d.registry.defaultMode(req.agent);
    const adapter = mode && this.#d.registry.select(req.agent, mode);
    if (!mode || !adapter) throw new BizziError('agent_unavailable', `${req.agent} is not available on this machine`);
    let available: string[] = [];
    try {
      available = adapter.capabilities(mode).permissionModes ?? [];
    } catch {
      available = [];
    }
    const clamp = clampPermission({
      parentAgent: parent.agent,
      parentMode: parent.permissionMode,
      agent: req.agent,
      requested: req.permissionMode,
      available,
    });
    if (clamp.note) notes.push(clamp.note);

    let workspace = this.#resolveWorkspace(parent, req.workspace);
    if (req.worktree !== undefined) {
      if (typeof req.worktree !== 'string' || !req.worktree.trim()) throw new BizziError('bad_request', 'worktree must be a branch name');
      workspace = await this.#d.workspaces.createWorktree({ workspaceId: workspace.id, branch: req.worktree.trim() });
    }

    // Concurrency (spec §12.2): live helpers per parent and per machine.
    const limit = this.#limitReached(parentId, settings);
    if (limit && settings.onLimit === 'fail') throw new BizziError('conflict', `${limit}; stop a helper first`);
    const queued = Boolean(limit);
    if (limit) notes.push(`queued: ${limit}`);

    const params: Parameters<Sessions['create']>[0] = { workspaceId: workspace.id, agent: req.agent, mode };
    if (req.model) params.model = req.model;
    if (clamp.permissionMode) params.permissionMode = clamp.permissionMode;
    if (req.effort) params.effort = req.effort;
    params.title = req.title?.trim() || titleFrom(req.prompt);
    if (req.budget) params.budget = req.budget;
    const session = await sessions.create(params, {
      spawnedBy: parentId,
      scope,
      depth,
      ...(queued ? { queued: true, queuedReason: `queued: ${limit}` } : {}),
    });
    if (queued) {
      this.#queue.push({ sessionId: session.id, parentId, prompt: req.prompt });
    } else {
      try {
        await sessions.send(session.id, [{ type: 'text', text: req.prompt }]);
      } catch (err) {
        notes.push(`the prompt could not be sent: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.#log.log('info', 'helper started', { parentId, sessionId: session.id, agent: req.agent, depth, scope, queued });
    return { session: sessions.get(session.id).session, workspace, queued, notes };
  }

  async send(parentId: string, helperId: string, input: InputBlock[]): Promise<{ turnId: string }> {
    this.assertHelper(parentId, helperId);
    return this.#d.sessions.send(helperId, input);
  }

  async interrupt(parentId: string, helperId: string): Promise<void> {
    this.assertHelper(parentId, helperId);
    await this.#d.sessions.interrupt(helperId);
  }

  async stop(parentId: string, helperId: string): Promise<void> {
    this.assertHelper(parentId, helperId);
    this.#dequeue(helperId);
    await this.#d.sessions.stop(helperId);
  }

  /** Wait until the helper reaches `until` or `timeoutMs` passes. Returns the state and a one-line reason. */
  async wait(parentId: string, helperId: string, until: WaitUntil, timeoutMs = DEFAULT_WAIT_MS, signal?: AbortSignal): Promise<WaitResult> {
    this.assertHelper(parentId, helperId);
    if (!WAIT_UNTIL.includes(until)) throw new BizziError('bad_request', `until must be one of ${WAIT_UNTIL.join(', ')}`);
    const ms = Math.max(0, Math.min(timeoutMs, MAX_WAIT_MS));
    const check = (): WaitResult | undefined => {
      if (!this.#d.sessions.has(helperId)) return { sessionId: helperId, state: 'ended', reached: true, reason: 'the helper was deleted' };
      return this.#reached(helperId, until) ? this.#waitResult(helperId, true) : undefined;
    };
    const now = check();
    if (now) return now;
    return new Promise<WaitResult>((resolve) => {
      let settled = false;
      const finish = (r: WaitResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        offGlobal();
        offSession();
        signal?.removeEventListener('abort', onAbort);
        resolve(r);
      };
      // Listeners run before the session's derived state is updated; look on the next tick.
      const recheck = () =>
        setImmediate(() => {
          if (settled) return;
          const r = check();
          if (r) finish(r);
        });
      const offGlobal = this.#d.bus.on(GLOBAL_CHANNEL, (ev) => {
        if ((ev.type === 'session.updated' && ev.data.session.id === helperId) || (ev.type === 'session.removed' && ev.data.sessionId === helperId)) recheck();
      });
      const offSession = this.#d.bus.on(sessionChannel(helperId), recheck);
      const timer = setTimeout(() => {
        const r = check();
        finish(r ?? this.#waitResult(helperId, false, ms));
      }, ms);
      const onAbort = () => finish(this.#d.sessions.has(helperId) ? this.#waitResult(helperId, false, ms, 'the wait was cancelled') : { sessionId: helperId, state: 'ended', reached: true, reason: 'the helper was deleted' });
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Structured summary of what the helper did since `since` (usage.md §2): never the raw transcript by default. */
  async read(parentId: string, helperId: string, opts: ReadOptions = {}): Promise<ReadResult> {
    const info = this.assertHelper(parentId, helperId);
    const since = opts.since ?? 0;
    if (!Number.isInteger(since) || since < 0) throw new BizziError('bad_request', 'since must be a non-negative integer');
    const maxTokens = Math.max(100, Math.min(opts.maxTokens ?? DEFAULT_READ_TOKENS, MAX_READ_TOKENS));
    const budgetChars = maxTokens * 4;
    const detail = opts.detail ?? 'summary';
    const events = this.#d.bus.replay(sessionChannel(helperId), since);
    const pending = this.#d.sessions.pending(helperId);

    const out: ReadResult = {
      sessionId: helperId,
      agent: info.agent,
      state: info.status,
      cursor: events.length ? events[events.length - 1]!.seq : Math.max(since, info.lastSeq),
      turns: 0,
      changedFiles: [],
      tools: { total: 0, byKind: {}, failed: 0, denied: 0 },
      usage: this.#d.sessions.spent(helperId).tree,
      truncated: false,
    };
    const files = new Map<string, ChangedFile['change']>();
    const diffs = new Map<string, string>();
    const toolKind = new Map<string, string>();
    const transcript: string[] = [];
    for (const ev of events) {
      switch (ev.type) {
        case 'turn.started':
          transcript.push(`> ${textOfInput(ev.data.input)}`);
          break;
        case 'turn.completed':
          out.turns++;
          out.stopReason = ev.data.stopReason;
          if (ev.data.error) out.error = ev.data.error;
          else delete out.error;
          break;
        case 'message.completed':
          if (ev.data.role === 'assistant' && !ev.data.parentToolId) {
            out.finalMessage = ev.data.text;
            transcript.push(ev.data.text);
          }
          break;
        case 'tool.started':
          if (!ev.data.parentToolId) {
            out.tools.total++;
            out.tools.byKind[ev.data.kind] = (out.tools.byKind[ev.data.kind] ?? 0) + 1;
            toolKind.set(ev.data.toolId, ev.data.kind);
            transcript.push(`[${ev.data.kind}] ${ev.data.title}`);
          }
          break;
        case 'tool.completed':
          if (!toolKind.has(ev.data.toolId)) break;
          if (ev.data.status === 'error') out.tools.failed++;
          if (ev.data.status === 'denied') out.tools.denied++;
          break;
        case 'file.changed':
          files.set(ev.data.path, files.has(ev.data.path) && files.get(ev.data.path) === 'created' && ev.data.change !== 'deleted' ? 'created' : ev.data.change);
          if (ev.data.diff) diffs.set(ev.data.path, ev.data.diff);
          break;
      }
    }
    out.changedFiles = [...files].map(([path, change]) => ({ path, change, diffRef: path }));
    if (pending.approvals.length || pending.questions.length || pending.budget) {
      out.waitingOn = {
        approvals: pending.approvals.map((a) => a.title || a.kind),
        questions: pending.questions.map((q) => q.text),
        ...(pending.budget ? { budget: pending.budget } : {}),
      };
    }

    if (detail === 'diff') {
      if (!opts.path) throw new BizziError('bad_request', "detail 'diff' needs a path (a changedFiles diffRef)");
      let diff = diffs.get(opts.path);
      if (diff === undefined) {
        const ws = this.#d.workspaces.get(info.workspaceId);
        diff = (await gitDiff(ws, { path: opts.path }).catch(() => ({ diff: '' }))).diff;
      }
      const t = truncate(diff, budgetChars);
      out.diff = t.text;
      out.truncated = t.truncated;
      return out;
    }
    if (detail === 'full') {
      let used = 0;
      const kept: string[] = [];
      for (let i = transcript.length - 1; i >= 0; i--) {
        const line = transcript[i]!;
        if (used + line.length > budgetChars) {
          out.truncated = true;
          if (kept.length === 0) kept.unshift(truncate(line, budgetChars).text);
          break;
        }
        kept.unshift(line);
        used += line.length;
      }
      out.transcript = kept;
      delete out.finalMessage;
      return out;
    }
    if (out.finalMessage !== undefined) {
      // The summary minus the final message is small; give the message what's left.
      const room = Math.max(400, budgetChars - JSON.stringify({ ...out, finalMessage: '' }).length);
      const t = truncate(out.finalMessage, room);
      out.finalMessage = t.text;
      out.truncated = t.truncated;
    }
    if (out.changedFiles.length > 200) {
      out.changedFiles = out.changedFiles.slice(0, 200);
      out.truncated = true;
    }
    return out;
  }

  // --- internals -------------------------------------------------------------------------------------

  #resolveWorkspace(parent: SessionInfo, ref: string | undefined): WorkspaceInfo {
    if (ref === undefined || ref === '') return this.#d.workspaces.get(parent.workspaceId);
    if (typeof ref !== 'string') throw new BizziError('bad_request', 'workspace must be a workspace id or path');
    const all = this.#d.workspaces.list();
    const ws = all.find((w) => w.id === ref) ?? all.find((w) => w.path === ref.replace(/\/+$/, ''));
    if (!ws) throw new BizziError('not_found', `workspace ${ref} is not registered on this machine`);
    return ws;
  }

  /** Why another helper can't run now, or undefined when there's a free slot. */
  #limitReached(parentId: string, settings: OrchestrationSettings): string | undefined {
    const sessions = this.#d.sessions;
    const live = sessions.list().filter((s) => s.spawnedBy && !TERMINAL.includes(s.status) && !sessions.isQueued(s.id));
    const mine = live.filter((s) => s.spawnedBy === parentId).length;
    if (mine >= settings.maxHelpersPerParent) return `this session already has ${mine} live helper(s) (max ${settings.maxHelpersPerParent})`;
    const machineMax = this.settings.get().maxHelpersPerMachine;
    if (live.length >= machineMax) return `this machine already runs ${live.length} helper(s) (max ${machineMax})`;
    return undefined;
  }

  #dequeue(id: string): void {
    const i = this.#queue.findIndex((q) => q.sessionId === id);
    if (i >= 0) this.#queue.splice(i, 1);
  }

  /** Start queued helpers, oldest first, while slots are free. */
  #pump(): void {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      for (let i = 0; i < this.#queue.length; ) {
        const q = this.#queue[i]!;
        const s = this.#d.sessions.has(q.sessionId) ? this.#d.sessions.get(q.sessionId).session : undefined;
        if (!s || TERMINAL.includes(s.status) || !this.#d.sessions.isQueued(q.sessionId)) {
          this.#queue.splice(i, 1);
          continue;
        }
        const parentWs = this.#d.sessions.has(q.parentId) ? this.#d.sessions.get(q.parentId).session.workspaceId : s.workspaceId;
        if (this.#limitReached(q.parentId, this.settings.effective(parentWs))) {
          i++;
          continue;
        }
        this.#queue.splice(i, 1);
        try {
          this.#d.sessions.startQueued(q.sessionId);
        } catch (err) {
          this.#log.log('warn', 'could not start queued helper', { sessionId: q.sessionId, err });
          continue;
        }
        this.#log.log('info', 'queued helper started', { sessionId: q.sessionId, parentId: q.parentId });
        this.#d.sessions.send(q.sessionId, [{ type: 'text', text: q.prompt }]).catch((err: unknown) => {
          this.#log.log('warn', 'queued helper prompt failed', { sessionId: q.sessionId, err });
        });
      }
    } finally {
      this.#pumping = false;
    }
  }

  #reached(id: string, until: WaitUntil): boolean {
    const s = this.#d.sessions.get(id).session;
    const busy = this.#d.sessions.isBusy(id);
    const terminal = TERMINAL.includes(s.status);
    const waiting = s.status === 'waiting_input' || s.status === 'waiting_approval';
    const quiet = s.status === 'idle' && !busy;
    const budget = Boolean(this.#d.sessions.pending(id).budget);
    switch (until) {
      case 'idle':
        return quiet || waiting || terminal;
      case 'waiting':
        return waiting || terminal;
      case 'done':
        return quiet || terminal || budget;
      case 'ended':
        return terminal;
    }
  }

  #waitResult(id: string, reached: boolean, waitedMs?: number, why?: string): WaitResult {
    const s = this.#d.sessions.get(id).session;
    if (!reached) {
      return { sessionId: id, state: s.status, reached, reason: why ?? `still ${s.status} after ${Math.round((waitedMs ?? 0) / 1000)}s; wait again or read progress` };
    }
    return { sessionId: id, state: s.status, reached, reason: this.#reason(id, s) };
  }

  #reason(id: string, s: SessionInfo): string {
    const pending = this.#d.sessions.pending(id);
    if (pending.budget) return pending.budget;
    if (pending.approvals.length) return `waiting for the user to approve: ${oneLine(pending.approvals[0]!.title || pending.approvals[0]!.kind)}`;
    if (pending.questions.length) return `waiting for the user to answer: ${oneLine(pending.questions[0]!.text)}`;
    const recent = this.#recent(id);
    if (TERMINAL.includes(s.status)) return `${s.status}${recent.statusReason ? `: ${recent.statusReason}` : ''}`;
    if (s.status === 'idle') {
      if (!recent.stopReason) return 'idle';
      return `turn finished (${recent.stopReason}${recent.error ? `: ${oneLine(recent.error)}` : ''})`;
    }
    return recent.statusReason ? `${s.status}: ${recent.statusReason}` : s.status;
  }

  /** Last stop reason and status reason among the most recent events. */
  #recent(id: string): { stopReason?: string; error?: string; statusReason?: string } {
    const ch = sessionChannel(id);
    const last = this.#d.bus.lastSeq(ch);
    const events: ChannelEvent[] = this.#d.bus.replay(ch, Math.max(0, last - 200));
    const out: { stopReason?: string; error?: string; statusReason?: string } = {};
    for (let i = events.length - 1; i >= 0 && (!out.stopReason || !out.statusReason); i--) {
      const ev = events[i]!;
      if (ev.type === 'turn.completed' && !out.stopReason) {
        out.stopReason = ev.data.stopReason;
        if (ev.data.error) out.error = ev.data.error;
      } else if (ev.type === 'session.status' && !out.statusReason && ev.data.reason) {
        out.statusReason = oneLine(ev.data.reason);
      }
    }
    return out;
  }
}

function titleFrom(prompt: string): string {
  const line = oneLine(prompt);
  return line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line;
}

function oneLine(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > 200 ? `${t.slice(0, 199)}…` : t;
}

function textOfInput(input: InputBlock[]): string {
  return input.map((b) => (b.type === 'text' ? b.text : b.type === 'file' ? `[file ${b.path}]` : '[image]')).join('\n');
}

function truncate(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  return { text: `${s.slice(0, Math.max(0, max - 20))}\n… [truncated]`, truncated: true };
}
