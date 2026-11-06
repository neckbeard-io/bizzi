// Pure mapping helpers: Claude Code tool names / SDK payloads -> bizzi protocol values.

import type { ApprovalKind, InputBlock, PlanItem, QuestionAnswers, QuestionItem, StopReason, ToolKind, Usage } from '@bizzi/protocol';
import type { SDKResultMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

export type UserContent = SDKUserMessage['message']['content'];

export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk', 'auto'] as const;
export type ClaudePermissionMode = (typeof PERMISSION_MODES)[number];
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ClaudeEffort = (typeof EFFORT_LEVELS)[number];

export function isPermissionMode(v: string): v is ClaudePermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(v);
}
export function isEffort(v: string): v is ClaudeEffort {
  return (EFFORT_LEVELS as readonly string[]).includes(v);
}

const KIND_BY_NAME: Record<string, ToolKind> = {
  Bash: 'shell',
  BashOutput: 'shell',
  KillShell: 'shell',
  Read: 'read',
  NotebookRead: 'read',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Write: 'write',
  Grep: 'search',
  Glob: 'search',
  LS: 'search',
  ToolSearch: 'search',
  WebFetch: 'web',
  WebSearch: 'web',
  Task: 'task',
  Agent: 'task',
};

export function toolKind(name: string): ToolKind {
  if (name.startsWith('mcp__')) return 'mcp';
  return KIND_BY_NAME[name] ?? 'other';
}

export function approvalKind(name: string): ApprovalKind {
  if (name === 'ExitPlanMode' || name === 'EnterPlanMode') return 'plan';
  const k = toolKind(name);
  switch (k) {
    case 'shell':
    case 'edit':
    case 'write':
    case 'read':
    case 'mcp':
    case 'web':
      return k;
    case 'search':
      return 'read';
    default:
      return 'other';
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function oneLine(s: string, max = 160): string {
  const line = s.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Human one-liner for a tool call: the command, file path, pattern, URL, … */
export function toolTitle(name: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const path = str(i.file_path) ?? str(i.notebook_path) ?? str(i.path);
  switch (name) {
    case 'Bash':
      return oneLine(str(i.command) ?? str(i.description) ?? 'Bash');
    case 'Read':
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
    case 'NotebookRead':
      return path ?? name;
    case 'Grep':
    case 'Glob': {
      const pattern = str(i.pattern) ?? '';
      return oneLine(path ? `${pattern} in ${path}` : pattern || name);
    }
    case 'LS':
      return path ?? 'LS';
    case 'WebFetch':
      return str(i.url) ?? 'WebFetch';
    case 'WebSearch':
      return oneLine(str(i.query) ?? 'WebSearch');
    case 'Task':
    case 'Agent': {
      const d = str(i.description) ?? str(i.subagent_type) ?? name;
      return oneLine(i.subagent_type && d !== i.subagent_type ? `${d} (${String(i.subagent_type)})` : d);
    }
    case 'TodoWrite':
      return 'Update todo list';
    case 'TaskCreate':
      return oneLine(`Add task: ${str(i.subject) ?? ''}`);
    case 'TaskUpdate':
      return oneLine(`Update task ${str(i.taskId) ?? ''}${i.status ? ` → ${String(i.status)}` : ''}`);
    case 'ExitPlanMode':
      return 'Exit plan mode';
    case 'AskUserQuestion': {
      const qs = Array.isArray(i.questions) ? (i.questions as { question?: unknown }[]) : [];
      return oneLine(str(qs[0]?.question) ?? 'Question');
    }
    case 'Skill':
      return oneLine(`Skill: ${str(i.skill) ?? str(i.command) ?? ''}`);
    default: {
      if (name.startsWith('mcp__')) {
        const [, server = '', tool = ''] = name.split('__');
        return `${server}: ${tool}`;
      }
      const hint = str(i.description) ?? path ?? str(i.command) ?? str(i.query) ?? str(i.url);
      return hint ? oneLine(`${name}: ${hint}`) : name;
    }
  }
}

/** bizzi input blocks -> Anthropic user message content. Text-only input stays a string so slash commands work. */
export function toUserContent(input: InputBlock[]): UserContent {
  const fileRef = (p: string) => (/\s/.test(p) ? `@"${p}"` : `@${p}`);
  if (input.every((b) => b.type !== 'image')) {
    return input.map((b) => (b.type === 'text' ? b.text : b.type === 'file' ? fileRef(b.path) : '')).join('\n\n');
  }
  type Block = Exclude<UserContent, string>[number];
  const blocks: Block[] = [];
  for (const b of input) {
    if (b.type === 'text') blocks.push({ type: 'text', text: b.text } as Block);
    else if (b.type === 'file') blocks.push({ type: 'text', text: fileRef(b.path) } as Block);
    else
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: b.mediaType, data: b.dataBase64 },
      } as Block);
  }
  return blocks;
}

