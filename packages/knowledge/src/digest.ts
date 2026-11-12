// Launch-mode projection (§4.1): the text appended to an agent's system prompt (rules in full +
// a ranked memory digest under a token budget + a note about the bizzi-memory tools), and the
// McpServerSpec that launches the bizzi-memory MCP server for the session over stdio.

import { fileURLToPath } from 'node:url';
import { BizziError } from '@bizzi/protocol';
import type { MachineInfo, McpServerSpec, StartSessionOptions } from '@bizzi/protocol';
import { rankMemories, resolveRules } from './resolver.ts';
import { scopeLabel } from './scope.ts';
import type { RankedMemory } from './resolver.ts';
import type { KnowledgeStore } from './store.ts';
import type { KnowledgeContext, KnowledgeItem, ScopeLevel } from './types.ts';

/** Key to use in `StartSessionOptions.mcpServers`. Claude exposes tools as `mcp__bizzi-memory__<tool>`. */
export const MCP_SERVER_NAME = 'bizzi-memory';

/** Absolute path of the stdio MCP server entry (run directly by Node; no build step). */
export const MCP_SERVER_ENTRY = fileURLToPath(new URL('./mcp-server.ts', import.meta.url));

/** Rough token estimate (~4 characters per token). Good enough for budgeting a digest. */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface DigestOptions {
  store: KnowledgeStore;
  /** E.g. the session's first prompt: memories matching it rank first. */
  query?: string;
  /** Approximate token budget for the memory digest (rules are always included in full). Default 1200. */
  memoryTokenBudget?: number;
  /** Hard cap on digest entries. Default 15. */
  maxMemories?: number;
  /** Max characters of each memory body in the digest. Default 240. */
  memoryExcerptChars?: number;
  /** Include the paragraph about the bizzi-memory tools. Default true. */
  includeToolsNote?: boolean;
  /** The machine the session runs on: adds the machine card (knowledge.md §9.2). */
  machine?: MachineCardFacts;
  /** Clock for recency ranking (tests). */
  now?: number;
}

export interface KnowledgeDigest {
  text: string;
  rules: KnowledgeItem[];
  /** Memories included in the digest, best first. */
  memories: RankedMemory[];
  /** Visible memories that were ranked but didn't fit. */
  omittedMemories: number;
  approxTokens: number;
  memoryTokens: number;
}

/** What the machine card is built from: facts the node has plus the user's tags and description. */
export type MachineCardFacts = Pick<MachineInfo, 'name' | 'os' | 'arch' | 'headful' | 'alwaysOn' | 'tags' | 'description'>;

const LEVEL_TITLE: Record<ScopeLevel, string> = {
  global: 'Global (everywhere)',
  tag: 'Tag (every machine with this tag)',
  machine: 'Machine (this machine, every project)',
  project: 'Project (this project, every machine)',
  workspace: 'Workspace (only this directory on this machine)',
  session: 'Session (this session only)',
  team: 'Team',
};

export const RULES_PREAMBLE =
  'These rules come from bizzi and apply to this session. They are listed from the most general scope to the ' +
  'most specific (global, tag, machine, project, workspace, session). When two rules conflict, the more specific ' +
  'scope (later in this list) overrides the more general one.';

export const TOOLS_NOTE =
  'You have the bizzi-memory MCP server: a knowledge store shared by every coding agent (Claude, Codex, OpenCode, ' +
  'agy) and every machine working here. Call `memory_search` before digging for something a previous session may ' +
  'already know (setup steps, gotchas, decisions, where things are). Call `memory_add` when you learn something ' +
  'durable and non-obvious that a future session would want; pick a scope: `workspace` = only this directory on this ' +
  'machine, `project` = this project on every machine (the default), `machine` = this machine for every project, ' +
  '`global` = everywhere, `session` = this session only. When the user tells you to always or never do something, ' +
  'record it with `rule_add` and `userRequested: true`. Fix or retire outdated entries with `knowledge_update` / ' +
  '`knowledge_forget`, using the ids in brackets. Never store secrets.';

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function excerpt(s: string, max: number): string {
  const t = oneLine(s);
  return t.length <= max ? t : `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function ruleLine(r: KnowledgeItem): string {
  const agents = r.appliesTo?.length ? ` (${r.appliesTo.join(', ')} only)` : '';
  const body = r.body.trim();
  const head = `- **${oneLine(r.title)}**${agents} [${r.id}]`;
  if (!body) return head;
  // Rules are injected in full; keep multi-line bodies readable as an indented block.
  const lines = body.split('\n');
  return lines.length === 1 ? `${head}: ${body}` : `${head}\n${lines.map((l) => `  ${l}`).join('\n')}`;
}

function memoryLine(m: KnowledgeItem, excerptChars: number): string {
  const tag = m.kind ? `${scopeLabel(m.scope)}, ${m.kind}` : scopeLabel(m.scope);
  const body = excerpt(m.body, excerptChars);
  return `- (${tag}) **${oneLine(m.title)}**${body ? ` — ${body}` : ''} [${m.id}]`;
}

function levelTitle(scope: KnowledgeItem['scope']): string {
  return scope.level === 'tag' && scope.tag ? `Tag \`${scope.tag}\` (every machine with this tag)` : LEVEL_TITLE[scope.level];
}

export function renderRules(rules: KnowledgeItem[]): string {
  if (rules.length === 0) return '';
  const out = ['## Rules', RULES_PREAMBLE];
  let heading: string | undefined;
  for (const r of rules) {
    const title = levelTitle(r.scope);
    if (title !== heading) {
      heading = title;
      out.push('', `### ${title}`);
    }
    out.push(ruleLine(r));
  }
  return out.join('\n');
}

