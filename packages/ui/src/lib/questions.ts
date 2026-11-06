// Answer drafts for `question.asked` forms (QuestionItem[] → QuestionAnswers).
import type { QuestionAnswers, QuestionItem as QuestionSpec } from '@bizzi/protocol';

export interface QuestionDraft {
  /** Selected option labels per question id. */
  selected: Readonly<Record<string, readonly string[]>>;
  /** Free text per question id. */
  text: Readonly<Record<string, string>>;
}

export const EMPTY_DRAFT: QuestionDraft = { selected: {}, text: {} };

/** Select an option: replaces the choice for single-select questions, toggles it for multiSelect. */
export function toggleOption(draft: QuestionDraft, q: QuestionSpec, label: string): QuestionDraft {
  const cur = draft.selected[q.id] ?? [];
  let next: string[];
  if (q.multiSelect) next = cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label];
  else next = cur.length === 1 && cur[0] === label ? [] : [label];
  return { ...draft, selected: { ...draft.selected, [q.id]: next } };
}

export function setText(draft: QuestionDraft, qid: string, text: string): QuestionDraft {
  return { ...draft, text: { ...draft.text, [qid]: text } };
}

/** Questions without options are free-text and may be left empty; the others need an answer. */
export function isOptional(q: QuestionSpec): boolean {
  return !q.options?.length;
}

/**
 * The wire answers: multiSelect → string[] (selected labels, plus free text when given); single-select →
 * the selected label, or the free text when nothing is selected; text-only → the text. Empty answers are omitted.
 */
export function buildAnswers(specs: readonly QuestionSpec[], draft: QuestionDraft): QuestionAnswers {
  const out: QuestionAnswers = {};
  for (const q of specs) {
    const sel = draft.selected[q.id] ?? [];
    const text = (draft.text[q.id] ?? '').trim();
    if (q.multiSelect) {
      const all = text ? [...sel, text] : [...sel];
      if (all.length) out[q.id] = all;
    } else if (sel[0] !== undefined) out[q.id] = sel[0];
    else if (text) out[q.id] = text;
  }
  return out;
}

/** Ids of required questions that have no answer yet. */
export function missingAnswers(specs: readonly QuestionSpec[], draft: QuestionDraft): string[] {
  const answers = buildAnswers(specs, draft);
  return specs.filter((q) => !isOptional(q) && answers[q.id] === undefined).map((q) => q.id);
}

/** One question, single choice, no free text: picking an option can submit right away. */
export function isQuickPick(specs: readonly QuestionSpec[]): boolean {
  const q = specs[0];
  return specs.length === 1 && !!q?.options?.length && !q.multiSelect && !q.allowText;
}

export function answerText(v: string | readonly string[] | undefined): string {
  if (v === undefined) return '';
  return typeof v === 'string' ? v : v.join(', ');
}
