import type { SessionMode } from './model.ts';

/** What an agent adapter supports. UIs gate controls on this, never on the agent name. */
export interface AgentCapabilities {
  modes: SessionMode[];
  streaming: 'token' | 'message' | 'none';
  steer: boolean;
  interrupt: boolean;
  fork: boolean;
  resume: boolean;
  resumeAfterNodeRestart: boolean;
  approvals: 'per-tool' | 'per-command' | 'mode-only' | 'none';
  editableApprovals: boolean;
  /** Native permission mode names, e.g. ['default', 'acceptEdits', 'plan', 'bypassPermissions']. */
  permissionModes: string[];
  models: 'dynamic' | string[];
  setModelMidSession: boolean;
  effort: string[] | null;
  planMode: boolean;
  todos: boolean;
  subagents: boolean;
  slashCommands: boolean;
  skills: boolean;
  images: boolean;
  mcpInjection: 'launch' | 'config-file' | 'none';
  instructionInjection: 'system-append' | 'config' | 'file' | 'none';
  usage: 'tokens' | 'tokens+cost' | 'none';
  /** Terminal mode: raw PTY in/out is available. */
  terminal: boolean;
  /** The agent can ask the user structured questions (`question.asked` / `question.respond`). */
  questions?: boolean;
  /** The adapter emits `context.updated` (usage.md §1). */
  context?: boolean;
  /** The adapter emits `background.updated` (background work between turns). */
  backgroundTasks?: boolean;
  /** The adapter emits `account.usage` snapshots (usage.md §3). */
  accountUsage?: boolean;
}

export const NO_CAPABILITIES: AgentCapabilities = {
  modes: [],
  streaming: 'none',
  steer: false,
  interrupt: false,
  fork: false,
  resume: false,
  resumeAfterNodeRestart: false,
  approvals: 'none',
  editableApprovals: false,
  permissionModes: [],
  models: [],
  setModelMidSession: false,
  effort: null,
  planMode: false,
  todos: false,
  subagents: false,
  slashCommands: false,
  skills: false,
  images: false,
  mcpInjection: 'none',
  instructionInjection: 'none',
  usage: 'none',
  terminal: false,
};
