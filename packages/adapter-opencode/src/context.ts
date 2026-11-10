// Context occupancy (docs/usage.md §1) from OpenCode v2 step tokens.

import type { ContextCategory, ContextUsage } from '@bizzi/protocol';
import type { TokenUsage } from './types.ts';

/** Approximate token count: UTF-8 bytes / 4. An approximation, not the model's tokenizer. */
export function approxTokens(text: string | undefined): number {
  return text ? Math.ceil(Buffer.byteLength(text, 'utf8') / 4) : 0;
}

/**
 * The latest assistant step's tokens → `context.updated`. `used` is that one request's total
 * (input + output + reasoning + cache read + cache write, the sum OpenCode's own TUI shows as
 * context), never a sum over steps; `window` is the model's `limit.context`. OpenCode reports no
 * breakdown, so the rows are only bizzi's estimate, the rest, and the free space.
 */
export function contextFromStep(tokens: TokenUsage | undefined, window: number | undefined, bizziTokens = 0): ContextUsage | undefined {
  if (!tokens || !window) return undefined;
  const used = (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.reasoning ?? 0) + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0);
  if (used <= 0) return undefined;
  const out: ContextUsage = { used, window };
  const bizzi = Math.min(bizziTokens, used);
  if (bizzi > 0) {
    const categories: ContextCategory[] = [
      { id: 'bizzi', label: 'bizzi overhead', tokens: bizzi, kind: 'used' },
      { id: 'other', label: 'Everything else', tokens: used - bizzi, kind: 'used' },
    ];
    if (window > used) categories.push({ id: 'free_space', label: 'Free space', tokens: window - used, kind: 'free' });
    out.categories = categories;
  }
  return out;
}
