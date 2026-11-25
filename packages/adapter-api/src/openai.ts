// OpenAI-compatible chat completions (`POST {base}/chat/completions`, `stream: true`): OpenAI, Gemini's
// and OpenRouter's compatible endpoints, vLLM, LiteLLM, Bifrost. Chunks carry `choices[0].delta.content`
// (and `reasoning_content` / `reasoning` on reasoning models), `finish_reason`, and with
// `stream_options.include_usage` a final chunk with `usage`; the stream ends with `data: [DONE]`.

import type { ChatDelta, ChatMessage, ChatRequest, ChatResult, ChatTarget, FinishReason, TokenCounts, WireParser, WireRequest } from './chat.ts';
import { authHeaders, type ModelLimits } from './chat.ts';
import { ApiError } from './http.ts';

type Content = string | Record<string, unknown>[];

function contentOf(m: ChatMessage): Content {
  if (m.parts.every((p) => p.type === 'text')) return m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n\n');
  return m.parts.map((p) =>
    p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image_url', image_url: { url: `data:${p.mediaType};base64,${p.dataBase64}` } },
  );
}

function isEmpty(c: Content): boolean {
  return typeof c === 'string' ? c.length === 0 : c.length === 0;
}

/** System message first, then the turns with empty ones dropped and consecutive same-role turns merged. */
export function toMessages(system: string | undefined, messages: ChatMessage[]): { role: string; content: Content }[] {
  const out: { role: string; content: Content }[] = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    // Assistant turns are text only (images are user input).
    const content = m.role === 'assistant' ? m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('') : contentOf(m);
    if (isEmpty(content)) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      if (typeof last.content === 'string' && typeof content === 'string') last.content = `${last.content}\n\n${content}`;
      else last.content = [...asParts(last.content), ...asParts(content)];
    } else {
      out.push({ role: m.role, content });
    }
  }
  return out;
}

function asParts(c: Content): Record<string, unknown>[] {
  return typeof c === 'string' ? [{ type: 'text', text: c }] : c;
}

export function buildRequest(t: ChatTarget, req: ChatRequest, _lim: ModelLimits): WireRequest {
  const body: Record<string, unknown> = { model: t.model, messages: toMessages(req.system, req.messages), stream: true };
  if (t.provider.streamUsage !== false) body.stream_options = { include_usage: true };
  const maxTokens = req.maxTokens ?? t.spec?.maxOutputTokens ?? t.provider.maxOutputTokens;
  if (maxTokens) body[t.provider.maxTokensParam ?? 'max_tokens'] = maxTokens;
  if (req.effort) body.reasoning_effort = req.effort;
  Object.assign(body, t.provider.body, t.spec?.body, req.body);
  return {
    url: `${t.provider.baseUrl}/chat/completions`,
    headers: { accept: 'text/event-stream', ...t.provider.headers, ...authHeaders(t) },
    body,
  };
}

function finishOf(raw: string | undefined): FinishReason {
  switch (raw) {
    case 'stop':
    case 'end_turn':
      return 'end';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return 'other';
  }
}

function n(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function createParser(onDelta?: (d: ChatDelta) => void): WireParser {
  let text = '';
  let reasoning = '';
  let finishRaw: string | undefined;
  let model: string | undefined;
  let usage: TokenCounts | undefined;
  return {
    push(_event, data) {
      if (data.trim() === '[DONE]') return true;
      let chunk: Record<string, unknown>;
      try {
        chunk = JSON.parse(data) as Record<string, unknown>;
      } catch {
        return false;
      }
      if (chunk.error) {
        const e = chunk.error as { message?: unknown; type?: unknown; code?: unknown } | string;
        const message = typeof e === 'string' ? e : typeof e.message === 'string' ? e.message : 'stream error';
        throw new ApiError(message, typeof e === 'object' && typeof e.code === 'number' ? e.code : undefined);
      }
      if (typeof chunk.model === 'string') model = chunk.model;
      const choice = (chunk.choices as Record<string, unknown>[] | undefined)?.[0];
      const delta = choice?.delta as Record<string, unknown> | undefined;
      const r = delta?.reasoning_content ?? delta?.reasoning;
      if (typeof r === 'string' && r) {
        reasoning += r;
        onDelta?.({ type: 'reasoning', text: r });
      }
      if (typeof delta?.content === 'string' && delta.content) {
        text += delta.content;
        onDelta?.({ type: 'text', text: delta.content });
      }
      if (typeof choice?.finish_reason === 'string') finishRaw = choice.finish_reason;
      const u = chunk.usage as Record<string, unknown> | undefined | null;
      if (u) {
        const prompt = n(u.prompt_tokens) ?? 0;
        const cached = n((u.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens) ?? 0;
        usage = { input: Math.max(0, prompt - cached), output: n(u.completion_tokens) ?? 0, cacheRead: cached, cacheWrite: 0 };
      }
      return false;
    },
    result() {
      const r: ChatResult = { text, reasoning, finish: finishOf(finishRaw) };
      if (finishRaw) r.finishRaw = finishRaw;
      if (usage) r.usage = usage;
      if (model) r.model = model;
      return r;
    },
  };
}
