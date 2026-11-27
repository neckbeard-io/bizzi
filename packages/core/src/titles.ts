// Automatic session titles (spec §4.1): a session nobody named is titled from its first message, and
// a title model, when the host has one, may replace that with a short summary. Titles set by the user
// always win; titles the agent reports (Codex thread names, OpenCode's generated titles) replace
// automatic ones, except the agent's own placeholders.

import type { InputBlock } from '@bizzi/protocol';

/** Longest automatic title, in characters (a cut title ends with "…"). */
export const AUTO_TITLE_MAX = 60;

/** Most text of the first message handed to a title model. */
export const TITLE_PROMPT_MAX = 4000;

/**
 * Suggests a short title for a conversation from its first message; undefined (or a throw) keeps the
 * title taken from the message.
 */
export type TitleSuggester = (text: string) => Promise<string | undefined>;

/** The text of a message: its text blocks, joined. */
export function messageText(input: readonly InputBlock[]): string {
  return input
    .filter((b): b is InputBlock & { type: 'text' } => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/**
 * A title from a first message: its first line with words in it, without markdown markers, collapsed
 * and cut at a word boundary. Attachments alone give "Attached <name>"; images alone give nothing.
 */
export function autoTitle(input: readonly InputBlock[]): string | undefined {
  const text = messageText(input);
  for (const raw of text.split('\n')) {
    const line = raw
      .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/, '')
      .replace(/`{3,}.*$/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (/[\p{L}\p{N}]/u.test(line)) return clip(line, AUTO_TITLE_MAX);
  }
  const file = input.find((b): b is InputBlock & { type: 'file' } => b.type === 'file');
  if (file) return clip(`Attached ${file.path.split(/[\\/]/).pop() || file.path}`, AUTO_TITLE_MAX);
  return undefined;
}

/** A title model's answer, tidied: first line, no quotes, labels or trailing period; undefined when unusable. */
export function cleanSuggestedTitle(raw: string): string | undefined {
  const line = raw
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return undefined;
  const t = line
    .replace(/^(?:\*\*)?title(?:\*\*)?\s*:\s*/i, '')
    .replace(/^["'`*_“‘]+|["'`*_”’]+$/g, '')
    .replace(/[.。]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!/[\p{L}\p{N}]/u.test(t)) return undefined;
  return clip(t, 80);
}

/**
 * Titles an agent gives a session before anyone has said anything (OpenCode's "New session - <ISO
 * date>"). They don't count as a title, so the session still gets one from its first message.
 */
export function isPlaceholderTitle(title: string): boolean {
  return /^(?:New|Child) session - \d{4}-\d{2}-\d{2}T/.test(title.trim());
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return (space >= max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.\-–—]+$/, '') + '…';
}
