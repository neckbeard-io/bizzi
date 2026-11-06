import type {
  AgentKind,
  ApprovalDecisionKind,
  ApprovalRequest,
  InputBlock,
  PlanItem,
  SessionEvent,
  SessionEventMap,
  SessionStatus,
  StopReason,
  ToolKind,
  Usage,
} from '@bizzi/protocol';

interface ItemBase {
  /** Unique within the timeline (prefixed by kind). */
  id: string;
  /** seq of the event that created the item. */
  seq: number;
  ts: string;
  turnId: string | null;
}

export interface TurnItem extends ItemBase {
  kind: 'turn';
  input: InputBlock[];
}

export interface TurnEndItem extends ItemBase {
  kind: 'turn-end';
  stopReason: StopReason;
  usage?: Usage;
  error?: string;
  /** ms between turn.started and turn.completed, when both were seen. */
  durationMs?: number;
}

export interface MessageItem extends ItemBase {
  kind: 'message';
  messageId: string;
  role: 'assistant' | 'user' | 'system';
  text: string;
  streaming: boolean;
}

export interface ReasoningItem extends ItemBase {
  kind: 'reasoning';
  messageId: string;
  text: string;
  streaming: boolean;
  summary: boolean;
}

export type ToolStatus = 'running' | 'ok' | 'error' | 'denied' | 'cancelled';

export interface ToolItem extends ItemBase {
  kind: 'tool';
  toolId: string;
  toolKind: ToolKind;
  name: string;
  title: string;
  input?: unknown;
  parentToolId?: string;
  output: string;
  progress?: string;
  status: ToolStatus;
  error?: string;
  /** Pending approval for this tool, if any. */
  approvalId?: string;
}

export interface ApprovalItem extends ItemBase {
  kind: 'approval';
  approvalId: string;
  request: ApprovalRequest;
  status: 'pending' | 'resolved' | 'expired';
  decision?: ApprovalDecisionKind;
  by?: string;
}

export interface QuestionItem extends ItemBase {
  kind: 'question';
  questionId: string;
  text: string;
  options?: string[];
  status: 'pending' | 'answered';
}

export interface FileChangeItem extends ItemBase {
  kind: 'file';
  path: string;
  change: 'created' | 'modified' | 'deleted';
  diff?: string;
}

export interface ErrorItem extends ItemBase {
  kind: 'error';
  message: string;
  code?: string;
  fatal: boolean;
}

export interface StatusItem extends ItemBase {
  kind: 'status';
  status: SessionStatus;
  reason?: string;
}

export interface SubagentItem extends ItemBase {
  kind: 'subagent';
  subagentId: string;
  name?: string;
  description?: string;
  parentToolId?: string;
  status: 'running' | 'ok' | 'error' | 'cancelled';
}

export interface RawItem extends ItemBase {
  kind: 'raw';
  agent: AgentKind;
  payload: unknown;
}

export type TimelineItem =
  | TurnItem
  | TurnEndItem
  | MessageItem
  | ReasoningItem
  | ToolItem
  | ApprovalItem
  | QuestionItem
  | FileChangeItem
  | ErrorItem
  | StatusItem
  | SubagentItem
  | RawItem;

export type TimelineItemKind = TimelineItem['kind'];

export interface FileChange {
  path: string;
  change: 'created' | 'modified' | 'deleted';
  diff?: string;
  seq: number;
}

export type SessionInfoPatch = SessionEventMap['session.info'];

/**
 * Per-session view model built from session events. Immutable: every reduction returns a new object,
 * and only the items that changed get new identities (so a delta re-renders one row).
 */
export interface Timeline {
  sessionId: string;
  /** Item ids in display order. Replaced only when items are added. */
  order: readonly string[];
  items: Readonly<Record<string, TimelineItem>>;
  lastSeq: number;
  /** Status derived from the session's own events (null until one is seen). */
  status: SessionStatus | null;
  statusReason?: string;
  info: SessionInfoPatch;
  activeTurnId: string | null;
  plan: readonly PlanItem[] | null;
  /** Latest usage snapshot (usage.updated or the last turn's usage). */
  usage: Usage | null;
  pendingApprovals: readonly string[];
  pendingQuestions: readonly string[];
  /** Latest change per path. */
  files: Readonly<Record<string, FileChange>>;
  terminalExit: { exitCode: number | null; signal?: string } | null;
}

export function emptyTimeline(sessionId: string): Timeline {
  return {
    sessionId,
    order: [],
    items: {},
    lastSeq: 0,
    status: null,
    info: {},
    activeTurnId: null,
    plan: null,
    usage: null,
    pendingApprovals: [],
    pendingQuestions: [],
    files: {},
    terminalExit: null,
  };
}

