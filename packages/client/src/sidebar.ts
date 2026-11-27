// Pure selectors for the sidebar (spec §11.1), session lists with helpers nested under their parent
// (spec §12.1) and the helper tree (usage.md §2). Everything here derives from BizziState only.
import { contextFraction } from '@bizzi/protocol';
import type { AgentKind, AgentListing, SessionContext, SessionInfo, SessionMode, WorkspaceInfo } from '@bizzi/protocol';
import type { BizziState } from './store.ts';
import { selectSessionPrompt, selectSessionStatus } from './store.ts';
import type { SessionPrompt } from './timeline.ts';

/** Sidebar state of one live session: ⚠ waiting · ✗ failed · ◐ working · ✓ done, not yet seen · ● idle. */
export type MarkState = 'waiting' | 'failed' | 'working' | 'done' | 'idle';

/** Display order of marks and urgency (lower first). */
export const MARK_ORDER: Readonly<Record<MarkState, number>> = { waiting: 0, failed: 1, working: 2, done: 3, idle: 4 };

export const MARK_STATES: readonly MarkState[] = ['waiting', 'failed', 'working', 'done', 'idle'];

// ---------------------------------------------------------------- indexes (memoized per sessions identity)

interface SessionIndex {
  byWorkspace: Map<string, SessionInfo[]>;
  byParent: Map<string, SessionInfo[]>;
}

const indexCache = new WeakMap<object, SessionIndex>();

function sessionIndex(s: BizziState): SessionIndex {
  let idx = indexCache.get(s.sessions);
  if (idx) return idx;
  idx = { byWorkspace: new Map(), byParent: new Map() };
  for (const x of Object.values(s.sessions)) {
    push(idx.byWorkspace, x.workspaceId, x);
    if (x.spawnedBy) push(idx.byParent, x.spawnedBy, x);
  }
  for (const list of idx.byWorkspace.values()) list.sort(byUpdatedDesc);
  for (const list of idx.byParent.values()) list.sort(byCreatedAsc);
  indexCache.set(s.sessions, idx);
  return idx;
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const l = m.get(k);
  if (l) l.push(v);
  else m.set(k, [v]);
}

function byUpdatedDesc(a: SessionInfo, b: SessionInfo): number {
  return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;
}

function byCreatedAsc(a: SessionInfo, b: SessionInfo): number {
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
}

// ---------------------------------------------------------------- per session

/** Highest seq known for a session: its own channel when watched, else the list's `lastSeq`. */
export function sessionLastSeq(s: BizziState, sessionId: string): number {
  return Math.max(s.sessions[sessionId]?.lastSeq ?? 0, s.timelines[sessionId]?.lastSeq ?? 0);
}

/**
 * "Done, not yet seen" (spec §4): idle with events past `seenThrough`. Sessions without a `seenThrough`
 * (older servers) never count, so the sidebar doesn't light up every idle session.
 */
export function isDoneUnseen(s: BizziState, session: SessionInfo): boolean {
  if (session.seenThrough === undefined) return false;
  const st = selectSessionStatus(s, session.id);
  if (st !== 'idle') return false;
  return sessionLastSeq(s, session.id) > session.seenThrough;
}

/**
 * Context occupancy 0..1 of `usable` (or `window`): the open timeline's latest report, else what the
 * session list carries (`SessionInfo.context`), so sessions nobody has open show it too.
 */
export function sessionContext(s: BizziState, session: SessionInfo): number | undefined {
  const c = sessionContextUsage(s, session);
  return c ? contextFraction(c) : undefined;
}

/** The latest context report itself (open timeline first, else the session list), for context bars. */
export function sessionContextUsage(s: BizziState, session: SessionInfo): SessionContext | undefined {
  const c = s.timelines[session.id]?.context ?? session.context;
  return c && c.window > 0 ? c : undefined;
}

/** A helper started by another session (spec §12.1) whose parent is known. */
export function isNestedHelper(s: BizziState, session: SessionInfo): boolean {
  return session.spawnedBy !== undefined && session.spawnedBy in s.sessions;
}

