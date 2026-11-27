import type { TimelineItem } from '@bizzi/client';
import type { InputBlock } from '@bizzi/protocol';

/**
 * The text of a user prompt, flattened for the pinned bar; null when the item isn't one. Steers are left
 * out: the prompt that started the turn is the one worth keeping in view. So is anything bizzi sent
 * itself (the continue-after-restart note) and turns the agent started on its own: only what you wrote.
 */
export function promptText(item: TimelineItem | undefined): string | null {
  if (!item) return null;
  let text: string | null = null;
  if (item.kind === 'turn') text = item.auto || item.agent ? null : inputText(item.input);
  else if (item.kind === 'message' && item.role === 'user') text = item.text.trim() || null;
  // History from nodes older than `turn.started.auto` only has the note's `[bizzi]` prefix to go by.
  return text !== null && /^\[bizzi\]/i.test(text) ? null : text;
}

function inputText(input: readonly InputBlock[]): string | null {
  const parts: string[] = [];
  let images = 0;
  for (const b of input) {
    if (b.type === 'text') {
      const t = b.text.trim();
      if (t) parts.push(t);
    } else if (b.type === 'file') parts.push(`@${b.path}`);
    else images++;
  }
  if (images > 0) parts.push(images === 1 ? '[image]' : `[${images} images]`);
  return parts.length > 0 ? parts.join('\n') : null;
}

/**
 * Which prompt to pin above the timeline: the last prompt that starts above the viewport, once it has
 * scrolled fully out of view. `prompts` are row indices in ascending order; `span(i)` gives a row's
 * offsets (undefined when not measured yet). Returns -1 when nothing needs pinning.
 */
export function pinnedPromptIndex(prompts: readonly number[], span: (index: number) => { start: number; end: number } | undefined, scrollTop: number): number {
  let lo = 0;
  let hi = prompts.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = span(prompts[mid]!);
    if (s && s.start <= scrollTop) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (found < 0) return -1;
  const index = prompts[found]!;
  const s = span(index);
  return s && s.end <= scrollTop ? index : -1;
}
