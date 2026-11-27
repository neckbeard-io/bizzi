// Read-only views over every session on this node, for agents (bizzi-agents `sessions_overview` and
// `session_peek`, spec §12.1): what each session was last asked, what it last said, and whether it is
// waiting on the user. Unlike the helper tools these are not limited to the caller's own helpers; they
// never change a session.

import { BizziError, sessionChannel } from '@bizzi/protocol';
import type { AgentKind, InputBlock, MachineInfo, SessionInfo, SessionStatus, WorkspaceInfo } from '@bizzi/protocol';
import type { HubPort } from './hub-port.ts';
import type { Orchestrator, ReadOptions, ReadResult } from './orchestration.ts';
import type { Sessions } from './sessions.ts';
import type { Store } from './store.ts';
import { gitStatus } from './tools.ts';
import type { Workspaces } from './workspaces.ts';

/** Trimmed lengths of the last prompt and reply in an overview entry. */
export const OVERVIEW_PROMPT_CHARS = 300;
export const OVERVIEW_REPLY_CHARS = 500;
export const OVERVIEW_DEFAULT_LIMIT = 20;
export const OVERVIEW_MAX_LIMIT = 50;
/** Rough cap on one overview page, in characters of JSON; a page stops early past it. */
export const OVERVIEW_MAX_CHARS = 40_000;
/** How far back (events of the scanned types) to look for the last prompt and reply. */
const SCAN_CAP = 400;
const EXCHANGE_TYPES = ['turn.started', 'turn.steered', 'message.completed', 'turn.completed'] as const;

export interface OverviewFilter {
  /** Workspace id or path on this machine; a repo workspace includes its worktrees. */
  workspace?: string;
  /** Default: every status except `ended`. */
  status?: SessionStatus[];
  agent?: AgentKind;
  /** ISO time, or a duration back from now: `90m`, `6h`, `2d`. */
  updatedSince?: string;
  /** Only sessions that wait on the user (pending approval, question or budget, or the heuristic). */
  waitingOnly?: boolean;
  /** Machine name or id; another machine is read from the hub's index (no prompts or replies). */
  machine?: string;
  offset?: number;
  limit?: number;
}

export interface OverviewText {
  text: string;
  at: string;
  truncated?: true;
}

/** Why a session waits on the user. `asks` is a heuristic: its final reply ends by asking something. */
export interface OverviewWaiting {
  approvals?: string[];
  questions?: string[];
  budget?: string;
  /** Status `waiting_input` / `waiting_approval` with nothing pending here (e.g. a login). */
  status?: string;
  /** Heuristic, not a pending item: the last reply ends with a question to the user. */
  asks?: { heuristic: true; question: string };
}

export interface OverviewEntry {
  sessionId: string;
  title?: string;
  agent: AgentKind;
  mode: SessionInfo['mode'];
  status: SessionStatus;
  updatedAt: string;
  machineId: string;
  workspace: { id: string; path?: string; name?: string; kind?: WorkspaceInfo['kind']; branch?: string };
  /** The calling session itself. */
  self?: true;
  /** Helper relation: the session that started this one (on `parentMachineId` when not here). */
  parentId?: string;
  parentMachineId?: string;
  scope?: SessionInfo['scope'];
  /** Ids of helpers this session started on this machine. */
  helpers?: string[];
  lastPrompt?: OverviewText;
  lastReply?: OverviewText;
  /** Something needs the user. Absent when nothing does. */
  waiting?: OverviewWaiting;
  /** A turn is in flight (or about to start). */
  turnOpen: boolean;
  /** Work the agent left running between turns. */
  background?: string[];
}

export interface OverviewResult {
  machine: { id: string; name: string; self: boolean };
  /** Where the data came from: this node's store, or the hub's index for another machine (less detail). */
  source: 'node' | 'hub-index';
  total: number;
  sessions: OverviewEntry[];
  /** Pass as `offset` for the next page. */
  nextOffset?: number;
  notes: string[];
}

