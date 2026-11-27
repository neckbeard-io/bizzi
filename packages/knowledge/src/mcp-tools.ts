// bizzi-memory MCP server (§5): tools over the local knowledge replica, so it works offline.
// Every write goes through the policy engine; every read through the resolver.

import { parseArgs } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { AGENT_KINDS, BizziError } from '@bizzi/protocol';
import type { AgentKind } from '@bizzi/protocol';
import { addKnowledge, defaultScopeLevel, forgetKnowledge, originFromContext, updateKnowledge } from './pipeline.ts';
import type { WriteResult } from './pipeline.ts';
import { registerHistoryTools, type HistorySource } from './history.ts';
import { registerBrowseTools } from './mcp-browse.ts';
import { loadSettings } from './policy.ts';
import { rankMemories } from './resolver.ts';
import { contextHasLevel, scopeLabel } from './scope.ts';
import type { KnowledgeStore } from './store.ts';
import type { KnowledgeContext, KnowledgeItem, SessionScopeLevel } from './types.ts';
import { MEMORY_KINDS, SESSION_SCOPE_LEVELS } from './types.ts';

export const MCP_SERVER_VERSION = '0.0.1';

const SCOPE_GUIDE =
  'Scopes: "workspace" = only this directory on this machine; "project" = this project on every machine and ' +
  'workspace; "machine" = this machine, every project (e.g. local paths, installed tools); "global" = you, ' +
  'everywhere (personal style and preferences); "session" = this session only (scratch notes). "tag" items apply ' +
  'on every machine with that tag; the user sets them, so you see them but cannot write at that scope.';

export function serverInstructions(ctx: KnowledgeContext): string {
  const available = SESSION_SCOPE_LEVELS.filter((l) => contextHasLevel(l, ctx));
  return [
    'bizzi-memory is a knowledge store shared by every coding agent (Claude, Codex, OpenCode, agy) and every machine ' +
      'the user works on. Rules (prescriptive: "always use pnpm") are injected into every matching session; memories ' +
      '(descriptive: "staging DB is on server-a:5433") are retrieved by relevance.',
    'When to use it:',
    '- Search (memory_search) before investigating something a previous session may already have figured out.',
    '- Save (memory_add) durable, non-obvious knowledge a future session would want: setup steps, gotchas and their ' +
      'causes, decisions and why, where things live. Not transient progress, not things obvious from the code, never secrets.',
    '- When the user tells you to always / never do something, record it with rule_add and userRequested: true. ' +
      'Only propose rules on your own initiative (userRequested: false) when clearly useful; they go to the user for review.',
    '- If something you find is wrong or outdated, fix it with knowledge_update or retire it with knowledge_forget.',
    '- To see what applies to you: rules_in_effect lists the rules in force with their ids (to cite or fix them); ' +
      'knowledge_list browses rules and memories by scope, kind, tags and status, including suggestions you proposed ' +
      'that are still waiting for review; knowledge_get reads one item in full with its history.',
    '- Before proposing something, check knowledge_list for a pending suggestion that already says it. You can amend ' +
      '(knowledge_update) or withdraw (knowledge_forget) suggestions this session made, not other sessions\' ones.',
    '- When a workspace or project item turns out to hold more widely, propose the move with knowledge_promote.',
    '- For what earlier sessions in this project did (any agent, including ended sessions): history_search finds ' +
      'where something was asked or answered, and handoff_brief summarises one session (what it was asked, files ' +
      'changed, PRs, where it ended, open questions) so you can pick up or check its work.',
    'Approving or rejecting suggestions is the user\'s, in their inbox; no tool does it.',
    SCOPE_GUIDE,
    `Scopes available in this session: ${available.join(', ')}. When you omit scope, the user's default applies.`,
    'Depending on the user\'s settings a write may go live immediately or wait in their inbox as a suggestion; the tool result says which.',
  ].join('\n');
}

function text(t: string, structured?: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: t }], ...(structured ? { structuredContent: structured } : {}) };
}

function errorResult(err: unknown): CallToolResult {
  const msg = err instanceof BizziError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: msg }], isError: true };
}

