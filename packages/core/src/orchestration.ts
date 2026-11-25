// Agent-to-agent orchestration (spec §12): guardrail settings, permission clamping, and the helper
// manager behind the bizzi-agents MCP tools (start / send / wait / read / stop), on this machine and,
// through the hub, on others (§12.4).
//
// The MCP transport lives in @bizzi/orchestration; everything that decides what a helper may do is here
// so it applies however the request arrives.

import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  AGENT_KINDS,
  BizziError,
  DEFAULT_ORCHESTRATION_SETTINGS,
  GLOBAL_CHANNEL,
  sessionChannel,
  type AgentKind,
  type ApprovalDecisionKind,
  type ApprovalKind,
  type ApprovalRequest,
  type ChannelEvent,
  type HelperChangedFile,
  type HelperParent,
  type HelperPendingItem,
  type HelperReadResult,
  type HelperStartRequest,
  type HelperStartResult,
  type HelperWaitResult,
  type HelperWaitUntil,
  type InputBlock,
  type Logger,
  type MachineInfo,
  type NodeCaller,
  type OrchestrationSettings,
  type QuestionAnswers,
  type QuestionItem,
  type SessionBudget,
  type SessionInfo,
  type SessionMode,
  type SessionStatus,
  type WorkspaceInfo,
} from '@bizzi/protocol';
import type { AdapterRegistry } from './agents.ts';
import { parseBudget, type Spent } from './budget.ts';
import type { EventBus } from './bus.ts';
import { normalizeRemoteUrl, originUrl } from './git.ts';
import type { HubPort } from './hub-port.ts';
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
  // API chat (spec §6.5) has no tools, so it is read-only under any parent.
  if (o.agent === 'api') return o.requested ? { note: `api has no permission modes (no tools); ignored ${o.requested}` } : {};
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

export type WaitUntil = HelperWaitUntil;
export const WAIT_UNTIL: readonly WaitUntil[] = ['idle', 'waiting', 'done', 'ended'];

export interface StartHelperRequest {
  agent: AgentKind;
  /**
   * Machine id or name to run the helper on (spec §12.4). Default (or this machine): here. Another
   * machine needs the hub link; an offline one fails fast with `machine_offline`.
   */
  machine?: string;
  /** Workspace id or path of a registered workspace on the target machine. Default: the parent's (or the linked one). */
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

export type StartHelperResult = HelperStartResult;
export type WaitResult = HelperWaitResult;
export type ChangedFile = HelperChangedFile;
export type ReadResult = HelperReadResult;

// ---- parent answers approvals (spec §12.5)

/** A pending approval or question of a helper, as its parent sees it (protocol: HelperPendingItem). */
export type PendingItem = HelperPendingItem;

export interface AnswerRequest {
  /** An approvalId or questionId from PendingItem.id. */
  id: string;
  /** Approvals: allow or deny (allow_always and edited input are the user's). */
  decision?: ApprovalDecisionKind;
  message?: string;
  editedInput?: unknown;
  /** Questions: answers keyed by question id, or cancel. */
  answers?: QuestionAnswers;
  cancel?: boolean;
}

export interface AnswerResult {
  sessionId: string;
  id: string;
  answered: boolean;
  /** Set when someone else (usually the user) answered first: how and by whom. */
  alreadyAnswered?: { outcome: string; by?: string; bySessionId?: string };
  message: string;
}

/** The parent's own level needed to allow each approval kind (PERMISSION_LEVELS scale). */
const ALLOW_LEVEL: Record<ApprovalKind, number> = { read: 0, edit: 2, write: 2, plan: 2, shell: 3, mcp: 3, web: 3, other: 3 };
const LEVEL_NEEDS = ['may read', 'may act after asking', 'edits without asking', 'runs unrestricted'];
const PATH_KEYS = new Set(['file_path', 'filePath', 'filepath', 'path', 'notebook_path', 'notebookPath', 'cwd', 'grantRoot', 'directory', 'dir']);
const PATH_LIST_KEYS = new Set(['paths', 'files', 'resources']);
const MAX_INPUT_CHARS = 2000;

export interface ReadOptions {
  /** Only events after this seq (the `cursor` of an earlier read). Default 0. */
  since?: number;
  /** Rough cap on the size of what comes back (~4 characters per token). Default 4000. */
  maxTokens?: number;
  /** summary (default) · full: messages and tool calls in order · diff: one file's diff (`path`). */
  detail?: 'summary' | 'full' | 'diff';
  path?: string;
}

/** A machine a helper could run on, as the `machines_list` tool shows it. */
export interface HelperMachine {
  id: string;
  name: string;
  online: boolean;
  self: boolean;
  os: MachineInfo['os'];
  headful: boolean;
  tags: string[];
  description?: string;
  lastSeenAt?: string;
  workspaces: { id: string; name: string; path: string; kind: WorkspaceInfo['kind']; branch?: string }[];
}

export const DEFAULT_READ_TOKENS = 4000;
export const MAX_READ_TOKENS = 32_000;
export const DEFAULT_WAIT_MS = 45_000;
export const MAX_WAIT_MS = 600_000;

const TERMINAL: readonly SessionStatus[] = ['ended', 'failed'];

/** Extra time a cross-machine call gets on top of the work it asks for (hub + two links). */
const REMOTE_MARGIN_MS = 30_000;
const REMOTE_START_TIMEOUT_MS = 120_000;
const REMOTE_HELPERS_KEY = 'orchestration.remoteHelpers';

interface Queued {
  sessionId: string;
  parentId: string;
  prompt: string;
}

/** A helper this node's session started on another machine (spec §12.4), persisted in node meta. */
interface RemoteHelper {
  helperId: string;
  machineId: string;
  parentId: string;
  scope: 'child' | 'detached';
  /** Last known state of the helper (start result, waits, reads, the hub index). */
  info: SessionInfo;
  /** A child helper whose parent ended while the hub was unreachable: stopped on the next link. */
  stopPending?: boolean;
}

/** The parent as the guardrails see it: a local session, or one on another machine. */
interface ParentFacts {
  id: string;
  agent: AgentKind;
  permissionMode: string | undefined;
  depth: number;
  remote?: { machineId: string };
}

export interface OrchestratorDeps {
  sessions: Sessions;
  workspaces: Workspaces;
  registry: AdapterRegistry;
  settings: OrchestrationSettingsStore;
  bus: EventBus;
  logger: Logger;
  /** Node meta storage (cross-machine helper records). Optional for tests that build an Orchestrator by hand. */
  store?: Store;
  /** This machine (its id and name); kept current by machine.set. */
  machine?: MachineInfo;
  /** Node → hub requests for cross-machine helpers (spec §12.4). */
  hub?: HubPort;
}

/**
 * Helper sessions started by other sessions (spec §12.1, §12.4). Every call names the calling session; a
 * session may only drive its own helpers. Helpers on other machines go through the hub: this node keeps
 * a record of each one, and the target machine checks that requests come from the parent's machine.
 */
export class Orchestrator {
  readonly settings: OrchestrationSettingsStore;
  readonly #d: OrchestratorDeps;
  readonly #log: Logger;
  readonly #queue: Queued[] = [];
  #pumping = false;
  readonly #off: () => void;
  /** Items session_wait already reported, per helper: `done` doesn't return early for them twice. */
  readonly #reported = new Map<string, Set<string>>();
  readonly #offHub: () => void;
  readonly #remote = new Map<string, RemoteHelper>();

