import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import { BizziError, NO_CAPABILITIES } from '@bizzi/protocol';
import type {
  AdapterContext,
  AdapterSession,
  AgentAdapter,
  AgentCapabilities,
  AgentProbe,
  EmitFn,
  McpServerSpec,
  ModelOption,
  ProcessLauncher,
  SessionMode,
  StartSessionOptions,
} from '@bizzi/protocol';
import type { McpServerConfig, ModelInfo, Options, SDKUserMessage, SettingSource, SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { EFFORT_LEVELS, PERMISSION_MODES, isEffort, isPermissionMode } from './mapping.ts';
import { findClaudeBinary, probeClaude } from './probe.ts';
import { ClaudeSession } from './session.ts';
import { keyFingerprint } from './usage.ts';
import type { QueryFn } from './types.ts';

export interface ClaudeAdapterOptions {
  /** Defaults to the SDK's `query`. Tests inject scripted streams here. */
  queryFn?: QueryFn;
  /**
   * Path to the `claude` executable. Default: the user's installed binary (PATH, ~/.local/bin,
   * ~/.claude/local, /opt/homebrew/bin), else the binary bundled with the SDK. `null` forces the bundled one.
   */
  claudePath?: string | null;
  /** Directories searched for `claude` instead of PATH + well-known dirs. */
  searchDirs?: string[];
  /** Filesystem settings loaded by Claude Code. Default: user, project, local (CLAUDE.md, AGENTS.md, settings). */
  settingSources?: SettingSource[];
  /** Stream token deltas (`message.delta` / `reasoning.delta`). Default true. */
  includePartialMessages?: boolean;
  /** Max characters of tool output carried in `tool.completed`. Default 8000. */
  maxToolOutputChars?: number;
  /** Launch with `allowDangerouslySkipPermissions` so `bypassPermissions` can be selected. Default true. */
  allowBypassPermissions?: boolean;
  /** How long to wait for the SDK's interrupted result before completing the turn anyway. Default 10s. */
  interruptGraceMs?: number;
  /** Extra SDK options merged last (hooks, agents, thinking, sandbox, plugins, …). */
  sdkOptions?: Partial<Options>;
}

/** @deprecated `fork` is part of StartSessionOptions since protocol v1.1. */
export type ClaudeStartSessionOptions = StartSessionOptions;

const CLIENT_APP = 'bizzi/0.0.1';

const STRUCTURED_CAPABILITIES: AgentCapabilities = {
  modes: ['structured'],
  streaming: 'token',
  steer: true,
  interrupt: true,
  fork: true,
  resume: true,
  resumeAfterNodeRestart: true,
  approvals: 'per-tool',
  editableApprovals: true,
  permissionModes: [...PERMISSION_MODES],
  models: 'dynamic',
  setModelMidSession: true,
  effort: [...EFFORT_LEVELS],
  planMode: true,
  todos: true,
  subagents: true,
  slashCommands: true,
  skills: true,
  images: true,
  mcpInjection: 'launch',
  instructionInjection: 'system-append',
  usage: 'tokens+cost',
  terminal: false,
  questions: true,
  context: true,
  accountUsage: true,
};

export function toSdkMcpServers(specs: Record<string, McpServerSpec>): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const [name, s] of Object.entries(specs)) {
    out[name] =
      s.type === 'stdio'
        ? { type: 'stdio', command: s.command, ...(s.args ? { args: s.args } : {}), ...(s.env ? { env: s.env } : {}) }
        : { type: 'http', url: s.url, ...(s.headers ? { headers: s.headers } : {}) };
  }
  return out;
}

export class ClaudeAdapter implements AgentAdapter {
  readonly agent = 'claude' as const;
  /** StartSessionOptions.executable is honored (restart fallback onto the previous version, updates.md §5). */
  readonly acceptsExecutable = true;
  readonly #opts: ClaudeAdapterOptions;
  readonly #sessions = new Set<ClaudeSession>();

  constructor(opts: ClaudeAdapterOptions = {}) {
    this.#opts = opts;
  }

