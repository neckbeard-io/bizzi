// Pure mapping helpers between OpenCode v2 shapes and bizzi's normalized events.

import { BizziError } from '@bizzi/protocol';
import type { ApprovalDecisionKind, ApprovalKind, PlanItem, QuestionAnswers, QuestionItem, ToolKind, Usage } from '@bizzi/protocol';
import type { FormAnswer, FormField, FormInfo, ModelRef, PermissionReply, ToolContent, TokenUsage } from './types.ts';

/**
 * OpenCode v2 built-in tool names (2.0.25: shell, read, edit, write, glob, grep, webfetch,
 * websearch, subagent, skill, question, execute). v1 names (bash, task, list, patch, todowrite…)
 * are kept so older servers and plugins map sensibly.
 */
const TOOL_KINDS: Record<string, ToolKind> = {
  shell: 'shell',
  bash: 'shell',
  read: 'read',
  edit: 'edit',
  multiedit: 'edit',
  patch: 'edit',
  apply_patch: 'edit',
  write: 'write',
  grep: 'search',
  glob: 'search',
  list: 'search',
  ls: 'search',
  codesearch: 'search',
  webfetch: 'web',
  websearch: 'web',
  subagent: 'task',
  task: 'task',
  // Code Mode: MCP tools are called from code passed to `execute`.
  execute: 'mcp',
};

