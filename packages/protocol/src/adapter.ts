// Internal contract between the core (node role) and agent adapters. Not part of the wire protocol.

import type { AgentCapabilities } from './capabilities.ts';
import type { SessionEventBody } from './events.ts';
import type { AgentKind, AgentProbe, ApprovalDecision, InputBlock, ModelOption, QuestionAnswers, SessionMode } from './model.ts';

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
  /** With resumeRef: start a new agent session forked from it (capability `fork`). */
  fork?: boolean;
  /** Terminal mode only: run this argv instead of the agent's TUI (e.g. a login command). */
  command?: string[];
  /** Extra environment for the agent process (merged over the node's environment). */
  env?: Record<string, string>;
  /** MCP servers to inject for this session (e.g. bizzi-memory). */
  mcpServers?: Record<string, McpServerSpec>;
  /** Text appended to the agent's system prompt / instructions (rules + memory digest). */
  systemPromptAppend?: string;
  /** Terminal mode: initial size. */
  cols?: number;
  rows?: number;
  /**
   * Run this executable instead of the adapter's own choice. Set only by the core's restart
   * fallback onto the previous version (updates.md §5), and only for adapters with
   * `acceptsExecutable`.
   */
  executable?: string;
  /** Run the agent process somewhere other than this machine's shell (container workspaces). */
  launcher?: ProcessLauncher;
}

// ---- process launchers (topology.md §7)

/** A process an adapter is about to spawn, as the agent should see it. */
export interface LaunchSpec {
  /** Bare command name, resolved inside the target (e.g. `codex`, not a host path). */
  command: string;
  args: string[];
  /** The agent's working directory inside the target. */
  cwd: string;
  /** The full environment the adapter would have used; the launcher decides what crosses over. */
  env: Record<string, string | undefined>;
  /** Allocate a terminal (terminal mode). */
  tty?: boolean;
}

/** What to spawn on this machine instead (e.g. `docker exec -i … <container> codex app-server`). */
export interface LaunchCommand {
  command: string;
  args: string[];
  /** Host-side working directory for the spawned process. */
  cwd: string;
  env: Record<string, string | undefined>;
}

/**
 * Runs agent processes inside another environment. Adapters that support it call `wrap` right before
 * spawning; the rest refuse to start with `unsupported` when one is set.
 */
export interface ProcessLauncher {
  /** For logs and errors, e.g. `container bizzi-ws-w_123`. */
  readonly label: string;
  wrap(spec: LaunchSpec): LaunchCommand;
  /** Rewrite (or drop) MCP servers the node injects, which may not be reachable from inside. */
  mapMcpServers?(servers: Record<string, McpServerSpec>): Record<string, McpServerSpec>;
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
  /** Add input to the in-flight turn without canceling it (capability `steer`). */
  steer?(input: InputBlock[]): Promise<void>;
  /** Cancel the in-flight turn; the adapter emits `turn.completed` with stopReason 'interrupted'. */
  interrupt(): Promise<void>;
  /** Answer an `approval.requested` event. The adapter emits `approval.resolved`. */
  respondApproval(approvalId: string, decision: ApprovalDecision): Promise<void>;
  /** Answer a `question.asked` event (`answers` undefined = declined). The adapter emits `question.resolved`. */
  respondQuestion?(questionId: string, answers: QuestionAnswers | undefined): Promise<void>;
  /** Terminal mode: recent output for late joiners. */
  snapshotTerminal?(): Uint8Array;
  /** Change model / permission mode / effort mid-session (capability-gated). */
  set?(opts: { model?: string; permissionMode?: string; effort?: string }): Promise<void>;
  /** Terminal mode: raw input and resize. */
  writeTerminal?(data: Uint8Array): void;
  resizeTerminal?(cols: number, rows: number): void;
  /** Stop the agent process and release resources. Idempotent. */
  stop(): Promise<void>;
  /**
   * Version of the agent process actually serving this session, when the adapter can ask it
   * (OpenCode: the shared server's `/api/info`). The core prefers it over the probe's version.
   */
  agentVersion?(): string | undefined;
}

export interface AgentAdapter {
  readonly agent: AgentKind;
  /** Is the agent installed / authenticated on this machine? Must not throw. */
  probe(): Promise<AgentProbe>;
  capabilities(mode: SessionMode): AgentCapabilities;
  start(opts: StartSessionOptions, emit: EmitFn, ctx: AdapterContext): Promise<AdapterSession>;
  /**
   * The models the agent offers (`agents.models`). Optional: without it the capability's fixed
   * `models` list is used. May start the agent briefly; the core caches the answer per version.
   * `env` is the agent's secrets (as sessions get them), for agents that need a key to ask.
   */
  listModels?(ctx?: { env?: Record<string, string> }): Promise<ModelOption[]>;
  /** Release shared resources (e.g. a per-node agent server) when the node shuts down. */
  dispose?(): Promise<void>;
  // ---- restarts onto a new agent version (updates.md §3, §5)
  /**
   * One agent process serves every session of this adapter instead of one per session
   * (updates.md §3). `owned`: bizzi started it and `recycle()` replaces it, so a restart covers
   * every session on it at once. `external`: someone else's server (the user's background
   * service); bizzi never restarts it.
   */
  readonly sharedProcess?: 'owned' | 'external';
  /**
   * `sharedProcess: 'owned'`: stop the shared process so the next start runs the installed binary.
   * The core calls it only after stopping every session on it.
   */
  recycle?(): Promise<void>;
  /** start() honors StartSessionOptions.executable (restart fallback onto the previous version). */
  readonly acceptsExecutable?: boolean;
}