export function trimOutput(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  return `${text.slice(0, head)}\n… [${text.length - max} chars trimmed] …\n${text.slice(text.length - tail)}`;
}

/** Text of a tool_result block's content (string or content blocks). */
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content === undefined || content === null ? '' : JSON.stringify(content);
  return content
    .map((b: { type?: string; text?: string }) => (b?.type === 'text' ? (b.text ?? '') : b?.type ? `[${b.type}]` : ''))
    .filter(Boolean)
    .join('\n');
}

export interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export function unifiedDiff(path: string, hunks: PatchHunk[], created: boolean): string {
  const rel = path.replace(/^\/+/, '');
  const out = [created ? '--- /dev/null' : `--- a/${rel}`, `+++ b/${rel}`];
  for (const h of hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines);
  }
  return out.join('\n');
}

export function todoItems(todos: unknown): PlanItem[] | undefined {
  if (!Array.isArray(todos)) return undefined;
  return todos
    .filter((t): t is { content: string; status: string } => !!t && typeof t.content === 'string')
    .map((t) => ({ text: t.content, status: normStatus(t.status) }));
}

export function normStatus(s: unknown): PlanItem['status'] {
  return s === 'in_progress' || s === 'completed' ? s : 'pending';
}

export function stopReasonOf(r: SDKResultMessage, interrupted: boolean): { stopReason: StopReason; error?: string } {
  if (interrupted) return { stopReason: 'interrupted' };
  if (r.terminal_reason === 'aborted_streaming' || r.terminal_reason === 'aborted_tools') {
    return { stopReason: 'interrupted' };
  }
  if (r.subtype === 'success') {
    if (r.is_error) return { stopReason: 'error', error: r.result || 'Claude Code reported an error' };
    if (r.stop_reason === 'refusal') return { stopReason: 'refusal' };
    if (r.stop_reason === 'max_tokens') return { stopReason: 'other', error: 'max_tokens' };
    return { stopReason: 'end_turn' };
  }
  const error = r.errors?.length ? r.errors.join('; ') : r.subtype;
  switch (r.subtype) {
    case 'error_max_turns':
      return { stopReason: 'max_turns', error };
    case 'error_during_execution':
      return { stopReason: 'error', error };
    default:
      return { stopReason: 'other', error };
  }
}

/** Per-result token usage (the main loop of this SDK turn). */
export function resultTokens(r: SDKResultMessage): Usage {
  const u = r.usage as unknown as Record<string, number | undefined>;
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
}

/** Session-cumulative usage from a result's modelUsage (all models, subagents included). */
export function sessionUsage(r: SDKResultMessage, model?: string): Usage {
  const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: r.total_cost_usd };
  let window: number | undefined;
  for (const [name, m] of Object.entries(r.modelUsage ?? {})) {
    usage.inputTokens! += m.inputTokens;
    usage.outputTokens! += m.outputTokens;
    usage.cacheReadTokens! += m.cacheReadInputTokens;
    usage.cacheWriteTokens! += m.cacheCreationInputTokens;
    if (m.contextWindow && (window === undefined || name === model || m.canonicalModel === model)) window = m.contextWindow;
  }
  if (window !== undefined) usage.contextWindow = window;
  return usage;
}

export function addUsage(a: Usage | undefined, b: Usage): Usage {
  if (!a) return { ...b };
  const out: Usage = { ...a };
  for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'costUsd'] as const) {
    if (b[k] !== undefined) out[k] = (out[k] ?? 0) + b[k];
  }
  if (b.contextWindow !== undefined) out.contextWindow = b.contextWindow;
  return out;
}

// ---------------------------------------------------------------- questions

