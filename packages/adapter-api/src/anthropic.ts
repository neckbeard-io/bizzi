// Anthropic Messages API (`POST /v1/messages`, `stream: true`).
// Events: message_start (usage), content_block_start/delta/stop (text, thinking, signature),
// message_delta (stop_reason, cumulative output usage), message_stop, ping, error.

import type { ChatDelta, ChatMessage, ChatRequest, ChatResult, ChatTarget, FinishReason, TokenCounts, WireParser, WireRequest } from './chat.ts';
import { authHeaders, type ModelLimits } from './chat.ts';
import { ApiError } from './http.ts';

export const API_VERSION = '2023-06-01';
/** Output cap when neither config nor discovery gives one. */
export const DEFAULT_MAX_TOKENS = 16_000;
/** Cap on a discovered output limit, so a 128k-output model doesn't reserve all of it by default. */
export const DISCOVERED_MAX_TOKENS_CAP = 32_000;

type Block = Record<string, unknown>;

function contentOf(m: ChatMessage): unknown[] {
  if (m.role === 'assistant' && m.native?.api === 'anthropic') return m.native.content;
  const out: Block[] = [];
  for (const p of m.parts) {
    if (p.type === 'text') {
      if (p.text) out.push({ type: 'text', text: p.text });
    } else {
      out.push({ type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.dataBase64 } });
    }
  }
  return out;
}

/** Messages for the API: empty turns dropped, consecutive turns of one role merged, starting with a user turn. */
export function toMessages(messages: ChatMessage[]): { role: 'user' | 'assistant'; content: unknown[] }[] {
  const out: { role: 'user' | 'assistant'; content: unknown[] }[] = [];
  for (const m of messages) {
    const content = contentOf(m);
    if (content.length === 0) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content = [...last.content, ...content];
    else if (out.length > 0 || m.role === 'user') out.push({ role: m.role, content });
  }
  return out;
}

export function buildRequest(t: ChatTarget, req: ChatRequest, lim: ModelLimits): WireRequest {
  const maxTokens =
    req.maxTokens ??
    t.spec?.maxOutputTokens ??
    t.provider.maxOutputTokens ??
    (lim.maxOutputTokens ? Math.min(lim.maxOutputTokens, DISCOVERED_MAX_TOKENS_CAP) : DEFAULT_MAX_TOKENS);
  const body: Record<string, unknown> = { model: t.model, max_tokens: maxTokens, stream: true };
  if (req.system) body.system = req.system;
  body.messages = toMessages(req.messages);
  if (req.effort) body.output_config = { effort: req.effort };
  Object.assign(body, t.provider.body, t.spec?.body, req.body);
  return {
    url: `${t.provider.baseUrl}/messages`,
    headers: { 'anthropic-version': API_VERSION, accept: 'text/event-stream', ...t.provider.headers, ...authHeaders(t) },
    body,
  };
}

function finishOf(raw: string | undefined): FinishReason {
  switch (raw) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'other';
  }
}

function n(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function createParser(onDelta?: (d: ChatDelta) => void): WireParser {
  const blocks: Block[] = [];
  let text = '';
  let reasoning = '';
  let finishRaw: string | undefined;
  let model: string | undefined;
  let usage: TokenCounts | undefined;

  const applyUsage = (u: Record<string, unknown> | undefined): void => {
    if (!u) return;
    usage ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    usage.input = n(u.input_tokens) ?? usage.input;
    usage.output = n(u.output_tokens) ?? usage.output;
    usage.cacheRead = n(u.cache_read_input_tokens) ?? usage.cacheRead;
    usage.cacheWrite = n(u.cache_creation_input_tokens) ?? usage.cacheWrite;
  };

  return {
    push(_event, data) {
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(data) as Record<string, unknown>;
      } catch {
        return false;
      }
      switch (ev.type) {
        case 'message_start': {
          const msg = ev.message as Record<string, unknown> | undefined;
          if (typeof msg?.model === 'string') model = msg.model;
          applyUsage(msg?.usage as Record<string, unknown> | undefined);
          break;
        }
        case 'content_block_start': {
          const i = n(ev.index) ?? blocks.length;
          const b = { ...(ev.content_block as Block) };
          // Text arrives in deltas; start blocks may carry an empty string.
          if (b.type === 'text') b.text = '';
          if (b.type === 'thinking') b.thinking = '';
          blocks[i] = b;
          break;
        }
        case 'content_block_delta': {
          const i = n(ev.index) ?? blocks.length - 1;
          const b = (blocks[i] ??= { type: 'text', text: '' });
          const d = ev.delta as Record<string, unknown> | undefined;
          if (d?.type === 'text_delta' && typeof d.text === 'string') {
            b.text = String(b.text ?? '') + d.text;
            text += d.text;
            onDelta?.({ type: 'text', text: d.text });
          } else if (d?.type === 'thinking_delta' && typeof d.thinking === 'string') {
            b.thinking = String(b.thinking ?? '') + d.thinking;
            reasoning += d.thinking;
            if (d.thinking) onDelta?.({ type: 'reasoning', text: d.thinking });
          } else if (d?.type === 'signature_delta' && typeof d.signature === 'string') {
            b.signature = String(b.signature ?? '') + d.signature;
          }
          break;
        }
        case 'message_delta': {
          const d = ev.delta as Record<string, unknown> | undefined;
          if (typeof d?.stop_reason === 'string') finishRaw = d.stop_reason;
          applyUsage(ev.usage as Record<string, unknown> | undefined);
          break;
        }
        case 'message_stop':
          return true;
        case 'error': {
          const e = ev.error as { type?: unknown; message?: unknown } | undefined;
          throw new ApiError(typeof e?.message === 'string' ? e.message : 'stream error', undefined, typeof e?.type === 'string' ? e.type : undefined);
        }
      }
      return false;
    },
    result() {
      const r: ChatResult = { text, reasoning, finish: finishOf(finishRaw) };
      if (finishRaw) r.finishRaw = finishRaw;
      if (usage) r.usage = usage;
      if (model) r.model = model;
      // Only blocks the API accepts back: text, and thinking with its signature (or redacted).
      const native = blocks.filter(
        (b) => b && ((b.type === 'text' && b.text) || (b.type === 'thinking' && b.signature) || b.type === 'redacted_thinking'),
      );
      if (native.length) r.native = { api: 'anthropic', content: native };
      return r;
    },
  };
}