function itemSummary(i: KnowledgeItem): Record<string, unknown> {
  return {
    id: i.id,
    type: i.type,
    scope: i.scope.level,
    ...(i.scope.tag ? { tag: i.scope.tag } : {}),
    ...(i.kind ? { kind: i.kind } : {}),
    title: i.title,
    body: i.body,
    tags: i.tags,
    ...(i.appliesTo ? { appliesTo: i.appliesTo } : {}),
    status: i.status,
    updatedAt: i.updatedAt,
  };
}

function describeWrite(verb: string, r: WriteResult): CallToolResult {
  const i = r.item;
  let msg: string;
  if (r.duplicate) {
    msg = `Already known (${i.status}) at ${i.scope.level} scope: [${i.id}] ${i.title}. Nothing new was saved.`;
  } else if (r.decision === 'suggest') {
    msg = `${verb} as a suggestion [${i.id}] at ${i.scope.level} scope. The user's policy requires review, so it is in their inbox and not live yet.`;
  } else if (r.decision === 'notice') {
    msg = `${verb} and live now [${i.id}] at ${i.scope.level} scope; the user gets an inbox notice and can undo it.`;
  } else {
    msg = `${verb} and live now [${i.id}] at ${i.scope.level} scope.`;
  }
  if (r.scopeDefaulted) msg += ' (No scope given; used the default.)';
  return text(msg, {
    id: i.id,
    status: i.status,
    decision: r.decision,
    scope: i.scope.level,
    duplicate: r.duplicate === true,
    scopeDefaulted: r.scopeDefaulted,
  });
}

const scopeSchema = z.enum(SESSION_SCOPE_LEVELS as [SessionScopeLevel, ...SessionScopeLevel[]]);
const agentsSchema = z.array(z.enum(AGENT_KINDS as [AgentKind, ...AgentKind[]]));
const kindSchema = z.enum(MEMORY_KINDS as [(typeof MEMORY_KINDS)[number], ...(typeof MEMORY_KINDS)[number][]]);

export interface KnowledgeMcpOptions {
  /** Max results for memory_search. Default 10. */
  searchLimit?: number;
  /** Session history for history_search / handoff_brief; without it they say they are unavailable. */
  history?: HistorySource;
}