export interface PeekResult extends ReadResult {
  title?: string;
  workspace: { id: string; path?: string; branch?: string };
  parentId?: string;
  lastPrompt?: OverviewText;
}

export interface HistoryDeps {
  store: Store;
  sessions: Sessions;
  workspaces: Workspaces;
  orchestration: Orchestrator;
  hub?: HubPort;
  machine: () => MachineInfo;
}

/** The last user prompt and assistant reply of a session, from the newest events back. */
export interface Exchange {
  lastPrompt?: OverviewText & { seq: number };
  lastReply?: OverviewText & { seq: number };
  /** seq of the last turn.completed. */
  lastTurnEnd?: number;
}

export class History {
  readonly #d: HistoryDeps;

  constructor(deps: HistoryDeps) {
    this.#d = deps;
  }

  /** Last prompt (skipping bizzi's own continuation prompts) and last top-level assistant reply. */
  exchange(sessionId: string): Exchange {
    const out: Exchange = {};
    let n = 0;
    for (const ev of this.#d.store.latestOfTypes(sessionChannel(sessionId), EXCHANGE_TYPES)) {
      if (++n > SCAN_CAP || (out.lastPrompt && out.lastReply && out.lastTurnEnd !== undefined)) break;
      if (ev.type === 'turn.completed') {
        out.lastTurnEnd ??= ev.seq;
      } else if (ev.type === 'message.completed') {
        if (!out.lastReply && ev.data.role === 'assistant' && !ev.data.parentToolId && ev.data.text.trim()) {
          out.lastReply = { text: ev.data.text.trim(), at: ev.ts, seq: ev.seq };
        }
      } else if (!out.lastPrompt && (ev.type === 'turn.started' || ev.type === 'turn.steered')) {
        if (ev.type === 'turn.started' && (ev.data.auto || ev.data.agent)) continue;
        const text = inputText(ev.data.input);
        if (text && !isBizziPrompt(text)) out.lastPrompt = { text, at: ev.ts, seq: ev.seq };
      }
    }
    return out;
  }

  /** Why `info` waits on the user, if it does (pending items, or the labelled heuristic). */
  waiting(info: SessionInfo, ex: Exchange): OverviewWaiting | undefined {
    const p = this.#d.sessions.pending(info.id);
    const w: OverviewWaiting = {};
    if (p.approvals.length) w.approvals = p.approvals.map((a) => oneLine(a.title || a.kind, 200));
    if (p.questions.length) w.questions = p.questions.map((q) => oneLine(q.text, 300));
    if (p.budget) w.budget = p.budget;
    if (!w.approvals && !w.questions && !w.budget && (info.status === 'waiting_input' || info.status === 'waiting_approval')) w.status = info.status;
    const quiet = info.status === 'idle' && !this.#d.sessions.isBusy(info.id);
    // The reply came after the last prompt: nothing was asked since.
    if (quiet && ex.lastReply && (ex.lastPrompt === undefined || ex.lastReply.seq > ex.lastPrompt.seq)) {
      const q = trailingQuestion(ex.lastReply.text);
      if (q) w.asks = { heuristic: true, question: q };
    }
    return Object.keys(w).length ? w : undefined;
  }

