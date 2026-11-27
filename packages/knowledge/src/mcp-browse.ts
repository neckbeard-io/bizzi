// bizzi-memory browse tools (knowledge.md §5): list, inspect and cite what applies to a session,
// and propose moving an item to a wider scope. Reads go through `access.ts` (never outside the
// session's scopes); the one write goes through the write pipeline and the user's policy.
// Approving or rejecting suggestions stays with the user: there is no tool for it.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { BizziError } from '@bizzi/protocol';
import { getWithHistory, listForSession, moveToScope, planScopeMove } from './access.ts';
import type { HistoryEntry } from './access.ts';
import { isForgetRequest } from './inbox.ts';
import { originFromContext } from './pipeline.ts';
import { resolveRules } from './resolver.ts';
import { contextHasLevel, isOwnSuggestion, scopeLabel } from './scope.ts';
import type { KnowledgeStore } from './store.ts';
import type { KnowledgeContext, KnowledgeItem, SessionScopeLevel } from './types.ts';
import { MEMORY_KINDS, SESSION_SCOPE_LEVELS } from './types.ts';

/** Max characters of a body in knowledge_list (knowledge_get returns it in full). */
export const LIST_BODY_CHARS = 280;

const APPROVAL_NOTE = 'Approving or rejecting suggestions is the user\'s, in their inbox; no tool does it.';

function text(t: string, structured?: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: t }], ...(structured ? { structuredContent: structured } : {}) };
}

function errorResult(err: unknown): CallToolResult {
  const msg = err instanceof BizziError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: msg }], isError: true };
}

function trimBody(body: string, max: number): { body: string; truncated: boolean } {
  const t = body.trim();
  if (t.length <= max) return { body: t, truncated: false };
  return { body: `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…`, truncated: true };
}

function entry(i: KnowledgeItem, ctx: KnowledgeContext, bodyChars?: number): Record<string, unknown> {
  const b = bodyChars === undefined ? { body: i.body, truncated: false } : trimBody(i.body, bodyChars);
  return {
    id: i.id,
    type: i.type,
    scope: i.scope.level,
    ...(i.scope.tag ? { tag: i.scope.tag } : {}),
    ...(i.kind ? { kind: i.kind } : {}),
    status: i.status,
    title: i.title,
    body: b.body,
    ...(b.truncated ? { truncated: true } : {}),
    tags: i.tags,
    ...(i.appliesTo ? { appliesTo: i.appliesTo } : {}),
    ...(i.supersedes ? { supersedes: i.supersedes } : {}),
    ...(isForgetRequest(i) ? { forgetRequest: true } : {}),
    ...(i.status === 'suggested' ? { mine: isOwnSuggestion(i, ctx.sessionId) } : {}),
    ...(i.source.agent ? { by: i.source.agent } : {}),
    updatedAt: i.updatedAt,
  };
}

function headLine(i: KnowledgeItem, ctx: KnowledgeContext): string {
  const bits = [scopeLabel(i.scope), i.type === 'memory' ? (i.kind ?? 'memory') : 'rule'];
  if (i.status !== 'active') bits.push(i.status === 'suggested' ? (isOwnSuggestion(i, ctx.sessionId) ? 'your suggestion' : 'suggestion') : i.status);
  if (isForgetRequest(i)) bits.push('forget request');
  if (i.appliesTo?.length) bits.push(`${i.appliesTo.join(', ')} only`);
  const sup = i.supersedes?.length ? ` (replaces ${i.supersedes.map((s) => `[${s}]`).join(', ')})` : '';
  return `[${i.id}] (${bits.join(', ')}) ${i.title}${sup}`;
}

const listScopeSchema = z.enum(['global', 'tag', 'machine', 'project', 'workspace', 'session']);
const moveScopeSchema = z.enum(SESSION_SCOPE_LEVELS as [SessionScopeLevel, ...SessionScopeLevel[]]);
const kindSchema = z.enum(MEMORY_KINDS as [(typeof MEMORY_KINDS)[number], ...(typeof MEMORY_KINDS)[number][]]);

