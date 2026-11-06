// Internal contract between the core (node role) and agent adapters. Not part of the wire protocol.

import type { AgentCapabilities } from './capabilities.ts';
import type { SessionEventBody } from './events.ts';
import type { AgentKind, AgentProbe, ApprovalDecision, InputBlock, SessionMode } from './model.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export type McpServerSpec =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> };

export interface StartSessionOptions {
  /** bizzi session id (stable across agent restarts). */
  sessionId: string;
  mode: SessionMode;
  /** Absolute workspace path; the agent's working directory. */
  cwd: string;
  model?: string;
  permissionMode?: string;
  effort?: string;
  /** Resume an agent-native session instead of starting fresh. */
  resumeRef?: string;
  /** Extra environment for the agent process (merged over the node's environment). */
  env?: Record<string, string>;
  /** MCP servers to inject for this session (e.g. bizzi-memory). */
  mcpServers?: Record<string, McpServerSpec>;
  /** Text appended to the agent's system prompt / instructions (rules + memory digest). */
  systemPromptAppend?: string;
  /** Terminal mode: initial size. */
  cols?: number;
  rows?: number;
}

/** Adapters push normalized events through this; the core assigns seq/ts and persists. */
export type EmitFn = (event: SessionEventBody) => void;

export interface AdapterContext {
  logger: Logger;
}

export interface AdapterSession {
  /** The agent's native session id once known (also reported via a `session.info` event). */
  agentSessionRef(): string | undefined;
  /**
   * Start a turn. The core has already emitted `turn.started` with this turnId.
   * The adapter must eventually emit `turn.completed` with the same turnId (also on error/interrupt).
   * Resolves once the input is accepted, not when the turn finishes.
   */
  send(turnId: string, input: InputBlock[]): Promise<void>;
  /** Add input to the in-flight turn without cancelling it (capability `steer`). */
  steer?(input: InputBlock[]): Promise<void>;
  /** Cancel the in-flight turn; the adapter emits `turn.completed` with stopReason 'interrupted'. */
  interrupt(): Promise<void>;
  /** Answer an `approval.requested` event. The adapter emits `approval.resolved`. */
  respondApproval(approvalId: string, decision: ApprovalDecision): Promise<void>;
  /** Change model / permission mode / effort mid-session (capability-gated). */
  set?(opts: { model?: string; permissionMode?: string; effort?: string }): Promise<void>;
  /** Terminal mode: raw input and resize. */
  writeTerminal?(data: Uint8Array): void;
  resizeTerminal?(cols: number, rows: number): void;
  /** Stop the agent process and release resources. Idempotent. */
  stop(): Promise<void>;
}

export interface AgentAdapter {
  readonly agent: AgentKind;
  /** Is the agent installed / authenticated on this machine? Must not throw. */
  probe(): Promise<AgentProbe>;
  capabilities(mode: SessionMode): AgentCapabilities;
  start(opts: StartSessionOptions, emit: EmitFn, ctx: AdapterContext): Promise<AdapterSession>;
}