  probe(): Promise<AgentProbe> {
    const claudePath = this.#opts.claudePath ?? undefined;
    return probeClaude({ claudePath, searchDirs: this.#opts.searchDirs }).catch(() => ({
      agent: 'claude' as const,
      installed: false,
      auth: 'unknown' as const,
    }));
  }

  capabilities(mode: SessionMode): AgentCapabilities {
    if (mode !== 'structured') return { ...NO_CAPABILITIES, modes: [] };
    return { ...STRUCTURED_CAPABILITIES, permissionModes: [...PERMISSION_MODES], effort: [...EFFORT_LEVELS], modes: ['structured'] };
  }

  /**
   * The models Claude Code offers this login (its `/model` list), read from a short-lived process
   * that never gets a prompt: started in the home directory, closed once it answered.
   */
  async listModels(): Promise<ModelOption[]> {
    let executable: string | undefined;
    if (this.#opts.claudePath !== null) {
      executable = (await findClaudeBinary({ claudePath: this.#opts.claudePath, searchDirs: this.#opts.searchDirs }))?.path;
    }
    const abort = new AbortController();
    const idle: AsyncIterable<SDKUserMessage> = {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
            abort.signal.addEventListener('abort', () => resolve({ done: true, value: undefined }), { once: true });
          }),
      }),
    };
    const options: Options = {
      cwd: homedir(),
      env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP },
      settingSources: this.#opts.settingSources ?? ['user', 'project', 'local'],
      persistSession: false,
      ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
    };
    const queryFn = this.#opts.queryFn ?? (await loadSdkQuery());
    const q = queryFn({ prompt: idle, options });
    let timer: NodeJS.Timeout | undefined;
    try {
      if (!q.supportedModels) return [];
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('claude did not list its models within 30s')), 30_000);
      });
      const models = await Promise.race([q.supportedModels(), timeout]);
      return models.map((m) => toModelOption(m));
    } finally {
      clearTimeout(timer);
      abort.abort();
      q.close();
    }
  }

  async start(opts: StartSessionOptions, emit: EmitFn, ctx: AdapterContext): Promise<AdapterSession> {
    if (opts.mode !== 'structured') {
      throw new BizziError('unsupported', 'the Claude SDK adapter only runs structured sessions');
    }
    const log = ctx.logger.child({ adapter: 'claude', sessionId: opts.sessionId });
    const fork = opts.fork === true && !!opts.resumeRef;
    const allowBypass = this.#opts.allowBypassPermissions ?? true;

    let permissionMode: Options['permissionMode'];
    if (opts.permissionMode) {
      if (!isPermissionMode(opts.permissionMode)) throw new BizziError('bad_request', `unknown permission mode: ${opts.permissionMode}`);
      if (opts.permissionMode === 'bypassPermissions' && !allowBypass) {
        throw new BizziError('unsupported', 'bypassPermissions is disabled for this adapter');
      }
      permissionMode = opts.permissionMode;
    }
    let effort: Options['effort'];
    if (opts.effort) {
      if (!isEffort(opts.effort)) throw new BizziError('bad_request', `unknown effort level: ${opts.effort}`);
      effort = opts.effort;
    }

    // A fresh session gets its id up front so agentSessionRef is known before the first turn.
    const sessionUuid = opts.resumeRef && !fork ? undefined : randomUUID();
    const ref = sessionUuid ?? opts.resumeRef;

    let executable: string | undefined = opts.executable;
    // Container workspaces (topology.md §7): the `claude` installed inside the target runs instead.
    if (opts.launcher) executable = 'claude';
    else if (executable) {
      log.log('info', 'starting a pinned claude executable', { path: executable });
    } else if (this.#opts.claudePath !== null) {
      const found = await findClaudeBinary({ claudePath: this.#opts.claudePath, searchDirs: this.#opts.searchDirs });
      executable = found?.path;
      if (!found) log.log('info', 'no installed claude binary found; using the SDK-bundled one');
      else if (found.wrapper) log.log('warn', 'only a shell-wrapped claude was found; SDK flags may conflict', { path: found.path });
    }

    const env: Record<string, string | undefined> = { ...process.env, ...opts.env, CLAUDE_AGENT_SDK_CLIENT_APP: CLIENT_APP };
    const fingerprint = keyFingerprint({ ...env, ...(this.#opts.sdkOptions?.env ?? {}) });
    const session = new ClaudeSession(
      emit,
      log,
      {
        maxToolOutputChars: this.#opts.maxToolOutputChars ?? 8000,
        interruptGraceMs: this.#opts.interruptGraceMs ?? 10_000,
        allowBypassPermissions: allowBypass,
        resumed: !!opts.resumeRef,
        injection: {
          ...(opts.systemPromptAppend ? { systemPromptAppend: opts.systemPromptAppend } : {}),
          ...(opts.mcpServers ? { mcpServers: Object.keys(opts.mcpServers) } : {}),
        },
        ...(fingerprint ? { keyFingerprint: fingerprint } : {}),
      },
      ref,
    );

    const options: Options = {
      cwd: opts.cwd,
      env,
      settingSources: this.#opts.settingSources ?? ['user', 'project', 'local'],
      systemPrompt: opts.systemPromptAppend
        ? { type: 'preset', preset: 'claude_code', append: opts.systemPromptAppend }
        : { type: 'preset', preset: 'claude_code' },
      includePartialMessages: this.#opts.includePartialMessages ?? true,
      canUseTool: session.canUseTool,
      onElicitation: session.onElicitation,
      forwardSubagentText: true,
      stderr: (d) => session.onStderr(d),
      ...(allowBypass ? { allowDangerouslySkipPermissions: true } : {}),
      ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
      ...(opts.launcher ? { spawnClaudeCodeProcess: launchThrough(opts.launcher, opts.cwd, (d) => session.onStderr(d)) } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      ...(effort ? { effort } : {}),
      ...(opts.resumeRef ? { resume: opts.resumeRef } : {}),
      ...(fork ? { forkSession: true } : {}),
      ...(sessionUuid ? { sessionId: sessionUuid } : {}),
      ...(opts.mcpServers && Object.keys(opts.mcpServers).length ? { mcpServers: toSdkMcpServers(opts.mcpServers) } : {}),
      ...this.#opts.sdkOptions,
    };

    const queryFn = this.#opts.queryFn ?? (await loadSdkQuery());
    let q;
    try {
      q = queryFn({ prompt: session.input, options });
    } catch (e) {
      throw new BizziError('agent_unavailable', `failed to start Claude Code: ${(e as Error)?.message ?? String(e)}`);
    }
    session.attach(q, {
      ...(opts.model ? { model: opts.model } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      ...(effort ? { effort } : {}),
    });
    this.#sessions.add(session);
    void session.done.finally(() => this.#sessions.delete(session));
    return session;
  }

  /** Stops every session this adapter started (there is no shared process). Idempotent. */
  async dispose(): Promise<void> {
    const sessions = [...this.#sessions];
    this.#sessions.clear();
    await Promise.allSettled(sessions.map((s) => s.stop()));
  }
}

/**
 * The SDK's command for the target: a JS entry point run by a host runtime (`node …/cli.js --flags`)
 * becomes `claude --flags`; a native binary path becomes `claude`.
 */
export function claudeLaunchArgs(command: string, args: readonly string[]): { command: string; args: string[] } {
  const runtime = /^(node|bun|deno)(\.exe)?$/i.test(basename(command));
  const rest = runtime && args.length > 0 && /\.[cm]?js$/i.test(args[0]!) ? args.slice(1) : [...args];
  return { command: 'claude', args: rest };
}

/** `spawnClaudeCodeProcess` that runs Claude Code through a launcher (e.g. `docker exec`). */
export function launchThrough(launcher: ProcessLauncher, cwd: string, onStderr: (d: string) => void): (o: SpawnOptions) => SpawnedProcess {
  return (o) => {
    const { command, args } = claudeLaunchArgs(o.command, o.args);
    const run = launcher.wrap({ command, args, cwd: o.cwd ?? cwd, env: o.env });
    const child = spawn(run.command, run.args, {
      cwd: run.cwd,
      env: run.env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: o.signal,
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => onStderr(d));
    // Spawn failures reach the SDK through its own 'error' listener; this one only keeps them handled.
    child.on('error', () => {});
    return child;
  };
}

/** An SDK model row as a ModelOption; the `default` row is the CLI's choice when no model is given. */
export function toModelOption(m: ModelInfo): ModelOption {
  const out: ModelOption = { id: m.value };
  if (m.displayName && m.displayName !== m.value) out.label = m.displayName;
  if (m.description) out.description = m.description;
  if (m.value === 'default') out.isDefault = true;
  if (m.supportedEffortLevels?.length) out.efforts = [...m.supportedEffortLevels];
  return out;
}

async function loadSdkQuery(): Promise<QueryFn> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  return sdk.query as QueryFn;
}

export function createAdapters(options?: ClaudeAdapterOptions): AgentAdapter[] {
  return [new ClaudeAdapter(options)];
}
