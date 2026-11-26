import {
  BizziError,
  NO_CAPABILITIES,
  type AdapterContext,
  type AdapterSession,
  type AgentAdapter,
  type AgentCapabilities,
  type AgentProbe,
  type EmitFn,
  type Logger,
  type SessionMode,
  type StartSessionOptions,
} from '@bizzi/protocol';
import type { GetAccountResponse, InitializeParams } from './codex-types.ts';
import { codexVersion, findCodex } from './locate.ts';
import { PERMISSION_MODE_NAMES } from './permissions.ts';
import { AppServerProcess, describeExit, type SpawnSpec } from './process.ts';
import { CodexSession } from './session.ts';

export const ADAPTER_VERSION = '0.0.1';

export interface CodexAdapterOptions {
  /** Path to the `codex` executable. Default: discovered (PATH, /opt/homebrew/bin, ~/.local/bin, npm global bin). */
  codexPath?: string;
  /**
   * Arguments inserted before `app-server` (and before `--version` in probe), for wrappers such as
   * `node path/to/codex.js`. Mostly for tests.
   */
  codexArgsPrefix?: string[];
  /** Extra arguments appended after `app-server`, e.g. `['-c', 'model_reasoning_summary="detailed"']`. */
  extraArgs?: string[];
  /** Extra environment for every codex process (over process.env, under StartSessionOptions.env). E.g. CODEX_HOME. */
  env?: Record<string, string>;
  /** Timeout for handshake / thread / turn requests. Default 60 s. */
  requestTimeoutMs?: number;
  /** How long to wait for Codex to confirm `turn/interrupt` before completing the turn locally. Default 15 s. */
  interruptTimeoutMs?: number;
  /** Upper bound for probe()'s auth check. Default 15 s. */
  probeTimeoutMs?: number;
  /** Logger used by probe() (sessions use the AdapterContext logger). */
  logger?: Logger;
}

const NOOP_LOGGER: Logger = {
  log() {},
  child() {
    return NOOP_LOGGER;
  },
};

/** Reasoning efforts advertised by `model/list` in codex-cli 0.167.0 (support varies per model). */
export const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export const CODEX_STRUCTURED_CAPABILITIES: AgentCapabilities = {
  ...NO_CAPABILITIES,
  modes: ['structured'],
  streaming: 'token',
  steer: true,
  interrupt: true,
  fork: true,
  resume: true,
  resumeAfterNodeRestart: true,
  approvals: 'per-command',
  editableApprovals: false,
  permissionModes: [...PERMISSION_MODE_NAMES],
  models: 'dynamic',
  setModelMidSession: true,
  effort: CODEX_EFFORTS,
  planMode: false,
  todos: true,
  subagents: false,
  slashCommands: false,
  skills: false,
  images: true,
  mcpInjection: 'launch',
  instructionInjection: 'system-append',
  usage: 'tokens',
  terminal: false,
  questions: true,
  context: true,
  accountUsage: true,
};

export class CodexAdapter implements AgentAdapter {
  readonly agent = 'codex' as const;
  /** StartSessionOptions.executable is honored (restart fallback onto the previous version, updates.md §5). */
  readonly acceptsExecutable = true;
  readonly #opts: CodexAdapterOptions;
  #resolvedPath: string | undefined;
  readonly #sessions = new Set<CodexSession>();

  constructor(opts: CodexAdapterOptions = {}) {
    this.#opts = opts;
  }

  capabilities(mode: SessionMode): AgentCapabilities {
    return mode === 'structured' ? CODEX_STRUCTURED_CAPABILITIES : { ...NO_CAPABILITIES };
  }

  #env(extra?: Record<string, string>): Record<string, string | undefined> {
    return { NO_COLOR: '1', ...process.env, ...this.#opts.env, ...extra };
  }