/** Copy-on-write draft used for one batch of events. */
class Draft {
  tl: Timeline;
  private order: string[] | null = null;
  private items: Record<string, TimelineItem> | null = null;
  private files: Record<string, FileChange> | null = null;
  private turnStarts = new Map<string, number>();

  constructor(tl: Timeline) {
    this.tl = { ...tl };
  }

  ids(): readonly string[] {
    return this.order ?? this.tl.order;
  }

  get(id: string): TimelineItem | undefined {
    return (this.items ?? this.tl.items)[id];
  }

  put(item: TimelineItem): void {
    if (!this.items) this.items = { ...this.tl.items };
    if (!(item.id in this.items)) {
      if (!this.order) this.order = [...this.tl.order];
      this.order.push(item.id);
    }
    this.items[item.id] = item;
  }

  setFile(fc: FileChange): void {
    if (!this.files) this.files = { ...this.tl.files };
    this.files[fc.path] = fc;
  }

  turnStarted(turnId: string, ts: string): void {
    const t = Date.parse(ts);
    if (!Number.isNaN(t)) this.turnStarts.set(turnId, t);
  }

  turnStart(turnId: string): number | undefined {
    const known = this.turnStarts.get(turnId);
    if (known !== undefined) return known;
    const item = this.get(`turn:${turnId}`);
    if (!item) return undefined;
    const t = Date.parse(item.ts);
    return Number.isNaN(t) ? undefined : t;
  }

  finish(): Timeline {
    if (this.order) this.tl.order = this.order;
    if (this.items) this.tl.items = this.items;
    if (this.files) this.tl.files = this.files;
    return this.tl;
  }
}

function without(list: readonly string[], id: string): readonly string[] {
  const i = list.indexOf(id);
  if (i < 0) return list;
  return [...list.slice(0, i), ...list.slice(i + 1)];
}

function withItem(list: readonly string[], id: string): readonly string[] {
  return list.includes(id) ? list : [...list, id];
}

/** Apply a batch of session events (in seq order). Events at or below `lastSeq` are ignored. */
export function reduceTimeline(tl: Timeline, events: readonly SessionEvent[]): Timeline {
  if (!events.some((ev) => ev.seq > tl.lastSeq)) return tl;
  const d = new Draft(tl);
  for (const ev of events) {
    if (ev.seq <= d.tl.lastSeq) continue;
    applyEvent(d, ev);
    d.tl.lastSeq = ev.seq;
  }
  return d.finish();
}

function base(d: Draft, id: string, ev: SessionEvent): ItemBase {
  return { id, seq: ev.seq, ts: ev.ts, turnId: d.tl.activeTurnId };
}

