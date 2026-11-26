import { realpath } from 'node:fs/promises';
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
  type McpServerSpec,
  type ModelOption,
  type SessionMode,
  type StartSessionOptions,
} from '@bizzi/protocol';
import { OpenCodeHttpError, type OpenCodeClient } from './client.ts';
import { formatModel, parseModel, usageOf } from './mapping.ts';
import { approxTokens } from './context.ts';
import { probeOpenCode } from './probe.ts';
import { OpenCodeServer } from './server.ts';
import { OpenCodeSession } from './session.ts';
import type { McpConfig, ModelInfo, ModelRef, PermissionRule, SessionInfo } from './types.ts';

export interface OpenCodeAdapterOptions {
  /** `opencode` executable (default "opencode" on PATH). */
  binary?: string;
  /** Hostname for the private server (default 127.0.0.1). */
  hostname?: string;
  /** Port for the private server (default 0 = ephemeral). */
  port?: number;
  /** Extra environment for the private server (e.g. XDG_DATA_HOME to isolate its database). */
  env?: Record<string, string>;
  /** Attach to an existing v2 server instead of spawning one (no lifecycle management). */
  serverUrl?: string;
  /** Basic-auth password for `serverUrl` (username "opencode"). */
  serverPassword?: string;
  /** Replace the server launch command (tests). It must print "server listening on <url>". */
  serverCommand?: string[];
  /** Agent used when a session has no permissionMode (default: the server's default agent, "build"). */
  defaultAgent?: string;
  /** Extra permission rules attached to every session created by bizzi (evaluated after config). */
  permissions?: PermissionRule[];
  /**
   * Let the agent call OpenCode's `question` tool (default true). Questions surface as
   * `question.asked` and are answered through `respondQuestion`. `false` adds a deny rule.
   */
  allowQuestions?: boolean;
  /** Waits between re-asks while a fresh server's model list is still empty (tests shorten it). */
  modelListRetryMs?: number[];
  /** Stop the private server this long after the last session stops (default 10 min; 0 = never). */
  idleShutdownMs?: number;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  healthIntervalMs?: number;
  maxRestarts?: number;
  restartWindowMs?: number;
  restartBackoffMs?: number;
  /** How long to wait for the server to confirm an interrupt before closing the turn anyway. */
  interruptFallbackMs?: number;
  probeTimeoutMs?: number;
  /** Logger for server lifecycle and probe (sessions use the per-session context logger). */
  logger?: Logger;
}

const noopLogger: Logger = {
  log() {},
  child() {
    return noopLogger;
  },
};

/** OpenCode primary agents shipped by default; any other primary agent name is accepted too. */
export const OPENCODE_PERMISSION_MODES = ['build', 'plan'];
/** An OpenCode model row as a ModelOption; its variants are the effort levels. */
export function toModelOption(m: ModelInfo): ModelOption {
  const out: ModelOption = { id: formatModel({ providerID: m.providerID, id: m.id }) };
  if (m.name && m.name !== m.id) out.label = m.name;
  const efforts = (m.variants ?? []).map((v) => v.id).filter((v) => v && v !== 'default');
  if (efforts.length) out.efforts = efforts;
  return out;
}

/** Model variants OpenCode ships for reasoning models; the actual set depends on the model. */
export const OPENCODE_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export const OPENCODE_CAPABILITIES: AgentCapabilities = {
  ...NO_CAPABILITIES,
  modes: ['structured'],
  streaming: 'token',
  steer: true,
  interrupt: true,
  fork: true,
  resume: true,
  resumeAfterNodeRestart: true,
  approvals: 'per-tool',
  editableApprovals: false,
  permissionModes: OPENCODE_PERMISSION_MODES,
  models: 'dynamic',
  setModelMidSession: true,
  effort: OPENCODE_EFFORTS,
  planMode: true,
  todos: false,
  subagents: true,
  slashCommands: false,
  skills: false,
  images: true,
  mcpInjection: 'launch',
  instructionInjection: 'system-append',
  usage: 'tokens+cost',
  terminal: false,
  questions: true,
  context: true,
  // No per-login identity or window data through `opencode serve`; spend stays in usage.updated.
  accountUsage: false,
};