interface AskQuestion {
  question?: unknown;
  header?: unknown;
  multiSelect?: unknown;
  options?: { label?: unknown; description?: unknown }[];
}

function askQuestions(input: Record<string, unknown>): AskQuestion[] {
  return Array.isArray(input.questions) ? (input.questions as AskQuestion[]).filter((q) => q && typeof q === 'object') : [];
}

/**
 * AskUserQuestion input -> QuestionItems. The item id is the question text, because Claude Code
 * keys its `answers` by question text. Every question also accepts free text ("Other").
 */
export function askUserQuestionItems(input: Record<string, unknown>): QuestionItem[] {
  return askQuestions(input).map((q, i) => {
    const text = typeof q.question === 'string' && q.question ? q.question : `Question ${i + 1}`;
    const item: QuestionItem = { id: text, text, allowText: true };
    if (typeof q.header === 'string' && q.header) item.header = q.header;
    const options = (Array.isArray(q.options) ? q.options : [])
      .filter((o) => o && typeof o.label === 'string')
      .map((o) =>
        typeof o.description === 'string' && o.description ? { label: String(o.label), description: o.description } : { label: String(o.label) },
      );
    if (options.length) item.options = options;
    if (q.multiSelect === true) item.multiSelect = true;
    return item;
  });
}

function answerString(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  const s = Array.isArray(v) ? v.map(String).filter(Boolean).join(', ') : String(v);
  return s.length ? s : undefined;
}

/**
 * bizzi answers -> the `answers` map Claude Code expects in AskUserQuestion's updatedInput
 * (question text -> answer; multi-select answers comma-separated). Answers may be keyed by
 * item id (the question text), header, or index.
 */
export function askUserQuestionAnswers(input: Record<string, unknown>, answers: QuestionAnswers): Record<string, string> {
  const out: Record<string, string> = {};
  askUserQuestionItems(input).forEach((item, i) => {
    const v = answerString(answers[item.id] ?? (item.header ? answers[item.header] : undefined) ?? answers[String(i)]);
    if (v !== undefined) out[item.text] = v;
  });
  return out;
}

// ---------------------------------------------------------------- MCP elicitation

interface SchemaProp {
  type?: unknown;
  title?: unknown;
  description?: unknown;
  enum?: unknown;
  enumNames?: unknown;
  oneOf?: unknown;
  anyOf?: unknown;
  items?: { enum?: unknown; anyOf?: unknown; oneOf?: unknown };
}

function enumOptions(p: { enum?: unknown; enumNames?: unknown; oneOf?: unknown; anyOf?: unknown }): { label: string; value: unknown }[] | undefined {
  if (Array.isArray(p.enum)) {
    const names = Array.isArray(p.enumNames) ? p.enumNames : [];
    return p.enum.map((v, i) => ({ label: typeof names[i] === 'string' ? (names[i] as string) : String(v), value: v }));
  }
  const alts = Array.isArray(p.oneOf) ? p.oneOf : Array.isArray(p.anyOf) ? p.anyOf : undefined;
  if (alts?.length && alts.every((a) => a && typeof a === 'object' && 'const' in a)) {
    return (alts as { const: unknown; title?: unknown }[]).map((a) => ({ label: typeof a.title === 'string' ? a.title : String(a.const), value: a.const }));
  }
  return undefined;
}

export interface ElicitationForm {
  items: QuestionItem[];
  /** QuestionAnswers -> the `content` of an accepted elicitation, or null when the answers decline it. */
  content(answers: QuestionAnswers): Record<string, unknown> | null;
}

const ACCEPT = 'Accept';
const DECLINE = 'Decline';

