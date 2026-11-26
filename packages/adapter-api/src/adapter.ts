// The `api` agent (spec §6.5 item 1, §6.7 "API chat"): a structured session with a plain model API and
// no tools. Streams text, reports token usage and context, interrupts by aborting the request.

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
  type ModelOption,
  type SessionMode,
  type StartSessionOptions,
} from '@bizzi/protocol';
import * as anthropic from './anthropic.ts';
import { authHeaders } from './chat.ts';
import { ConfigSource, defaultModelRef, hasPricing, listedModels, modelSpecs, resolveApiKey, resolveModel, type ApiConfigFile, type ProviderSpec } from './config.ts';
import { getJson, type HttpOptions } from './http.ts';
import { ApiChatSession } from './session.ts';
import { isTranscriptRef, TranscriptStore, type Transcript } from './transcript.ts';
import { approxTokens } from './usage.ts';

export interface ApiAdapterOptions extends HttpOptions {
  /** The node's data dir: `api-providers.json` and the transcripts (`api-chat/`) live here. */
  dataDir?: string;
  /** Config file path (default `<dataDir>/api-providers.json`). */
  configPath?: string;
  /** Inline config merged over the file (tests, embedding). */
  config?: ApiConfigFile;
  /** The node's environment, where keys are found when the session's secrets don't have them. Default process.env. */
  env?: Readonly<Record<string, string | undefined>>;
  logger?: Logger;
}

