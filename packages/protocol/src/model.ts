// Domain objects exchanged over the protocol. Hierarchy: Machine > Workspace > Session.

export type AgentKind = 'claude' | 'codex' | 'opencode' | 'agy' | 'shell';
export const AGENT_KINDS: readonly AgentKind[] = ['claude', 'codex', 'opencode', 'agy', 'shell'];

export type SessionMode = 'structured' | 'terminal';

export type SessionStatus =
  | 'starting'
  | 'running'
  | 'waiting_input'
  | 'waiting_approval'
  | 'idle'
  | 'paused'
  | 'ended'
  | 'failed';

export type MachineRole = 'node' | 'hub';

export interface MachineInfo {
  id: string;
  name: string;
  hostname: string;
  os: 'darwin' | 'linux' | 'win32' | 'other';
  arch: string;
  /** A display/GUI session is available to agents (macOS Aqua session, or a virtual X display). */
  headful: boolean;
  alwaysOn: boolean;
  tags: string[];
  online: boolean;
  roles: MachineRole[];
  bizziVersion: string;
}

export type AgentAuthState = 'ok' | 'missing' | 'expired' | 'unknown';

export interface AgentProbe {
  agent: AgentKind;
  installed: boolean;
  path?: string;
  version?: string;
  latestVersion?: string;
  auth: AgentAuthState;
  /** e.g. account email or plan, when the agent reports it */
  account?: string;
  notes?: string[];
}

export type WorkspaceKind = 'git' | 'dir';

export interface WorkspaceInfo {
  id: string;
  machineId: string;
  name: string;
  /** Absolute path on the machine. */
  path: string;
  kind: WorkspaceKind;
  projectId?: string;
  createdAt: string;
}

export interface SessionInfo {
  id: string;
  machineId: string;
  workspaceId: string;
  agent: AgentKind;
  mode: SessionMode;
  status: SessionStatus;
  title?: string;
  /** The agent's own id for this conversation (Claude session id, Codex thread id, OpenCode session id). */
  agentSessionRef?: string;
  model?: string;
  permissionMode?: string;
  effort?: string;
  forkedFrom?: string;
  createdAt: string;
  updatedAt: string;
  lastSeq: number;
}

export type InputBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; dataBase64: string }
  | { type: 'file'; path: string };

export type ApprovalKind = 'shell' | 'edit' | 'write' | 'read' | 'mcp' | 'web' | 'plan' | 'other';
export type ApprovalDecisionKind = 'allow' | 'allow_always' | 'deny';

export interface ApprovalRequest {
  approvalId: string;
  toolId?: string;
  kind: ApprovalKind;
  title: string;
  description?: string;
  /** The tool input the agent wants to use (command, file edit, …). */
  input?: unknown;
  /** Whether the adapter supports `editedInput` in the decision. */
  editable: boolean;
  /** Decisions this agent supports for this request. */
  options: ApprovalDecisionKind[];
}

export interface ApprovalDecision {
  decision: ApprovalDecisionKind;
  /** Optional message to the agent (e.g. why it was denied). */
  message?: string;
  /** Replacement tool input, only when the request was `editable`. */
  editedInput?: unknown;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  contextWindow?: number;
}

/** Printed by `bizzi serve` as a single JSON line on stdout once it is listening. */
export interface ServeReady {
  event: 'ready';
  /** WebSocket URL of the client-protocol endpoint, e.g. ws://127.0.0.1:7777/ws */
  url: string;
  /** Bearer token required in `hello` (local mode). */
  token: string;
  machineId: string;
  pid: number;
}