/** An MCP elicitation (form or URL mode) as bizzi questions: one question per schema field. */
export function elicitationForm(req: {
  message: string;
  mode?: string;
  url?: string;
  requestedSchema?: Record<string, unknown>;
  serverName?: string;
  title?: string;
  displayName?: string;
}): ElicitationForm {
  const schema = req.requestedSchema ?? {};
  const props = (schema.properties && typeof schema.properties === 'object' ? schema.properties : {}) as Record<string, SchemaProp>;
  const keys = req.mode === 'url' ? [] : Object.keys(props);
  const label = req.title ?? req.displayName ?? req.serverName;
  if (!keys.length) {
    // URL mode or an empty form: a confirmation.
    const text = req.mode === 'url' && req.url ? `${req.message}\n${req.url}` : req.message;
    return {
      items: [{ id: 'confirm', text, ...(label ? { header: label } : {}), options: [{ label: ACCEPT }, { label: DECLINE }] }],
      content: (answers) => {
        const a = answers.confirm;
        return (Array.isArray(a) ? a[0] : a) === DECLINE ? null : {};
      },
    };
  }
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const optionsOf = (p: SchemaProp) =>
    p.type === 'array' ? enumOptions(p.items ?? {}) : p.type === 'boolean' ? [{ label: 'Yes', value: true }, { label: 'No', value: false }] : enumOptions(p);
  const items: QuestionItem[] = keys.map((key) => {
    const p = props[key] ?? {};
    const title = typeof p.title === 'string' && p.title ? p.title : key;
    const desc = typeof p.description === 'string' && p.description ? p.description : undefined;
    let text = keys.length === 1 ? [req.message, desc ?? (title !== key ? title : undefined)].filter(Boolean).join('\n') : (desc ?? title);
    if (keys.length > 1 && !required.has(key)) text += ' (optional)';
    const item: QuestionItem = { id: key, text, header: title };
    const opts = optionsOf(p);
    if (opts) {
      item.options = opts.map((o) => ({ label: o.label }));
      if (p.type === 'array') item.multiSelect = true;
    } else item.allowText = true;
    return item;
  });
  return {
    items,
    content(answers) {
      const out: Record<string, unknown> = {};
      for (const key of keys) {
        const p = props[key] ?? {};
        const raw = answers[key];
        if (raw === undefined || raw === '' || (Array.isArray(raw) && !raw.length)) continue;
        const first = String(Array.isArray(raw) ? raw[0] : raw);
        const opts = optionsOf(p);
        const pick = (s: string) => opts?.find((o) => o.label === s || String(o.value) === s)?.value ?? s;
        switch (p.type) {
          case 'boolean': {
            const v = pick(first);
            out[key] = typeof v === 'boolean' ? v : ['yes', 'true', 'y', '1'].includes(first.trim().toLowerCase());
            break;
          }
          case 'number':
          case 'integer': {
            const n = Number(first);
            if (Number.isFinite(n)) out[key] = p.type === 'integer' ? Math.trunc(n) : n;
            break;
          }
          case 'array':
            out[key] = (Array.isArray(raw) ? raw : first.split(',').map((s) => s.trim()).filter(Boolean)).map(pick);
            break;
          default:
            out[key] = pick(first);
        }
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------- server-side tool results

/** A server tool result block (web_search_tool_result, web_fetch_tool_result, code execution, mcp_tool_result, …). */
export function serverToolResult(b: Record<string, unknown>): { status: 'ok' | 'error'; text: string } {
  const c = b.content as unknown;
  if (b.type === 'mcp_tool_result') return { status: b.is_error === true ? 'error' : 'ok', text: toolResultText(c) };
  if (Array.isArray(c)) {
    const lines = c.map((r: Record<string, unknown>) => {
      if (r?.type === 'web_search_result') return [r.title, r.url].filter((s) => typeof s === 'string' && s).join(' — ');
      if (r?.type === 'text') return String(r.text ?? '');
      return r?.type ? `[${String(r.type)}]` : '';
    });
    return { status: 'ok', text: lines.filter(Boolean).join('\n') };
  }
  if (c && typeof c === 'object') {
    const r = c as Record<string, unknown>;
    const type = String(r.type ?? '');
    if (type.endsWith('_error') || typeof r.error_code === 'string') return { status: 'error', text: String(r.error_code ?? type) };
    if (typeof r.stdout === 'string' || typeof r.stderr === 'string') {
      const text = [r.stdout, r.stderr].filter((s) => typeof s === 'string' && s).join('\n');
      const failed = typeof r.return_code === 'number' && r.return_code !== 0;
      return { status: failed ? 'error' : 'ok', text: failed && !text ? `exit code ${String(r.return_code)}` : text };
    }
    if (type === 'web_fetch_result') return { status: 'ok', text: String(r.url ?? '') };
    return { status: 'ok', text: JSON.stringify(r) };
  }
  return { status: 'ok', text: typeof c === 'string' ? c : '' };
}
