// bizzi permission-mode names mapped onto Codex approval policy + sandbox combinations.
// They mirror the presets of Codex's own TUI (/approvals), plus 'untrusted'.

import type { AskForApproval, SandboxMode, SandboxPolicy } from './codex-types.ts';

export interface CodexPermissionPreset {
  approvalPolicy: AskForApproval;
  sandbox: SandboxMode;
  description: string;
}

export const PERMISSION_MODES = {
  /** Read files anywhere; ask before any write or network access. */
  'read-only': {
    approvalPolicy: 'on-request',
    sandbox: 'read-only',
    description: 'Read-only sandbox; Codex asks before editing files or running commands that need more access.',
  },
  /** Codex's default: edit and run inside the workspace; ask to go beyond it. */
  auto: {
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write',
    description: 'Workspace-write sandbox; Codex asks before leaving the workspace or using the network.',
  },
  /** Ask before every command that is not known to be safe (reads). */
  untrusted: {
    approvalPolicy: 'untrusted',
    sandbox: 'workspace-write',
    description: 'Workspace-write sandbox; Codex asks before any command that is not a trusted read.',
  },
  /** No sandbox, no prompts. */
  'full-access': {
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
    description: 'No sandbox and no approval prompts.',
  },
} as const satisfies Record<string, CodexPermissionPreset>;

export type PermissionModeName = keyof typeof PERMISSION_MODES;

export const PERMISSION_MODE_NAMES = Object.keys(PERMISSION_MODES) as PermissionModeName[];

export function isPermissionMode(name: string): name is PermissionModeName {
  return Object.hasOwn(PERMISSION_MODES, name);
}

/** Reverse-map Codex's effective settings to a bizzi mode name, if they match a preset. */
export function permissionModeFor(approvalPolicy: unknown, sandbox: unknown): PermissionModeName | undefined {
  const mode = sandboxModeOf(sandbox);
  for (const name of PERMISSION_MODE_NAMES) {
    const p = PERMISSION_MODES[name];
    if (p.approvalPolicy === approvalPolicy && p.sandbox === mode) return name;
  }
  return undefined;
}

/** `turn/start` takes a full SandboxPolicy rather than a SandboxMode. */
export function sandboxPolicyFor(mode: SandboxMode): SandboxPolicy {
  switch (mode) {
    case 'read-only':
      return { type: 'readOnly', networkAccess: false };
    case 'workspace-write':
      return {
        type: 'workspaceWrite',
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
    case 'danger-full-access':
      return { type: 'dangerFullAccess' };
  }
}

function sandboxModeOf(sandbox: unknown): SandboxMode | undefined {
  if (sandbox === 'read-only' || sandbox === 'workspace-write' || sandbox === 'danger-full-access') return sandbox;
  if (typeof sandbox === 'object' && sandbox !== null && 'type' in sandbox) {
    switch ((sandbox as { type: unknown }).type) {
      case 'readOnly':
        return 'read-only';
      case 'workspaceWrite':
        return 'workspace-write';
      case 'dangerFullAccess':
        return 'danger-full-access';
    }
  }
  return undefined;
}
