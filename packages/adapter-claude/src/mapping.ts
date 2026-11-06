// Pure mapping helpers: Claude Code tool names / SDK payloads -> bizzi protocol values.

import type { ApprovalKind, InputBlock, PlanItem, StopReason, ToolKind, Usage } from '@bizzi/protocol';
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