/** The session's own mark state; null for sessions that aren't live (ended). */
export function sessionMarkState(s: BizziState, session: SessionInfo): MarkState | null {
  const st = selectSessionStatus(s, session.id) ?? session.status;
  if (st === 'ended') return null;
  const tl = s.timelines[session.id];
  if (st === 'waiting_approval' || st === 'waiting_input') return 'waiting';
  if (tl && (tl.pendingApprovals.length > 0 || tl.pendingQuestions.length > 0 || (tl.prompt !== null && st !== 'idle'))) return 'waiting';
  if (st === 'failed') return 'failed';
  if (st === 'running' || st === 'starting') return 'working';
  return isDoneUnseen(s, session) ? 'done' : 'idle';
}

/** Live helpers of a session, recursively (helpers of helpers too), depth-first in start order. */
export function selectDescendants(s: BizziState, sessionId: string): SessionInfo[] {
  const { byParent } = sessionIndex(s);
  const out: SessionInfo[] = [];
  const seen = new Set<string>([sessionId]);
  const walk = (id: string): void => {
    for (const c of byParent.get(id) ?? []) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
      walk(c.id);
    }
  };
  walk(sessionId);
  return out;
}

function moreUrgent(a: MarkState, b: MarkState): MarkState {
  return MARK_ORDER[a] <= MARK_ORDER[b] ? a : b;
}

// ---------------------------------------------------------------- workspace row

export interface SessionMark {
  sessionId: string;
  agent: AgentKind;
  /** The most urgent state of the session and its live helpers. */
  state: MarkState;
  /** Live helpers counted inside this mark (spec §11.1). */
  helpers: number;
}

export interface UrgentItem {
  sessionId: string;
  agent: AgentKind;
  state: 'waiting' | 'failed' | 'done';
  /** One line: the waiting reason, the failure, or the first line of the final message. */
  text: string;
}

export interface WorkspaceRowModel {
  workspaceId: string;
  /** Every mark in display order (the UI shows four, then `+n`). */
  marks: SessionMark[];
  /** Live sessions per state, helpers included. */
  counts: Record<MarkState, number>;
  /** Row 2: the single most urgent item, or null when nothing needs you. */
  urgent: UrgentItem | null;
}

function emptyCounts(): Record<MarkState, number> {
  return { waiting: 0, failed: 0, working: 0, done: 0, idle: 0 };
}

/** Rows 1–2 of a workspace in the sidebar. */
export function selectWorkspaceRow(s: BizziState, workspaceId: string): WorkspaceRowModel {
  const { byWorkspace } = sessionIndex(s);
  const marks: SessionMark[] = [];
  const counts = emptyCounts();
  const candidates: { session: SessionInfo; state: MarkState }[] = [];
  for (const session of byWorkspace.get(workspaceId) ?? []) {
    // Helpers count inside their parent's mark, not as marks of their own.
    if (isNestedHelper(s, session)) continue;
    const own = sessionMarkState(s, session);
    let state = own;
    let helpers = 0;
    for (const h of selectDescendants(s, session.id)) {
      const hs = sessionMarkState(s, h);
      if (!hs) continue;
      helpers++;
      counts[hs]++;
      candidates.push({ session: h, state: hs });
      state = state ? moreUrgent(state, hs) : hs;
    }
    if (own) {
      counts[own]++;
      candidates.push({ session, state: own });
    }
    if (state) marks.push({ sessionId: session.id, agent: session.agent, state, helpers });
  }
  marks.sort((a, b) => MARK_ORDER[a.state] - MARK_ORDER[b.state]);
  return { workspaceId, marks, counts, urgent: pickUrgent(s, candidates) };
}

