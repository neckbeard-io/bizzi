import type { AgentCapabilities } from './capabilities.ts';
import type {
  AgentKind,
  AgentProbe,
  ApprovalDecision,
  InputBlock,
  MachineInfo,
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

/** Client → server methods. Every method is a request with exactly one response. */
export interface Methods {
  hello: {
    params: { protocol: string; client: { name: string; version: string }; token?: string };
    result: { protocol: string; serverVersion: string; machine: MachineInfo };
  };
  /** Replays events with seq > since (default 0), then streams live ones. */
  subscribe: { params: { ch: string; since?: number }; result: { ch: string; lastSeq: number } };
  unsubscribe: { params: { ch: string }; result: Empty };

  'machines.list': { params: Empty; result: { machines: MachineInfo[] } };
  'agents.list': { params: { refresh?: boolean }; result: { agents: AgentListing[] } };

  'workspaces.list': { params: Empty; result: { workspaces: WorkspaceInfo[] } };
  /** Adopt an existing directory, or create it when `create` is true. */
  'workspace.create': {
    params: { path: string; name?: string; create?: boolean };
    result: { workspace: WorkspaceInfo };
  };
  /** Removes the workspace from bizzi's registry only; files are untouched. */
  'workspace.remove': { params: { workspaceId: string }; result: Empty };

  'sessions.list': { params: { workspaceId?: string }; result: { sessions: SessionInfo[] } };
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
    };
    result: { session: SessionInfo };
  };
  'session.send': { params: { sessionId: string; input: InputBlock[] }; result: { turnId: string } };
  'session.steer': { params: { sessionId: string; input: InputBlock[] }; result: Empty };
  'session.interrupt': { params: { sessionId: string }; result: Empty };
  'session.stop': { params: { sessionId: string }; result: Empty };
  'session.set': {
    params: { sessionId: string; model?: string; permissionMode?: string; effort?: string };
    result: { session: SessionInfo };
  };
  'approval.respond': { params: { sessionId: string; approvalId: string } & ApprovalDecision; result: Empty };

  /** Terminal-mode sessions only. */
  'term.input': { params: { sessionId: string; dataBase64: string }; result: Empty };
  'term.resize': { params: { sessionId: string; cols: number; rows: number }; result: Empty };

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
}

export type MethodName = keyof Methods;
export type MethodParams<M extends MethodName> = Methods[M]['params'];
export type MethodResult<M extends MethodName> = Methods[M]['result'];
