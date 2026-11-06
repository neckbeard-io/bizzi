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
  /** Set by the hub: last time the machine's node was connected. */
  lastSeenAt?: string;
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
  /** How the binary appears to have been installed (recipe method name, e.g. 'installer', 'brew', 'npm'). */
  method?: string;
  updateAvailable?: boolean;
  /** Whether the binary is on the PATH of non-interactive shells (launchd/systemd/containers). */
  onPath?: boolean;
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
/** How an approval ended: a decision, or 'cancelled' when its turn ended / the node restarted first. */
export type ApprovalResolution = ApprovalDecisionKind | 'cancelled';

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

export interface QuestionItem {
  id: string;
  text: string;
  /** Short label, e.g. "Auth method". */
  header?: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
  /** Free-text answer allowed (besides or instead of options). */
  allowText?: boolean;
}

/** Answers keyed by QuestionItem.id: an option label, several labels (multiSelect), or free text. */
export type QuestionAnswers = Record<string, string | string[]>;

// ---- provisioning

export type InstallAction = 'install' | 'update' | 'uninstall';

export interface InstallStep {
  id: string;
  title: string;
  /** Shell command shown to the user (already quoted). */
  command?: string;
  requiresSudo?: boolean;
}

export interface InstallPlan {
  /** Agent kind, or a tool name such as 'node'. */
  target: string;
  action: InstallAction;
  method: string;
  steps: InstallStep[];
  notes?: string[];
}

export type LoginMode = 'interactive' | 'device-code' | 'token';

export interface SecretInfo {
  agent: AgentKind;
  /** Environment variable name, e.g. ANTHROPIC_API_KEY. Values are never returned. */
  name: string;
  setAt: string;
}

// ---- knowledge (wire shape; see docs/knowledge.md)

export type KnowledgeScopeLevel = 'global' | 'machine' | 'project' | 'workspace' | 'session' | 'team';

export interface KnowledgeScope {
  level: KnowledgeScopeLevel;
  machineId?: string;
  projectId?: string;
  workspaceId?: string;
  sessionId?: string;
}

export interface KnowledgeItemInfo {
  id: string;
  type: 'rule' | 'memory';
  scope: KnowledgeScope;
  /** Default: all agents. */
  appliesTo?: AgentKind[];
  /** Memories only: fact | preference | decision | gotcha | procedure | reference | todo. */
  kind?: string;
  title: string;
  body: string;
  tags: string[];
  source: {
    agent?: AgentKind;
    sessionId?: string;
    machineId: string;
    via: 'ui' | 'tool' | 'harvest' | 'extract';
    userRequested?: boolean;
  };
  status: 'active' | 'suggested' | 'superseded' | 'deleted';
  supersedes?: string[];
  createdAt: string;
  updatedAt: string;
}

export type KnowledgePreset = 'trusting' | 'balanced' | 'strict';

export interface KnowledgeSettings {
  preset: KnowledgePreset;
  /** Scope used when an agent writes without naming one. */
  defaultAgentScope: KnowledgeScopeLevel;
  /** Per source × scope overrides; shape owned by @bizzi/knowledge. */
  overrides?: unknown;
}

export interface KnowledgeInboxCard {
  sessionId?: string;
  agent?: AgentKind;
  items: KnowledgeItemInfo[];
}

// ---- hub: devices and pairing

export type DeviceKind = 'device' | 'node';

export interface DeviceInfo {
  id: string;
  name: string;
  kind: DeviceKind;
  /** For kind 'node': the machine it serves. */
  machineId?: string;
  /** The first device paired with the setup code. */
  owner?: boolean;
  createdAt: string;
  lastSeenAt?: string;
  revoked?: boolean;
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
