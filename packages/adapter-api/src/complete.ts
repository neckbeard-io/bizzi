// Utility completions (spec §6.5 item 1): one-shot calls for session titles, handoff briefs, memory
// extraction and review passes, outside any session. Uses the same providers as API chat sessions;
// the model defaults to `utilityModel` (then `defaultModel`) from api-providers.json.

import { BizziError, type BillingClass, type Logger, type StopReason, type Usage } from '@bizzi/protocol';
import { streamChat, type ChatMessage, type ChatTarget } from './chat.ts';
import { ConfigSource, resolveApiKey, resolveModel, type ApiConfigFile } from './config.ts';
import { ApiError, type HttpOptions } from './http.ts';
import { toUsage } from './usage.ts';

export interface CompleteRequest {
  /** `provider/model`; default the configured utility model. */
  model?: string;
  system?: string;
  /** A single user message; or pass `messages`. */
  prompt?: string;
  messages?: ChatMessage[];
  maxTokens?: number;
  effort?: string;
  body?: Record<string, unknown>;
  signal?: AbortSignal;
  /** Whole call, including retries (default 120 s). */
  timeoutMs?: number;
}

export interface CompleteResult {
  text: string;
  /** `provider/model`. */
  model: string;
  billing: BillingClass;
  stopReason: StopReason;
  usage?: Usage;
}

export interface UtilityOptions extends HttpOptions {
  /** The node's data dir, for `api-providers.json`. */
  dataDir?: string;
  configPath?: string;
  config?: ApiConfigFile;
  /** Where keys come from: e.g. the node's secrets for agent `api`, then its environment. Default: process.env. */
  key?: (name: string) => string | undefined | Promise<string | undefined>;
  logger?: Logger;
}

export interface UtilityCompleter {
  /** The `provider/model` utility calls use by default, or undefined when none is configured. */
  defaultModel(): string | undefined;
  complete(req: CompleteRequest): Promise<CompleteResult>;
}

export function stopReasonOf(finish: string): StopReason {
  return finish === 'end' ? 'end_turn' : finish === 'refusal' ? 'refusal' : 'other';
}

/**
 * Build a completer. Errors are BizziErrors: `bad_request` (unknown model), `agent_unavailable` (no
 * key, provider error or timeout). Keys never appear in errors or logs.
 */
export function createUtilityCompleter(opts: UtilityOptions = {}): UtilityCompleter {
  const source = new ConfigSource({
    ...(opts.dataDir ? { dataDir: opts.dataDir } : {}),
    ...(opts.configPath ? { path: opts.configPath } : {}),
    ...(opts.config ? { inline: opts.config } : {}),
  });
  const keyOf = opts.key ?? ((name: string) => process.env[name]);
  return {
    defaultModel() {
      const loaded = source.get();
      try {
        return resolveModel(loaded, loaded.config.utilityModel).ref;
      } catch {
        return undefined;
      }
    },
    async complete(req) {
      const loaded = source.get();
      const resolved = resolveModel(loaded, req.model ?? loaded.config.utilityModel);
      const envName = resolved.provider.apiKeyEnv;
      const env: Record<string, string | undefined> = envName ? { [envName]: await keyOf(envName) } : {};
      const apiKey = resolveApiKey(resolved.providerId, resolved.provider, env);
      const target: ChatTarget = apiKey ? { ...resolved, apiKey } : resolved;
      const messages: ChatMessage[] = req.messages ?? (req.prompt !== undefined ? [{ role: 'user', parts: [{ type: 'text', text: req.prompt }] }] : []);
      if (messages.length === 0) throw new BizziError('bad_request', 'prompt or messages is required');
      const timeout = AbortSignal.timeout(req.timeoutMs ?? 120_000);
      const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
      const t0 = performance.now();
      try {
        const r = await streamChat(
          target,
          {
            messages,
            ...(req.system ? { system: req.system } : {}),
            ...(req.maxTokens ? { maxTokens: req.maxTokens } : {}),
            ...(req.effort ? { effort: req.effort } : {}),
            ...(req.body ? { body: req.body } : {}),
          },
          { ...opts, signal },
        );
        const out: CompleteResult = {
          text: r.text,
          model: resolved.ref,
          billing: resolved.provider.billing ?? 'metered',
          stopReason: stopReasonOf(r.finish),
        };
        if (r.usage) out.usage = toUsage(r.usage, resolved.spec?.price);
        opts.logger?.log('debug', 'utility completion', { model: resolved.ref, ms: Math.round(performance.now() - t0), outputTokens: r.usage?.output });
        return out;
      } catch (err) {
        if (req.signal?.aborted) throw req.signal.reason ?? err;
        if (timeout.aborted) throw new BizziError('agent_unavailable', `${resolved.ref} did not answer within ${Math.round((req.timeoutMs ?? 120_000) / 1000)} s`);
        if (err instanceof ApiError) throw new BizziError('agent_unavailable', `${resolved.ref}: ${err.message}`, err.status ? { status: err.status } : undefined);
        throw err;
      }
    },
  };
}
