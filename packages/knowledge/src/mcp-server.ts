#!/usr/bin/env node
// Entry point: the bizzi-memory MCP server over stdio, one process per agent session.
//   node src/mcp-server.ts --db <knowledge.db> --agent claude --machine-id m_… [--machine-tag gui …]
//        [--project-id p_…] [--workspace-id w_…] [--session-id s_…]
// The same values can come from BIZZI_KNOWLEDGE_DB, BIZZI_AGENT, BIZZI_MACHINE_ID, BIZZI_MACHINE_TAGS
// (comma-separated), BIZZI_PROJECT_ID, BIZZI_WORKSPACE_ID and BIZZI_SESSION_ID. stdout carries the MCP protocol; logs go to stderr.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { LogLevel, Logger } from '@bizzi/protocol';
import { createKnowledgeMcpServer, parseServerConfig } from './mcp-tools.ts';
import { KnowledgeStore } from './store.ts';

function stderrLogger(fields: Record<string, unknown> = {}): Logger {
  return {
    log(level: LogLevel, msg: string, extra?: Record<string, unknown>) {
      if (level === 'debug' && !process.env.BIZZI_DEBUG) return;
      process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields, ...extra })}\n`);
    },
    child(more: Record<string, unknown>) {
      return stderrLogger({ ...fields, ...more });
    },
  };
}

async function main(): Promise<void> {
  const logger = stderrLogger({ component: 'bizzi-memory' });
  let config;
  try {
    config = parseServerConfig(process.argv.slice(2));
  } catch (err) {
    logger.log('error', 'bad arguments', { error: err instanceof Error ? err.message : String(err) });
    process.exit(2);
  }
  const store = new KnowledgeStore({ path: config.dbPath, machineId: config.context.machineId, logger });
  const server = createKnowledgeMcpServer(store, config.context);
  const transport = new StdioServerTransport();
  let closed = false;
  const shutdown = async () => {
    if (closed) return;
    closed = true;
    try {
      await server.close();
    } finally {
      store.close();
    }
  };
  transport.onclose = () => void shutdown();
  process.stdin.on('end', () => void shutdown().then(() => process.exit(0)));
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void shutdown().then(() => process.exit(0)));
  await server.connect(transport);
  logger.log('debug', 'ready', { context: config.context, fts5: store.ftsAvailable });
}

main().catch((err: unknown) => {
  process.stderr.write(`bizzi-memory: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
