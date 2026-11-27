// bizzi-memory's history tools (§5): `history_search` and `handoff_brief` over the node's session history.
// The history lives in core's event store, not in the knowledge replica, and this server is a stdio
// process with no node connection of its own, so it calls the node's loopback history endpoint with a
// per-session token handed over in its environment. The node scopes every call to the session's project.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { BizziError, type ErrorCode, type HistorySearchResult, type SessionBrief } from '@bizzi/protocol';

export const HISTORY_URL_ENV = 'BIZZI_HISTORY_URL';
export const HISTORY_TOKEN_ENV = 'BIZZI_HISTORY_TOKEN';
const TIMEOUT_MS = 20_000;

export interface HistorySearchArgs {
  query: string;
  scope?: 'project' | 'workspace';
  role?: 'user' | 'assistant';
  sessionId?: string;
  limit?: number;
  offset?: number;
}

/** Where the history tools get their data: the node (over HTTP), or a fake in tests. */
export interface HistorySource {
  search(args: HistorySearchArgs): Promise<HistorySearchResult>;
  brief(sessionId: string): Promise<{ brief: SessionBrief }>;
}

/** The node's loopback history endpoint (`POST { method, params }` with a bearer token). */
export function httpHistorySource(url: string, token: string, fetchImpl: typeof fetch = fetch): HistorySource {
  const call = async <T>(method: string, params: unknown): Promise<T> => {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ method, params }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new BizziError('internal', `bizzi's session history is unreachable (${err instanceof Error ? err.message : String(err)}); is bizzi still running?`);
    }
    const body = (await res.json().catch(() => undefined)) as { result?: T; error?: { code?: string; message?: string } } | undefined;
    if (res.status === 401) throw new BizziError('unauthorized', 'this session can no longer read session history (its token was revoked)');
    if (body?.error) throw new BizziError((body.error.code ?? 'internal') as ErrorCode, body.error.message ?? 'history request failed');
    if (!res.ok || body?.result === undefined) throw new BizziError('internal', `history request failed (HTTP ${res.status})`);
    return body.result;
  };
  return {
    search: (args) => call<HistorySearchResult>('search', args),
    brief: (sessionId) => call<{ brief: SessionBrief }>('brief', { sessionId }),
  };
}

/** From BIZZI_HISTORY_URL / BIZZI_HISTORY_TOKEN, when bizzi set them for this session. */
export function historySourceFromEnv(env: Record<string, string | undefined> = process.env): HistorySource | undefined {
  const url = env[HISTORY_URL_ENV];
  const token = env[HISTORY_TOKEN_ENV];
  return url && token ? httpHistorySource(url, token) : undefined;
}

function text(t: string, structured?: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: t }], ...(structured ? { structuredContent: structured } : {}) };
}

function errorResult(err: unknown): CallToolResult {
  const msg = err instanceof BizziError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: msg }], isError: true };
}

export function registerHistoryTools(server: McpServer, source: HistorySource | undefined): void {
  const unavailable = (tool: string): CallToolResult =>
    text(
      `${tool} is not available in this session: bizzi did not give it access to session history (an older bizzi, or ` +
        'the agent-to-agent server is turned off). Use memory_search for saved knowledge instead.',
      { available: false },
    );

  server.registerTool(
    'history_search',
    {
      title: 'Search past sessions',
      description:
        "Full-text search over this project's sessions on this machine, any agent, including ended ones: the user's " +
        'prompts and the agents\' replies. Words must all match; "quoted phrases", word* prefixes and OR work. Best ' +
        'match first, with the session id, title, seq, time and a snippet (matches in [ ]). Use it to find where ' +
        'something was discussed or decided, then handoff_brief for that session. scope "workspace" narrows to this ' +
        'workspace (and its worktrees); the default "project" is this repo with all its worktrees.',
      inputSchema: {
        query: z.string().min(1),
        scope: z.enum(['project', 'workspace']).optional(),
        role: z.enum(['user', 'assistant']).optional().describe('Only prompts (user) or only replies (assistant).'),
        sessionId: z.string().optional().describe('Search one session.'),
        limit: z.number().int().min(1).max(50).optional().describe('Default 10.'),
        offset: z.number().int().nonnegative().optional(),
      },
    },
    async (args) => {
      if (!source) return unavailable('history_search');
      try {
        const r = await source.search({
          query: args.query,
          ...(args.scope ? { scope: args.scope } : {}),
          ...(args.role ? { role: args.role } : {}),
          ...(args.sessionId ? { sessionId: args.sessionId } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
          ...(args.offset !== undefined ? { offset: args.offset } : {}),
        });
        if (r.hits.length === 0) return text('No matches in past sessions.', { ...r });
        const lines = r.hits.map((h) => `- ${h.sessionId} "${h.title ?? 'Untitled'}" (${h.agent}) ${h.ts} seq ${h.seq} ${h.role}: ${h.snippet.replace(/\s+/g, ' ')}`);
        if (r.nextOffset !== undefined) lines.push(`More: offset ${r.nextOffset}.`);
        if (!r.fullText) lines.push('(Substring matching: this SQLite has no FTS5.)');
        return text(lines.join('\n'), { ...r });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'handoff_brief',
    {
      title: 'Brief on another session',
      description:
        "A compact brief of any session in this project on this machine, for picking up or checking its work: what it " +
        'was asked (first and latest requests), what it did (turns, tools, files changed, PRs mentioned), where it ' +
        'ended (state, last reply) and what is still open (pending approvals and questions, or a last reply that asks ' +
        'the user something, which is a heuristic). No transcript. Session ids come from history_search or ' +
        'bizzi-agents sessions_overview.',
      inputSchema: { sessionId: z.string().min(1) },
    },
    async (args) => {
      if (!source) return unavailable('handoff_brief');
      try {
        const { brief } = await source.brief(args.sessionId);
        return text(brief.text, { ...brief });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