/** Runtime MCP registrations, shared per (directory, name) between sessions. */
class McpRegistry {
  #entries = new Map<string, { dir: string; name: string; json: string; config: McpConfig; owners: Set<string> }>();

  async acquire(client: OpenCodeClient, dir: string, name: string, spec: McpServerSpec, owner: string): Promise<string> {
    const config = toMcpConfig(spec);
    const json = JSON.stringify(config);
    let finalName = name;
    const existing = this.#entries.get(key(dir, name));
    if (existing && existing.json !== json) finalName = `${name}-${owner.slice(-6).toLowerCase()}`;
    const k = key(dir, finalName);
    const entry = this.#entries.get(k);
    if (entry && entry.json === json) {
      entry.owners.add(owner);
      return finalName;
    }
    await client.addMcp(finalName, config, { directory: dir });
    this.#entries.set(k, { dir, name: finalName, json, config, owners: new Set([owner]) });
    return finalName;
  }

  async release(client: OpenCodeClient | undefined, owner: string): Promise<void> {
    for (const [k, e] of this.#entries) {
      if (!e.owners.delete(owner) || e.owners.size) continue;
      this.#entries.delete(k);
      if (client) await client.removeMcp(e.name, { directory: e.dir }).catch(() => undefined);
    }
  }

  /** Re-register everything for `owner` (after the server restarted and lost runtime state). */
  async reapply(client: OpenCodeClient, owner: string): Promise<void> {
    for (const e of this.#entries.values()) {
      if (e.owners.has(owner)) await client.addMcp(e.name, e.config, { directory: e.dir });
    }
  }
}

function key(dir: string, name: string): string {
  return `${dir}\u0000${name}`;
}

function toMcpConfig(spec: McpServerSpec): McpConfig {
  if (spec.type === 'stdio') {
    const c: McpConfig = { type: 'local', command: [spec.command, ...(spec.args ?? [])] };
    if (spec.env) c.environment = spec.env;
    return c;
  }
  const c: McpConfig = { type: 'remote', url: spec.url, oauth: false };
  if (spec.headers) c.headers = spec.headers;
  return c;
}

export class OpenCodeAdapter implements AgentAdapter {
  readonly agent = 'opencode' as const;
  readonly options: OpenCodeAdapterOptions;
  readonly server: OpenCodeServer;
  /**
   * One server serves every session (updates.md §3): the private one is bizzi's to restart onto a
   * new version (`recycle`); a `serverUrl` server is someone else's.
   */
  readonly sharedProcess: 'owned' | 'external';
  #mcp = new McpRegistry();
  #sessions = new Set<OpenCodeSession>();
  #idleTimer: NodeJS.Timeout | undefined;

  constructor(options: OpenCodeAdapterOptions = {}) {
    this.options = options;
    this.sharedProcess = options.serverUrl ? 'external' : 'owned';
    this.server = new OpenCodeServer({
      binary: options.binary ?? 'opencode',
      hostname: options.hostname ?? '127.0.0.1',
      port: options.port ?? 0,
      env: options.env,
      command: options.serverCommand,
      url: options.serverUrl,
      password: options.serverPassword,
      startupTimeoutMs: options.startupTimeoutMs ?? 30_000,
      requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
      healthIntervalMs: options.healthIntervalMs ?? 15_000,
      maxRestarts: options.maxRestarts ?? 5,
      restartWindowMs: options.restartWindowMs ?? 5 * 60_000,
      restartBackoffMs: options.restartBackoffMs ?? 500,
      logger: options.logger ?? noopLogger,
    });
  }

  probe(): Promise<AgentProbe> {
    return probeOpenCode({
      binary: this.options.binary ?? 'opencode',
      env: this.options.env,
      timeoutMs: this.options.probeTimeoutMs ?? 20_000,
      ...(this.options.serverUrl ? { server: { url: this.options.serverUrl, password: this.options.serverPassword } } : {}),
    }).catch((err: unknown) => ({ agent: 'opencode' as const, installed: false, auth: 'unknown' as const, notes: [String(err)] }));
  }

  capabilities(mode: SessionMode): AgentCapabilities {
    return mode === 'structured' ? OPENCODE_CAPABILITIES : { ...NO_CAPABILITIES };
  }

