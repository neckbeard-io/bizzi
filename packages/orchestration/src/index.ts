// @bizzi/orchestration: the agent-to-agent MCP tools (spec §12.1) as a node extension.
//
// The extension serves the bizzi-agents MCP server over HTTP on a loopback port of its own (never on the
// node's client listener, which may be exposed with --host 0.0.0.0), and injects it into every
// structured session bizzi starts, with a per-session bearer token that identifies the caller.

import type { BizziNode, NodeExtension } from '@bizzi/core';
import { GLOBAL_CHANNEL, type Logger, type McpServerSpec } from '@bizzi/protocol';
import { AgentsServer } from './server.ts';
import { MCP_SERVER_NAME, TOOLS_NOTE } from './tools.ts';

export { AgentsServer, HISTORY_PATH, MCP_PATH } from './server.ts';
export { MCP_SERVER_NAME, PROGRESS_EVERY_MS, SERVER_INSTRUCTIONS, SILENT_WAIT_MAX_MS, TOOLS_NOTE, createAgentsMcpServer, type AgentsMcpOptions } from './tools.ts';

export interface OrchestrationExtensionOptions {
  /** Loopback address for the MCP listener (default 127.0.0.1). */
  host?: string;
  /** Default 0: any free port. */
  port?: number;
}

export interface OrchestrationExtension extends NodeExtension {
  /** The MCP endpoint once started. */
  readonly url: string | undefined;
  /**
   * Session history for `sessionId`'s bizzi-memory server (history_search, handoff_brief): the loopback
   * URL and a token for that session, minted anew on each call. Undefined until the server listens.
   */
  historyEndpoint(sessionId: string): { url: string; token: string } | undefined;
}

export function createOrchestrationExtension(opts: OrchestrationExtensionOptions = {}): OrchestrationExtension {
  let server: AgentsServer | undefined;
  let node: BizziNode | undefined;
  let log: Logger | undefined;
  let off: (() => void) | undefined;

  return {
    methods: {},
    get url() {
      return server?.url;
    },
    historyEndpoint(sessionId) {
      return server?.mintHistory(sessionId);
    },
    async start(ctx) {
      node = ctx.node;
      log = ctx.logger.child({ component: 'bizzi-agents' });
      server = new AgentsServer(ctx.node, log);
      await server.listen({ ...(opts.host ? { host: opts.host } : {}), ...(opts.port !== undefined ? { port: opts.port } : {}) });
      // A session's token dies with the session.
      off = ctx.node.bus.on(GLOBAL_CHANNEL, (ev) => {
        if (ev.type === 'session.removed') server?.revoke(ev.data.sessionId);
        else if (ev.type === 'session.updated' && (ev.data.session.status === 'ended' || ev.data.session.status === 'failed')) {
          server?.revoke(ev.data.session.id);
        }
      });
    },
    async stop() {
      off?.();
      off = undefined;
      await server?.close();
      server = undefined;
    },
    prepareStart(session) {
      const url = server?.url;
      if (!server || !url || !node) return {};
      // Terminal sessions type into a TUI; like the knowledge server, the tools go to structured sessions.
      if (session.mode !== 'structured') return {};
      // At the depth limit the tools could only refuse; leave them out.
      const settings = node.orchestration.settings.effective(session.workspaceId);
      if ((session.depth ?? 0) >= settings.maxDepth) return {};
      const spec: McpServerSpec = { type: 'http', url, headers: { Authorization: `Bearer ${server.mint(session.id)}` } };
      log?.log('debug', 'injecting bizzi-agents', { sessionId: session.id });
      return { mcpServers: { [MCP_SERVER_NAME]: spec }, systemPromptAppend: `## bizzi-agents tools\n${TOOLS_NOTE}` };
    },
  };
}
