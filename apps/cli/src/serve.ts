// `bizzi serve`: run the node role and the client-protocol server.

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createJsonLogger, createNode, isLogLevel, startServer, type BizziServer } from '@bizzi/core';
import type { AgentAdapter, ServeReady } from '@bizzi/protocol';
import { loadAdapters } from './adapters.ts';
import { createKnowledgeHook } from './knowledge.ts';
import { defaultDataDir, resolveDir, UsageError } from './util.ts';

export const SERVE_HELP = `Usage: bizzi serve [options]

  --host <host>        listen address (default 127.0.0.1)
  --port <port>        listen port, 0 for any free port (default 7777)
  --data-dir <dir>     data directory (default ~/.bizzi)
  --name <name>        machine display name (default: hostname)
  --token <token>      client token (default: $BIZZI_TOKEN, else random)
  --fake               add scripted fake adapters (for manual testing)
  --no-knowledge       don't inject rules, memory or the bizzi-memory MCP server
  --log-level <level>  debug | info | warn | error (default: $BIZZI_LOG_LEVEL or info)

Prints one JSON "ready" line on stdout when listening; logs go to stderr.
SIGTERM/SIGINT drain running turns (up to $BIZZI_DRAIN_SECONDS, default 120) before exiting.`;

function parsePort(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new UsageError(`invalid port: ${v}`);
  return n;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function serve(argv: string[], version: string): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      host: { type: 'string', default: '127.0.0.1' },
      port: { type: 'string', default: '7777' },
      'data-dir': { type: 'string' },
      name: { type: 'string' },
      token: { type: 'string' },
      fake: { type: 'boolean', default: false },
      'no-knowledge': { type: 'boolean', default: false },
      'log-level': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(SERVE_HELP + '\n');
    return;
  }

  const level = values['log-level'] ?? process.env.BIZZI_LOG_LEVEL ?? 'info';
  if (!isLogLevel(level)) throw new UsageError(`invalid log level: ${level}`);
  const logger = createJsonLogger({ level });
  const port = parsePort(values.port);
  const dataDir = resolveDir(values['data-dir'] ?? defaultDataDir());
  const token = values.token || process.env.BIZZI_TOKEN || randomBytes(24).toString('base64url');
  const drainSeconds = Number(process.env.BIZZI_DRAIN_SECONDS ?? 120);
  if (!Number.isFinite(drainSeconds) || drainSeconds < 0) throw new UsageError('BIZZI_DRAIN_SECONDS must be a non-negative number');

  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const serveJson = join(dataDir, 'serve.json');
  const existing = readReady(serveJson);
  if (existing && existing.pid !== process.pid && pidAlive(existing.pid)) {
    throw new UsageError(`a bizzi node (pid ${existing.pid}) is already serving ${dataDir} at ${existing.url}`);
  }

  const adapters: AgentAdapter[] = [];
  if (values.fake) {
    const testing = await import('@bizzi/core/testing');
    adapters.push(...testing.createAdapters());
    logger.log('info', 'fake adapters enabled');
  }
  adapters.push(...(await loadAdapters(logger)));

  let machineId = '';
  const prepareStart = values['no-knowledge'] ? undefined : await createKnowledgeHook(dataDir, logger, () => machineId);
  const node = await createNode({
    dataDir,
    machineName: values.name,
    adapters,
    logger,
    version,
    ...(prepareStart ? { prepareStart } : {}),
  });
  machineId = node.machine.id;
  let server: BizziServer;
  try {
    server = await startServer(node, { host: values.host, port, token, logger });
  } catch (err) {
    await node.close();
    throw err;
  }

  const ready: ServeReady = { event: 'ready', url: server.url, token, machineId: node.machine.id, pid: process.pid };
  const removeServeJson = () => {
    if (readReady(serveJson)?.pid === process.pid) rmSync(serveJson, { force: true });
  };
  writeFileSync(serveJson, JSON.stringify(ready) + '\n', { mode: 0o600 });
  process.on('exit', removeServeJson);
  process.stdout.write(JSON.stringify(ready) + '\n');
  logger.log('info', 'node ready', { url: server.url, machineId: node.machine.id, dataDir, adapters: adapters.length });

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      logger.log('warn', 'second signal; exiting without waiting for turns', { signal });
      removeServeJson();
      process.exit(1);
    }
    shuttingDown = true;
    logger.log('info', 'draining', { signal, activeTurns: node.sessions.activeTurns(), drainSeconds });
    try {
      const drained = await node.drain(drainSeconds * 1000);
      if (!drained) logger.log('warn', 'drain timed out; stopping running turns', { activeTurns: node.sessions.activeTurns() });
      await server.close();
      await node.close();
      logger.log('info', 'stopped');
    } catch (err) {
      logger.log('error', 'error during shutdown', { err });
    } finally {
      removeServeJson();
      process.exit(0);
    }
  };
  process.on('SIGTERM', (s) => void shutdown(s));
  process.on('SIGINT', (s) => void shutdown(s));
}

export function readReady(path: string): ServeReady | undefined {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as ServeReady;
    return v && v.event === 'ready' && typeof v.pid === 'number' ? v : undefined;
  } catch {
    return undefined;
  }
}