  async overview(callerId: string | undefined, f: OverviewFilter = {}): Promise<OverviewResult> {
    const self = this.#d.machine();
    const limit = clampInt(f.limit ?? OVERVIEW_DEFAULT_LIMIT, 1, OVERVIEW_MAX_LIMIT, 'limit');
    const offset = clampInt(f.offset ?? 0, 0, Number.MAX_SAFE_INTEGER, 'offset');
    const since = f.updatedSince !== undefined ? parseSince(f.updatedSince) : undefined;
    const statuses = f.status?.length ? new Set(f.status) : undefined;
    const remote = f.machine ? await this.#remoteMachine(f.machine, self) : undefined;
    if (remote) return this.#remoteOverview(remote, f, { limit, offset, since, statuses });

    const notes: string[] = [];
    const all = this.#d.sessions.list();
    let infos = all;
    if (f.workspace !== undefined) {
      const ids = familyOf(this.#d.workspaces.list(), f.workspace, 'this machine');
      infos = infos.filter((s) => ids.has(s.workspaceId));
    }
    infos = infos.filter((s) => (statuses ? statuses.has(s.status) : s.status !== 'ended'));
    if (f.agent) infos = infos.filter((s) => s.agent === f.agent);
    if (since !== undefined) infos = infos.filter((s) => Date.parse(s.updatedAt) >= since);
    infos.sort(byRecent);

    const children = new Map<string, string[]>();
    for (const s of all) {
      if (s.spawnedBy && !s.spawnedByMachineId) children.set(s.spawnedBy, [...(children.get(s.spawnedBy) ?? []), s.id]);
    }
    const entry = (s: SessionInfo): OverviewEntry => {
      const ex = this.exchange(s.id);
      const kids = children.get(s.id);
      const e: OverviewEntry = {
        ...baseEntry(s),
        ...(s.id === callerId ? { self: true as const } : {}),
        ...(kids?.length ? { helpers: kids.slice(0, 20) } : {}),
        turnOpen: this.#d.sessions.isBusy(s.id),
      };
      if (ex.lastPrompt) e.lastPrompt = clipText(ex.lastPrompt, OVERVIEW_PROMPT_CHARS);
      if (ex.lastReply) e.lastReply = clipText(ex.lastReply, OVERVIEW_REPLY_CHARS);
      const w = this.waiting(s, ex);
      if (w) e.waiting = w;
      return e;
    };

    // `waitingOnly` needs the entry to filter, so those are built before paging.
    const pool: (SessionInfo | OverviewEntry)[] = f.waitingOnly ? infos.map(entry).filter((e) => e.waiting) : infos;
    const page: OverviewEntry[] = [];
    let used = 0;
    let i = offset;
    for (; i < pool.length && page.length < limit; i++) {
      const item = pool[i]!;
      const e = 'sessionId' in item ? item : entry(item);
      const size = JSON.stringify(e).length;
      if (page.length > 0 && used + size > OVERVIEW_MAX_CHARS) break;
      page.push(e);
      used += size;
    }
    await this.#fillWorkspaces(page);
    const out: OverviewResult = { machine: { id: self.id, name: self.name, self: true }, source: 'node', total: pool.length, sessions: page, notes };
    if (i < pool.length) out.nextOffset = i;
    if (this.#d.hub?.connected) notes.push('This machine only; pass machine to look at another one.');
    return out;
  }

  /**
   * session_read's summary for any session on this node, plus where it runs and its last prompt. Read
   * only: driving a session (send, answer, stop) stays limited to the caller's own helpers.
   */
  async peek(sessionId: string, opts: ReadOptions = {}): Promise<PeekResult> {
    if (typeof sessionId !== 'string' || !sessionId) throw new BizziError('bad_request', 'sessionId is required');
    if (!this.#d.sessions.has(sessionId)) throw new BizziError('not_found', `no session ${sessionId} on this machine`);
    const info = this.#d.sessions.get(sessionId).session;
    const r = await this.#d.orchestration.summarize(sessionId, opts);
    const ws = this.#workspace(info.workspaceId);
    const ex = this.exchange(sessionId);
    const out: PeekResult = {
      ...r,
      ...(info.title ? { title: info.title } : {}),
      workspace: { id: info.workspaceId, ...(ws ? { path: ws.path } : {}), ...(ws?.branch ? { branch: ws.branch } : {}) },
      ...(info.spawnedBy ? { parentId: info.spawnedBy } : {}),
    };
    if (ex.lastPrompt) out.lastPrompt = clipText(ex.lastPrompt, OVERVIEW_PROMPT_CHARS * 2);
    return out;
  }

  // ---- internals

  #workspace(id: string): WorkspaceInfo | undefined {
    try {
      return this.#d.workspaces.get(id);
    } catch {
      return undefined;
    }
  }

  async #fillWorkspaces(page: OverviewEntry[]): Promise<void> {
    const branches = new Map<string, Promise<string | undefined>>();
    for (const e of page) {
      const ws = this.#workspace(e.workspace.id);
      if (!ws) continue;
      e.workspace = workspaceView(ws);
      if (ws.branch || ws.kind !== 'git' || branches.has(ws.id)) continue;
      branches.set(ws.id, withTimeout(gitStatus(ws).then((g) => g.branch), 3000).catch(() => undefined));
    }
    for (const e of page) {
      const b = await branches.get(e.workspace.id);
      if (b && !e.workspace.branch) e.workspace.branch = b;
    }
  }

  async #remoteMachine(ref: string, self: MachineInfo): Promise<MachineInfo | undefined> {
    const want = ref.trim();
    if (want === self.id || want.toLowerCase() === self.name.toLowerCase()) return undefined;
    const hub = this.#d.hub;
    if (!hub?.connected) throw new BizziError('unsupported', 'other machines need a hub link; without one only this machine is visible');
    const { machines } = await hub.request<{ machines: MachineInfo[] }>('machines.list', {});
    const m = machines.find((x) => x.id === want) ?? machines.find((x) => x.name.toLowerCase() === want.toLowerCase());
    if (!m) throw new BizziError('not_found', `no machine ${want} (machines: ${machines.map((x) => x.name).join(', ') || 'none'})`);
    return m.id === self.id ? undefined : m;
  }