const OS_NAME: Record<MachineInfo['os'], string> = { darwin: 'macOS', linux: 'Linux', win32: 'Windows', other: 'an unknown OS' };

/**
 * The machine card (knowledge.md §9.2): where this session runs, generated from facts so it stays
 * current. Says "always on" only when the node knows it; it never guesses that a machine sleeps.
 */
export function renderMachineCard(m: MachineCardFacts): string {
  const facts = [`${OS_NAME[m.os]} (${m.arch})`, m.headful ? 'has a GUI session (apps, simulators, headed browsers)' : 'headless (no GUI)'];
  if (m.alwaysOn) facts.push('always on');
  const out = ['## This machine', `You are running on **${oneLine(m.name)}**: ${facts.join(', ')}.`];
  if (m.tags.length > 0) out.push(`Tags: ${m.tags.map((t) => `\`${t}\``).join(', ')}.`);
  const description = m.description?.trim();
  if (description) out.push('', 'What the user says this machine is for:', description);
  return out.join('\n');
}

export function buildKnowledgeDigest(context: KnowledgeContext, opts: DigestOptions): KnowledgeDigest {
  const { store } = opts;
  const budget = opts.memoryTokenBudget ?? 1200;
  const maxMemories = opts.maxMemories ?? 15;
  const excerptChars = opts.memoryExcerptChars ?? 240;
  const rules = resolveRules(store, context);
  const ranked = rankMemories(store, context, {
    ...(opts.query !== undefined ? { query: opts.query } : {}),
    requireMatch: false,
    limit: 1000,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });

  const memHeader = ['## Memory digest', 'What bizzi remembers about this context, most relevant first (search for more with `memory_search`):'];
  const included: RankedMemory[] = [];
  const lines: string[] = [];
  let used = approxTokens(memHeader.join('\n'));
  for (const m of ranked) {
    if (included.length >= maxMemories) break;
    const line = memoryLine(m.item, excerptChars);
    const cost = approxTokens(`${line}\n`);
    if (used + cost > budget) continue; // a shorter one further down may still fit
    included.push(m);
    lines.push(line);
    used += cost;
  }

  const sections: string[] = [];
  if (opts.machine) sections.push(renderMachineCard(opts.machine));
  const rulesText = renderRules(rules);
  if (rulesText) sections.push(rulesText);
  let memoryTokens = 0;
  if (lines.length > 0) {
    const text = [...memHeader, ...lines].join('\n');
    memoryTokens = approxTokens(text);
    sections.push(text);
  }
  if (opts.includeToolsNote !== false) sections.push(`## bizzi-memory tools\n${TOOLS_NOTE}`);
  const text = sections.length ? `# bizzi knowledge\n\n${sections.join('\n\n')}\n` : '';
  return {
    text,
    rules,
    memories: included,
    omittedMemories: ranked.length - included.length,
    approxTokens: approxTokens(text),
    memoryTokens,
  };
}

/** Text for `StartSessionOptions.systemPromptAppend`. */
export function buildSystemPromptAppend(context: KnowledgeContext, opts: DigestOptions): string {
  return buildKnowledgeDigest(context, opts).text;
}

export interface McpSpecOptions {
  /** Knowledge database file (the same one the node uses). */
  dbPath: string;
  /** Node binary. Default: the current process's. */
  nodePath?: string;
  /** Extra env for the server process. */
  env?: Record<string, string>;
}

/** Command line that runs the bizzi-memory MCP server over stdio for this context. */
export function mcpServerArgs(context: KnowledgeContext, dbPath: string): string[] {
  const args = [MCP_SERVER_ENTRY, '--db', dbPath, '--agent', context.agent, '--machine-id', context.machineId];
  for (const tag of context.machineTags ?? []) args.push('--machine-tag', tag);
  if (context.projectId) args.push('--project-id', context.projectId);
  if (context.workspaceId) args.push('--workspace-id', context.workspaceId);
  if (context.sessionId) args.push('--session-id', context.sessionId);
  return args;
}

export function mcpServerSpec(context: KnowledgeContext, opts: McpSpecOptions): McpServerSpec {
  if (!opts.dbPath || opts.dbPath === ':memory:') {
    throw new BizziError('bad_request', 'the bizzi-memory MCP server needs an on-disk database path');
  }
  return {
    type: 'stdio',
    command: opts.nodePath ?? process.execPath,
    args: mcpServerArgs(context, opts.dbPath),
    ...(opts.env ? { env: { ...opts.env } } : {}),
  };
}

export interface SessionKnowledgeOptions extends DigestOptions {
  /** Default: `store.path`. */
  dbPath?: string;
  nodePath?: string;
  /** Skip the MCP server (e.g. the agent can't take one). */
  withMcp?: boolean;
}

/** Everything a session start needs, ready to spread into `StartSessionOptions`. */
export function knowledgeForSession(
  context: KnowledgeContext,
  opts: SessionKnowledgeOptions,
): Required<Pick<StartSessionOptions, 'systemPromptAppend'>> & Pick<StartSessionOptions, 'mcpServers'> {
  const withMcp = opts.withMcp !== false;
  const systemPromptAppend = buildSystemPromptAppend(context, { ...opts, includeToolsNote: withMcp && opts.includeToolsNote !== false });
  if (!withMcp) return { systemPromptAppend };
  const spec = mcpServerSpec(context, {
    dbPath: opts.dbPath ?? opts.store.path,
    ...(opts.nodePath !== undefined ? { nodePath: opts.nodePath } : {}),
  });
  return { systemPromptAppend, mcpServers: { [MCP_SERVER_NAME]: spec } };
}
