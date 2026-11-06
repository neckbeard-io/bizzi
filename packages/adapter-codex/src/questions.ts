// Codex server requests that ask the user something -> bizzi questions, and answers back.
//   item/tool/requestUserInput      -> ToolRequestUserInputResponse
//   mcpServer/elicitation/request   -> McpServerElicitationRequestResponse

import { BizziError, type QuestionAnswers, type QuestionItem } from '@bizzi/protocol';
import type {
  McpServerElicitationRequestParams,
  McpServerElicitationRequestResponse,
  ToolRequestUserInputParams,
  ToolRequestUserInputResponse,
} from './codex-types.ts';

export interface QuestionForm {
  /** Summary for simple clients (`question.asked.text`). */
  text: string;
  options?: string[];
  questions: QuestionItem[];
}

// ---- item/tool/requestUserInput

export function userInputQuestions(p: ToolRequestUserInputParams): QuestionForm {
  const questions: QuestionItem[] = p.questions.map((q) => {
    const options = q.options?.length ? q.options.map((o) => (o.description ? { label: o.label, description: o.description } : { label: o.label })) : undefined;
    const item: QuestionItem = { id: q.id, text: q.question };
    if (q.header) item.header = q.header;
    if (options) item.options = options;
    // Free text when Codex offers an "Other" answer, or when there is nothing to pick from.
    if (q.isOther || !options) item.allowText = true;
    return item;
  });
  const first = questions[0];
  return {
    text: first?.text ?? 'Codex has a question',
    ...(first?.options ? { options: first.options.map((o) => o.label) } : {}),
    questions,
  };
}

/** `answers === undefined` (declined) answers nothing; Codex then treats the questions as unanswered. */
export function userInputResponse(answers: QuestionAnswers | undefined): ToolRequestUserInputResponse {
  const out: ToolRequestUserInputResponse = { answers: {} };
  for (const [id, a] of Object.entries(answers ?? {})) {
    const list = (Array.isArray(a) ? a : [a]).filter((s) => typeof s === 'string' && s.length > 0);
    out.answers[id] = { answers: list };
  }
  return out;
}

// ---- mcpServer/elicitation/request

type FieldKind =
  | { type: 'text' }
  | { type: 'number'; integer: boolean }
  | { type: 'boolean' }
  | { type: 'choice'; values: Map<string, string> }
  | { type: 'multi'; values: Map<string, string> };

/** How to turn bizzi answers into the elicitation response. */
export type ElicitationPlan =
  | { mode: 'form'; fields: Map<string, FieldKind> }
  | { mode: 'confirm' }
  | { mode: 'url' };

export const CONFIRM_ID = 'confirm';
export const URL_ID = 'url';
const ACCEPT = 'Accept';
const DECLINE = 'Decline';
const DONE = 'Done';
const CANCEL = 'Cancel';
const YES = 'Yes';
const NO = 'No';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

function choiceValues(schema: Obj): Map<string, string> | undefined {
  // Titled: oneOf / anyOf [{const, title}]
  const titled = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : undefined;
  if (titled) {
    const m = new Map<string, string>();
    for (const o of titled) if (isObj(o) && typeof o.const === 'string') m.set(str(o.title) ?? o.const, o.const);
    return m.size ? m : undefined;
  }
  // Untitled / legacy titled: enum (+ enumNames)
  if (Array.isArray(schema.enum)) {
    const names = Array.isArray(schema.enumNames) ? schema.enumNames : [];
    const m = new Map<string, string>();
    schema.enum.forEach((v, i) => {
      if (typeof v === 'string') m.set(str(names[i]) ?? v, v);
    });
    return m.size ? m : undefined;
  }
  return undefined;
}

function fieldKind(schema: Obj): FieldKind {
  if (schema.type === 'array' && isObj(schema.items)) {
    const values = choiceValues(schema.items);
    if (values) return { type: 'multi', values };
  }
  const values = choiceValues(schema);
  if (values) return { type: 'choice', values };
  if (schema.type === 'boolean') return { type: 'boolean' };
  if (schema.type === 'number' || schema.type === 'integer') return { type: 'number', integer: schema.type === 'integer' };
  return { type: 'text' };
}

/**
 * Map an elicitation to questions. Form schemas become one question per property; a form with no
 * properties is an accept/decline confirmation; URL mode asks the user to open the URL and confirm.
 */