/** Register knowledge_list, rules_in_effect, knowledge_get and knowledge_promote on `server`. */
export function registerBrowseTools(server: McpServer, store: KnowledgeStore, ctx: KnowledgeContext): void {
  const wider = SESSION_SCOPE_LEVELS.filter((l) => l !== 'session' && contextHasLevel(l, ctx));

  server.registerTool(
    'knowledge_list',
    {
      title: 'List rules and memories',
      description:
        'Browse the rules and memories visible to this session by scope, kind, tags and status (use memory_search ' +
        'for relevance search). Also lists pending suggestions you or other sessions of your agent proposed, so you ' +
        'can check one before proposing it again, or amend or withdraw your own with knowledge_update / knowledge_forget. ' +
        `Newest first, with trimmed bodies (knowledge_get has the full text and history) and paging. ${APPROVAL_NOTE}`,
      inputSchema: {
        type: z.enum(['rule', 'memory']).optional().describe('Omit for both.'),
        scope: listScopeSchema.optional().describe('Only items stored at this scope level.'),
        kind: kindSchema.optional().describe('Only memories of this kind.'),
        tags: z.array(z.string()).optional().describe('Only items with all of these tags.'),
        status: z
          .enum(['active', 'suggested', 'all'])
          .optional()
          .describe('"active" = live; "suggested" = pending the user\'s review; "all" (default) = both.'),
        mine: z.boolean().optional().describe('Only the pending suggestions this session made.'),
        offset: z.number().int().min(0).optional().describe('Paging: skip this many (use nextOffset from the last page).'),
        limit: z.number().int().min(1).max(100).optional().describe('Page size (default 20).'),
      },
    },
    async (args) => {
      try {
        const page = listForSession(store, ctx, {
          ...(args.type ? { type: args.type } : {}),
          ...(args.scope ? { scope: args.scope } : {}),
          ...(args.kind ? { kind: args.kind } : {}),
          ...(args.tags ? { tags: args.tags } : {}),
          ...(args.status ? { status: args.status } : {}),
          ...(args.mine ? { mine: true } : {}),
          ...(args.offset !== undefined ? { offset: args.offset } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        });
        const structured = {
          items: page.items.map((i) => entry(i, ctx, LIST_BODY_CHARS)),
          total: page.total,
          offset: page.offset,
          ...(page.nextOffset !== undefined ? { nextOffset: page.nextOffset } : {}),
        };
        if (page.items.length === 0) return text(page.total > 0 ? `No items past offset ${page.offset} (${page.total} in total).` : 'No items match.', structured);
        const lines = page.items.map((i) => {
          const b = trimBody(i.body, LIST_BODY_CHARS).body;
          return b ? `${headLine(i, ctx)}\n${b}` : headLine(i, ctx);
        });
        const end = page.offset + page.items.length;
        const footer =
          page.nextOffset !== undefined
            ? `Showing ${page.offset + 1}–${end} of ${page.total}; pass offset: ${page.nextOffset} for more.`
            : `Showing ${page.offset + 1}–${end} of ${page.total}.`;
        return text(`${lines.join('\n\n')}\n\n${footer}`, structured);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'rules_in_effect',
    {
      title: 'Rules in effect',
      description:
        'The exact set of rules that apply to this session right now (the same set injected into your instructions ' +
        'at start, plus anything that went live since), ordered from the most general scope to the most specific; ' +
        'a later rule overrides an earlier one it conflicts with. Use the ids to cite a rule or to fix it with ' +
        'knowledge_update / knowledge_forget.',
      inputSchema: {},
    },
    async () => {
      try {
        const rules = resolveRules(store, ctx);
        const structured = { rules: rules.map((r) => entry(r, ctx)) };
        if (rules.length === 0) return text('No rules apply to this session.', structured);
        const out: string[] = [];
        let heading: string | undefined;
        for (const r of rules) {
          const h = scopeLabel(r.scope);
          if (h !== heading) {
            heading = h;
            out.push(`${out.length ? '\n' : ''}## ${h}`);
          }
          const agents = r.appliesTo?.length ? ` (${r.appliesTo.join(', ')} only)` : '';
          out.push(`- [${r.id}] ${r.title}${agents}${r.body.trim() ? `: ${r.body.trim()}` : ''}`);
        }
        return text(`Most general first; more specific scopes override.\n${out.join('\n')}`, structured);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'knowledge_get',
    {
      title: 'Read one rule or memory',
      description:
        'One rule or memory by id, with its full body and version history: the versions it replaced and any that ' +
        'replaced it (edits, moves, forget requests). Works on live items, on suggestions you can see in ' +
        'knowledge_list, and on earlier versions in scopes this session sees.',
      inputSchema: { id: z.string().min(1) },
    },
    async (args) => {
      try {
        const { item, history, hiddenVersions } = getWithHistory(store, args.id, ctx, isForgetRequest);
        const hist = (h: HistoryEntry) =>
          `- ${h.relation === 'earlier' ? 'replaced' : h.forgetRequest ? 'forget request' : 'replaced by'} [${h.id}] (${scopeLabel(h.scope)}, ${h.status}, ${h.updatedAt}) ${h.title}`;
        const lines = [headLine(item, ctx), `updated ${item.updatedAt}${item.tags.length ? `, tags: ${item.tags.join(', ')}` : ''}`, '', item.body || '(no body)'];
        if (history.length > 0) lines.push('', 'History:', ...history.map(hist));
        if (hiddenVersions > 0) lines.push(`(${hiddenVersions} linked version${hiddenVersions === 1 ? '' : 's'} not visible here.)`);
        const current = history.find((h) => h.relation === 'later' && !h.forgetRequest && h.status === 'active');
        if (item.status === 'superseded' && current) lines.push('', `Current version: [${current.id}].`);
        return text(lines.join('\n'), { item: entry(item, ctx), history, hiddenVersions });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'knowledge_promote',
    {
      title: 'Move an item to a wider scope',
      description:
        'Propose moving a rule or memory to a wider scope, e.g. a workspace memory that turns out to hold for the ' +
        `whole project, or a project rule the user wants everywhere. Wider scopes available here: ${wider.join(', ') || 'none'}. ` +
        'The move is a new version at the target scope that replaces the old one once live; the user\'s review ' +
        'policy decides whether it goes live now or waits in their inbox (the old item stays live meanwhile). ' +
        `Pass dryRun: true to see what would happen first. To narrow an item, use knowledge_update. ${APPROVAL_NOTE}`,
      inputSchema: {
        id: z.string().min(1),
        scope: moveScopeSchema.describe('Target scope; must be wider than the item\'s current one.'),
        userRequested: z.boolean().optional().describe('True if the user explicitly asked for this move (rules).'),
        dryRun: z.boolean().optional().describe('Only report what would happen; change nothing.'),
      },
    },
    async (args) => {
      try {
        const origin = originFromContext(ctx, 'tool', args.userRequested ? { userRequested: true } : {});
        const route = (d: string) =>
          d === 'suggest' ? 'go to the user\'s inbox for review' : d === 'notice' ? 'go live now with an inbox notice the user can undo' : 'go live now';
        if (args.dryRun) {
          const plan = planScopeMove(store, args.id, args.scope, ctx, origin);
          const msg = plan.duplicateOf
            ? `An identical ${plan.item.type} already exists at ${args.scope} scope: [${plan.duplicateOf.id}] (${plan.duplicateOf.status}). Nothing to move; retire [${plan.item.id}] with knowledge_forget if it is redundant.`
            : `Moving [${plan.item.id}] from ${scopeLabel(plan.from)} to ${args.scope} scope would ${route(plan.decision)}.`;
          return text(msg, {
            id: plan.item.id,
            from: plan.from.level,
            to: args.scope,
            decision: plan.decision,
            dryRun: true,
            ...(plan.duplicateOf ? { duplicateOf: plan.duplicateOf.id } : {}),
          });
        }
        const { plan, result } = moveToScope(store, args.id, args.scope, ctx, origin);
        if (!result) {
          return text(
            `Not moved: an identical ${plan.item.type} already exists at ${args.scope} scope: [${plan.duplicateOf!.id}] (${plan.duplicateOf!.status}). Retire [${plan.item.id}] with knowledge_forget if it is redundant.`,
            { id: plan.item.id, duplicateOf: plan.duplicateOf!.id, decision: plan.decision, moved: false },
          );
        }
        const i = result.item;
        const msg =
          result.decision === 'suggest'
            ? `Move proposed as [${i.id}] at ${args.scope} scope. The user's policy requires review, so it is in their inbox; [${args.id}] stays live at ${scopeLabel(plan.from)} scope until they accept.`
            : `Moved: [${i.id}] is live at ${args.scope} scope and replaces [${args.id}].${result.decision === 'notice' ? ' The user gets an inbox notice and can undo it.' : ''}`;
        return text(msg, { id: i.id, replaces: args.id, status: i.status, decision: result.decision, from: plan.from.level, to: args.scope, moved: true });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
