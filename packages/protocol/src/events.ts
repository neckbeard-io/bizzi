import type {
  AgentKind,
  ApprovalDecisionKind,
  ApprovalRequest,
  InputBlock,
  MachineInfo,
  SessionInfo,
  SessionStatus,
  Usage,
  WorkspaceInfo,
} from './model.ts';

export type ToolKind = 'shell' | 'read' | 'edit' | 'write' | 'search' | 'web' | 'mcp' | 'task' | 'other';

export type StopReason = 'end_turn' | 'interrupted' | 'error' | 'max_turns' | 'refusal' | 'other';

export interface PlanItem {
  id?: string;
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/**
 * Events on a session channel (`session:<sessionId>`). Adapters emit the body ({type, data});
 * the core assigns `ch`, `seq` and `ts`.
 *
 * Status bookkeeping: the core derives `session.status` from turn.started (running),
 * approval.requested (waiting_approval), approval.resolved (running) and turn.completed (idle).
 * Adapters only emit `session.status` for other transitions (failed, ended, waiting_input).
 */
export interface SessionEventMap {
  'session.status': { status: SessionStatus; reason?: string };
  /** Adapter-reported metadata changes (agent session id assigned, model switched, …). */
  'session.info': {
    agentSessionRef?: string;
    model?: string;
    permissionMode?: string;
    effort?: string;
    title?: string;
    /** Slash commands / skills the agent advertises. */
    commands?: { name: string; description?: string }[];
  };
  /** Emitted by the core when a turn starts; echoes the user input. */
  'turn.started': { turnId: string; input: InputBlock[] };
  /** Emitted by the adapter when the turn finishes, with the same turnId. */
  'turn.completed': { turnId: string; stopReason: StopReason; usage?: Usage; error?: string };
  'message.delta': { messageId: string; role: 'assistant'; text: string };
  'message.completed': { messageId: string; role: 'assistant' | 'user' | 'system'; text: string };
  'reasoning.delta': { messageId: string; text: string };
  'reasoning.completed': { messageId: string; text: string; summary?: boolean };
  'tool.started': {
    toolId: string;
    kind: ToolKind;
    /** Native tool name, e.g. "Bash", "Edit", "commandExecution". */
    name: string;
    /** Human-readable one-liner, e.g. "pnpm test". */
    title: string;
    input?: unknown;
    parentToolId?: string;
  };
  'tool.updated': { toolId: string; output?: string; progress?: string };
  'tool.completed': {
    toolId: string;
    status: 'ok' | 'error' | 'denied' | 'cancelled';
    output?: string;
    error?: string;
  };
  'file.changed': { path: string; change: 'created' | 'modified' | 'deleted'; diff?: string };
  'plan.updated': { items: PlanItem[] };
  'approval.requested': ApprovalRequest;
  'approval.resolved': { approvalId: string; decision: ApprovalDecisionKind; by?: string };
  'question.asked': { questionId: string; text: string; options?: string[] };
  'usage.updated': Usage;
  'subagent.started': { subagentId: string; name?: string; description?: string; parentToolId?: string };
  'subagent.completed': { subagentId: string; status: 'ok' | 'error' | 'cancelled' };
  /** Terminal-mode output. */
  'term.output': { dataBase64: string };
  'term.exited': { exitCode: number | null; signal?: string };
  /** Untranslated native event, always allowed; UIs render it generically. */
  'agent.raw': { agent: AgentKind; payload: unknown };
  error: { message: string; code?: string; fatal?: boolean };
}

/** Events on the `global` channel (machine-wide changes). */
export interface GlobalEventMap {
  'machine.updated': { machine: MachineInfo };
  'workspace.created': { workspace: WorkspaceInfo };
  'workspace.removed': { workspaceId: string };
  'session.created': { session: SessionInfo };
  'session.updated': { session: SessionInfo };
  'install.progress': { agent: AgentKind; stage: string; message?: string; done?: boolean; ok?: boolean };
}

export type SessionEventType = keyof SessionEventMap;
export type GlobalEventType = keyof GlobalEventMap;

export type SessionEventBody = {
  [K in SessionEventType]: { type: K; data: SessionEventMap[K] };
}[SessionEventType];

export type GlobalEventBody = {
  [K in GlobalEventType]: { type: K; data: GlobalEventMap[K] };
}[GlobalEventType];

export interface EventMeta {
  /** `session:<id>` or `global` */
  ch: string;
  /** Monotonic per channel, starting at 1. */
  seq: number;
  /** ISO-8601 */
  ts: string;
}

export type SessionEvent = SessionEventBody & EventMeta;
export type GlobalEvent = GlobalEventBody & EventMeta;
export type ChannelEvent = SessionEvent | GlobalEvent;

export const GLOBAL_CHANNEL = 'global';

export function sessionChannel(sessionId: string): string {
  return `session:${sessionId}`;
}

export function parseChannel(ch: string): { kind: 'session'; sessionId: string } | { kind: 'global' } | null {
  if (ch === GLOBAL_CHANNEL) return { kind: 'global' };
  if (ch.startsWith('session:') && ch.length > 'session:'.length) {
    return { kind: 'session', sessionId: ch.slice('session:'.length) };
  }
  return null;
}
