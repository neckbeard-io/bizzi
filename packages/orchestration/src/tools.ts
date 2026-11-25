// The bizzi-agents MCP tools (spec §12.1), bound to one calling session. Every decision (limits,
// permissions, budgets, ownership) is the core Orchestrator's; this file only maps tool calls onto it.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { BizziNode } from '@bizzi/core';
import { DEFAULT_READ_TOKENS, DEFAULT_WAIT_MS, MAX_READ_TOKENS, MAX_WAIT_MS, WAIT_UNTIL, type WaitUntil } from '@bizzi/core';
import { AGENT_KINDS, BizziError, type AgentKind, type SessionInfo } from '@bizzi/protocol';

export const MCP_SERVER_NAME = 'bizzi-agents';
export const MCP_SERVER_VERSION = '0.0.1';

export const SERVER_INSTRUCTIONS = [
  'bizzi-agents lets you start helper sessions: full coding-agent sessions (Claude, Codex, OpenCode, agy) on this ' +
    'machine, or on another of the user\'s machines, that the user can watch, steer and stop. Use one to get a second ' +
    'opinion (e.g. ask Codex to review your change), to run independent work in parallel, ideally in its own worktree, ' +
    'or to use another machine (machines_list shows them: a Mac for Xcode builds and screenshots, a server for long runs).',
  'Typical flow: session_start with a self-contained prompt (the helper does not see your conversation) → ' +
    'session_wait until "done" → session_read for a structured summary (final message, changed files, tool counts, ' +
    'stop reason). Ask session_read for detail "diff" (one file) or "full" only when the summary is not enough.',
  'Helpers count against limits (depth, concurrency, budget). Stop helpers you no longer need with session_stop. ' +
    "A helper's approvals and questions go to the user; session_wait tells you when it is waiting on them. If the user " +
    'opted in (parentAnswersApprovals), session_wait also lists them with what you may do, and session_answer answers ' +
    'them: allow only what you could do yourself without asking, inside the helper\'s workspace; deny anything. The user ' +
    'can still answer first; then session_answer says it was already answered.',
].join('\n');

/** Short note appended to the system prompt of sessions that get these tools. */
export const TOOLS_NOTE =
  'You can start helper sessions with the bizzi-agents MCP tools (session_start, session_wait, session_read, ' +
  'session_send, session_answer, session_stop, sessions_list, machines_list): any installed agent on this machine, optionally ' +
  'in a git worktree (`worktree: "<branch>"`), or on another online machine (`machine: "<name>"`). Give helpers ' +
  'self-contained prompts, read their structured results instead of asking for transcripts, and stop them when done.';

function text(t: string, structured?: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: t }], ...(structured ? { structuredContent: structured } : {}) };
}

function errorResult(err: unknown): CallToolResult {
  const msg = err instanceof BizziError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: msg }], isError: true };
}

function helperSummary(s: SessionInfo, self?: string): Record<string, unknown> {
  return {
    sessionId: s.id,
    agent: s.agent,
    status: s.status,
    ...(self !== undefined && s.machineId !== self ? { machineId: s.machineId } : {}),
    ...(s.title ? { title: s.title } : {}),
    workspaceId: s.workspaceId,
    ...(s.scope ? { scope: s.scope } : {}),
    ...(s.depth !== undefined ? { depth: s.depth } : {}),
    ...(s.model ? { model: s.model } : {}),
    ...(s.permissionMode ? { permissionMode: s.permissionMode } : {}),
    ...(s.budget ? { budget: s.budget } : {}),
  };
}

const agentSchema = z.enum(AGENT_KINDS as [AgentKind, ...AgentKind[]]);
const sessionIdSchema = z.string().min(1).describe('A helper id returned by session_start.');

