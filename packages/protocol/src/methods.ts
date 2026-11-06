import type { AgentCapabilities } from './capabilities.ts';
import type {
  AgentKind,
  AgentProbe,
  ApprovalDecision,
  DeviceInfo,
  DeviceKind,
  InputBlock,
  InstallAction,
  InstallPlan,
  KnowledgeInboxCard,
  KnowledgeItemInfo,
  KnowledgeScope,
  KnowledgeScopeLevel,
  KnowledgeSettings,
  LoginMode,
  MachineInfo,
  MachineRole,
  QuestionAnswers,
  SecretInfo,
  SessionInfo,
  SessionMode,
  WorkspaceInfo,
} from './model.ts';

type Empty = Record<string, never>;

export interface FsEntry {
  name: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
  size?: number;
}

export interface GitFileStatus {
  path: string;
  /** Porcelain v1 XY code, e.g. " M", "??", "A ". */
  status: string;
}

export interface AgentListing extends AgentProbe {
  capabilities?: AgentCapabilities;
}

/**
 * Routing to a machine (hub). Methods that name a session or workspace are routed by that id.
 * Methods without one take an optional `machineId`: required when talking to a hub, ignored by a
 * node when it matches its own machine (a different id → `not_found`).
 */
export interface MachineTarget {
  machineId?: string;
}

/** Client → server methods. Every method is a request with exactly one response. */
export interface Methods {
  hello: {
    params: { protocol: string; client: { name: string; version: string }; token?: string };
    /** `machine` is the node's machine (role 'node') or the hub's own host (role 'hub'). */
    result: { protocol: string; serverVersion: string; machine: MachineInfo; role?: MachineRole };
  };
  /** Replays events with seq > since (default 0), then streams live ones. */
  subscribe: { params: { ch: string; since?: number }; result: { ch: string; lastSeq: number } };
  unsubscribe: { params: { ch: string }; result: Empty };

  'machines.list': { params: Empty; result: { machines: MachineInfo[] } };
  'agents.list': { params: MachineTarget & { refresh?: boolean }; result: { agents: AgentListing[] } };

  'workspaces.list': { params: MachineTarget; result: { workspaces: WorkspaceInfo[] } };
  /** Adopt an existing directory, or create it when `create` is true. */
  'workspace.create': {
    params: MachineTarget & { path: string; name?: string; create?: boolean };
    result: { workspace: WorkspaceInfo };
  };
  /** Removes the workspace from bizzi's registry only; files are untouched. */
  'workspace.remove': { params: { workspaceId: string }; result: Empty };

  'sessions.list': { params: MachineTarget & { workspaceId?: string }; result: { sessions: SessionInfo[] } };
  'session.get': { params: { sessionId: string }; result: { session: SessionInfo; capabilities: AgentCapabilities } };
  'session.create': {
    params: {
      workspaceId: string;
      agent: AgentKind;
      mode?: SessionMode;
      model?: string;
      permissionMode?: string;
      effort?: string;
      title?: string;
      /** Resume an existing agent-native session (Claude session id, Codex thread id, …). */
      resumeRef?: string;
      /** Terminal mode: initial size. */
      cols?: number;
      rows?: number;
      /** Terminal mode only: run this command (argv) instead of the agent's TUI. */
      command?: string[];
    };
    result: { session: SessionInfo };
  };
  /** New session continuing from the source session's conversation (agent-native fork when supported). */
  'session.fork': { params: { sessionId: string; title?: string }; result: { session: SessionInfo } };
  /** Stop the session if needed and remove it and its events. */
  'session.delete': { params: { sessionId: string }; result: Empty };
  'session.send': { params: { sessionId: string; input: InputBlock[] }; result: { turnId: string } };
  'session.steer': { params: { sessionId: string; input: InputBlock[] }; result: Empty };
  'session.interrupt': { params: { sessionId: string }; result: Empty };
  'session.stop': { params: { sessionId: string }; result: Empty };
  'session.set': {
    params: { sessionId: string; model?: string; permissionMode?: string; effort?: string };
    result: { session: SessionInfo };
  };
  'approval.respond': { params: { sessionId: string; approvalId: string } & ApprovalDecision; result: Empty };
  /** Answer a `question.asked`; `cancel` declines it. */
  'question.respond': {
    params: { sessionId: string; questionId: string; answers?: QuestionAnswers; cancel?: boolean };
    result: Empty;
  };