function pickUrgent(s: BizziState, list: { session: SessionInfo; state: MarkState }[]): UrgentItem | null {
  let best: { session: SessionInfo; state: 'waiting' | 'failed' | 'done' } | null = null;
  for (const c of list) {
    if (c.state !== 'waiting' && c.state !== 'failed' && c.state !== 'done') continue;
    if (!best || MARK_ORDER[c.state] < MARK_ORDER[best.state]) {
      best = { session: c.session, state: c.state };
      continue;
    }
    if (MARK_ORDER[c.state] > MARK_ORDER[best.state]) continue;
    // Same state: the longest-waiting one first; otherwise the most recent.
    const better = c.state === 'waiting' ? c.session.updatedAt < best.session.updatedAt : c.session.updatedAt > best.session.updatedAt;
    if (better) best = { session: c.session, state: c.state };
  }
  if (!best) return null;
  const { session, state } = best;
  const text = state === 'waiting' ? waitingText(s, session.id) : state === 'failed' ? failedText(s, session) : doneText(s, session);
  return { sessionId: session.id, agent: session.agent, state, text };
}

function firstLine(text: string): string {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return (line ?? '').replace(/^[#>*\-\s]+/, '');
}

/** What a waiting session waits on, as one line: "approve `bun run build`?", the question, "login needed". */
export function waitingText(s: BizziState, sessionId: string): string {
  const tl = s.timelines[sessionId];
  const prompt: SessionPrompt | null = selectSessionPrompt(s, sessionId);
  if (tl) {
    const apId = tl.pendingApprovals[0];
    const ap = apId ? tl.items[`ap:${apId}`] : undefined;
    if (ap && ap.kind === 'approval') {
      const cmd = commandOf(ap.request.input);
      return cmd ? `approve \`${cmd}\`?` : `approve: ${ap.request.title}`;
    }
    const qId = tl.pendingQuestions[0];
    const q = qId ? tl.items[`q:${qId}`] : undefined;
    if (q && q.kind === 'question') return q.text;
  }
  if (prompt === 'login') return 'login needed';
  if (prompt === 'budget') return tl?.statusReason ? `budget: ${tl.statusReason}` : 'budget reached';
  if (tl?.statusReason) return tl.statusReason;
  if (prompt === 'approval') return 'needs approval';
  if (prompt === 'question') return 'has a question';
  return 'waiting for input';
}

function commandOf(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const c = (input as { command?: unknown }).command;
  if (typeof c === 'string') return c;
  if (Array.isArray(c) && c.every((x) => typeof x === 'string')) return c.join(' ');
  return null;
}

function failedText(s: BizziState, session: SessionInfo): string {
  return s.timelines[session.id]?.statusReason ?? 'failed';
}

function doneText(s: BizziState, session: SessionInfo): string {
  const tl = s.timelines[session.id];
  if (tl) {
    for (let i = tl.order.length - 1; i >= 0; i--) {
      const id = tl.order[i];
      const it = id ? tl.items[id] : undefined;
      if (it && it.kind === 'message' && it.role === 'assistant' && it.text.trim()) return firstLine(it.text);
    }
  }
  return session.title ? `finished: ${session.title}` : 'finished';
}

/** Equality for `selectWorkspaceRow` results, so a row re-renders only when what it shows changes. */
export function workspaceRowEqual(a: WorkspaceRowModel, b: WorkspaceRowModel): boolean {
  if (a === b) return true;
  if (a.workspaceId !== b.workspaceId || a.marks.length !== b.marks.length) return false;
  for (let i = 0; i < a.marks.length; i++) {
    const x = a.marks[i];
    const y = b.marks[i];
    if (!x || !y || x.sessionId !== y.sessionId || x.state !== y.state || x.helpers !== y.helpers || x.agent !== y.agent) return false;
  }
  for (const k of MARK_STATES) if (a.counts[k] !== b.counts[k]) return false;
  const u = a.urgent;
  const v = b.urgent;
  if (!u || !v) return u === v;
  return u.sessionId === v.sessionId && u.state === v.state && u.text === v.text;
}

// ---------------------------------------------------------------- hover breakdown

export interface SessionBreakdownLine {
  sessionId: string;
  agent: AgentKind;
  mode: SessionMode;
  title: string;
  state: MarkState;
  /** Waiting reason / failure, when there is one. */
  reason?: string;
  updatedAt: string;
  /** Context occupancy 0..1 of `usable` (or `window`), when the session reported it. */
  context?: number;
  /** The report behind `context` (for `contextView`: the same bar and label as the session header). */
  contextUsage?: SessionContext;
  /** Nesting under the parent session (0 for sessions you started). */
  depth: number;
}

/**
 * One line per live session of a workspace (helpers under their parent): the sidebar tree's session rows
 * and the long-press breakdown.
 */
export function selectWorkspaceBreakdown(s: BizziState, workspaceId: string): SessionBreakdownLine[] {
  const out: SessionBreakdownLine[] = [];
  for (const { session, depth } of selectNestedSessions(s, workspaceId)) {
    const state = sessionMarkState(s, session);
    if (!state) continue;
    const line: SessionBreakdownLine = { sessionId: session.id, agent: session.agent, mode: session.mode, title: session.title || 'Untitled session', state, updatedAt: session.updatedAt, depth };
    if (state === 'waiting') line.reason = waitingText(s, session.id);
    else if (state === 'failed') line.reason = failedText(s, session);
    const usage = sessionContextUsage(s, session);
    if (usage) {
      line.context = contextFraction(usage);
      line.contextUsage = usage;
    }
    out.push(line);
  }
  return out;
}

/** Equality for `selectWorkspaceBreakdown` results (lines are flat, so field by field). */
export function breakdownEqual(a: readonly SessionBreakdownLine[], b: readonly SessionBreakdownLine[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.sessionId !== y.sessionId || x.state !== y.state || x.title !== y.title || x.reason !== y.reason || x.context !== y.context || x.depth !== y.depth) return false;
    if (x.updatedAt !== y.updatedAt || x.agent !== y.agent || x.mode !== y.mode) return false;
    if (x.contextUsage?.window !== y.contextUsage?.window || x.contextUsage?.compactAt !== y.contextUsage?.compactAt) return false;
  }
  return true;
}

// ---------------------------------------------------------------- session lists and helper trees

export interface SessionTreeRow {
  session: SessionInfo;
  /** 0 for top-level rows; helpers sit one level under their parent. */
  depth: number;
}

/**
 * Sessions of a workspace with helpers nested under their parent (spec §12.1): parents most recent first,
 * then each one's helpers (recursively) in start order. A helper whose parent is in another workspace (or
 * unknown) is a top-level row here.
 */
export function selectNestedSessions(s: BizziState, workspaceId: string): SessionTreeRow[] {
  const { byWorkspace } = sessionIndex(s);
  const out: SessionTreeRow[] = [];
  const list = byWorkspace.get(workspaceId) ?? [];
  const here = new Set(list.map((x) => x.id));
  for (const session of list) {
    if (session.spawnedBy && here.has(session.spawnedBy)) continue;
    out.push({ session, depth: 0 });
    out.push(...selectHelperTree(s, session.id));
  }
  return out;
}

/** A session's helpers as tree rows (depth 1 = direct helper). */
export function selectHelperTree(s: BizziState, rootId: string): SessionTreeRow[] {
  const { byParent } = sessionIndex(s);
  const out: SessionTreeRow[] = [];
  const seen = new Set<string>([rootId]);
  const walk = (id: string, depth: number): void => {
    for (const c of byParent.get(id) ?? []) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push({ session: c, depth });
      walk(c.id, depth + 1);
    }
  };
  walk(rootId, 1);
  return out;
}