/** The MCP server for one calling session. Stateless: build one per HTTP request. */
export function createAgentsMcpServer(node: BizziNode, callerId: string): McpServer {
  const orch = node.orchestration;
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS, capabilities: { tools: {} } },
  );

  server.registerTool(
    'session_start',
    {
      title: 'Start a helper session',
      description:
        'Start a helper session with any agent installed on this machine (or on `machine`) and send it `prompt`. Returns ' +
        'its sessionId right away; use session_wait / session_read for the result. The helper starts fresh: put ' +
        'everything it needs in the prompt. `worktree: "<branch>"` runs it in a git worktree of the workspace (created ' +
        'if needed) so its edits stay separate. `scope: "child"` (default) stops it when you stop; "detached" outlives ' +
        'you. Its permission mode is never looser than yours. On another machine it works on that machine\'s copy of ' +
        'the files (commit and push anything it should see first); an offline machine fails right away.',
      inputSchema: {
        agent: agentSchema.describe('claude, codex, opencode, agy (terminal) or shell.'),
        prompt: z.string().min(1).describe('The task, self-contained.'),
        machine: z.string().optional().describe('Machine name or id (see machines_list). Default: this machine.'),
        workspace: z
          .string()
          .optional()
          .describe('Workspace id or path registered on the target machine. Default: yours, or on another machine the one linked to yours (same repository).'),
        worktree: z.string().optional().describe('Branch name: run in a worktree of the workspace on this branch.'),
        model: z.string().optional(),
        permissionMode: z.string().optional().describe('Agent permission mode; clamped to be no looser than yours.'),
        effort: z.string().optional(),
        scope: z.enum(['child', 'detached']).optional(),
        title: z.string().optional().describe('Shown in the session list. Default: the start of the prompt.'),
        budget: z
          .object({
            usd: z.number().nonnegative().optional().describe('Metered spend cap (pay-per-token logins only).'),
            tokens: z.number().int().nonnegative().optional(),
            turns: z.number().int().nonnegative().optional(),
          })
          .optional()
          .describe('Cap for this helper and its own helpers; it pauses at the next turn boundary when reached.'),
      },
    },
    async (args) => {
      try {
        const r = await orch.startHelper(callerId, {
          agent: args.agent,
          prompt: args.prompt,
          ...(args.machine ? { machine: args.machine } : {}),
          ...(args.workspace ? { workspace: args.workspace } : {}),
          ...(args.worktree ? { worktree: args.worktree } : {}),
          ...(args.model ? { model: args.model } : {}),
          ...(args.permissionMode ? { permissionMode: args.permissionMode } : {}),
          ...(args.effort ? { effort: args.effort } : {}),
          ...(args.scope ? { scope: args.scope } : {}),
          ...(args.title ? { title: args.title } : {}),
          ...(args.budget ? { budget: args.budget } : {}),
        });
        const s = r.session;
        const where = r.workspace.kind === 'worktree' ? `worktree ${r.workspace.path} (branch ${r.workspace.branch})` : r.workspace.path;
        const lines = [`Started helper ${s.id} (${s.agent}, ${s.scope}) in ${where}${r.queued ? ' — queued until a helper slot frees up' : ''}.`];
        for (const n of r.notes) lines.push(`Note: ${n}`);
        lines.push('Next: session_wait { sessionId, until: "done" }, then session_read.');
        return text(lines.join('\n'), {
          ...helperSummary(s),
          workspacePath: r.workspace.path,
          ...(r.workspace.branch ? { branch: r.workspace.branch } : {}),
          queued: r.queued,
          notes: r.notes,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'session_send',
    {
      title: 'Send a helper a message',
      description: 'Start a new turn in one of your helpers (it must not be mid-turn; check with session_wait first).',
      inputSchema: { sessionId: sessionIdSchema, text: z.string().min(1) },
    },
    async (args) => {
      try {
        const r = await orch.send(callerId, args.sessionId, [{ type: 'text', text: args.text }]);
        return text(`Sent; turn ${r.turnId} started.`, { turnId: r.turnId });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'session_interrupt',
    {
      title: 'Interrupt a helper',
      description: "Interrupt a helper's current turn. The session stays open.",
      inputSchema: { sessionId: sessionIdSchema },
    },
    async (args) => {
      try {
        await orch.interrupt(callerId, args.sessionId);
        return text('Interrupted.');
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'session_wait',
    {
      title: 'Wait for a helper',
      description:
        'Block until a helper reaches a state, then return only the state and a one-line reason. until: "done" = its ' +
        'turn finished or it ended (keeps waiting while the user answers its approvals); "idle" = it stopped working ' +
        '(finished, or waiting on the user); "waiting" = it needs the user (approval, question, budget); "ended". ' +
        'When you may answer its approvals (parentAnswersApprovals), "done" also returns for a new one you may answer, ' +
        'and `pending` lists them for session_answer. ' +
        `On timeout (default ${DEFAULT_WAIT_MS / 1000}s) reached is false; call again.`,
      inputSchema: {
        sessionId: sessionIdSchema,
        until: z.enum(WAIT_UNTIL as [WaitUntil, ...WaitUntil[]]).optional().describe('Default "done".'),
        timeout: z.number().positive().max(MAX_WAIT_MS / 1000).optional().describe('Seconds.'),
      },
    },
    async (args, extra) => {
      try {
        const ms = args.timeout !== undefined ? Math.round(args.timeout * 1000) : DEFAULT_WAIT_MS;
        const r = await orch.wait(callerId, args.sessionId, args.until ?? 'done', ms, extra.signal);
        const lines = [`${r.state}${r.reached ? '' : ' (not yet)'}: ${r.reason}`];
        for (const p of r.pending ?? []) {
          lines.push(`- ${p.type} ${p.id}: ${p.title} — you may ${p.parentMay.join(' or ')}${p.note ? ` (${p.note})` : ''}`);
        }
        return text(lines.join('\n'), { ...r });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ---- parent answers approvals (spec §12.5)
  server.registerTool(
    'session_answer',
    {
      title: "Answer a helper's approval or question",
      description:
        'Only when the user opted in (parentAnswersApprovals): answer one of your helper\'s pending approvals ' +
        '(decision "allow" or "deny") or questions (answers keyed by question id, or cancel). Ids come from ' +
        "session_wait's `pending` or session_read's waitingOn.items. You may allow only what your own permission mode " +
        "does without asking, inside the helper's workspace, while it is within budget; allow_always and edited input " +
        'stay with the user. The user sees every approval too: whoever answers first wins, and a late answer returns ' +
        'answered: false with who answered.',
      inputSchema: {
        sessionId: sessionIdSchema,
        id: z.string().min(1).describe('approvalId or questionId.'),
        decision: z.enum(['allow', 'deny']).optional().describe('Approvals.'),
        message: z.string().optional().describe('Approvals: a note to the helper (e.g. why it was denied).'),
        answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional().describe('Questions: answers keyed by question id.'),
        cancel: z.boolean().optional().describe('Questions: decline to answer.'),
      },
    },
    async (args) => {
      try {
        const r = await orch.answer(callerId, args.sessionId, {
          id: args.id,
          ...(args.decision ? { decision: args.decision } : {}),
          ...(args.message !== undefined ? { message: args.message } : {}),
          ...(args.answers ? { answers: args.answers } : {}),
          ...(args.cancel !== undefined ? { cancel: args.cancel } : {}),
        });
        return text(r.message, { ...r });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'session_read',
    {
      title: "Read a helper's results",
      description:
        'Structured summary of what a helper did (since `since`, a cursor from an earlier read): final message, changed ' +
        'files (pass one as `path` with detail "diff" for its diff), tool counts, stop reason, what it waits on, usage. ' +
        `Not the transcript unless detail is "full". Capped at about maxTokens (default ${DEFAULT_READ_TOKENS}).`,
      inputSchema: {
        sessionId: sessionIdSchema,
        since: z.number().int().nonnegative().optional(),
        maxTokens: z.number().int().min(100).max(MAX_READ_TOKENS).optional(),
        detail: z.enum(['summary', 'full', 'diff']).optional(),
        path: z.string().optional().describe('With detail "diff": the changed file.'),
      },
    },
    async (args) => {
      try {
        const r = await orch.read(callerId, args.sessionId, {
          ...(args.since !== undefined ? { since: args.since } : {}),
          ...(args.maxTokens !== undefined ? { maxTokens: args.maxTokens } : {}),
          ...(args.detail ? { detail: args.detail } : {}),
          ...(args.path ? { path: args.path } : {}),
        });
        return text(JSON.stringify(r, null, 1), { ...r });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'session_stop',
    {
      title: 'Stop a helper',
      description: 'End a helper session (and its own child helpers). Its history stays visible to the user.',
      inputSchema: { sessionId: sessionIdSchema },
    },
    async (args) => {
      try {
        await orch.stop(callerId, args.sessionId);
        return text('Stopped.');
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'sessions_list',
    {
      title: 'List your helpers',
      description: 'The helpers this session started, with their state.',
      inputSchema: {},
    },
    async () => {
      try {
        const helpers = (await orch.listHelpers(callerId)).map((h) => helperSummary(h, node.machine.id));
        if (helpers.length === 0) return text('No helpers.', { helpers: [] });
        const lines = helpers.map((h) => `${String(h.sessionId)} ${String(h.agent)} ${String(h.status)}${h.title ? ` — ${String(h.title)}` : ''}`);
        return text(lines.join('\n'), { helpers });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'machines_list',
    {
      title: 'List machines',
      description:
        "The user's machines a helper can run on (session_start `machine`): online state, OS, GUI, tags, description " +
        'and registered workspaces. Without a hub link only this machine is listed.',
      inputSchema: {},
    },
    async () => {
      try {
        const r = await orch.machines();
        const lines = r.machines.map((m) => {
          const facts = [m.online ? 'online' : `offline${m.lastSeenAt ? ` since ${m.lastSeenAt}` : ''}`, m.os, m.headful ? 'GUI' : 'headless', ...m.tags.map((t) => `#${t}`)];
          const ws = m.workspaces.length ? `\n  workspaces: ${m.workspaces.map((w) => `${w.name} (${w.path})`).join(', ')}` : '';
          return `${m.name}${m.self ? ' (this machine)' : ''} [${m.id}]: ${facts.join(', ')}${m.description ? ` — ${m.description}` : ''}${ws}`;
        });
        if (!r.connected) lines.push('(not connected to a hub: other machines are unavailable)');
        return text(lines.join('\n'), { ...r });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return server;
}