function applyEvent(d: Draft, ev: SessionEvent): void {
  const tl = d.tl;
  switch (ev.type) {
    case 'session.status': {
      tl.status = ev.data.status;
      tl.statusReason = ev.data.reason;
      if (ev.data.status === 'failed' || ev.data.status === 'ended' || ev.data.status === 'paused') {
        const item: StatusItem = { ...base(d, `status:${ev.seq}`, ev), kind: 'status', status: ev.data.status };
        if (ev.data.reason !== undefined) item.reason = ev.data.reason;
        d.put(item);
      }
      return;
    }
    case 'session.info': {
      tl.info = { ...tl.info, ...ev.data };
      return;
    }
    case 'turn.started': {
      tl.activeTurnId = ev.data.turnId;
      tl.status = 'running';
      d.turnStarted(ev.data.turnId, ev.ts);
      d.put({ ...base(d, `turn:${ev.data.turnId}`, ev), turnId: ev.data.turnId, kind: 'turn', input: ev.data.input });
      // A new turn answers any open question.
      for (const qid of tl.pendingQuestions) {
        const q = d.get(`q:${qid}`);
        if (q && q.kind === 'question') d.put({ ...q, status: 'answered' });
      }
      tl.pendingQuestions = [];
      return;
    }
    case 'turn.completed': {
      const { turnId, stopReason } = ev.data;
      const start = d.turnStart(turnId);
      const end = Date.parse(ev.ts);
      const item: TurnEndItem = { ...base(d, `end:${turnId}`, ev), turnId, kind: 'turn-end', stopReason };
      if (ev.data.usage) item.usage = ev.data.usage;
      if (ev.data.error !== undefined) item.error = ev.data.error;
      if (start !== undefined && !Number.isNaN(end)) item.durationMs = Math.max(0, end - start);
      d.put(item);
      if (ev.data.usage) tl.usage = { ...tl.usage, ...ev.data.usage };
      finalizeTurn(d, turnId, stopReason);
      if (tl.activeTurnId === turnId) tl.activeTurnId = null;
      tl.status = 'idle';
      return;
    }
    case 'message.delta': {
      const id = `msg:${ev.data.messageId}`;
      const prev = d.get(id);
      if (prev && prev.kind === 'message') {
        if (!prev.streaming) return; // late delta after completion
        d.put({ ...prev, text: prev.text + ev.data.text });
      } else {
        d.put({ ...base(d, id, ev), kind: 'message', messageId: ev.data.messageId, role: 'assistant', text: ev.data.text, streaming: true });
      }
      return;
    }
    case 'message.completed': {
      const id = `msg:${ev.data.messageId}`;
      const prev = d.get(id);
      if (prev && prev.kind === 'message') {
        d.put({ ...prev, role: ev.data.role, text: ev.data.text, streaming: false });
      } else {
        d.put({ ...base(d, id, ev), kind: 'message', messageId: ev.data.messageId, role: ev.data.role, text: ev.data.text, streaming: false });
      }
      return;
    }
    case 'reasoning.delta': {
      const id = `rsn:${ev.data.messageId}`;
      const prev = d.get(id);
      if (prev && prev.kind === 'reasoning') {
        if (!prev.streaming) return;
        d.put({ ...prev, text: prev.text + ev.data.text });
      } else {
        d.put({ ...base(d, id, ev), kind: 'reasoning', messageId: ev.data.messageId, text: ev.data.text, streaming: true, summary: false });
      }
      return;
    }
    case 'reasoning.completed': {
      const id = `rsn:${ev.data.messageId}`;
      const prev = d.get(id);
      const summary = ev.data.summary ?? false;
      if (prev && prev.kind === 'reasoning') {
        d.put({ ...prev, text: ev.data.text, streaming: false, summary });
      } else {
        d.put({ ...base(d, id, ev), kind: 'reasoning', messageId: ev.data.messageId, text: ev.data.text, streaming: false, summary });
      }
      return;
    }
    case 'tool.started': {
      const id = `tool:${ev.data.toolId}`;
      const prev = d.get(id);
      const item: ToolItem = {
        ...(prev && prev.kind === 'tool' ? prev : base(d, id, ev)),
        kind: 'tool',
        toolId: ev.data.toolId,
        toolKind: ev.data.kind,
        name: ev.data.name,
        title: ev.data.title,
        output: prev && prev.kind === 'tool' ? prev.output : '',
        status: prev && prev.kind === 'tool' ? prev.status : 'running',
      };
      if (ev.data.input !== undefined) item.input = ev.data.input;
      if (ev.data.parentToolId !== undefined) item.parentToolId = ev.data.parentToolId;
      d.put(item);
      return;
    }
    case 'tool.updated': {
      const prev = toolOrPlaceholder(d, ev.data.toolId, ev);
      const next: ToolItem = { ...prev };
      // `output` on tool.updated is an incremental chunk.
      if (ev.data.output !== undefined) next.output = prev.output + ev.data.output;
      if (ev.data.progress !== undefined) next.progress = ev.data.progress;
      d.put(next);
      return;
    }
    case 'tool.completed': {
      const prev = toolOrPlaceholder(d, ev.data.toolId, ev);
      const next: ToolItem = { ...prev, status: ev.data.status };
      // `output` on tool.completed is the final, full output when present.
      if (ev.data.output !== undefined) next.output = ev.data.output;
      if (ev.data.error !== undefined) next.error = ev.data.error;
      delete next.progress;
      delete next.approvalId;
      d.put(next);
      return;
    }
    case 'file.changed': {
      const item: FileChangeItem = { ...base(d, `file:${ev.seq}`, ev), kind: 'file', path: ev.data.path, change: ev.data.change };
      if (ev.data.diff !== undefined) item.diff = ev.data.diff;
      d.put(item);
      const fc: FileChange = { path: ev.data.path, change: ev.data.change, seq: ev.seq };
      if (ev.data.diff !== undefined) fc.diff = ev.data.diff;
      d.setFile(fc);
      return;
    }
    case 'plan.updated': {
      tl.plan = ev.data.items;
      return;
    }
    case 'approval.requested': {
      const id = `ap:${ev.data.approvalId}`;
      d.put({ ...base(d, id, ev), kind: 'approval', approvalId: ev.data.approvalId, request: ev.data, status: 'pending' });
      tl.pendingApprovals = withItem(tl.pendingApprovals, ev.data.approvalId);
      tl.status = 'waiting_approval';
      if (ev.data.toolId) {
        const tool = d.get(`tool:${ev.data.toolId}`);
        if (tool && tool.kind === 'tool') d.put({ ...tool, approvalId: ev.data.approvalId });
      }
      return;
    }
    case 'approval.resolved': {
      const id = `ap:${ev.data.approvalId}`;
      const prev = d.get(id);
      if (prev && prev.kind === 'approval') {
        const next: ApprovalItem = { ...prev, status: 'resolved', decision: ev.data.decision };
        if (ev.data.by !== undefined) next.by = ev.data.by;
        d.put(next);
        if (prev.request.toolId) {
          const tool = d.get(`tool:${prev.request.toolId}`);
          if (tool && tool.kind === 'tool' && tool.approvalId === ev.data.approvalId) {
            const t: ToolItem = { ...tool };
            delete t.approvalId;
            d.put(t);
          }
        }
      }
      tl.pendingApprovals = without(tl.pendingApprovals, ev.data.approvalId);
      if (tl.pendingApprovals.length === 0 && tl.status === 'waiting_approval') tl.status = 'running';
      return;
    }
    case 'question.asked': {
      const item: QuestionItem = { ...base(d, `q:${ev.data.questionId}`, ev), kind: 'question', questionId: ev.data.questionId, text: ev.data.text, status: 'pending' };
      if (ev.data.options) item.options = ev.data.options;
      d.put(item);
      tl.pendingQuestions = withItem(tl.pendingQuestions, ev.data.questionId);
      return;
    }
    case 'usage.updated': {
      tl.usage = { ...tl.usage, ...ev.data };
      return;
    }
    case 'subagent.started': {
      const item: SubagentItem = { ...base(d, `sub:${ev.data.subagentId}`, ev), kind: 'subagent', subagentId: ev.data.subagentId, status: 'running' };
      if (ev.data.name !== undefined) item.name = ev.data.name;
      if (ev.data.description !== undefined) item.description = ev.data.description;
      if (ev.data.parentToolId !== undefined) item.parentToolId = ev.data.parentToolId;
      d.put(item);
      return;
    }
    case 'subagent.completed': {
      const prev = d.get(`sub:${ev.data.subagentId}`);
      if (prev && prev.kind === 'subagent') d.put({ ...prev, status: ev.data.status });
      return;
    }
    case 'term.output':
      // Terminal bytes never enter the store (see TerminalStreams).
      return;
    case 'term.exited': {
      tl.terminalExit = ev.data.signal === undefined ? { exitCode: ev.data.exitCode } : { exitCode: ev.data.exitCode, signal: ev.data.signal };
      return;
    }
    case 'agent.raw': {
      d.put({ ...base(d, `raw:${ev.seq}`, ev), kind: 'raw', agent: ev.data.agent, payload: ev.data.payload });
      return;
    }
    case 'error': {
      const item: ErrorItem = { ...base(d, `err:${ev.seq}`, ev), kind: 'error', message: ev.data.message, fatal: ev.data.fatal ?? false };
      if (ev.data.code !== undefined) item.code = ev.data.code;
      d.put(item);
      return;
    }
    default: {
      const unknown: never = ev;
      void unknown;
    }
  }
}