export function treeRowsEqual(a: SessionTreeRow[], b: SessionTreeRow[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i]?.session !== b[i]?.session || a[i]?.depth !== b[i]?.depth) return false;
  return true;
}

export interface HelperTreeNode {
  sessionId: string;
  depth: number;
  agent: AgentKind;
  title: string;
  model?: string;
  billing?: SessionInfo['billing'];
  state: MarkState | 'ended';
  /** 0..1 of usable context, when reported. */
  context?: number;
  /** Input + output tokens, when reported. */
  tokens?: number;
  /** Spend that counts (metered billing only, spec §12.3). */
  meteredUsd?: number;
}

export interface HelperTreeModel {
  nodes: HelperTreeNode[];
  /** Root totals count metered spend only (usage.md §2). */
  meteredUsd: number;
}

/** The tree view on a parent session: the root and its helpers with what each one costs. */
export function selectHelperTreeModel(s: BizziState, rootId: string): HelperTreeModel | null {
  const root = s.sessions[rootId];
  if (!root) return null;
  const rows: SessionTreeRow[] = [{ session: root, depth: 0 }, ...selectHelperTree(s, rootId)];
  let meteredUsd = 0;
  const nodes = rows.map(({ session, depth }) => {
    const tl = s.timelines[session.id];
    const node: HelperTreeNode = { sessionId: session.id, depth, agent: session.agent, title: session.title || 'Untitled session', state: sessionMarkState(s, session) ?? 'ended' };
    const model = tl?.info.model ?? session.model;
    if (model !== undefined) node.model = model;
    if (session.billing !== undefined) node.billing = session.billing;
    const ctx = sessionContext(s, session);
    if (ctx !== undefined) node.context = ctx;
    const u = tl?.usage;
    if (u && (u.inputTokens !== undefined || u.outputTokens !== undefined)) node.tokens = (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
    if (session.billing === 'metered' && u?.costUsd !== undefined) {
      node.meteredUsd = u.costUsd;
      meteredUsd += u.costUsd;
    }
    return node;
  });
  return { nodes, meteredUsd };
}

// ---------------------------------------------------------------- machines and workspaces

export interface MachineSummary {
  /** Live sessions (helpers included). */
  live: number;
  waiting: number;
  online: boolean;
  /** Counts come from the last known state (machine offline). */
  cached: boolean;
  /** Agents whose installed version bizzi doesn't support (spec §7: warning on the machine header). */
  unsupported: AgentKind[];
  /** Sessions running an older agent version than the installed one ("updates pending: N sessions"). */
  staleSessions: number;
}

export function selectMachineSummary(s: BizziState, machineId: string): MachineSummary {
  let live = 0;
  let waiting = 0;
  for (const x of Object.values(s.sessions)) {
    if (x.machineId !== machineId) continue;
    const st = sessionMarkState(s, x);
    if (!st) continue;
    live++;
    if (st === 'waiting') waiting++;
  }
  const online = s.role === 'hub' ? (s.machines[machineId]?.online ?? false) : s.connection.state === 'open' && s.machine?.id === machineId;
  const agents: readonly AgentListing[] = s.agents[machineId] ?? [];
  const unsupported = agents.filter((a) => a.installed && a.support === 'unsupported').map((a) => a.agent);
  const staleSessions = agents.reduce((n, a) => n + (a.staleSessions ?? 0), 0);
  return { live, waiting, online, cached: !online, unsupported, staleSessions };
}

export function machineSummaryEqual(a: MachineSummary, b: MachineSummary): boolean {
  return (
    a.live === b.live &&
    a.waiting === b.waiting &&
    a.online === b.online &&
    a.cached === b.cached &&
    a.staleSessions === b.staleSessions &&
    a.unsupported.length === b.unsupported.length &&
    a.unsupported.every((x, i) => x === b.unsupported[i])
  );
}

/** "6 · 1 waiting", "2 (cached)", "" when nothing runs. */
export function machineTotalsLabel(m: MachineSummary): string {
  if (m.live === 0) return m.cached ? '0 (cached)' : '';
  const base = m.waiting > 0 ? `${m.live} · ${m.waiting} waiting` : String(m.live);
  return m.cached ? `${base} (cached)` : base;
}

export interface WorkspaceTreeRow {
  workspace: WorkspaceInfo;
  /** 1 for worktrees grouped under their parent repo. */
  depth: number;
}

/** A machine's workspaces by name, worktrees grouped under the repo they came from. */
export function selectMachineWorkspaces(s: BizziState, machineId: string): WorkspaceTreeRow[] {
  const all = Object.values(s.workspaces ?? {})
    .filter((w) => w.machineId === machineId)
    .sort((a, b) => a.name.localeCompare(b.name));
  const ids = new Set(all.map((w) => w.id));
  const children = new Map<string, WorkspaceInfo[]>();
  for (const w of all) if (w.parentWorkspaceId && ids.has(w.parentWorkspaceId)) push(children, w.parentWorkspaceId, w);
  const out: WorkspaceTreeRow[] = [];
  for (const w of all) {
    if (w.parentWorkspaceId && ids.has(w.parentWorkspaceId)) continue;
    out.push({ workspace: w, depth: 0 });
    for (const c of children.get(w.id) ?? []) out.push({ workspace: c, depth: 1 });
  }
  return out;
}

export function workspaceTreeEqual(a: WorkspaceTreeRow[], b: WorkspaceTreeRow[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i]?.workspace !== b[i]?.workspace || a[i]?.depth !== b[i]?.depth) return false;
  return true;
}