/** Effort names passed through to the provider (anthropic `output_config.effort`, openai `reasoning_effort`). */
export const API_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export class ApiChatAdapter implements AgentAdapter {
  readonly agent = 'api' as const;
  readonly options: ApiAdapterOptions;
  readonly config: ConfigSource;
  readonly transcripts: TranscriptStore;
  #sessions = new Set<ApiChatSession>();

  constructor(options: ApiAdapterOptions = {}) {
    this.options = options;
    this.config = new ConfigSource({
      ...(options.dataDir ? { dataDir: options.dataDir } : {}),
      ...(options.configPath ? { path: options.configPath } : {}),
      ...(options.config ? { inline: options.config } : {}),
    });
    this.transcripts = new TranscriptStore(options.dataDir);
  }

  get #env(): Readonly<Record<string, string | undefined>> {
    return this.options.env ?? process.env;
  }

  async probe(): Promise<AgentProbe> {
    const loaded = this.config.get();
    const notes = [...loaded.errors];
    const providers = Object.entries(loaded.config.providers);
    // Session secrets aren't visible here, only the node's environment: a provider without a key in it
    // may still work once its secret is stored for agent "api".
    const ready = providers.filter(([, p]) => !p.apiKeyEnv || this.#env[p.apiKeyEnv]).map(([id]) => id);
    notes.push(`providers: ${providers.map(([id]) => id).join(', ') || 'none'}`);
    if (ready.length < providers.length) {
      notes.push('keys are read from secrets stored for agent "api" (agent.setSecret) or the node environment');
    }
    const def = defaultModelRef(loaded);
    if (def) notes.push(`default model: ${def}`);
    const probe: AgentProbe = { agent: 'api', installed: providers.length > 0, auth: ready.length > 0 ? 'ok' : 'unknown', notes };
    if (def) {
      try {
        probe.billing = resolveModel(loaded, def).provider.billing ?? 'metered';
      } catch {
        // an invalid default is reported when a session uses it
      }
    }
    return probe;
  }

  /**
   * `provider/model` for every provider: its configured models, else (unless `discover: false`) its
   * models endpoint. A provider that can't be reached or has no key is left out.
   */
  async listModels(ctx: { env?: Record<string, string> } = {}): Promise<ModelOption[]> {
    const loaded = this.config.get();
    const env = { ...this.#env, ...ctx.env };
    const def = defaultModelRef(loaded);
    const perProvider = await Promise.all(
      Object.entries(loaded.config.providers).map(async ([providerId, provider]): Promise<ModelOption[]> => {
        const specs = modelSpecs(provider);
        if (specs.length) return specs.map((m) => ({ id: `${providerId}/${m.id}` }));
        if (provider.discover === false) return [];
        let apiKey: string | undefined;
        try {
          apiKey = resolveApiKey(providerId, provider, env);
        } catch {
          return [];
        }
        return (await this.#discoverModels(providerId, provider, apiKey)).map((m) => ({ ...m, id: `${providerId}/${m.id}` }));
      }),
    );
    return perProvider.flat().map((m) => (m.id === def ? { ...m, isDefault: true } : m));
  }

  async #discoverModels(providerId: string, provider: ProviderSpec, apiKey: string | undefined): Promise<ModelOption[]> {
    const headers = { ...provider.headers, ...authHeaders({ providerId, provider, model: '', ref: '', ...(apiKey ? { apiKey } : {}) }) };
    const fetchOpts = this.options.fetch ? { fetch: this.options.fetch } : {};
    const anthropicApi = provider.api === 'anthropic';
    const url = `${provider.baseUrl}/models${anthropicApi ? '?limit=1000' : ''}`;
    const j = (await getJson(url, anthropicApi ? { 'anthropic-version': anthropic.API_VERSION, ...headers } : headers, fetchOpts)) as { data?: unknown } | undefined;
    if (!Array.isArray(j?.data)) return [];
    const out: ModelOption[] = [];
    for (const m of j.data as Record<string, unknown>[]) {
      if (!m || typeof m.id !== 'string' || !m.id) continue;
      const label = typeof m.display_name === 'string' ? m.display_name : typeof m.name === 'string' ? m.name : undefined;
      out.push(label && label !== m.id ? { id: m.id, label } : { id: m.id });
    }
    return out;
  }

  capabilities(mode: SessionMode): AgentCapabilities {
    if (mode !== 'structured') return { ...NO_CAPABILITIES };
    const { config } = this.config.get();
    return {
      ...NO_CAPABILITIES,
      modes: ['structured'],
      streaming: 'token',
      interrupt: true,
      fork: true,
      resume: true,
      // Transcripts survive a node restart only on disk.
      resumeAfterNodeRestart: this.transcripts.persistent,
      models: listedModels(config) ?? 'dynamic',
      setModelMidSession: true,
      effort: API_EFFORTS,
      images: true,
      instructionInjection: 'system-append',
      usage: hasPricing(config) ? 'tokens+cost' : 'tokens',
      context: true,
      accountUsage: true,
    };
  }

  async start(opts: StartSessionOptions, emit: EmitFn, ctx: AdapterContext): Promise<AdapterSession> {
    if (opts.mode !== 'structured') throw new BizziError('unsupported', 'API chat only has structured sessions');
    const log = ctx.logger.child({ adapter: 'api', sessionId: opts.sessionId });
    const loaded = this.config.get();
    const resolve = (model: string | undefined) => resolveModel(this.config.get(), model);

    let transcript: Transcript;
    let ref: string;
    if (opts.resumeRef) {
      const source = this.#load(opts.resumeRef);
      if (opts.fork) {
        ref = this.#newRef(opts.sessionId);
        transcript = structuredClone(source);
      } else {
        ref = opts.resumeRef;
        transcript = source;
      }
    } else {
      ref = this.#newRef(opts.sessionId);
      transcript = { version: 1, messages: [] };
    }
    if (opts.model) transcript.model = opts.model;
    if (opts.effort) transcript.effort = opts.effort;
    const resolved = resolve(transcript.model);
    transcript.model = resolved.ref;

    const env = { ...this.#env, ...opts.env };
    // Fail at start, not on the first message, when the key is missing.
    resolveApiKey(resolved.providerId, resolved.provider, env);

    let session: ApiChatSession | undefined = undefined;
    const system = opts.systemPromptAppend?.trim() || undefined;
    session = new ApiChatSession({
      ref,
      emit,
      logger: log,
      store: this.transcripts,
      transcript,
      resolve,
      env,
      http: this.#http(),
      cwd: opts.cwd,
      ...(system ? { system } : {}),
      bizziTokens: approxTokens(system),
      onStop: () => {
        if (session) this.#sessions.delete(session);
      },
    });
    this.#sessions.add(session);
    this.transcripts.save(ref, transcript);
    session.target();
    const info: { agentSessionRef: string; model: string; effort?: string } = { agentSessionRef: ref, model: resolved.ref };
    if (transcript.effort) info.effort = transcript.effort;
    emit({ type: 'session.info', data: info });
    if (loaded.errors.length) log.log('warn', 'api-providers.json has problems', { errors: loaded.errors });
    log.log('info', 'api chat session started', {
      ref,
      model: resolved.ref,
      baseUrl: resolved.provider.baseUrl,
      resumed: Boolean(opts.resumeRef && !opts.fork),
      forkedFrom: opts.fork ? opts.resumeRef : undefined,
      messages: transcript.messages.length,
    });
    return session;
  }

  #load(ref: string): Transcript {
    let t: Transcript | undefined;
    try {
      t = this.transcripts.load(ref);
    } catch (err) {
      throw new BizziError('internal', `API chat transcript ${ref} is unreadable: ${(err as Error).message}`);
    }
    if (!t) throw new BizziError('not_found', `API chat conversation ${ref} not found`);
    return t;
  }

  /** The session id when it is free, otherwise a suffixed one (a fork of a fork starting twice, say). */
  #newRef(sessionId: string): string {
    const base = isTranscriptRef(sessionId) ? sessionId : `api_${Date.now().toString(36)}`;
    let ref = base;
    for (let i = 2; this.#exists(ref); i++) ref = `${base}-${i}`;
    return ref;
  }

  #exists(ref: string): boolean {
    try {
      return this.transcripts.load(ref) !== undefined;
    } catch {
      return true;
    }
  }

  #http(): HttpOptions {
    const o = this.options;
    const h: HttpOptions = {};
    if (o.fetch) h.fetch = o.fetch;
    if (o.maxRetries !== undefined) h.maxRetries = o.maxRetries;
    if (o.retryBaseMs !== undefined) h.retryBaseMs = o.retryBaseMs;
    if (o.timeoutMs !== undefined) h.timeoutMs = o.timeoutMs;
    if (o.idleTimeoutMs !== undefined) h.idleTimeoutMs = o.idleTimeoutMs;
    return h;
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.#sessions].map((s) => s.stop().catch(() => undefined)));
  }
}