  async start(opts: StartSessionOptions, emit: EmitFn, ctx: AdapterContext): Promise<AdapterSession> {
    if (opts.mode !== 'structured') {
      throw new BizziError('unsupported', 'the OpenCode adapter only supports structured mode (use the pty adapter for the TUI)');
    }
    if (opts.launcher) {
      // One `opencode serve` per node, reached over HTTP: it can't run inside a container workspace yet.
      throw new BizziError('unsupported', `OpenCode sessions can't run in ${opts.launcher.label} yet; use a terminal session instead`);
    }
    const log = ctx.logger.child({ adapter: 'opencode', sessionId: opts.sessionId });
    clearTimeout(this.#idleTimer);
    let client: OpenCodeClient;
    try {
      client = await this.server.ensure();
    } catch (err) {
      throw new BizziError('agent_unavailable', `could not start opencode serve: ${String(err)}`);
    }
    const directory = await realpath(opts.cwd).catch(() => opts.cwd);
    let model: ModelRef | undefined;
    try {
      model = opts.model ? parseModel(opts.model, opts.effort) : undefined;
    } catch (err) {
      throw new BizziError('bad_request', String(err instanceof Error ? err.message : err));
    }

    const permissions = [...(this.options.permissions ?? [])];
    if (this.options.allowQuestions === false) permissions.push({ action: 'question', resource: '*', effect: 'deny' });

    let info: SessionInfo;
    if (opts.resumeRef) {
      const notFound = (err: unknown): never => {
        if (err instanceof OpenCodeHttpError && (err.status === 404 || err.status === 400)) {
          throw new BizziError('not_found', `OpenCode session ${opts.resumeRef} not found`);
        }
        throw err;
      };
      info = await client.getSession(opts.resumeRef).catch(notFound);
      if (opts.fork) {
        // A new OpenCode session with a copy of the conversation. The fork keeps location and
        // model but not the agent or the session's permission rules, so carry those over.
        const source = info;
        info = await client.forkSession(source.id).catch(notFound);
        if (permissions.length) await client.updateSession(info.id, { permissions });
        const agent = opts.permissionMode ?? source.agent;
        if (agent && agent !== info.agent) await client.switchAgent(info.id, agent);
        info = { ...info, agent, model: info.model ?? source.model };
      } else if (opts.permissionMode && opts.permissionMode !== info.agent) {
        await client.switchAgent(info.id, opts.permissionMode);
      }
      if (model) await client.switchModel(info.id, model);
    } else {
      info = await client.createSession({
        location: { directory },
        agent: opts.permissionMode ?? this.options.defaultAgent,
        model,
        metadata: { bizziSessionId: opts.sessionId },
        ...(permissions.length ? { permissions } : {}),
      });
      if (!model && opts.effort && info.model) {
        await client.switchModel(info.id, { ...info.model, variant: opts.effort });
        model = { ...info.model, variant: opts.effort };
      }
    }
    const ref = info.id;
    const agent = opts.permissionMode ?? info.agent;
    model ??= info.model;
    const contextWindow = await this.#contextWindow(client, directory, model);

    const reapply = async (): Promise<void> => {
      const c = await this.server.ensure();
      if (opts.systemPromptAppend) await c.putInstruction(ref, 'bizzi', opts.systemPromptAppend);
      if (opts.env && Object.keys(opts.env).length) await c.setEnvironment(ref, opts.env);
      await this.#mcp.reapply(c, ref);
    };

    let session: OpenCodeSession | undefined = undefined;
    const onStop = async (): Promise<void> => {
      if (session) this.#sessions.delete(session);
      await this.#mcp.release(this.server.client, ref);
      this.#scheduleIdleShutdown();
    };
    session = new OpenCodeSession({
      server: this.server,
      ref,
      directory,
      emit,
      logger: log,
      model,
      agent,
      contextWindow,
      reapply,
      onStop,
      initialUsage: info.cost || info.tokens?.input || info.tokens?.output ? usageOf(info.tokens, info.cost) : undefined,
      // MCP tool schemas aren't reported by the server, so only the instructions are counted.
      bizziTokens: approxTokens(opts.systemPromptAppend),
      interruptFallbackMs: this.options.interruptFallbackMs ?? 5_000,
    });
    this.#sessions.add(session);

    // Injection: instructions, environment, MCP. Experimental server APIs; failures are reported
    // to the session but don't prevent it from running.
    const warn = (what: string, err: unknown): void => {
      log.log('warn', `opencode ${what} failed`, { err: String(err) });
      emit({ type: 'error', data: { message: `OpenCode ${what} failed: ${String(err instanceof Error ? err.message : err)}`, code: 'injection_failed' } });
    };
    if (opts.systemPromptAppend) {
      await client.putInstruction(ref, 'bizzi', opts.systemPromptAppend).catch((err: unknown) => warn('instruction injection', err));
    }
    if (opts.env && Object.keys(opts.env).length) {
      await client.setEnvironment(ref, opts.env).catch((err: unknown) => warn('session environment', err));
    }
    for (const [name, spec] of Object.entries(opts.mcpServers ?? {})) {
      await this.#mcp.acquire(client, directory, name, spec, ref).catch((err: unknown) => warn(`MCP server "${name}" injection`, err));
    }

    const sessionInfo: { agentSessionRef: string; model?: string; permissionMode?: string; effort?: string; title?: string } = {
      agentSessionRef: ref,
    };
    if (model) sessionInfo.model = formatModel(model);
    if (model?.variant && model.variant !== 'default') sessionInfo.effort = model.variant;
    if (agent) sessionInfo.permissionMode = agent;
    if (info.title) sessionInfo.title = info.title;
    emit({ type: 'session.info', data: sessionInfo });
    if (info.cost || info.tokens?.input || info.tokens?.output) {
      const usage = usageOf(info.tokens, info.cost);
      if (contextWindow) usage.contextWindow = contextWindow;
      emit({ type: 'usage.updated', data: usage });
    }
    log.log('info', 'opencode session started', { ref, directory, resumed: Boolean(opts.resumeRef), forkedFrom: opts.fork ? opts.resumeRef : undefined });
    return session;
  }

  /** The enabled models of the configured providers, as `provider/model` (what `model` takes). */
  async listModels(): Promise<ModelOption[]> {
    clearTimeout(this.#idleTimer);
    try {
      const client = await this.server.ensure();
      // A freshly started server loads its model catalog in the background and answers [] until then.
      const waits = this.options.modelListRetryMs ?? [250, 500, 1000, 1500, 2000];
      let models = await client.models();
      for (const ms of waits) {
        if (models.length) break;
        await new Promise((r) => setTimeout(r, ms));
        models = await client.models();
      }
      return models.filter((m) => m.enabled !== false).map((m) => toModelOption(m));
    } finally {
      this.#scheduleIdleShutdown();
    }
  }

  async #contextWindow(client: OpenCodeClient, directory: string, model: ModelRef | undefined): Promise<number | undefined> {
    if (!model) return undefined;
    const models = await client.models({ directory }).catch(() => undefined);
    return models?.find((m) => m.providerID === model.providerID && m.id === model.id)?.limit?.context;
  }

  #scheduleIdleShutdown(): void {
    clearTimeout(this.#idleTimer);
    const ms = this.options.idleShutdownMs ?? 10 * 60_000;
    if (this.#sessions.size || ms <= 0 || this.options.serverUrl) return;
    this.#idleTimer = setTimeout(() => {
      if (!this.#sessions.size) void this.server.stop();
    }, ms);
    this.#idleTimer.unref();
  }

  /**
   * Stop the private server so the next session start spawns the installed `opencode` (updates.md
   * §3, §5). The core calls it once it has stopped every session on the server; sessions resume
   * from OpenCode's database on the new one.
   */
  async recycle(): Promise<void> {
    if (this.options.serverUrl) throw new BizziError('unsupported', 'attached to an OpenCode server bizzi did not start; restart it there');
    if (this.#sessions.size) throw new BizziError('conflict', `${this.#sessions.size} OpenCode session(s) still run on the server`);
    clearTimeout(this.#idleTimer);
    const was = this.server.version;
    await this.server.stop();
    this.options.logger?.log('info', 'opencode server stopped for a restart onto the installed version', { version: was });
  }

  /** Stop every session and the private server. */
  async dispose(): Promise<void> {
    clearTimeout(this.#idleTimer);
    await Promise.all([...this.#sessions].map((s) => s.stop().catch(() => undefined)));
    await this.server.stop();
  }
}