/** Sessions waiting on you across every machine (Inbox tab badge). */
export function selectWaitingCount(s: BizziState): number {
  let n = 0;
  for (const x of Object.values(s.sessions)) if (sessionMarkState(s, x) === 'waiting') n++;
  // Pipeline gates wait on you too (docs/pipelines.md).
  for (const p of Object.values(s.pipelines ?? {})) if (p.status === 'waiting' && p.gate) n++;
  return n;
}

/** Installed agents bizzi doesn't support, per machine (inbox alerts). */
export function selectUnsupportedAgents(s: BizziState): { machineId: string; agent: AgentListing }[] {
  const out: { machineId: string; agent: AgentListing }[] = [];
  for (const [machineId, list] of Object.entries(s.agents)) for (const a of list) if (a.installed && a.support === 'unsupported') out.push({ machineId, agent: a });
  return out;
}

// ---- restart policy `ask` (updates.md §6)

/** A live session on an older agent process whose machine asks before restarting it (inbox item). */
export interface RestartPrompt {
  session: SessionInfo;
  /** What the session's process runs and what is installed now. */
  running: string;
  installed: string;
}

/**
 * Sessions waiting for you to restart them onto a new agent version: restart policy `ask`, the
 * session's process older than the installed version (the version chip's rule), not ended or failed.
 */
