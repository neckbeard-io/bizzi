// Per-agent launch recipes for terminal mode: which binary, how StartSessionOptions map to flags.
//
// Verification status (see README): claude flags checked against `claude --help` (2.1.311);
// opencode flags against `opencode --help` (2.0.25); codex and agy are not installed on the dev
// machine, so their flags are from public docs / docs/spec.md and marked unverified.

import { randomUUID } from 'node:crypto';
import type { AgentCapabilities, AgentKind, McpServerSpec, StartSessionOptions } from '@bizzi/protocol';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { commonBinDirs, findBinary } from './probe.ts';

export interface LaunchPlan {
  args: string[];
  /** The agent's own session id when known up front (e.g. claude --session-id). */
  nativeRef?: string;
  /** Options that were given but could not be mapped (logged). */
  ignored?: string[];
}

export interface TerminalAgentSpec {
  agent: AgentKind;
  /** Human-readable binary name for messages. */
  binaryName: string;
  /** Resolve the executable (absolute path) or undefined if missing. */
  resolveBinary(lookup: { path?: string; extraDirs?: string[] }): string | undefined;
  versionArgs?: string[];
  /** Map start options (+ native resume ref, if any) to CLI args. */
  buildLaunch(opts: StartSessionOptions, nativeResumeRef: string | undefined): LaunchPlan;
  /** Environment variables to remove for the child (e.g. nested-session guards). */
  unsetEnv?: string[];
  /** Capability overrides on top of the terminal baseline. */
  capabilities?: Partial<AgentCapabilities>;
  /** Bytes sent by interrupt(). Default Ctrl-C. */
  interruptSequence?: string;
  /** How a file input block is typed into the TUI. Default: the path. */
  formatFile?(path: string): string;
  /** Probe notes (verification status etc.). */
  notes?: string[];
  /** Through a launcher (container workspaces): run this instead of `binaryName` + buildLaunch's args. */
  launcherCommand?: { command: string; args: string[] };
}

function ignoredOpts(opts: StartSessionOptions, keys: (keyof StartSessionOptions)[]): string[] {
  return keys.filter((k) => {
    const v = opts[k];
    return v !== undefined && !(typeof v === 'object' && Object.keys(v as object).length === 0);
  });
}

function binarySpec(name: string, agentDirs: () => string[] = () => []) {
  return (lookup: { path?: string; extraDirs?: string[] }) =>
    findBinary(name, { path: lookup.path, extraDirs: [...(lookup.extraDirs ?? commonBinDirs()), ...agentDirs()] });
}

// ---------------------------------------------------------------------------------------------

export interface ShellCommand {
  command: string;
  args?: string[];
}

export function shellSpec(override?: ShellCommand): TerminalAgentSpec {
  return {
    agent: 'shell',
    binaryName: override?.command ?? 'login shell',
    resolveBinary(lookup) {
      if (override) return findBinary(override.command, lookup);
      for (const candidate of [process.env.SHELL, '/bin/bash', '/bin/sh']) {
        if (!candidate) continue;
        const found = findBinary(candidate, lookup);
        if (found) return found;
      }
      return undefined;
    },
    buildLaunch(opts, native) {
      const ignored = ignoredOpts(opts, ['model', 'permissionMode', 'effort', 'systemPromptAppend', 'mcpServers']);
      if (native) ignored.push('resumeRef');
      return { args: override ? [...(override.args ?? [])] : ['-l'], ignored };
    },
    capabilities: { resume: false },
    notes: ['terminal mode: the login shell ($SHELL -l, fallback /bin/bash)'],
    // Inside a container: bash when the image has it, else sh.
    ...(override
      ? {}
      : { launcherCommand: { command: 'sh', args: ['-c', 'if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi'] } }),
  };
}

const CLAUDE_PERMISSION_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'];
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

function claudeMcpConfig(servers: Record<string, McpServerSpec>): string {
  return JSON.stringify({ mcpServers: servers });
}