export function toolKind(name: string): ToolKind {
  const k = TOOL_KINDS[name.toLowerCase()];
  if (k) return k;
  // MCP tools surfaced directly are namespaced "<server>_<tool>" (v1) or "<server>.<tool>".
  if (/^[a-z0-9-]+[._][\w.-]+$/i.test(name)) return 'mcp';
  return 'other';
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function oneLine(s: string, max = 120): string {
  const line = s.replace(/\s+/g, ' ').trim();
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

/** Human-readable one-liner for a tool call. */
export function toolTitle(name: string, input: Record<string, unknown> | undefined): string {
  const i = input ?? {};
  const path = str(i.path) ?? str(i.filePath) ?? str(i.file);
  switch (toolKind(name)) {
    case 'shell':
      return oneLine(str(i.command) ?? name);
    case 'read':
    case 'edit':
    case 'write':
      return path ?? name;
    case 'search': {
      const pattern = str(i.pattern) ?? str(i.query) ?? '';
      const where = str(i.path) ?? str(i.include);
      return oneLine([pattern, where && `in ${where}`].filter(Boolean).join(' ') || name);
    }
    case 'web':
      return oneLine(str(i.url) ?? str(i.query) ?? name);
    case 'task':
      return oneLine(str(i.description) ?? str(i.prompt) ?? name);
    case 'mcp':
      return name === 'execute' ? oneLine(str(i.description) ?? 'code mode') : name;
    default:
      return oneLine(str(i.description) ?? str(i.title) ?? name);
  }
}

/** Permission action (e.g. "shell", "edit", "external_directory", "doom_loop") → approval kind. */
export function approvalKind(action: string): ApprovalKind {
  const known = TOOL_KINDS[action.toLowerCase()];
  if (!known) return action === 'plan' || action === 'plan_exit' ? 'plan' : action.startsWith('mcp') ? 'mcp' : 'other';
  switch (known) {
    case 'shell':
      return 'shell';
    case 'edit':
      return 'edit';
    case 'write':
      return 'write';
    case 'read':
    case 'search':
      return 'read';
    case 'web':
      return 'web';
    case 'mcp':
      return 'mcp';
    default:
      return action === 'plan' || action === 'plan_exit' ? 'plan' : 'other';
  }
}

export function decisionToReply(d: ApprovalDecisionKind): PermissionReply {
  return d === 'allow' ? 'once' : d === 'allow_always' ? 'always' : 'reject';
}

export function replyToDecision(r: PermissionReply | string): ApprovalDecisionKind {
  return r === 'once' ? 'allow' : r === 'always' ? 'allow_always' : 'deny';
}

/** "provider/model" or "provider/model#variant" → ModelRef. The model id itself may contain "/". */
export function parseModel(model: string, effort?: string): ModelRef {
  let m = model.trim();
  let variant = effort;
  const hash = m.lastIndexOf('#');
  if (hash > 0) {
    variant ??= m.slice(hash + 1);
    m = m.slice(0, hash);
  }
  const slash = m.indexOf('/');
  if (slash <= 0 || slash === m.length - 1) {
    throw new Error(`OpenCode model must be "provider/model", got "${model}"`);
  }
  const ref: ModelRef = { providerID: m.slice(0, slash), id: m.slice(slash + 1) };
  if (variant) ref.variant = variant;
  return ref;
}

export function formatModel(ref: ModelRef): string {
  return `${ref.providerID}/${ref.id}`;
}

export function toolOutput(content: ToolContent[] | undefined): string | undefined {
  if (!content || content.length === 0) return undefined;
  const parts = content.map((c) => (c.type === 'text' ? c.text : `[${c.mime}] ${c.name ?? c.uri}`));
  return parts.join('\n');
}

export function addTokens(acc: Usage, tokens: TokenUsage | undefined, cost: number | undefined): void {
  if (tokens) {
    acc.inputTokens = (acc.inputTokens ?? 0) + (tokens.input ?? 0);
    acc.outputTokens = (acc.outputTokens ?? 0) + (tokens.output ?? 0) + (tokens.reasoning ?? 0);
    acc.cacheReadTokens = (acc.cacheReadTokens ?? 0) + (tokens.cache?.read ?? 0);
    acc.cacheWriteTokens = (acc.cacheWriteTokens ?? 0) + (tokens.cache?.write ?? 0);
  }
  if (typeof cost === 'number') acc.costUsd = (acc.costUsd ?? 0) + cost;
}

/** Todo-style tool input → plan items (v1 `todowrite`; v2.0.25 ships no todo tool). */
export function todoItems(input: Record<string, unknown> | undefined): PlanItem[] | undefined {
  const todos = input?.todos;
  if (!Array.isArray(todos)) return undefined;
  const items: PlanItem[] = [];
  for (const t of todos) {
    if (!t || typeof t !== 'object') continue;
    const o = t as Record<string, unknown>;
    const text = str(o.content) ?? str(o.text) ?? str(o.title);
    if (!text) continue;
    const s = String(o.status ?? 'pending');
    const status: PlanItem['status'] = s === 'completed' || s === 'done' ? 'completed' : s === 'in_progress' ? 'in_progress' : 'pending';
    const item: PlanItem = { text, status };
    if (str(o.id)) item.id = String(o.id);
    items.push(item);
  }
  return items;
}

export function isTodoTool(name: string): boolean {
  const n = name.toLowerCase();
  return n === 'todowrite' || n === 'todo' || n === 'todo_write';
}

/** Session-cumulative usage (`session.usage.updated` / `Session.Info`) → bizzi Usage. */
export function usageOf(tokens: TokenUsage | undefined, cost: number | undefined): Usage {
  const u: Usage = {};
  addTokens(u, tokens, cost);
  return u;
}

export function sumUsage(parts: Usage[]): Usage {
  const out: Usage = {};
  for (const p of parts) {
    for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'costUsd'] as const) {
      if (p[k] !== undefined) out[k] = (out[k] ?? 0) + p[k];
    }
  }
  return out;
}

// --- forms (question tool, MCP elicitation) ----------------------------------------------------

const BOOL_OPTIONS = [{ label: 'Yes' }, { label: 'No' }];

function visibleFields(form: FormInfo): FormField[] {
  return form.fields.filter((f) => !f.hidden);
}