export function selectRestartPrompts(s: BizziState): RestartPrompt[] {
  const out: RestartPrompt[] = [];
  for (const x of Object.values(s.sessions)) {
    const running = x.agentVersion;
    if (!running) continue;
    const listing = s.agents[x.machineId]?.find((a) => a.agent === x.agent);
    if (!listing || listing.restartPolicy !== 'ask' || !listing.installed || !listing.version || listing.version === running) continue;
    const status = selectSessionStatus(s, x.id);
    if (status === 'ended' || status === 'failed') continue;
    out.push({ session: x, running, installed: listing.version });
  }
  out.sort((a, b) => (a.session.updatedAt < b.session.updatedAt ? 1 : a.session.updatedAt > b.session.updatedAt ? -1 : 0));
  return out;
}

export function restartPromptsEqual(a: readonly RestartPrompt[], b: readonly RestartPrompt[]): boolean {
  return a.length === b.length && a.every((x, i) => x.session === b[i]?.session && x.installed === b[i]?.installed && x.running === b[i]?.running);
}

/**
 * Phone layout: more than three marks collapse to counts per state (`⚠1 ◐2 ●3`), in mark order.
 * Returns null when the marks fit.
 */
export function collapsedCounts(row: WorkspaceRowModel, max = 3): { state: MarkState; n: number }[] | null {
  if (row.marks.length <= max) return null;
  const per = emptyCounts();
  for (const m of row.marks) per[m.state]++;
  return MARK_STATES.filter((k) => per[k] > 0).map((state) => ({ state, n: per[state] }));
}