  /** Another machine from the hub's index: states and titles, not prompts, replies or pending details. */
  async #remoteOverview(
    m: MachineInfo,
    f: OverviewFilter,
    o: { limit: number; offset: number; since: number | undefined; statuses: Set<SessionStatus> | undefined },
  ): Promise<OverviewResult> {
    const hub = this.#d.hub!;
    const [{ sessions }, { workspaces }] = await Promise.all([
      hub.request<{ sessions: SessionInfo[] }>('sessions.list', { machineId: m.id }),
      hub.request<{ workspaces: WorkspaceInfo[] }>('workspaces.list', { machineId: m.id }),
    ]);
    let infos = sessions;
    if (f.workspace !== undefined) {
      const ids = familyOf(workspaces, f.workspace, m.name);
      infos = infos.filter((s) => ids.has(s.workspaceId));
    }
    infos = infos.filter((s) => (o.statuses ? o.statuses.has(s.status) : s.status !== 'ended'));
    if (f.agent) infos = infos.filter((s) => s.agent === f.agent);
    if (o.since !== undefined) infos = infos.filter((s) => Date.parse(s.updatedAt) >= o.since!);
    if (f.waitingOnly) infos = infos.filter((s) => s.status === 'waiting_input' || s.status === 'waiting_approval');
    infos.sort(byRecent);
    const wsById = new Map(workspaces.map((w) => [w.id, w]));
    const page = infos.slice(o.offset, o.offset + o.limit).map((s): OverviewEntry => {
      const ws = wsById.get(s.workspaceId);
      return {
        ...baseEntry(s),
        ...(ws ? { workspace: workspaceView(ws) } : {}),
        ...(s.status === 'waiting_input' || s.status === 'waiting_approval' ? { waiting: { status: s.status } } : {}),
        turnOpen: s.status === 'running' || s.status === 'starting',
      };
    });
    const out: OverviewResult = {
      machine: { id: m.id, name: m.name, self: false },
      source: 'hub-index',
      total: infos.length,
      sessions: page,
      notes: [`From the hub's index of ${m.name}${m.online ? '' : ' (offline: last known state)'}: no last prompt or reply, and "waiting" is the status only.`],
    };
    if (o.offset + o.limit < infos.length) out.nextOffset = o.offset + o.limit;
    return out;
  }
}