/** Build the MCP server for one session context. Connect it to a transport yourself (see mcp-server.ts). */
export function createKnowledgeMcpServer(store: KnowledgeStore, ctx: KnowledgeContext, opts: KnowledgeMcpOptions = {}): McpServer {
  const server = new McpServer(
    { name: 'bizzi-memory', version: MCP_SERVER_VERSION },
    { instructions: serverInstructions(ctx), capabilities: { tools: {} } },
  );
  const available = SESSION_SCOPE_LEVELS.filter((l) => contextHasLevel(l, ctx));
  const defaultLevel = defaultScopeLevel(loadSettings(store), ctx);
  const scopeDesc = `${SCOPE_GUIDE} Available here: ${available.join(', ')}.`;

  server.registerTool(
    'memory_search',
    {
      title: 'Search bizzi memory',
      description:
        'Ranked full-text search over the memories (or rules) visible to this session: global, this machine, ' +
        'this project, this workspace and this session, written by any agent on any machine. Use it before ' +
        're-investigating something; results are ranked by relevance, scope specificity and recency.',
      inputSchema: {
        query: z.string().min(1).describe('Keywords or a short natural-language question.'),
        scope: scopeSchema.optional().describe('Only return items stored at this scope level.'),
        type: z.enum(['memory', 'rule']).optional().describe('Default "memory". Rules are already in your instructions.'),
        limit: z.number().int().min(1).max(50).optional().describe('Max results (default 10).'),
      },
    },
    async (args) => {
      try {
        const limit = args.limit ?? opts.searchLimit ?? 10;
        let items: Array<{ item: KnowledgeItem; score: number }>;
        if ((args.type ?? 'memory') === 'memory') {
          items = rankMemories(store, ctx, { query: args.query, limit, ...(args.scope ? { scopeLevel: args.scope } : {}) });
        } else {
          items = store
            .search(args.query, { context: ctx, type: 'rule', limit: 200 })
            .filter((h) => !args.scope || h.item.scope.level === args.scope)
            .slice(0, limit)
            .map((h) => ({ item: h.item, score: h.relevance }));
        }
        if (items.length === 0) return text(`No ${args.type ?? 'memory'} items match "${args.query}".`, { results: [] });
        const lines = items.map(
          ({ item }) =>
            `[${item.id}] (${scopeLabel(item.scope)}${item.kind ? `, ${item.kind}` : ''}) ${item.title}\n${item.body}`.trim(),
        );
        return text(lines.join('\n\n'), {
          results: items.map(({ item, score }) => ({ ...itemSummary(item), score: Number(score.toFixed(4)) })),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'memory_add',
    {
      title: 'Save a memory',
      description:
        'Save a descriptive memory (a fact, gotcha, decision, procedure…) so every agent and machine that works ' +
        'in the same scope can find it later. Keep the title to one line and the body self-contained. Never store ' +
        `secrets. ${scopeDesc} If you omit scope, "${defaultLevel}" is used. The user's policy decides whether it is live ` +
        'immediately or waits for review; the result says which.',
      inputSchema: {
        title: z.string().min(1).max(200).describe('One line, used in digests and for dedupe.'),
        body: z.string().describe('The memory itself: what, why, and how to apply it.'),
        kind: kindSchema.describe(
          'fact = how things are; preference = how the user likes things; decision = a choice and why; ' +
            'gotcha = a trap and its cause; procedure = steps; reference = where to find something; todo = follow-up.',
        ),
        scope: scopeSchema.optional().describe(scopeDesc),
        appliesTo: agentsSchema.optional().describe('Limit to certain agents. Omit for all agents (the usual case).'),
        tags: z.array(z.string()).optional(),
      },
    },
    async (args) => {
      try {
        const r = addKnowledge(
          store,
          {
            type: 'memory',
            title: args.title,
            body: args.body,
            kind: args.kind,
            ...(args.scope ? { scope: args.scope } : {}),
            ...(args.appliesTo ? { appliesTo: args.appliesTo } : {}),
            ...(args.tags ? { tags: args.tags } : {}),
          },
          originFromContext(ctx, 'tool'),
        );
        return describeWrite('Saved', r);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'rule_add',
    {
      title: 'Propose a rule',
      description:
        'Record a prescriptive rule ("always use pnpm", "never touch migrations/") that is injected into every ' +
        'future session in that scope, for every agent unless appliesTo limits it. Set userRequested: true only ' +
        'when the user explicitly asked for it ("from now on, always…"); unprompted rules always go to the user ' +
        `for review. More specific scopes override general ones. ${scopeDesc} Pick the narrowest scope that matches what the user said.`,
      inputSchema: {
        title: z.string().min(1).max(200).describe('The rule in one line, imperative.'),
        body: z.string().describe('Details, rationale, exceptions. May be empty.'),
        scope: scopeSchema.describe(scopeDesc),
        appliesTo: agentsSchema.optional().describe('e.g. ["codex"] for "Codex: run just fmt before finishing". Omit for all agents.'),
        userRequested: z.boolean().describe('True only if the user explicitly asked for this rule.'),
      },
    },
    async (args) => {
      try {
        const r = addKnowledge(
          store,
          {
            type: 'rule',
            title: args.title,
            body: args.body,
            scope: args.scope,
            ...(args.appliesTo ? { appliesTo: args.appliesTo } : {}),
          },
          originFromContext(ctx, 'tool', { userRequested: args.userRequested }),
        );
        return describeWrite('Rule recorded', r);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'knowledge_update',
    {
      title: 'Edit a rule or memory',
      description:
        'Correct or refine an existing rule or memory by id (ids appear in [brackets] in your instructions and in ' +
        'search results). Creates a new version that supersedes the old one, so the change is auditable and ' +
        'reversible. Also amends a pending suggestion this session made (not other sessions\' suggestions; ' +
        `approval is the user's). To widen an item's scope, prefer knowledge_promote. Only pass the fields that change. ${scopeDesc}`,
      inputSchema: {
        id: z.string().min(1),
        title: z.string().min(1).max(200).optional(),
        body: z.string().optional(),
        kind: kindSchema.optional(),
        tags: z.array(z.string()).optional(),
        scope: scopeSchema.optional().describe('Move it to another scope.'),
        appliesTo: agentsSchema.optional().describe('Empty array = all agents.'),
        userRequested: z.boolean().optional().describe('True if the user explicitly asked for this change (rules).'),
      },
    },
    async (args) => {
      try {
        const r = updateKnowledge(
          store,
          args.id,
          {
            ...(args.title !== undefined ? { title: args.title } : {}),
            ...(args.body !== undefined ? { body: args.body } : {}),
            ...(args.kind !== undefined ? { kind: args.kind } : {}),
            ...(args.tags !== undefined ? { tags: args.tags } : {}),
            ...(args.scope !== undefined ? { scope: args.scope } : {}),
            ...(args.appliesTo !== undefined ? { appliesTo: args.appliesTo.length ? args.appliesTo : null } : {}),
          },
          originFromContext(ctx, 'tool', args.userRequested ? { userRequested: true } : {}),
          { context: ctx },
        );
        return describeWrite('Updated', r);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'knowledge_forget',
    {
      title: 'Retire a rule or memory',
      description:
        'Retire a rule or memory that is wrong or no longer true, by id. It is tombstoned (kept for audit, hidden ' +
        'from every session) or, when the user\'s policy requires review, a forget request goes to their inbox. ' +
        'Prefer knowledge_update when the item just needs correcting. On a pending suggestion this session made, it ' +
        'withdraws the suggestion at once; other sessions\' suggestions are the user\'s to reject.',
      inputSchema: {
        id: z.string().min(1),
        reason: z.string().optional().describe('Why it should go (shown to the user on review).'),
        userRequested: z.boolean().optional().describe('True if the user explicitly asked you to forget it.'),
      },
    },
    async (args) => {
      try {
        const r = forgetKnowledge(store, args.id, originFromContext(ctx, 'tool', args.userRequested ? { userRequested: true } : {}), {
          context: ctx,
          ...(args.reason !== undefined ? { reason: args.reason } : {}),
        });
        if (r.decision === 'suggest') {
          return text(`Forget request [${r.item.id}] sent to the user's inbox for review; [${args.id}] stays live until accepted.`, {
            id: r.item.id,
            decision: r.decision,
            status: r.item.status,
          });
        }
        return text(`Forgot [${args.id}].${r.decision === 'notice' ? ' The user gets an inbox notice and can undo it.' : ''}`, {
          id: args.id,
          decision: r.decision,
          status: r.item.status,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  registerBrowseTools(server, store, ctx);

  registerHistoryTools(server, opts.history);

  return server;
}

export interface McpServerConfig {
  dbPath: string;
  context: KnowledgeContext;
}

/** Context from CLI args (`--db --agent --machine-id --project-id --workspace-id --session-id`), falling back to env. */
export function parseServerConfig(argv: string[], env: Record<string, string | undefined> = process.env): McpServerConfig {
  const { values } = parseArgs({
    args: argv,
    options: {
      db: { type: 'string' },
      agent: { type: 'string' },
      'machine-id': { type: 'string' },
      'machine-tag': { type: 'string', multiple: true },
      'project-id': { type: 'string' },
      'workspace-id': { type: 'string' },
      'session-id': { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  const dbPath = values.db ?? env.BIZZI_KNOWLEDGE_DB;
  const agent = values.agent ?? env.BIZZI_AGENT;
  const machineId = values['machine-id'] ?? env.BIZZI_MACHINE_ID;
  const projectId = values['project-id'] ?? env.BIZZI_PROJECT_ID;
  const workspaceId = values['workspace-id'] ?? env.BIZZI_WORKSPACE_ID;
  const sessionId = values['session-id'] ?? env.BIZZI_SESSION_ID;
  const machineTags = values['machine-tag'] ?? (env.BIZZI_MACHINE_TAGS ? env.BIZZI_MACHINE_TAGS.split(',').filter(Boolean) : []);
  if (!dbPath) throw new BizziError('bad_request', 'missing --db (or BIZZI_KNOWLEDGE_DB)');
  if (!machineId) throw new BizziError('bad_request', 'missing --machine-id (or BIZZI_MACHINE_ID)');
  if (!agent || !(AGENT_KINDS as readonly string[]).includes(agent)) {
    throw new BizziError('bad_request', `missing or unknown --agent (or BIZZI_AGENT): ${agent ?? ''}`);
  }
  return {
    dbPath,
    context: {
      agent: agent as AgentKind,
      machineId,
      ...(machineTags.length > 0 ? { machineTags } : {}),
      ...(projectId ? { projectId } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(sessionId ? { sessionId } : {}),
    },
  };
}
