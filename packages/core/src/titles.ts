// Automatic session titles (spec §4.1): a session nobody named is titled from its first message, and
// a title model, when the host has one, may replace that with a short summary and, as the conversation
// moves on, re-title it from the first message plus the latest ones. Titles set by the user always win;
// titles the agent reports (Codex thread names, OpenCode's generated titles) replace automatic ones,
// except the agent's own placeholders. Messages bizzi sends itself (`[bizzi] …`) never title a session.

import { AUTO_TITLE_MAX, clipTitle, titleFromText, type InputBlock } from '@bizzi/protocol';

export { AUTO_TITLE_MAX };

/** Most text of the first message handed to a title model. */
export const TITLE_PROMPT_MAX = 4000;

/** Most text kept of the first message (the session's original intent) for re-titling later. */
export const INTENT_MAX = 2000;

/** Most text of each recent message handed to a title model when re-titling. */
export const RECENT_MAX = 600;

/** Messages since the session was titled after which a title model re-titles it (drift). */
export const RETITLE_AT: readonly number[] = [3, 8, 20, 50];

/** How many of the latest messages a re-title looks at. */
export const RECENT_KEPT = 3;

/** A message bizzi sends on its own (continuing after a restart), not the user's: `[bizzi] …`. */
export function isBizziNote(text: string): boolean {
  return /^\s*\[bizzi\]/i.test(text);
}

/**
 * What a title model gets when re-titling: the original request first (what the session is for),
 * then the latest messages, so the title follows the conversation without losing where it started.
 */
export function retitlePrompt(intent: string, recent: readonly string[]): string {
  const latest = recent.map((t) => `- ${t.replace(/\s+/g, ' ').trim().slice(0, RECENT_MAX)}`).join('\n');
  return `First message:\n${intent.slice(0, INTENT_MAX)}\n\nLatest messages, newest last:\n${latest}`;
}

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
 * A title from a first message: the gist of its first line with words in it (`titleFromText` in
 * @bizzi/protocol: preambles like "I'd like" dropped, cut before asides, a few words at most).
 * Attachments alone give "Attached <name>"; images alone give nothing.
 */
export function autoTitle(input: readonly InputBlock[]): string | undefined {
  const title = titleFromText(messageText(input));
  if (title) return title;
  const file = input.find((b): b is InputBlock & { type: 'file' } => b.type === 'file');
  if (file) return clipTitle(`Attached ${file.path.split(/[\\/]/).pop() || file.path}`, AUTO_TITLE_MAX);
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
  return clipTitle(t, 80);
}

/**
 * Titles an agent gives a session before anyone has said anything (OpenCode's "New session - <ISO
 * date>"). They don't count as a title, so the session still gets one from its first message.
 */
export function isPlaceholderTitle(title: string): boolean {
  return /^(?:New|Child) session - \d{4}-\d{2}-\d{2}T/.test(title.trim());
}