  /** Terminal-mode sessions only. */
  'term.input': { params: { sessionId: string; dataBase64: string }; result: Empty };
  'term.resize': { params: { sessionId: string; cols: number; rows: number }; result: Empty };
  /** Recent terminal output (scrollback) as of `seq`; subscribe with `since: seq` to continue live. */
  'term.snapshot': { params: { sessionId: string }; result: { dataBase64: string; seq: number } };

  'fs.list': { params: { workspaceId: string; path?: string }; result: { entries: FsEntry[] } };
  'fs.read': {
    params: { workspaceId: string; path: string; maxBytes?: number };
    result: { content: string; encoding: 'utf8' | 'base64'; truncated: boolean };
  };
  'git.status': {
    params: { workspaceId: string };
    result: { isRepo: boolean; branch?: string; ahead?: number; behind?: number; files: GitFileStatus[] };
  };
  'git.diff': { params: { workspaceId: string; path?: string; staged?: boolean }; result: { diff: string } };

  // ---- provisioning (docs/spec.md §7)
  /** Preview the steps for installing / updating / uninstalling an agent. */
  'agent.plan': {
    params: MachineTarget & { agent: AgentKind; action: InstallAction; method?: string; version?: string };
    result: { plan: InstallPlan };
  };
  /** Run a plan; progress streams as `install.progress` (global channel) with this jobId. */
  'agent.install': {
    params: MachineTarget & { agent: AgentKind; action: InstallAction; method?: string; version?: string; dryRun?: boolean };
    result: { jobId: string; plan: InstallPlan };
  };
  /** Start a login flow as a terminal-mode session; it emits `login.prompt` / `login.completed`. */
  'agent.login': {
    params: MachineTarget & { agent: AgentKind; mode?: LoginMode; workspaceId?: string };
    result: { session: SessionInfo };
  };
  /** Store a secret (e.g. an API key) on the machine; injected into that agent's environment. */
  'agent.setSecret': { params: MachineTarget & { agent: AgentKind; name: string; value: string }; result: Empty };
  'agent.deleteSecret': { params: MachineTarget & { agent: AgentKind; name: string }; result: Empty };
  'agent.secrets': { params: MachineTarget & { agent?: AgentKind }; result: { secrets: SecretInfo[] } };

  // ---- knowledge (docs/knowledge.md)
  'knowledge.list': {
    params: MachineTarget & {
      type?: 'rule' | 'memory';
      status?: KnowledgeItemInfo['status'];
      scopeLevel?: KnowledgeScopeLevel;
      workspaceId?: string;
      projectId?: string;
      query?: string;
      limit?: number;
    };
    result: { items: KnowledgeItemInfo[] };
  };
  'knowledge.add': {
    params: MachineTarget & {
      type: 'rule' | 'memory';
      title: string;
      body: string;
      scope: KnowledgeScope;
      kind?: string;
      appliesTo?: AgentKind[];
      tags?: string[];
    };
    result: { item: KnowledgeItemInfo };
  };
  'knowledge.update': {
    params: MachineTarget & {
      id: string;
      title?: string;
      body?: string;
      scope?: KnowledgeScope;
      appliesTo?: AgentKind[];
      tags?: string[];
    };
    result: { item: KnowledgeItemInfo };
  };
  'knowledge.forget': { params: MachineTarget & { id: string }; result: Empty };
  'knowledge.inbox': { params: MachineTarget; result: { cards: KnowledgeInboxCard[] } };
  'knowledge.accept': { params: MachineTarget & { ids: string[]; scope?: KnowledgeScope }; result: Empty };
  'knowledge.reject': { params: MachineTarget & { ids: string[] }; result: Empty };
  'knowledge.settings.get': { params: MachineTarget; result: { settings: KnowledgeSettings } };
  'knowledge.settings.set': {
    params: MachineTarget & { settings: Partial<KnowledgeSettings> };
    result: { settings: KnowledgeSettings };
  };

  // ---- hub only (see hub.ts for the HTTP pairing/auth API)
  /** Create a one-time pairing code for a new device or node. */
  'pairing.create': {
    params: { kind: DeviceKind; name?: string };
    result: { code: string; expiresAt: string; pairUrl: string };
  };
  'devices.list': { params: Empty; result: { devices: DeviceInfo[] } };
  'device.revoke': { params: { deviceId: string }; result: Empty };
}

export type MethodName = keyof Methods;
export type MethodParams<M extends MethodName> = Methods[M]['params'];
export type MethodResult<M extends MethodName> = Methods[M]['result'];