  async #codexPath(): Promise<string | undefined> {
    if (this.#resolvedPath) return this.#resolvedPath;
    const found = await findCodex({ codexPath: this.#opts.codexPath, env: this.#env() as NodeJS.ProcessEnv });
    if (found) this.#resolvedPath = found;
    return found;
  }

  async probe(): Promise<AgentProbe> {
    try {
      return await this.#probe();
    } catch (e) {
      return { agent: 'codex', installed: false, auth: 'unknown', notes: [`probe failed: ${(e as Error).message}`] };
    }
  }

  async #probe(): Promise<AgentProbe> {
    this.#resolvedPath = undefined;
    const path = await this.#codexPath();
    if (!path) {
      const notes = this.#opts.codexPath ? [`codex not found or not executable at ${this.#opts.codexPath}`] : ['codex not found'];
      return { agent: 'codex', installed: false, auth: 'unknown', notes };
    }
    const prefix = this.#opts.codexArgsPrefix ?? [];
    const env = this.#env() as NodeJS.ProcessEnv;
    const version = await codexVersion(path, env, prefix);
    if (!version) {
      // A shim or wrapper (e.g. a terminal app's CLI shim) can sit on PATH without a real codex behind it.
      return { agent: 'codex', installed: false, path, auth: 'unknown', notes: [`found ${path}, but \`codex --version\` failed`] };
    }
    const probe: AgentProbe = { agent: 'codex', installed: true, path, auth: 'unknown', version };
    const auth = await this.#readAccount(path);
    probe.auth = auth.auth;
    if (auth.account) probe.account = auth.account;
    if (auth.notes.length > 0) probe.notes = auth.notes;
    return probe;
  }

  /** Starts a throwaway app-server and asks `account/read`. */
  async #readAccount(path: string): Promise<{ auth: AgentProbe['auth']; account?: string; notes: string[] }> {
    const logger = this.#opts.logger ?? NOOP_LOGGER;
    const timeout = this.#opts.probeTimeoutMs ?? 15_000;
    let proc: AppServerProcess | undefined;
    try {
      proc = new AppServerProcess(
        {
          command: path,
          args: [...(this.#opts.codexArgsPrefix ?? []), 'app-server', ...(this.#opts.extraArgs ?? [])],
          env: this.#env(),
        },
        {
          onNotification: () => {},
          onRequest: (r) => proc?.rpc.respondError(r.id, { code: -32601, message: 'probe client' }),
        },
        logger,
      );
      const init: InitializeParams = {
        clientInfo: { name: 'bizzi', title: 'bizzi', version: ADAPTER_VERSION },
        capabilities: { experimentalApi: false, requestAttestation: false },
      };
      await proc.rpc.request('initialize', init, timeout);
      proc.rpc.notify('initialized');
      const acct = await proc.rpc.request<GetAccountResponse>('account/read', { refreshToken: false }, timeout);
      if (acct.account) {
        const a = acct.account;
        const account = a.type === 'chatgpt' ? (a.email ?? `ChatGPT ${a.planType}`) : a.type;
        const notes = a.type === 'chatgpt' ? [`plan: ${a.planType}`] : [];
        return { auth: 'ok', account, notes };
      }
      if (!acct.requiresOpenaiAuth) return { auth: 'ok', notes: ['configured model provider does not need OpenAI auth'] };
      return { auth: 'missing', notes: ['run `codex login`'] };
    } catch (e) {
      const exit = proc?.exitInfo;
      const why = exit ? describeExit(exit, proc?.stderrTail() ?? '') : (e as Error).message;
      return { auth: 'unknown', notes: [`could not read codex account: ${why}`] };
    } finally {
      await proc?.kill(500);
    }
  }

  async start(opts: StartSessionOptions, emit: EmitFn, ctx: AdapterContext): Promise<AdapterSession> {
    if (opts.mode !== 'structured') {
      throw new BizziError('unsupported', `the codex adapter only supports structured mode (got '${opts.mode}')`);
    }
    const logger = ctx.logger.child({ agent: 'codex', sessionId: opts.sessionId });
    let spawn: SpawnSpec;
    if (opts.launcher) {
      // Container workspaces (topology.md §7): the codex installed inside the target, not this machine's.
      spawn = opts.launcher.wrap({ command: 'codex', args: ['app-server', ...(this.#opts.extraArgs ?? [])], cwd: opts.cwd, env: this.#env(opts.env) });
      logger.log('info', 'starting codex through a launcher', { launcher: opts.launcher.label });
    } else {
      const path = opts.executable ?? (await this.#codexPath());
      if (!path) throw new BizziError('agent_unavailable', 'codex executable not found');
      if (opts.executable) logger.log('info', 'starting a pinned codex executable', { path });
      spawn = {
        command: path,
        args: [...(this.#opts.codexArgsPrefix ?? []), 'app-server', ...(this.#opts.extraArgs ?? [])],
        cwd: opts.cwd,
        env: this.#env(opts.env),
      };
    }
    const session = await CodexSession.start(
      {
        spawn,
        clientInfo: { name: 'bizzi', version: ADAPTER_VERSION },
        requestTimeoutMs: this.#opts.requestTimeoutMs ?? 60_000,
        interruptTimeoutMs: this.#opts.interruptTimeoutMs ?? 15_000,
      },
      opts,
      emit,
      logger,
    );
    this.#sessions.add(session);
    void session.exited.then(() => this.#sessions.delete(session));
    return session;
  }

  /** Stop every session this adapter started (node shutdown). Idempotent. */
  async dispose(): Promise<void> {
    const sessions = [...this.#sessions];
    this.#sessions.clear();
    await Promise.allSettled(sessions.map((s) => s.stop()));
  }
}

/** Entry point used by the CLI to discover adapters. */
export function createAdapters(options: CodexAdapterOptions = {}): AgentAdapter[] {
  return [new CodexAdapter(options)];
}