export function elicitationQuestions(p: McpServerElicitationRequestParams): { form: QuestionForm; plan: ElicitationPlan } {
  const header = p.serverName.slice(0, 40);
  if (p.mode === 'url') {
    const text = `${p.message}\n${p.url}`;
    return {
      form: {
        text,
        options: [DONE, CANCEL],
        questions: [{ id: URL_ID, text, header, options: [{ label: DONE, description: `Opened ${p.url} and finished` }, { label: CANCEL }] }],
      },
      plan: { mode: 'url' },
    };
  }
  // Modes other than form/url (e.g. experimental-only ones) fall through to a confirmation.
  const message = str((p as { message?: unknown }).message) ?? `${p.serverName} needs your input`;
  const schema = isObj((p as { requestedSchema?: unknown }).requestedSchema) ? ((p as { requestedSchema: Obj }).requestedSchema) : {};
  const props = isObj(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === 'string') : []);
  const fields = new Map<string, FieldKind>();
  const questions: QuestionItem[] = [];
  for (const [key, raw] of Object.entries(props)) {
    if (!isObj(raw)) continue;
    const kind = fieldKind(raw);
    fields.set(key, kind);
    const title = str(raw.title);
    const description = str(raw.description);
    let text = description ?? title ?? key;
    if (!required.has(key)) text += ' (optional)';
    const item: QuestionItem = { id: key, text, header: (title ?? key).slice(0, 40) };
    switch (kind.type) {
      case 'choice':
      case 'multi':
        item.options = [...kind.values.keys()].map((label) => ({ label }));
        if (kind.type === 'multi') item.multiSelect = true;
        break;
      case 'boolean':
        item.options = [{ label: YES }, { label: NO }];
        break;
      default:
        item.allowText = true;
    }
    questions.push(item);
  }
  if (questions.length === 0) {
    return {
      form: {
        text: message,
        options: [ACCEPT, DECLINE],
        questions: [{ id: CONFIRM_ID, text: message, header, options: [{ label: ACCEPT }, { label: DECLINE }] }],
      },
      plan: { mode: 'confirm' },
    };
  }
  return { form: { text: message, questions }, plan: { mode: 'form', fields } };
}

function one(a: string | string[] | undefined): string | undefined {
  return Array.isArray(a) ? a[0] : a;
}

function toValue(key: string, kind: FieldKind, a: string | string[]): unknown {
  switch (kind.type) {
    case 'text':
      return Array.isArray(a) ? a.join(', ') : a;
    case 'number': {
      const n = Number(one(a)?.trim());
      if (!Number.isFinite(n) || (kind.integer && !Number.isInteger(n))) {
        throw new BizziError('bad_request', `answer for '${key}' must be ${kind.integer ? 'an integer' : 'a number'}`);
      }
      return n;
    }
    case 'boolean': {
      const v = one(a)?.trim().toLowerCase();
      if (v === 'yes' || v === 'true') return true;
      if (v === 'no' || v === 'false') return false;
      throw new BizziError('bad_request', `answer for '${key}' must be Yes or No`);
    }
    case 'choice': {
      const label = one(a) ?? '';
      return kind.values.get(label) ?? label; // a label, or the raw value
    }
    case 'multi':
      return (Array.isArray(a) ? a : [a]).map((label) => kind.values.get(label) ?? label);
  }
}

/** Build the elicitation reply. `answers === undefined` declines; `cancel` is for turn end / stop. */
export function elicitationResponse(
  plan: ElicitationPlan,
  answers: QuestionAnswers | undefined,
  cancel = false,
): McpServerElicitationRequestResponse {
  if (cancel) return { action: 'cancel', content: null, _meta: null };
  if (answers === undefined) return { action: 'decline', content: null, _meta: null };
  switch (plan.mode) {
    case 'url':
      return one(answers[URL_ID]) === CANCEL ? { action: 'decline', content: null, _meta: null } : { action: 'accept', content: null, _meta: null };
    case 'confirm':
      return one(answers[CONFIRM_ID]) === DECLINE ? { action: 'decline', content: null, _meta: null } : { action: 'accept', content: {}, _meta: null };
    case 'form': {
      const content: Record<string, unknown> = {};
      for (const [key, a] of Object.entries(answers)) {
        const kind = plan.fields.get(key);
        if (!kind || a === '' || (Array.isArray(a) && a.length === 0 && kind.type !== 'multi')) continue;
        content[key] = toValue(key, kind, a);
      }
      return { action: 'accept', content: content as McpServerElicitationRequestResponse['content'], _meta: null };
    }
  }
}

/** Shallow validation of a `respondQuestion` answers object. */
export function assertAnswers(answers: unknown): asserts answers is QuestionAnswers | undefined {
  if (answers === undefined) return;
  if (!isObj(answers)) throw new BizziError('bad_request', 'answers must be an object');
  for (const [k, v] of Object.entries(answers)) {
    if (typeof v === 'string') continue;
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) continue;
    throw new BizziError('bad_request', `answer for '${k}' must be a string or a list of strings`);
  }
}
