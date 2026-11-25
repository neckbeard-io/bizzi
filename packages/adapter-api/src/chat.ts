// Provider-neutral chat: one streaming call to a model API in either wire format.

import type { ResolvedModel } from './config.ts';
import { ApiError, getJson, limiterFor, postJson, scrub, sseMessages, type HttpOptions } from './http.ts';
import * as anthropic from './anthropic.ts';
import * as openai from './openai.ts';

export type ChatPart = { type: 'text'; text: string } | { type: 'image'; mediaType: string; dataBase64: string };

export interface ChatMessage {
  role: 'user' | 'assistant';
  parts: ChatPart[];
  /**
   * The assistant's content blocks exactly as the Anthropic API returned them (thinking blocks with
   * their signatures), replayed unchanged when the next request goes to an Anthropic-format provider.
   */
  native?: { api: 'anthropic'; content: unknown[] };
}

export interface ChatRequest {
  system?: string;
  messages: ChatMessage[];
  /** Output cap; default from the model/provider config, discovery, or 16000 (anthropic only; openai omits it). */
  maxTokens?: number;
  /** anthropic: `output_config.effort`; openai: `reasoning_effort`. Passed through as given. */
  effort?: string;
  /** Extra request fields, merged last. */
  body?: Record<string, unknown>;
}

export interface TokenCounts {
  /** Uncached input. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type FinishReason = 'end' | 'max_tokens' | 'refusal' | 'other';

export interface ChatResult {
  text: string;
  reasoning: string;
  finish: FinishReason;
  /** The provider's own stop/finish reason. */
  finishRaw?: string;
  usage?: TokenCounts;
  /** Model id the provider reports. */
  model?: string;
  native?: ChatMessage['native'];
}

export type ChatDelta = { type: 'text'; text: string } | { type: 'reasoning'; text: string };

export interface ChatTarget extends ResolvedModel {
  apiKey?: string;
}

export interface ChatCallOptions extends HttpOptions {
  signal?: AbortSignal;
  onDelta?: (d: ChatDelta) => void;
}

/** What a wire module produces for one request. */
export interface WireRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Folds a wire format's SSE messages into deltas and a result. */
export interface WireParser {
  /** Returns true when the stream is complete (OpenAI's `[DONE]`). */
  push(event: string | undefined, data: string): boolean;
  result(): ChatResult;
}

export function authHeaders(t: ChatTarget): Record<string, string> {
  const h: Record<string, string> = {};
  if (t.apiKey) {
    const mode = t.provider.auth ?? (t.provider.api === 'anthropic' ? 'x-api-key' : 'bearer');
    if (mode === 'x-api-key') h['x-api-key'] = t.apiKey;
    else h.authorization = `Bearer ${t.apiKey}`;
  }
  return h;
}

/** Discovered limits per provider + model (from its models endpoint), kept for the process lifetime. */
export interface ModelLimits {
  contextWindow?: number;
  maxOutputTokens?: number;
}

const discovered = new Map<string, Promise<ModelLimits>>();

/** Context window and output cap for the target: config first, then (once) the provider's models endpoint. */
export async function modelLimits(t: ChatTarget, o: HttpOptions = {}): Promise<ModelLimits> {
  const fromConfig: ModelLimits = {};
  const cw = t.spec?.contextWindow ?? t.provider.contextWindow;
  const mo = t.spec?.maxOutputTokens ?? t.provider.maxOutputTokens;
  if (cw) fromConfig.contextWindow = cw;
  if (mo) fromConfig.maxOutputTokens = mo;
  if ((cw && mo) || t.provider.discover === false) return fromConfig;
  const key = `${t.providerId}\u0000${t.provider.baseUrl}\u0000${t.model}`;
  let p = discovered.get(key);
  if (!p) {
    p = discover(t, o);
    discovered.set(key, p);
  }
  const d = await p;
  return { ...d, ...fromConfig };
}

/** Forget discovered limits (tests). */
export function clearDiscovered(): void {
  discovered.clear();
}

async function discover(t: ChatTarget, o: HttpOptions): Promise<ModelLimits> {
  const headers = { ...t.provider.headers, ...authHeaders(t) };
  const fetchOpts = o.fetch ? { fetch: o.fetch } : {};
  if (t.provider.api === 'anthropic') {
    const j = (await getJson(`${t.provider.baseUrl}/models/${encodeURIComponent(t.model)}`, { 'anthropic-version': anthropic.API_VERSION, ...headers }, fetchOpts)) as
      | { max_input_tokens?: unknown; max_tokens?: unknown }
      | undefined;
    return limits(j?.max_input_tokens, j?.max_tokens);
  }
  const j = (await getJson(`${t.provider.baseUrl}/models`, headers, fetchOpts)) as { data?: unknown } | undefined;
  const m = Array.isArray(j?.data) ? (j.data as Record<string, unknown>[]).find((x) => x && x.id === t.model) : undefined;
  if (!m) return {};
  const top = m.top_provider as { max_completion_tokens?: unknown; context_length?: unknown } | undefined;
  // vLLM: max_model_len · OpenRouter: context_length, top_provider.max_completion_tokens · others: context_window.
  return limits(m.max_model_len ?? m.context_length ?? m.context_window ?? top?.context_length, top?.max_completion_tokens);
}

function limits(window: unknown, out: unknown): ModelLimits {
  const r: ModelLimits = {};
  if (typeof window === 'number' && window > 0) r.contextWindow = window;
  if (typeof out === 'number' && out > 0) r.maxOutputTokens = out;
  return r;
}

/**
 * One streaming request. Resolves with the whole result; deltas go to `onDelta` as they arrive. Throws
 * ApiError on HTTP or stream errors, and the abort reason when `signal` aborts.
 */
export async function streamChat(t: ChatTarget, req: ChatRequest, o: ChatCallOptions = {}): Promise<ChatResult> {
  const wire = t.provider.api === 'anthropic' ? anthropic : openai;
  const http: HttpOptions = { ...o, secrets: [...(o.secrets ?? []), ...(t.apiKey ? [t.apiKey] : [])] };
  const lim = await modelLimits(t, http);
  const request = wire.buildRequest(t, req, lim);
  const release = await limiterFor(t.providerId, t.provider.maxConcurrent)?.acquire(o.signal);
  try {
    const res = await postJson(request.url, request.headers, request.body, o.signal, http);
    const parser = wire.createParser(o.onDelta);
    let complete = false;
    for await (const m of sseMessages(res, o.signal, http)) {
      if (parser.push(m.event, m.data)) {
        complete = true;
        break;
      }
    }
    const result = parser.result();
    if (!complete && !result.finishRaw) throw new ApiError('stream ended before the response was complete');
    return result;
  } catch (err) {
    // Stream error events carry the provider's text, which may echo the key.
    if (err instanceof ApiError) throw new ApiError(scrub(err.message, http.secrets), err.status, err.type);
    throw err;
  } finally {
    release?.();
  }
}
