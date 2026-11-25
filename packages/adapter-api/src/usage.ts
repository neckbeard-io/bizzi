// Token counts → protocol Usage, cost and context occupancy (docs/usage.md §1).

import type { ContextCategory, ContextUsage, Usage } from '@bizzi/protocol';
import type { TokenCounts } from './chat.ts';
import type { ModelPrice } from './config.ts';

/** Approximate token count: UTF-8 bytes / 4. An approximation, not the model's tokenizer. */
export function approxTokens(text: string | undefined): number {
  return text ? Math.ceil(Buffer.byteLength(text, 'utf8') / 4) : 0;
}

/** USD for one request. Cache reads and writes are charged at the input price unless the config prices them. */
export function costOf(c: TokenCounts, p: ModelPrice): number {
  const usd =
    c.input * p.inputPerMTok +
    c.output * p.outputPerMTok +
    c.cacheRead * (p.cacheReadPerMTok ?? p.inputPerMTok) +
    c.cacheWrite * (p.cacheWritePerMTok ?? p.inputPerMTok);
  return usd / 1e6;
}

export function toUsage(c: TokenCounts, price?: ModelPrice, contextWindow?: number): Usage {
  const u: Usage = { inputTokens: c.input, outputTokens: c.output };
  if (c.cacheRead) u.cacheReadTokens = c.cacheRead;
  if (c.cacheWrite) u.cacheWriteTokens = c.cacheWrite;
  if (price) u.costUsd = costOf(c, price);
  if (contextWindow) u.contextWindow = contextWindow;
  return u;
}

export function addUsage(total: Usage | undefined, u: Usage): Usage {
  const out: Usage = { ...total };
  for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'costUsd'] as const) {
    if (u[k] !== undefined) out[k] = (out[k] ?? 0) + u[k];
  }
  if (u.contextWindow) out.contextWindow = u.contextWindow;
  return out;
}

/**
 * The last request's tokens → `context.updated`. `used` is that request's whole prompt plus its output
 * (what the next request starts from), never a sum over turns. No breakdown from the APIs, so the rows
 * are bizzi's own estimate, the rest, and the free space.
 */
export function contextOf(c: TokenCounts, window: number | undefined, bizziTokens = 0): ContextUsage | undefined {
  if (!window) return undefined;
  const used = c.input + c.cacheRead + c.cacheWrite + c.output;
  if (used <= 0) return undefined;
  const out: ContextUsage = { used, window };
  const bizzi = Math.min(bizziTokens, used);
  if (bizzi > 0) {
    const categories: ContextCategory[] = [
      { id: 'bizzi', label: 'bizzi overhead', tokens: bizzi, kind: 'used' },
      { id: 'messages', label: 'Messages', tokens: used - bizzi, kind: 'used' },
    ];
    if (window > used) categories.push({ id: 'free_space', label: 'Free space', tokens: window - used, kind: 'free' });
    out.categories = categories;
  }
  return out;
}