  constructor(deps: OrchestratorDeps) {
    this.#d = deps;
    this.settings = deps.settings;
    this.#log = deps.logger.child({ component: 'orchestration' });
    this.#loadRemote();
    this.#off = deps.bus.on(GLOBAL_CHANNEL, (ev) => {
      if (this.#queue.length > 0 && (ev.type === 'session.updated' || ev.type === 'session.removed')) setImmediate(() => this.#pump());
      if (ev.type === 'session.removed') this.#reported.delete(ev.data.sessionId);
      else if (ev.type === 'session.updated' && TERMINAL.includes(ev.data.session.status)) this.#reported.delete(ev.data.session.id);
      if (this.#remote.size === 0) return;
      if (ev.type === 'session.updated' && TERMINAL.includes(ev.data.session.status)) this.#parentGone(ev.data.session.id, false);
      else if (ev.type === 'session.removed') this.#parentGone(ev.data.sessionId, true);
    });
    this.#offHub = deps.hub?.onChange((state) => {
      if (state === 'connected') void this.#flushPendingStops();
    }) ?? (() => {});
  }

  close(): void {
    this.#off();
    this.#offHub();
    this.#queue.length = 0;
    this.#reported.clear();
  }

  /** Helpers started by `parentId` on this machine. */
  helpers(parentId: string): SessionInfo[] {
    this.#d.sessions.get(parentId);
    return this.#d.sessions.list(undefined, { spawnedBy: parentId });
  }

  /**
   * Every helper `parentId` started, on this machine and others. Remote ones come from the hub's index
   * when linked (and refresh the records), else from the last known state.
   */
  async listHelpers(parentId: string): Promise<SessionInfo[]> {
    const local = this.helpers(parentId);
    const mine = [...this.#remote.values()].filter((r) => r.parentId === parentId);
    if (mine.length === 0) return local;
    const hub = this.#d.hub;
    if (hub?.connected) {
      try {
        const { sessions } = await hub.request<{ sessions: SessionInfo[] }>('sessions.list', { spawnedBy: parentId });
        for (const s of sessions) {
          const r = this.#remote.get(s.id);
          if (r && r.parentId === parentId && s.machineId === r.machineId) r.info = { ...s };
        }
        this.#saveRemote();
      } catch (err) {
        this.#log.log('debug', 'could not refresh remote helpers', { parentId, err });
      }
    }
    return [...local, ...mine.map((r) => ({ ...r.info }))];
  }

  /** Throws unless `helperId` is a helper started by `parentId` on this machine. */
  assertHelper(parentId: string, helperId: string): SessionInfo {
    return this.#assertLocal(parentId, helperId, undefined);
  }

  async startHelper(parentId: string, req: StartHelperRequest): Promise<StartHelperResult> {
    const sessions = this.#d.sessions;
    const parent = sessions.get(parentId).session;
    if (TERMINAL.includes(parent.status)) throw new BizziError('conflict', 'the calling session has ended');
    if (typeof req.prompt !== 'string' || !req.prompt.trim()) throw new BizziError('bad_request', 'prompt is required');
    if (req.machine !== undefined && req.machine !== null && req.machine !== '') {
      if (typeof req.machine !== 'string') throw new BizziError('bad_request', 'machine must be a machine id or name');
      const target = await this.#resolveMachine(req.machine);
      if (target) return this.#startRemote(parent, req, target);
    }
    const settings = this.settings.effective(parent.workspaceId);
    const depth = (parent.depth ?? 0) + 1;
    if (depth > settings.maxDepth) {
      throw new BizziError('conflict', `helper depth limit reached (max ${settings.maxDepth}); finish this work yourself`, {
        maxDepth: settings.maxDepth,
      });
    }
    const over = sessions.overBudget(parentId);
    if (over) throw new BizziError('conflict', `${over}; no new helpers until the budget is raised`, { budget: true });
    const workspace = this.#resolveWorkspace(parent, req.workspace);
    return this.#launch(
      { id: parentId, agent: parent.agent, permissionMode: parent.permissionMode, depth: parent.depth ?? 0 },
      settings,
      workspace,
      req,
    );
  }

  async send(parentId: string, helperId: string, input: InputBlock[]): Promise<{ turnId: string }> {
    const remote = this.#remoteFor(parentId, helperId);
    if (remote) return this.#hubCall<{ turnId: string }>(remote, 'helper.send', { input });
    this.assertHelper(parentId, helperId);
    return this.#d.sessions.send(helperId, input);
  }

  async interrupt(parentId: string, helperId: string): Promise<void> {
    const remote = this.#remoteFor(parentId, helperId);
    if (remote) {
      await this.#hubCall(remote, 'helper.interrupt', {});
      return;
    }
    this.assertHelper(parentId, helperId);
    await this.#d.sessions.interrupt(helperId);
  }

  async stop(parentId: string, helperId: string): Promise<void> {
    const remote = this.#remoteFor(parentId, helperId);
    if (remote) {
      await this.#hubCall(remote, 'helper.stop', {});
      remote.info = { ...remote.info, status: 'ended' };
      remote.stopPending = undefined;
      this.#saveRemote();
      return;
    }
    this.assertHelper(parentId, helperId);
    this.#dequeue(helperId);
    await this.#d.sessions.stop(helperId);
  }

  /** Wait until the helper reaches `until` or `timeoutMs` passes. Returns the state and a one-line reason. */
  async wait(parentId: string, helperId: string, until: WaitUntil, timeoutMs = DEFAULT_WAIT_MS, signal?: AbortSignal): Promise<WaitResult> {
    if (!WAIT_UNTIL.includes(until)) throw new BizziError('bad_request', `until must be one of ${WAIT_UNTIL.join(', ')}`);
    const ms = Math.max(0, Math.min(timeoutMs, MAX_WAIT_MS));
    const remote = this.#remoteFor(parentId, helperId);
    if (remote) return this.#remoteWait(remote, until, ms, signal);
    this.assertHelper(parentId, helperId);
    return this.#waitFor(helperId, until, ms, signal, parentId);
  }

  /** Structured summary of what the helper did since `since` (usage.md §2): never the raw transcript by default. */
  async read(parentId: string, helperId: string, opts: ReadOptions = {}): Promise<ReadResult> {
    const remote = this.#remoteFor(parentId, helperId);
    if (remote) {
      const r = await this.#hubCall<ReadResult>(remote, 'helper.read', { ...opts });
      this.#noteRemote(remote, r.state, r.usage);
      return r;
    }
    const info = this.assertHelper(parentId, helperId);
    return this.#readFor(info, opts, parentId);
  }

  /** Machines a helper could run on: this one, plus every machine the hub knows when linked. */
  async machines(): Promise<{ connected: boolean; machines: HelperMachine[] }> {
    const self = this.#d.machine;
    const selfId = self?.id ?? '';
    const view = (m: MachineInfo, workspaces: WorkspaceInfo[], isSelf: boolean): HelperMachine => ({
      id: m.id,
      name: m.name,
      online: isSelf ? true : m.online,
      self: isSelf,
      os: m.os,
      headful: m.headful,
      tags: [...(m.tags ?? [])],
      ...(m.description ? { description: m.description } : {}),
      ...(m.lastSeenAt && !isSelf ? { lastSeenAt: m.lastSeenAt } : {}),
      workspaces: workspaces
        .filter((w) => w.machineId === m.id)
        .map((w) => ({ id: w.id, name: w.name, path: w.path, kind: w.kind, ...(w.branch ? { branch: w.branch } : {}) })),
    });
    const localWs = this.#d.workspaces.list();
    const hub = this.#d.hub;
    if (hub?.connected) {
      try {
        const [{ machines }, { workspaces }] = await Promise.all([
          hub.request<{ machines: MachineInfo[] }>('machines.list', {}),
          hub.request<{ workspaces: WorkspaceInfo[] }>('workspaces.list', {}),
        ]);
        const out = machines.filter((m) => !(m.roles?.length === 1 && m.roles[0] === 'hub')).map((m) => view(m, m.id === selfId ? localWs : workspaces, m.id === selfId));
        if (self && !out.some((m) => m.self)) out.unshift(view(self, localWs, true));
        return { connected: true, machines: out };
      } catch (err) {
        this.#log.log('debug', 'machines.list through the hub failed', { err });
      }
    }
    return { connected: false, machines: self ? [view(self, localWs, true)] : [] };
  }

  // --- the target side of cross-machine helpers (helper.*, called through the hub) -----------------------

  /** `helper.start`: a parent on `caller`'s machine starts a helper here. */
  async startForRemote(caller: NodeCaller | undefined, parent: HelperParent, req: HelperStartRequest): Promise<StartHelperResult> {
    const from = callerMachine(caller);
    if (!parent || typeof parent !== 'object') throw new BizziError('bad_request', 'parent is required');
    if (typeof parent.sessionId !== 'string' || !parent.sessionId) throw new BizziError('bad_request', 'parent.sessionId is required');
    if (!AGENT_KINDS.includes(parent.agent)) throw new BizziError('bad_request', 'parent.agent is required');
    if (!Number.isInteger(parent.depth) || parent.depth < 0) throw new BizziError('bad_request', 'parent.depth must be a non-negative integer');
    if (parent.permissionMode !== undefined && typeof parent.permissionMode !== 'string') throw new BizziError('bad_request', 'parent.permissionMode must be a string');
    if (!req || typeof req !== 'object') throw new BizziError('bad_request', 'request is required');
    if (!AGENT_KINDS.includes(req.agent)) throw new BizziError('bad_request', `unknown agent ${String(req.agent)}`);
    if (typeof req.prompt !== 'string' || !req.prompt.trim()) throw new BizziError('bad_request', 'prompt is required');
    if (this.#d.sessions.draining) throw new BizziError('machine_offline', 'this machine is shutting down');
    const workspace = await this.#resolveWorkspaceForRemote(parent, req.workspace);
    const settings = this.settings.effective(workspace.id);
    const depth = parent.depth + 1;
    if (depth > settings.maxDepth) {
      throw new BizziError('conflict', `helper depth limit reached on ${this.#machineName()} (max ${settings.maxDepth}); finish this work yourself`, {
        maxDepth: settings.maxDepth,
      });
    }
    const budget = parseBudget(req.budget, 'request.budget');
    const r = await this.#launch(
      { id: parent.sessionId, agent: parent.agent, permissionMode: parent.permissionMode, depth: parent.depth, remote: { machineId: from } },
      settings,
      workspace,
      { ...pickStart(req), ...(budget ? { budget } : {}) },
    );
    return r;
  }

  async remoteSend(caller: NodeCaller | undefined, parentId: string, helperId: string, input: InputBlock[]): Promise<{ turnId: string }> {
    this.#assertLocal(parentId, helperId, callerMachine(caller));
    return this.#d.sessions.send(helperId, input);
  }

  async remoteInterrupt(caller: NodeCaller | undefined, parentId: string, helperId: string): Promise<void> {
    this.#assertLocal(parentId, helperId, callerMachine(caller));
    await this.#d.sessions.interrupt(helperId);
  }

  async remoteStop(caller: NodeCaller | undefined, parentId: string, helperId: string): Promise<void> {
    this.#assertLocal(parentId, helperId, callerMachine(caller));
    this.#dequeue(helperId);
    await this.#d.sessions.stop(helperId);
  }

  async remoteWait(caller: NodeCaller | undefined, parentId: string, helperId: string, until: WaitUntil, timeoutMs: number): Promise<WaitResult> {
    this.#assertLocal(parentId, helperId, callerMachine(caller));
    if (!WAIT_UNTIL.includes(until)) throw new BizziError('bad_request', `until must be one of ${WAIT_UNTIL.join(', ')}`);
    const r = await this.#waitFor(helperId, until, Math.max(0, Math.min(timeoutMs, MAX_WAIT_MS)));
    if (this.#d.sessions.has(helperId)) r.usage = this.#d.sessions.spent(helperId).tree;
    return r;
  }

  async remoteRead(caller: NodeCaller | undefined, parentId: string, helperId: string, opts: ReadOptions): Promise<ReadResult> {
    const info = this.#assertLocal(parentId, helperId, callerMachine(caller));
    return this.#readFor(info, opts);
  }

  // --- internals -------------------------------------------------------------------------------------

  /** Everything after the parent is known and the workspace resolved: the shared guardrails and the start. */
  async #launch(parent: ParentFacts, settings: OrchestrationSettings, base: WorkspaceInfo, req: StartHelperRequest): Promise<StartHelperResult> {
    const sessions = this.#d.sessions;
    const depth = parent.depth + 1;
    const scope = req.scope ?? 'child';
    if (scope !== 'child' && scope !== 'detached') throw new BizziError('bad_request', "scope must be 'child' or 'detached'");

    const notes: string[] = [];
    const mode = req.mode ?? this.#d.registry.defaultMode(req.agent);
    const adapter = mode && this.#d.registry.select(req.agent, mode);
    if (!mode || !adapter) throw new BizziError('agent_unavailable', `${req.agent} is not available on ${parent.remote ? this.#machineName() : 'this machine'}`);
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

    let workspace = base;
    if (req.worktree !== undefined) {
      if (typeof req.worktree !== 'string' || !req.worktree.trim()) throw new BizziError('bad_request', 'worktree must be a branch name');
      workspace = await this.#d.workspaces.createWorktree({ workspaceId: workspace.id, branch: req.worktree.trim() });
    }

    // Concurrency (spec §12.2): live helpers per parent and per machine.
    const limit = this.#limitReached(parent.id, settings);
    if (limit && settings.onLimit === 'fail') throw new BizziError('conflict', `${limit}; stop a helper first`);
    const queued = Boolean(limit);
    if (limit) notes.push(`queued: ${limit}`);

    const params: Parameters<Sessions['create']>[0] = { workspaceId: workspace.id, agent: req.agent, mode };
    if (req.model) params.model = req.model;
    if (clamp.permissionMode) params.permissionMode = clamp.permissionMode;
    if (req.effort) params.effort = req.effort;
    params.title = req.title?.trim() || titleFrom(req.prompt);
    if (req.budget) params.budget = req.budget;
    if (settings.parentAnswersApprovals) notes.push('you may answer some of its approvals and questions with session_answer; the user can still answer first');
    const session = await sessions.create(params, {
      spawnedBy: parent.id,
      scope,
      depth,
      ...(queued ? { queued: true, queuedReason: `queued: ${limit}` } : {}),
      ...(settings.parentAnswersApprovals ? { parentAnswersApprovals: true } : {}),
      ...(parent.remote ? { remoteParent: { machineId: parent.remote.machineId, agent: parent.agent, ...(parent.permissionMode ? { permissionMode: parent.permissionMode } : {}) } } : {}),
    });
    if (queued) {
      this.#queue.push({ sessionId: session.id, parentId: parent.id, prompt: req.prompt });
    } else {
      try {
        await sessions.send(session.id, [{ type: 'text', text: req.prompt }]);
      } catch (err) {
        notes.push(`the prompt could not be sent: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.#log.log('info', 'helper started', {
      parentId: parent.id,
      sessionId: session.id,
      agent: req.agent,
      depth,
      scope,
      queued,
      ...(parent.remote ? { parentMachineId: parent.remote.machineId } : {}),
    });
    return { session: sessions.get(session.id).session, workspace, queued, notes };
  }

  /** Start a helper on another machine through the hub; the guardrails this side can check come first. */
  async #startRemote(parent: SessionInfo, req: StartHelperRequest, machine: MachineInfo): Promise<StartHelperResult> {
    const sessions = this.#d.sessions;
    const hub = this.#d.hub!;
    const settings = this.settings.effective(parent.workspaceId);
    const depth = (parent.depth ?? 0) + 1;
    if (depth > settings.maxDepth) {
      throw new BizziError('conflict', `helper depth limit reached (max ${settings.maxDepth}); finish this work yourself`, {
        maxDepth: settings.maxDepth,
      });
    }
    const over = sessions.overBudget(parent.id);
    if (over) throw new BizziError('conflict', `${over}; no new helpers until the budget is raised`, { budget: true });
    const scope = req.scope ?? 'child';
    if (scope !== 'child' && scope !== 'detached') throw new BizziError('bad_request', "scope must be 'child' or 'detached'");
    if (!AGENT_KINDS.includes(req.agent)) throw new BizziError('bad_request', `unknown agent ${String(req.agent)}`);
    // The parent's limit counts its helpers everywhere. Another machine can't hold a queue slot for us, so
    // a full parent fails here; the target applies its own per-machine limit (and its onLimit).
    const live = this.#liveHelpers(parent.id);
    if (live >= settings.maxHelpersPerParent) {
      throw new BizziError('conflict', `this session already has ${live} live helper(s) (max ${settings.maxHelpersPerParent}); stop a helper first`);
    }
    // Budgets: the helper gets at most what the parent's caps have left; its spend comes back with waits and reads.
    const requested = parseBudget(req.budget);
    const budget = minBudget(requested, sessions.remainingBudget(parent.id));
    const facts: HelperParent = { sessionId: parent.id, agent: parent.agent, depth: parent.depth ?? 0 };
    if (parent.permissionMode) facts.permissionMode = parent.permissionMode;
    const ws = this.#d.workspaces.list().find((w) => w.id === parent.workspaceId);
    if (ws?.projectId) facts.projectId = ws.projectId;
    if (ws && ws.kind !== 'dir') {
      const url = await originUrl(ws.path);
      if (url) facts.gitRemote = normalizeRemoteUrl(url);
    }
    const request: HelperStartRequest = { ...pickStart(req), scope };
    if (budget) request.budget = budget;
    else delete request.budget;
    const r = await hub.request<HelperStartResult>('helper.start', { machineId: machine.id, parent: facts, request }, { timeoutMs: REMOTE_START_TIMEOUT_MS });
    const rec: RemoteHelper = { helperId: r.session.id, machineId: machine.id, parentId: parent.id, scope, info: { ...r.session } };
    this.#remote.set(rec.helperId, rec);
    this.#saveRemote();
    const notes = [...(r.notes ?? [])];
    if (requested && budget && JSON.stringify(budget) !== JSON.stringify(requested)) notes.push(`budget capped at what this session has left: ${JSON.stringify(budget)}`);
    else if (!requested && budget) notes.push(`budget set to what this session has left: ${JSON.stringify(budget)}`);
    this.#log.log('info', 'remote helper started', { parentId: parent.id, sessionId: rec.helperId, machineId: machine.id, agent: req.agent, scope });
    return { ...r, notes: [`runs on ${machine.name}`, ...notes] };
  }

  /** undefined when `ref` is this machine; the target MachineInfo otherwise (online), else throws. */
  async #resolveMachine(ref: string): Promise<MachineInfo | undefined> {
    const self = this.#d.machine;
    const want = ref.trim();
    if (self && (want === self.id || want.toLowerCase() === self.name.toLowerCase())) return undefined;
    const hub = this.#d.hub;
    if (!hub) throw new BizziError('unsupported', 'helpers on other machines need a hub link');
    const { machines } = await hub.request<{ machines: MachineInfo[] }>('machines.list', {});
    let m = machines.find((x) => x.id === want);
    if (!m) {
      const byName = machines.filter((x) => x.name.toLowerCase() === want.toLowerCase());
      if (byName.length > 1) throw new BizziError('bad_request', `several machines are called ${want}; use a machine id`, { machines: byName.map((x) => x.id) });
      m = byName[0];
    }
    if (!m) throw new BizziError('not_found', `no machine ${want} (machines: ${machines.map((x) => x.name).join(', ') || 'none'})`);
    if (self && m.id === self.id) return undefined;
    if (m.roles?.length === 1 && m.roles[0] === 'hub') throw new BizziError('bad_request', `${m.name} is the hub, not a machine that runs agents`);
    if (!m.online) {
      throw new BizziError('machine_offline', `machine ${m.name} is offline${m.lastSeenAt ? ` (last seen ${m.lastSeenAt})` : ''}`, {
        machineId: m.id,
        lastSeenAt: m.lastSeenAt,
      });
    }
    return m;
  }

  /** The record of a remote helper of `parentId`, or undefined when `helperId` should be local. */
  #remoteFor(parentId: string, helperId: string): RemoteHelper | undefined {
    if (typeof helperId !== 'string' || !helperId) throw new BizziError('bad_request', 'sessionId is required');
    if (this.#d.sessions.has(helperId)) return undefined;
    const r = this.#remote.get(helperId);
    if (!r) return undefined;
    if (r.parentId !== parentId) throw new BizziError('not_found', `no helper ${helperId} (only helpers this session started can be used)`);
    return r;
  }

  #hubCall<T = unknown>(r: RemoteHelper, method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    const hub = this.#d.hub;
    if (!hub) return Promise.reject(new BizziError('unsupported', 'helpers on other machines need a hub link'));
    return hub.request<T>(method, { ...params, machineId: r.machineId, sessionId: r.helperId, parentId: r.parentId }, timeoutMs ? { timeoutMs } : {});
  }

  async #remoteWait(r: RemoteHelper, until: WaitUntil, ms: number, signal?: AbortSignal): Promise<WaitResult> {
    const call = this.#hubCall<WaitResult>(r, 'helper.wait', { until, timeoutMs: ms }, ms + REMOTE_MARGIN_MS);
    let res: WaitResult;
    if (signal) {
      if (signal.aborted) return { sessionId: r.helperId, state: r.info.status, reached: false, reason: 'the wait was cancelled' };
      res = await new Promise<WaitResult>((resolve, reject) => {
        const onAbort = () => resolve({ sessionId: r.helperId, state: r.info.status, reached: false, reason: 'the wait was cancelled' });
        signal.addEventListener('abort', onAbort, { once: true });
        call.then(
          (v) => {
            signal.removeEventListener('abort', onAbort);
            resolve(v);
          },
          (e: unknown) => {
            signal.removeEventListener('abort', onAbort);
            reject(e);
          },
        );
      });
    } else {
      res = await call;
    }
    this.#noteRemote(r, res.state, res.usage);
    return res;
  }

  /** Remember a remote helper's state and spend (its spend counts in the parent's tree, spec §12.4). */
  #noteRemote(r: RemoteHelper, state: SessionStatus | undefined, usage: Spent | undefined): void {
    if (state && r.info.status !== state) {
      r.info = { ...r.info, status: state };
      this.#saveRemote();
    }
    if (usage && typeof usage === 'object') this.#d.sessions.recordRemoteSpent(r.parentId, r.helperId, usage);
  }

  /** Live helpers of `parentId` here plus remote ones not known to have ended. */
  #liveHelpers(parentId: string): number {
    const sessions = this.#d.sessions;
    const local = sessions.list(undefined, { spawnedBy: parentId }).filter((s) => !TERMINAL.includes(s.status) && !sessions.isQueued(s.id)).length;
    let remote = 0;
    for (const r of this.#remote.values()) if (r.parentId === parentId && !TERMINAL.includes(r.info.status)) remote++;
    return local + remote;
  }

  /** A parent ended (or was deleted): stop its child helpers on other machines, now or on the next link. */
  #parentGone(parentId: string, removed: boolean): void {
    let changed = false;
    for (const r of [...this.#remote.values()]) {
      if (r.parentId !== parentId) continue;
      if (r.scope === 'child' && !TERMINAL.includes(r.info.status)) {
        r.stopPending = true;
        changed = true;
      } else if (removed) {
        this.#remote.delete(r.helperId);
        changed = true;
      }
    }
    if (changed) {
      this.#saveRemote();
      void this.#flushPendingStops(removed ? parentId : undefined);
    }
  }

  async #flushPendingStops(dropParent?: string): Promise<void> {
    const hub = this.#d.hub;
    if (!hub?.connected) return;
    for (const r of [...this.#remote.values()]) {
      if (!r.stopPending) continue;
      try {
        await this.#hubCall(r, 'helper.stop', {});
        r.stopPending = undefined;
        r.info = { ...r.info, status: 'ended' };
        this.#log.log('debug', 'stopped remote child helper with its parent', { sessionId: r.helperId, parentId: r.parentId, machineId: r.machineId });
      } catch (err) {
        const code = err instanceof BizziError ? err.code : undefined;
        if (code === 'not_found') {
          // Already gone on the target (deleted, or the machine was reset).
          r.stopPending = undefined;
          r.info = { ...r.info, status: 'ended' };
        } else {
          this.#log.log('debug', 'remote child helper not stopped yet', { sessionId: r.helperId, machineId: r.machineId, err });
          continue;
        }
      }
      if (!this.#d.sessions.has(r.parentId) || r.parentId === dropParent) this.#remote.delete(r.helperId);
    }
    this.#saveRemote();
  }

  #loadRemote(): void {
    const raw = this.#d.store?.getMeta(REMOTE_HELPERS_KEY);
    if (!raw) return;
    let list: RemoteHelper[];
    try {
      list = JSON.parse(raw) as RemoteHelper[];
    } catch {
      return;
    }
    if (!Array.isArray(list)) return;
    for (const r of list) {
      if (!r || typeof r.helperId !== 'string' || typeof r.parentId !== 'string' || typeof r.machineId !== 'string' || !r.info) continue;
      // A child whose parent ended (or vanished) while this node was down stops on the next link.
      const parent = this.#d.sessions.has(r.parentId) ? this.#d.sessions.get(r.parentId).session : undefined;
      if (r.scope === 'child' && !TERMINAL.includes(r.info.status) && (!parent || TERMINAL.includes(parent.status))) r.stopPending = true;
      if (!parent && !r.stopPending) continue;
      this.#remote.set(r.helperId, r);
    }
  }

  #saveRemote(): void {
    const store = this.#d.store;
    if (!store) return;
    try {
      if (this.#remote.size === 0) store.deleteMeta(REMOTE_HELPERS_KEY);
      else store.setMeta(REMOTE_HELPERS_KEY, JSON.stringify([...this.#remote.values()]));
    } catch (err) {
      // The store is closed during shutdown.
      this.#log.log('debug', 'could not save remote helper records', { err });
    }
  }

  #machineName(): string {
    return this.#d.machine?.name ?? 'this machine';
  }

  /** Ownership: the helper exists here and was started by `parentId` (on `fromMachine` for remote parents). */
  #assertLocal(parentId: string, helperId: string, fromMachine: string | undefined): SessionInfo {
    if (typeof helperId !== 'string' || !helperId) throw new BizziError('bad_request', 'sessionId is required');
    let s: SessionInfo;
    try {
      s = this.#d.sessions.get(helperId).session;
    } catch {
      throw new BizziError('not_found', `no helper ${helperId}`);
    }
    if (s.spawnedBy !== parentId || (s.spawnedByMachineId ?? undefined) !== fromMachine) {
      throw new BizziError('not_found', `no helper ${helperId} (only helpers this session started can be used)`);
    }
    return s;
  }

  /** With `parentId` (a local parent), items the parent may answer are listed and `done` returns for new ones. */
  #waitFor(helperId: string, until: WaitUntil, ms: number, signal?: AbortSignal, parentId?: string): Promise<WaitResult> {
    const check = (): WaitResult | undefined => {
      if (!this.#d.sessions.has(helperId)) return { sessionId: helperId, state: 'ended', reached: true, reason: 'the helper was deleted' };
      const items = parentId ? this.pendingFor(parentId, helperId) : undefined;
      // `done` also returns for something new the parent may answer, so it can unblock its helper.
      const fresh = items?.some((i) => (i.parentMay.includes('allow') || i.parentMay.includes('answer')) && !this.#reported.get(helperId)?.has(i.id));
      if (!this.#reached(helperId, until) && !(until === 'done' && fresh)) return undefined;
      return this.#withPending(this.#waitResult(helperId, true, undefined, undefined, items), items);
    };
    const now = check();
    if (now) return Promise.resolve(now);
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
        finish(r ?? this.#withPending(this.#waitResult(helperId, false, ms), parentId ? this.pendingFor(parentId, helperId) : undefined));
      }, ms);
      const onAbort = () => finish(this.#d.sessions.has(helperId) ? this.#waitResult(helperId, false, ms, 'the wait was cancelled') : { sessionId: helperId, state: 'ended', reached: true, reason: 'the helper was deleted' });
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * The same summary for any session on this machine, without the ownership check (pipelines, docs/pipelines.md).
   * With `parentId`, pending items the parent may answer are listed too (parentAnswersApprovals).
   */
  summarize(helperId: string, opts: ReadOptions = {}, parentId?: string): Promise<ReadResult> {
    return this.#readFor(this.#d.sessions.get(helperId).session, opts, parentId);
  }

  async #readFor(info: SessionInfo, opts: ReadOptions, parentId?: string): Promise<ReadResult> {
    const helperId = info.id;
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
      const items = parentId ? this.pendingFor(parentId, helperId) : undefined;
      out.waitingOn = {
        approvals: pending.approvals.map((a) => a.title || a.kind),
        questions: pending.questions.map((q) => q.text),
        ...(pending.budget ? { budget: pending.budget } : {}),
        ...(items?.length ? { items } : {}),
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

  // ---- parent answers approvals (spec §12.5) ----------------------------------------------------------

  /**
   * The helper's pending approvals and questions with what the parent may do about each, or undefined
   * when the parent may not answer for this helper at all (the default: they go to the user).
   */
  pendingFor(parentId: string, helperId: string): PendingItem[] | undefined {
    const helper = this.assertHelper(parentId, helperId);
    const parent = this.#d.sessions.get(parentId).session;
    if (this.#gate(parent, helper)) return undefined;
    const pending = this.#d.sessions.pending(helperId);
    const items: PendingItem[] = [];
    for (const a of pending.approvals) {
      const allow = this.#mayAllow(parent, helper, a);
      const item: PendingItem = { type: 'approval', id: a.approvalId, kind: a.kind, title: a.title || a.kind, parentMay: allow.ok ? ['allow', 'deny'] : ['deny'] };
      if (a.description) item.description = a.description;
      if (a.input !== undefined) item.input = truncate(safeJson(a.input), MAX_INPUT_CHARS).text;
      if (!allow.ok) item.note = allow.why;
      items.push(item);
    }
    for (const q of pending.questions) {
      const item: PendingItem = { type: 'question', id: q.questionId, title: q.text, parentMay: ['answer', 'cancel'] };
      if (q.options) item.options = q.options;
      if (q.questions) item.questions = q.questions;
      items.push(item);
    }
    return items;
  }

  /**
   * Answer one of the helper's approvals or questions as its parent (the spec §12.2 opt-in). The user
   * can still answer first; then this returns `answered: false` with `alreadyAnswered` instead of
   * failing. What the parent may never decide (allow_always, edited input, an allow outside the
   * helper's workspace, beyond the parent's own permission level, or while the helper is over budget)
   * stays with the user and fails with `conflict`.
   */
  async answer(parentId: string, helperId: string, req: AnswerRequest): Promise<AnswerResult> {
    const helper = this.assertHelper(parentId, helperId);
    const parent = this.#d.sessions.get(parentId).session;
    if (!req || typeof req.id !== 'string' || !req.id) throw new BizziError('bad_request', 'id (an approvalId or questionId) is required');
    const gate = this.#gate(parent, helper);
    if (gate) throw new BizziError('conflict', gate, { goesToUser: true });
    const sessions = this.#d.sessions;
    const pending = sessions.pending(helperId);
    const approval = pending.approvals.find((a) => a.approvalId === req.id);
    const question = approval ? undefined : pending.questions.find((q) => q.questionId === req.id);
    const responder = { by: 'parent' as const, sessionId: parentId };
    try {
      if (approval) {
        const decision = req.decision;
        if (decision === 'allow_always') {
          throw new BizziError('conflict', 'allow_always saves a rule beyond this helper; only the user can choose it. Use allow or deny.', { goesToUser: true });
        }
        if (decision !== 'allow' && decision !== 'deny') throw new BizziError('bad_request', "decision must be 'allow' or 'deny' for an approval");
        if (req.editedInput !== undefined) throw new BizziError('conflict', "only the user can edit an approval's input", { goesToUser: true });
        if (req.answers !== undefined || req.cancel !== undefined) throw new BizziError('bad_request', `${req.id} is an approval: pass decision, not answers or cancel`);
        if (decision === 'allow') {
          const allow = this.#mayAllow(parent, helper, approval);
          if (!allow.ok) throw new BizziError('conflict', `${allow.why}; allowing it stays with the user (you may deny it)`, { goesToUser: true });
        }
        const params: Parameters<Sessions['respondApproval']>[0] = { sessionId: helperId, approvalId: approval.approvalId, decision };
        if (req.message !== undefined) params.message = req.message;
        await sessions.respondApproval(params, responder);
        this.#log.log('info', 'parent answered a helper approval', { parentId, sessionId: helperId, approvalId: approval.approvalId, decision });
        return { sessionId: helperId, id: req.id, answered: true, message: `${decision === 'allow' ? 'Allowed' : 'Denied'}: ${oneLine(approval.title || approval.kind)}` };
      }
      if (question) {
        if (req.decision !== undefined) throw new BizziError('bad_request', `${req.id} is a question: pass answers or cancel, not decision`);
        if (req.cancel !== true && req.answers === undefined) throw new BizziError('bad_request', 'answers or cancel is required');
        const params: Parameters<Sessions['respondQuestion']>[0] = { sessionId: helperId, questionId: question.questionId };
        if (req.cancel === true) params.cancel = true;
        else params.answers = req.answers!;
        await sessions.respondQuestion(params, responder);
        this.#log.log('info', 'parent answered a helper question', { parentId, sessionId: helperId, questionId: question.questionId, cancel: req.cancel === true });
        return { sessionId: helperId, id: req.id, answered: true, message: req.cancel === true ? 'Declined the question.' : 'Answered.' };
      }
      const r = sessions.resolution(helperId, req.id);
      if (r) return alreadyAnswered(helperId, req.id, r);
      throw new BizziError('not_found', `${helper.id} has no pending approval or question ${req.id}`);
    } catch (err) {
      const data = err instanceof BizziError ? (err.data as { alreadyAnswered?: boolean; outcome?: string; by?: string; bySessionId?: string } | undefined) : undefined;
      if (!data?.alreadyAnswered) throw err;
      const r: { outcome: string; by?: string; bySessionId?: string } = { outcome: data.outcome ?? 'answered' };
      if (data.by) r.by = data.by;
      if (data.bySessionId) r.bySessionId = data.bySessionId;
      return alreadyAnswered(helperId, req.id, r);
    }
  }

  /** Why the parent may not answer for this helper at all, or undefined when it may (within #mayAllow). */
  #gate(parent: SessionInfo, helper: SessionInfo): string | undefined {
    if (!helper.parentAnswersApprovals) return 'this helper was started without parentAnswersApprovals; the user answers its approvals and questions';
    if (!this.settings.effective(parent.workspaceId).parentAnswersApprovals) return 'parentAnswersApprovals is off for this workspace now; the user answers';
    if (TERMINAL.includes(parent.status)) return 'the calling session has ended';
    return undefined;
  }

  /**
   * Whether the parent may allow an approval on the user's behalf: only what its own permission mode
   * does without asking, only inside the helper's workspace, and only while the helper is within
   * budget. Deny is always the parent's to choose once it may answer at all.
   */
  #mayAllow(parent: SessionInfo, helper: SessionInfo, a: ApprovalRequest): { ok: true } | { ok: false; why: string } {
    const over = this.#d.sessions.overBudget(helper.id);
    if (over) return { ok: false, why: `the helper is over its budget (${over})` };
    const need = ALLOW_LEVEL[a.kind] ?? 3;
    const level = permissionLevel(parent.agent, parent.permissionMode) ?? 1;
    if (level < need) {
      return { ok: false, why: `allowing a ${a.kind} approval needs a parent that ${LEVEL_NEEDS[need]} itself, and yours (${parent.permissionMode ?? 'default'}) doesn't` };
    }
    let root: string;
    try {
      root = this.#d.workspaces.get(helper.workspaceId).path;
    } catch {
      return { ok: false, why: "the helper's workspace is gone" };
    }
    const paths = approvalPaths(a.input);
    if (paths.length === 0 && (a.kind === 'read' || a.kind === 'edit' || a.kind === 'write')) {
      return { ok: false, why: 'bizzi cannot tell which files it touches' };
    }
    const outside = paths.find((p) => !isInside(root, p));
    if (outside !== undefined) return { ok: false, why: `${outside} is outside the helper's workspace (${root})` };
    return { ok: true };
  }

  /** Attach pending items and remember them as reported to the parent. */
  #withPending(r: WaitResult, items: PendingItem[] | undefined): WaitResult {
    if (!items?.length) return r;
    let seen = this.#reported.get(r.sessionId);
    if (!seen) this.#reported.set(r.sessionId, (seen = new Set()));
    for (const i of items) seen.add(i.id);
    return { ...r, pending: items };
  }

  // --- internals -------------------------------------------------------------------------------------

  #resolveWorkspace(parent: SessionInfo, ref: string | undefined): WorkspaceInfo {
    if (ref === undefined || ref === '') return this.#d.workspaces.get(parent.workspaceId);
    return this.#findWorkspace(ref);
  }

  #findWorkspace(ref: string): WorkspaceInfo {
    if (typeof ref !== 'string') throw new BizziError('bad_request', 'workspace must be a workspace id or path');
    const all = this.#d.workspaces.list();
    const ws = all.find((w) => w.id === ref) ?? all.find((w) => w.path === ref.replace(/\/+$/, ''));
    if (!ws) throw new BizziError('not_found', `workspace ${ref} is not registered on ${this.#machineName()}`);
    return ws;
  }

  /**
   * Default workspace for a helper whose parent is on another machine: the one linked to the parent's
   * (same project, else same `origin`), else the only workspace here.
   */
  async #resolveWorkspaceForRemote(parent: HelperParent, ref: string | undefined): Promise<WorkspaceInfo> {
    if (ref !== undefined && ref !== '') return this.#findWorkspace(ref);
    const linked = await linkedWorkspace(this.#d.workspaces.list(), parent);
    if (linked) return linked;
    const roots = this.#d.workspaces.list().filter((w) => w.kind !== 'worktree');
    if (roots.length === 1) return roots[0]!;
    const names = roots.map((w) => `${w.name} (${w.path})`).join(', ');
    throw new BizziError('bad_request', `no workspace on ${this.#machineName()} is linked to the parent's; pass workspace (one of: ${names || 'none registered'})`);
  }

  /** Why another helper can't run now, or undefined when there's a free slot. */
  #limitReached(parentId: string, settings: OrchestrationSettings): string | undefined {
    const sessions = this.#d.sessions;
    const live = sessions.list().filter((s) => s.spawnedBy && !TERMINAL.includes(s.status) && !sessions.isQueued(s.id));
    let mine = live.filter((s) => s.spawnedBy === parentId).length;
    for (const r of this.#remote.values()) if (r.parentId === parentId && !TERMINAL.includes(r.info.status)) mine++;
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

  #waitResult(id: string, reached: boolean, waitedMs?: number, why?: string, items?: PendingItem[]): WaitResult {
    const s = this.#d.sessions.get(id).session;
    if (!reached) {
      return { sessionId: id, state: s.status, reached, reason: why ?? `still ${s.status} after ${Math.round((waitedMs ?? 0) / 1000)}s; wait again or read progress` };
    }
    return { sessionId: id, state: s.status, reached, reason: this.#reason(id, s, items) };
  }

  #reason(id: string, s: SessionInfo, items?: PendingItem[]): string {
    const pending = this.#d.sessions.pending(id);
    if (pending.budget) return pending.budget;
    const first = items?.[0];
    if (first) {
      if (first.parentMay.includes('allow') || first.parentMay.includes('answer')) {
        const what = first.type === 'approval' ? 'approval' : 'an answer';
        return `waiting for ${what} (${first.id}); you may answer it with session_answer, or leave it to the user: ${oneLine(first.title)}`;
      }
      return `waiting for the user to approve: ${oneLine(first.title)} (you may only deny it: ${first.note ?? 'not yours to allow'})`;
    }
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

function alreadyAnswered(sessionId: string, id: string, r: { outcome: string; by?: string; bySessionId?: string }): AnswerResult {
  const who = r.by === 'user' ? 'the user' : r.by === 'parent' ? (r.bySessionId ? `parent session ${r.bySessionId}` : 'the parent') : r.by;
  const message =
    r.outcome === 'in_flight'
      ? `Already being answered by ${who ?? 'someone else'}.`
      : r.outcome === 'cancelled' && !who
        ? 'Already resolved: it was cancelled.'
        : `Already answered${who ? ` by ${who}` : ''}: ${r.outcome}.`;
  return { sessionId, id, answered: false, alreadyAnswered: { ...r }, message };
}

function safeJson(v: unknown): string {
  try {
    return typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v));
  } catch {
    return String(v);
  }
}