function fieldItem(f: FormField): QuestionItem {
  const label = f.title ?? f.key;
  const item: QuestionItem = { id: f.key, text: f.description ?? label };
  if (f.description && f.title && f.title !== f.description) item.header = f.title;
  if (f.type === 'external') {
    item.text = [f.description ?? f.title ?? 'Open this link', f.url].filter(Boolean).join(': ');
    return item;
  }
  if (f.type === 'boolean') item.options = BOOL_OPTIONS.map((o) => ({ ...o }));
  else if (f.options?.length) item.options = f.options.map((o) => (o.description ? { label: o.label, description: o.description } : { label: o.label }));
  if (f.type === 'multiselect') item.multiSelect = true;
  if (f.custom || (!item.options && f.type !== 'boolean')) item.allowText = true;
  return item;
}

/** A pending form → `question.asked` payload (`text`/`options` summarize the first question). */
export function formQuestion(form: FormInfo): { questionId: string; text: string; options?: string[]; questions: QuestionItem[] } {
  const questions = visibleFields(form).map(fieldItem);
  const first = questions[0];
  let text = first?.text ?? form.title;
  if (form.metadata?.kind !== 'question' && form.title && form.title !== text) text = first ? `${form.title}\n${text}` : form.title;
  const out: { questionId: string; text: string; options?: string[]; questions: QuestionItem[] } = { questionId: form.id, text, questions };
  if (first?.options?.length) out.options = first.options.map((o) => o.label);
  return out;
}

function optionValue(f: FormField, answer: string): string {
  const o = f.options?.find((x) => x.label === answer) ?? f.options?.find((x) => x.value === answer);
  if (o) return o.value;
  if (f.options?.length && f.custom === false) {
    throw new BizziError('bad_request', `"${answer}" is not an option for "${f.title ?? f.key}"`);
  }
  return answer;
}

/**
 * bizzi answers (keyed by QuestionItem.id = field key; the question text is accepted too) →
 * the form answer the server expects: option labels become option values, multiselect values are
 * arrays, booleans and numbers are typed.
 */
export function toFormAnswer(form: FormInfo, answers: QuestionAnswers): FormAnswer {
  const fields = visibleFields(form).filter((f) => f.type !== 'external');
  const out: FormAnswer = {};
  for (const [k, v] of Object.entries(answers)) {
    const f = fields.find((x) => x.key === k) ?? fields.find((x) => (x.description ?? x.title) === k);
    if (!f) throw new BizziError('bad_request', `unknown question "${k}"`, { questions: fields.map((x) => x.key) });
    const one = Array.isArray(v) ? v.join(', ') : v;
    switch (f.type) {
      case 'multiselect':
        out[f.key] = (Array.isArray(v) ? v : [v]).map((x) => optionValue(f, String(x)));
        break;
      case 'boolean': {
        if (/^(true|yes|y|1|on)$/i.test(one.trim())) out[f.key] = true;
        else if (/^(false|no|n|0|off)$/i.test(one.trim())) out[f.key] = false;
        else throw new BizziError('bad_request', `"${f.title ?? f.key}" needs yes or no`);
        break;
      }
      case 'number':
      case 'integer': {
        const n = Number(one);
        if (one.trim() === '' || !Number.isFinite(n) || (f.type === 'integer' && !Number.isInteger(n))) {
          throw new BizziError('bad_request', `"${f.title ?? f.key}" needs ${f.type === 'integer' ? 'an integer' : 'a number'}`);
        }
        out[f.key] = n;
        break;
      }
      default:
        out[f.key] = optionValue(f, one);
    }
  }
  return out;
}

/** A form answer from the server (e.g. answered in the TUI) → bizzi answers (option labels). */
export function fromFormAnswer(form: FormInfo, answer: FormAnswer): QuestionAnswers {
  const out: QuestionAnswers = {};
  const label = (f: FormField | undefined, v: string): string => f?.options?.find((o) => o.value === v)?.label ?? v;
  for (const [k, v] of Object.entries(answer)) {
    const f = form.fields.find((x) => x.key === k);
    if (Array.isArray(v)) out[k] = v.map((x) => label(f, String(x)));
    else if (typeof v === 'boolean' && f?.type === 'boolean') out[k] = v ? 'Yes' : 'No';
    else out[k] = label(f, String(v));
  }
  return out;
}