export function claudeSpec(): TerminalAgentSpec {
  return {
    agent: 'claude',
    binaryName: 'claude',
    resolveBinary: binarySpec('claude', () => [join(homedir(), '.claude', 'local')]),
    buildLaunch(opts, native) {
      const args: string[] = [];
      let nativeRef: string;
      if (native) {
        args.push('--resume', native);
        nativeRef = native;
      } else {
        // Pin the session id so bizzi knows it without parsing the TUI.
        nativeRef = randomUUID();
        args.push('--session-id', nativeRef);
      }
      if (opts.model) args.push('--model', opts.model);
      if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode);
      if (opts.effort) args.push('--effort', opts.effort);
      if (opts.systemPromptAppend) args.push('--append-system-prompt', opts.systemPromptAppend);
      if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0) {
        args.push('--mcp-config', claudeMcpConfig(opts.mcpServers));
      }
      return { args, nativeRef };
    },
    // Claude Code refuses to start when it thinks it is nested inside another Claude Code session.
    unsetEnv: ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'],
    capabilities: {
      resume: true,
      permissionModes: CLAUDE_PERMISSION_MODES,
      effort: CLAUDE_EFFORTS,
      mcpInjection: 'launch',
      instructionInjection: 'system-append',
    },
    formatFile: (p) => `@${p}`,
    notes: ['terminal mode (TUI); flags verified against claude --help 2.1.311'],
  };
}

export function codexSpec(): TerminalAgentSpec {
  return {
    agent: 'codex',
    binaryName: 'codex',
    resolveBinary: binarySpec('codex'),
    buildLaunch(opts, native) {
      // UNVERIFIED (codex not installed here): `codex resume <id>`, -m, -c key=value, -a, -s.
      const args: string[] = [];
      if (native) args.push('resume', native);
      if (opts.model) args.push('--model', opts.model);
      if (opts.effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(opts.effort)}`);
      const ignored = ignoredOpts(opts, ['systemPromptAppend', 'mcpServers']);
      if (opts.permissionMode) {
        if (['untrusted', 'on-failure', 'on-request', 'never'].includes(opts.permissionMode)) {
          args.push('--ask-for-approval', opts.permissionMode);
        } else if (['read-only', 'workspace-write', 'danger-full-access'].includes(opts.permissionMode)) {
          args.push('--sandbox', opts.permissionMode);
        } else ignored.push('permissionMode');
      }
      return { args, nativeRef: native, ignored };
    },
    capabilities: { resume: true },
    notes: ['terminal mode (TUI); flags unverified (codex not installed when written)'],
  };
}

export function opencodeSpec(): TerminalAgentSpec {
  return {
    agent: 'opencode',
    binaryName: 'opencode',
    resolveBinary: binarySpec('opencode'),
    buildLaunch(opts, native) {
      // Verified against opencode 2.0.25: --session <id>, --auto. No model flag on the TUI.
      const args: string[] = [];
      if (native) args.push('--session', native);
      const ignored = ignoredOpts(opts, ['model', 'effort', 'systemPromptAppend', 'mcpServers']);
      if (opts.permissionMode === 'auto') args.push('--auto');
      else if (opts.permissionMode && opts.permissionMode !== 'default') ignored.push('permissionMode');
      return { args, nativeRef: native, ignored };
    },
    capabilities: { resume: true, permissionModes: ['default', 'auto'] },
    notes: ['terminal mode (TUI); flags verified against opencode --help 2.0.25'],
  };
}

export function agySpec(): TerminalAgentSpec {
  return {
    agent: 'agy',
    binaryName: 'agy',
    resolveBinary: binarySpec('agy'),
    buildLaunch(opts, native) {
      // UNVERIFIED (agy not installed here): flags from docs/spec.md §6.7.
      const args: string[] = [];
      if (native) args.push('--conversation', native);
      if (opts.effort) args.push('--effort', opts.effort);
      const ignored = ignoredOpts(opts, ['model', 'systemPromptAppend', 'mcpServers']);
      if (opts.permissionMode === 'plan') args.push('--mode', 'plan');
      else if (opts.permissionMode) ignored.push('permissionMode');
      return { args, nativeRef: native, ignored };
    },
    capabilities: { resume: true },
    notes: ['terminal mode only (no structured protocol); flags unverified (agy not installed when written)'],
  };
}