function baseEntry(s: SessionInfo): Omit<OverviewEntry, 'turnOpen'> {
  return {
    sessionId: s.id,
    ...(s.title ? { title: s.title } : {}),
    agent: s.agent,
    mode: s.mode,
    status: s.status,
    updatedAt: s.updatedAt,
    machineId: s.machineId,
    workspace: { id: s.workspaceId },
    ...(s.spawnedBy ? { parentId: s.spawnedBy } : {}),
    ...(s.spawnedByMachineId ? { parentMachineId: s.spawnedByMachineId } : {}),
    ...(s.scope ? { scope: s.scope } : {}),
    ...(s.background?.length ? { background: s.background.slice(0, 10).map((b) => oneLine(b.description, 200)) } : {}),
  };
}

function workspaceView(ws: WorkspaceInfo): OverviewEntry['workspace'] {
  return { id: ws.id, path: ws.path, name: ws.name, kind: ws.kind, ...(ws.branch ? { branch: ws.branch } : {}) };
}

function byRecent(a: SessionInfo, b: SessionInfo): number {
  return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}

/** The workspace `ref` names (id or path) and, for a repo workspace, its worktrees. */
export function familyOf(all: WorkspaceInfo[], ref: string, where: string): Set<string> {
  const want = ref.trim().replace(/\/+$/, '');
  const ws = all.find((w) => w.id === want) ?? all.find((w) => w.path.replace(/\/+$/, '') === want);
  if (!ws) throw new BizziError('not_found', `no workspace ${ref} on ${where}`);
  return new Set([ws.id, ...all.filter((w) => w.parentWorkspaceId === ws.id).map((w) => w.id)]);
}

// ---- text helpers (exported for tests and the history search)

/** bizzi's own prompts (continuations after a restart) start with "[bizzi]"; they aren't the user's. */
export function isBizziPrompt(text: string): boolean {
  return text.trimStart().startsWith('[bizzi]');
}

export function inputText(input: InputBlock[]): string {
  return input
    .map((b) => (b.type === 'text' ? b.text : b.type === 'file' ? `[file ${b.path}]` : '[image]'))
    .join('\n')
    .trim();
}

/**
 * The question a reply ends on, if it ends by asking the user something: one of the last two sentences of
 * its last paragraph ends with "?". A heuristic; code blocks don't count.
 */
export function trailingQuestion(text: string): string | undefined {
  const noCode = text.replace(/```[\s\S]*?(```|$)/g, '').trim();
  const paras = noCode
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const last = paras.at(-1);
  if (!last) return undefined;
  const sentences = last
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.replace(/[*_`)"'\]]+$/, '').trim())
    .filter(Boolean);
  for (const s of sentences.slice(-2).reverse()) if (s.endsWith('?')) return oneLine(s.replace(/^[-*>#\s]+/, ''), 300);
  return undefined;
}

export function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

function clipText(t: OverviewText, max: number): OverviewText {
  const flat = t.text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return { text: flat, at: t.at };
  return { text: `${flat.slice(0, max - 1).trimEnd()}…`, at: t.at, truncated: true };
}

/** ISO time or `<n>m|h|d|w` back from now → epoch ms. */
export function parseSince(v: string, now = Date.now()): number {
  const m = /^(\d+(?:\.\d+)?)\s*([mhdw])$/i.exec(v.trim());
  if (m) {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2]!.toLowerCase() as 'm' | 'h' | 'd' | 'w'];
    return now - Number(m[1]) * unit;
  }
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new BizziError('bad_request', 'updatedSince must be an ISO time or a duration like 90m, 6h, 2d');
  return t;
}

function clampInt(v: number, min: number, max: number, name: string): number {
  if (!Number.isInteger(v)) throw new BizziError('bad_request', `${name} must be an integer`);
  return Math.max(min, Math.min(max, v));
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timed out')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}