function toolOrPlaceholder(d: Draft, toolId: string, ev: SessionEvent): ToolItem {
  const prev = d.get(`tool:${toolId}`);
  if (prev && prev.kind === 'tool') return prev;
  return { ...base(d, `tool:${toolId}`, ev), kind: 'tool', toolId, toolKind: 'other', name: 'tool', title: toolId, output: '', status: 'running' };
}

/** Close everything still open in a finished turn. */
function finalizeTurn(d: Draft, turnId: string, stopReason: StopReason): void {
  const tl = d.tl;
  const aborted = stopReason !== 'end_turn';
  for (const id of d.ids()) {
    const item = d.get(id);
    if (!item || item.turnId !== turnId) continue;
    if ((item.kind === 'message' || item.kind === 'reasoning') && item.streaming) d.put({ ...item, streaming: false });
    else if (item.kind === 'tool' && item.status === 'running' && aborted) d.put({ ...item, status: 'cancelled' });
    else if (item.kind === 'subagent' && item.status === 'running' && aborted) d.put({ ...item, status: 'cancelled' });
    else if (item.kind === 'approval' && item.status === 'pending') {
      d.put({ ...item, status: 'expired' });
      tl.pendingApprovals = without(tl.pendingApprovals, item.approvalId);
    }
  }
}

/** Items of the timeline in display order (allocates; prefer `order` + `items` in renderers). */
export function timelineItems(tl: Timeline): TimelineItem[] {
  const out: TimelineItem[] = [];
  for (const id of tl.order) {
    const it = tl.items[id];
    if (it) out.push(it);
  }
  return out;
}
