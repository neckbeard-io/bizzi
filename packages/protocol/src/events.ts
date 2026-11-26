import type {
  AgentKind,
  ApprovalRequest,
  ApprovalResolution,
  DeviceInfo,
  QuestionAnswers,
  QuestionItem,
  InputBlock,
  MachineInfo,
  AccountUsage,
  PipelineInfo,
  ContextUsage,
  SessionInfo,
  WidgetValue,
  SessionStatus,
  Usage,
  UserPrefs,
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
 * approval.requested (waiting_approval), approval.resolved (running), question.asked (waiting_input),
 * question.resolved (running) and turn.completed (idle).
 * Adapters emit `session.status` for other transitions (failed, ended, waiting_input, and running
 * when activity resumes without a turn, e.g. typing into a terminal session).
 *
 * Turns: exactly one `turn.completed` per turnId reaches the log. Adapters emit it; if `send()` rejects
 * the core completes the turn itself. The core drops duplicates and completions for unknown turns.
 *
 * Usage: `turn.completed.usage` is per turn; `usage.updated` is the running session total.
 * `tool.updated.output` is a chunk to append, not the full output so far.
 */
export interface SessionEventMap {
  'session.status': {
    status: SessionStatus;
    reason?: string;
    /** What the session is waiting on, when known (terminal heuristics, login flows). */
    prompt?: 'approval' | 'input' | 'login' | 'question' | 'budget';
    /**
     * What produced this status, for the "explain" view (landscape.md §4.3), e.g.
     * 'osc7501', 'detector:claude-permission', 'adapter'.
     */
    source?: string;
  };
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
  /** Emitted by the core when input is steered into the in-flight turn. */
  'turn.steered': { turnId: string; input: InputBlock[] };
  /** Emitted by the adapter when the turn finishes, with the same turnId. */
  'turn.completed': { turnId: string; stopReason: StopReason; usage?: Usage; error?: string };
  /** `parentToolId` set when the text comes from a subagent started by that tool call. */
  'message.delta': { messageId: string; role: 'assistant'; text: string; parentToolId?: string };
  'message.completed': {
    messageId: string;
    role: 'assistant' | 'user' | 'system';
    text: string;
    parentToolId?: string;
  };
  'reasoning.delta': { messageId: string; text: string; parentToolId?: string };
  'reasoning.completed': { messageId: string; text: string; summary?: boolean; parentToolId?: string };
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
  /**
   * `by`: who resolved it. Adapters set it for resolutions that didn't come from approval.respond
   * ('bizzi', 'agent', …); the core stamps 'user' (approval.respond) or 'parent' (the helper's parent
   * session through the bizzi-agents tools, spec §12.5) with `bySessionId`.
   */
  'approval.resolved': { approvalId: string; decision: ApprovalResolution; by?: string; bySessionId?: string };
  /**
   * The agent asks the user something (Claude AskUserQuestion, Codex requestUserInput, MCP elicitation…).
   * `text`/`options` summarize the first question for simple clients; `questions` carries the full form.
   * Answer with `question.respond`.
   */
  'question.asked': { questionId: string; text: string; options?: string[]; questions?: QuestionItem[] };
  /** `by` / `bySessionId`: as for approval.resolved. */
  'question.resolved': { questionId: string; answers?: QuestionAnswers; cancelled?: boolean; by?: string; bySessionId?: string };
  'usage.updated': Usage;
  /** Current context-window occupancy (usage.md §1.2). Agents without data never emit it. */
  'context.updated': ContextUsage;
  'context.compacted': { before?: number; after?: number };
  /** Per-login usage observed during this session (rate-limit events etc.); the core republishes it globally. */
  'account.usage': AccountUsage;
  /** The agent process is being replaced at a safe point (updates.md §5). The bizzi session carries on. */
  'session.restarting': { fromVersion?: string; toVersion?: string; reason?: string };
  /**
   * `ok: false` with `fallbackVersion`: the new version failed to start and the session resumed on
   * the previous version (`fallbackVersion`) instead; it keeps running and stays stale.
   */
  'session.restarted': { fromVersion?: string; toVersion?: string; ok: boolean; error?: string; fallbackVersion?: string };
  'subagent.started': { subagentId: string; name?: string; description?: string; parentToolId?: string };
  'subagent.completed': { subagentId: string; status: 'ok' | 'error' | 'cancelled' };
  /** Terminal-mode output. */
  'term.output': { dataBase64: string };
  'term.exited': { exitCode: number | null; signal?: string };
  /** Login sessions (`agent.login`): URLs / one-time codes detected in the terminal output. */
  'login.prompt': { urls: string[]; codes: string[]; callbackPort?: number; awaitingCodeInput?: boolean };
  'login.completed': { ok: boolean; account?: string; message?: string };
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
  'session.removed': { sessionId: string; workspaceId: string };
  'install.progress': {
    agent: AgentKind;
    /** Set for non-agent tools (e.g. 'node'); `agent` is then the agent it was installed for. */
    tool?: string;
    jobId?: string;
    stage: string;
    message?: string;
    step?: number;
    total?: number;
    done?: boolean;
    ok?: boolean;
  };
  'knowledge.changed': { ids: string[] };
  /** Latest snapshot for one login (usage.md §3). */
  'account.usage': { usage: AccountUsage };
  'widget.updated': { widget: WidgetValue };
  'widget.removed': { machineId: string; widgetId: string };
  /** Hub only. */
  'device.updated': { device: DeviceInfo };
  /** User-wide preferences changed (from `prefs.set` on any device); emitted by the server that stores them. */
  'prefs.updated': { prefs: UserPrefs };
  // ---- pipelines (docs/pipelines.md)
  /** A pipeline run was started or changed (stage started or finished, gate opened or answered). */
  'pipeline.updated': { pipeline: PipelineInfo };
  'pipeline.removed': { pipelineId: string; machineId: string };
  // ---- identity colour and icon (spec §11.1 "Identity colour")
  /** A workspace's user fields changed (`workspace.set`): the whole new record. */
  'workspace.updated': { workspace: WorkspaceInfo };
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
