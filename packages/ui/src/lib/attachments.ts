import type { InputBlock } from '@bizzi/protocol';

/**
 * Composer attachments: pasted images and long pasted text. Each one sits in the draft as a
 * placeholder (`[Image 1]`, `[Pasted text 2 · 48 lines]`) so the textarea stays short and the
 * user decides where it goes; `buildInput` swaps the placeholders back for the real content.
 * Deleting a placeholder drops its attachment. Placeholders carry no `#`, `@` or `/` so the
 * one-pane router never reads them as targets.
 */
export type Attachment =
  | { kind: 'image'; id: number; mediaType: string; dataBase64: string; name?: string; width?: number; height?: number }
  | { kind: 'text'; id: number; text: string };

/** Pastes at least this long are condensed into a placeholder. */
export const CONDENSE_MIN_LINES = 10;
export const CONDENSE_MIN_CHARS = 1000;

/** Collapse a user text block in the timeline past this. */
export const COLLAPSE_MIN_LINES = 12;
export const COLLAPSE_MIN_CHARS = 1500;

const PLACEHOLDER = /\[(Image|Pasted text) (\d+)(?: · [^\]\n]*)?\]/g;

export function lineCount(text: string): number {
  if (!text) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return text.endsWith('\n') ? n - 1 : n;
}

/** A paste long enough to stand in the draft as a placeholder. */
export function shouldCondense(text: string): boolean {
  return text.length >= CONDENSE_MIN_CHARS || lineCount(text) >= CONDENSE_MIN_LINES;
}

/** Long enough that the timeline shows it collapsed. */
export function shouldCollapse(text: string): boolean {
  return text.length >= COLLAPSE_MIN_CHARS || lineCount(text) >= COLLAPSE_MIN_LINES;
}

export function placeholderFor(a: Attachment): string {
  if (a.kind === 'image') return `[Image ${a.id}]`;
  const lines = lineCount(a.text);
  return `[Pasted text ${a.id} · ${lines === 1 ? `${a.text.length} chars` : `${lines} lines`}]`;
}

/** The next free attachment number in a draft. */
export function nextId(attachments: readonly Attachment[]): number {
  return attachments.reduce((m, a) => Math.max(m, a.id), 0) + 1;
}

function find(attachments: readonly Attachment[], label: string, id: number): Attachment | undefined {
  const kind = label === 'Image' ? 'image' : 'text';
  return attachments.find((a) => a.kind === kind && a.id === id);
}

/** Attachments whose placeholder is still in the draft, in draft order (each once). */
export function liveAttachments(text: string, attachments: readonly Attachment[]): Attachment[] {
  const out: Attachment[] = [];
  for (const m of text.matchAll(PLACEHOLDER)) {
    const a = find(attachments, m[1]!, Number(m[2]));
    if (a && !out.includes(a)) out.push(a);
  }
  return out;
}

/** Whether the draft has anything to send. */
export function hasContent(text: string, attachments: readonly Attachment[]): boolean {
  return text.trim().length > 0 || liveAttachments(text, attachments).length > 0;
}

/**
 * The draft as input blocks, in order: typed text, each pasted text as its own block (so the
 * timeline can collapse it), each image as an image block. Unknown placeholders stay as text.
 */
export function buildInput(text: string, attachments: readonly Attachment[]): InputBlock[] {
  const out: InputBlock[] = [];
  let typed = '';
  const flush = (): void => {
    const t = typed.trim();
    if (t) out.push({ type: 'text', text: t });
    typed = '';
  };
  let last = 0;
  for (const m of text.matchAll(PLACEHOLDER)) {
    const a = find(attachments, m[1]!, Number(m[2]));
    if (!a) continue;
    typed += text.slice(last, m.index);
    last = m.index + m[0].length;
    flush();
    if (a.kind === 'image') out.push({ type: 'image', mediaType: a.mediaType, dataBase64: a.dataBase64 });
    else out.push({ type: 'text', text: a.text });
  }
  typed += text.slice(last);
  flush();
  return out;
}

/** Replace a text attachment's placeholder(s) with the text itself. */
export function expandInDraft(text: string, a: Attachment): string {
  if (a.kind !== 'text') return text;
  return text.replace(PLACEHOLDER, (all, label: string, id: string) => (find([a], label, Number(id)) ? a.text : all));
}

/** Remove an attachment's placeholder(s) from the draft, with one adjoining space. */
export function removeFromDraft(text: string, a: Attachment): string {
  return text.replace(new RegExp(`${PLACEHOLDER.source} ?`, 'g'), (all, label: string, id: string) => (find([a], label, Number(id)) ? '' : all));
}

/** Insert `insert` over the selection, padding with spaces so a placeholder never glues onto a word. */
export function insertAt(text: string, start: number, end: number, insert: string): { text: string; caret: number } {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const lead = before && !/\s$/.test(before) ? ' ' : '';
  const trail = after && !/^\s/.test(after) ? ' ' : after ? '' : ' ';
  const piece = lead + insert + trail;
  return { text: before + piece + after, caret: before.length + piece.length };
}

/** The draft with every placeholder of a known attachment taken out (for titles and previews). */
export function stripPlaceholders(text: string, attachments: readonly Attachment[]): string {
  return text
    .replace(PLACEHOLDER, (all, label: string, id: string) => (find(attachments, label, Number(id)) ? ' ' : all))
    .replace(/[ \t]+/g, ' ')
    .trim();
}