/**
 * Every path-like value in an approval's tool input (Claude file_path / path / notebook_path, Codex
 * changes[].path / fileChanges keys / cwd / grantRoot, OpenCode filePath / resources). Over-collects on
 * purpose: an extra path can only make the parent's allow stricter.
 */
export function approvalPaths(input: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 5 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (PATH_KEYS.has(k) && typeof x === 'string' && x) out.push(x);
      else if (PATH_LIST_KEYS.has(k) && Array.isArray(x)) {
        for (const y of x) if (typeof y === 'string' && y) out.push(y);
      } else if (k === 'fileChanges' && x && typeof x === 'object' && !Array.isArray(x)) out.push(...Object.keys(x));
      walk(x, depth + 1);
    }
  };
  walk(input, 0);
  return [...new Set(out)];
}

/** `p` (relative to `root`; symlinks resolved as far as the path exists) is `root` or below it. `~` paths never are. */
export function isInside(root: string, p: string): boolean {
  if (p.startsWith('~')) return false;
  const rootReal = realish(root);
  const target = realish(isAbsolute(p) ? p : resolve(rootReal, p));
  const rel = relative(rootReal, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** realpath of the longest existing prefix, plus the rest. */
function realish(p: string): string {
  let cur = resolve(p);
  const rest: string[] = [];
  while (!existsSync(cur)) {
    const up = dirname(cur);
    if (up === cur) return resolve(p);
    rest.unshift(basename(cur));
    cur = up;
  }
  try {
    return join(realpathSync(cur), ...rest);
  } catch {
    return resolve(p);
  }
}

/** The caller's machine id stamped by the hub (required for helper.* calls). */
function callerMachine(caller: NodeCaller | undefined): string {
  if (!caller || typeof caller !== 'object' || typeof caller.machineId !== 'string' || !caller.machineId) {
    throw new BizziError('bad_request', 'caller is required (helper.* calls come through the hub)');
  }
  return caller.machineId;
}

/** The fields of a start request that travel to another machine. */
function pickStart(req: StartHelperRequest | HelperStartRequest): HelperStartRequest {
  const out: HelperStartRequest = { agent: req.agent, prompt: req.prompt };
  for (const k of ['workspace', 'worktree', 'model', 'permissionMode', 'effort', 'title'] as const) {
    const v = req[k];
    if (v !== undefined && v !== null && v !== '') {
      if (typeof v !== 'string') throw new BizziError('bad_request', `${k} must be a string`);
      out[k] = v;
    }
  }
  if (req.scope !== undefined) out.scope = req.scope;
  if (req.budget !== undefined) out.budget = req.budget;
  return out;
}

/** Field-wise minimum of two budgets (either may be undefined). */
export function minBudget(a: SessionBudget | undefined, b: SessionBudget | undefined): SessionBudget | undefined {
  if (!a) return b ? { ...b } : undefined;
  if (!b) return { ...a };
  const out: SessionBudget = {};
  for (const k of ['usd', 'tokens', 'turns'] as const) {
    const x = a[k];
    const y = b[k];
    if (x !== undefined || y !== undefined) out[k] = x === undefined ? y! : y === undefined ? x : Math.min(x, y);
  }
  return out;
}

/**
 * The workspace on this machine linked to another machine's (spec §4 projects): same projectId, else
 * the same normalized `origin` URL. Repository workspaces win over worktrees.
 */
export async function linkedWorkspace(all: WorkspaceInfo[], ref: { projectId?: string; gitRemote?: string }): Promise<WorkspaceInfo | undefined> {
  const roots = all.filter((w) => w.kind !== 'worktree');
  if (ref.projectId) {
    const p = roots.find((w) => w.projectId === ref.projectId);
    if (p) return p;
  }
  if (ref.gitRemote) {
    for (const w of roots) {
      if (w.kind !== 'git') continue;
      const url = await originUrl(w.path);
      if (url && normalizeRemoteUrl(url) === ref.gitRemote) return w;
    }
  }
  return undefined;
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
