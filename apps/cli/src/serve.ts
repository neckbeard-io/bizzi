// `bizzi serve`: run the node role and the client-protocol server.

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createJsonLogger, createNode, isLogLevel, platformPowerBackend, startServer, type BizziServer, type NodeExtension } from '@bizzi/core';
import { cleanNpmScriptEnv, type AgentAdapter, type Logger, type ServeReady } from '@bizzi/protocol';
import { createContainersExtension } from '@bizzi/containers';
import { createRoutingExtension, routerOptionsFromEnv, type RouterOptions } from '@bizzi/routing';
import { loadAdapters } from './adapters.ts';
import { createKnowledgeRuntime } from './knowledge.ts';
import { startHubLink } from './link.ts';
import { loadOrchestration } from './orchestration.ts';
import { loadServices } from './services.ts';
import { defaultDataDir, resolveDir, UsageError } from './util.ts';
import { loadTitleSuggester } from './titles.ts';

/** How long a stop may take after the second signal before the process exits anyway. */
const STOP_BACKSTOP_MS = 15_000;

export const SERVE_HELP = `Usage: bizzi serve [options]

  --host <host>        listen address (default 127.0.0.1)
  --port <port>        listen port, 0 for any free port (default 7777)
  --data-dir <dir>     data directory (default ~/.bizzi)
  --name <name>        machine display name (default: hostname)
  --token <token>      client token (default: $BIZZI_TOKEN, else random)
  --fake               add scripted fake adapters (for manual testing)
  --no-knowledge       don't inject rules, memory or the bizzi-memory MCP server
  --no-services        don't load @bizzi/services (agent install/login, secrets, knowledge methods, widgets)
  --widgets-dir <dir>  widget files (default: $BIZZI_WIDGETS_DIR, else ~/.config/bizzi/widgets)
  --no-widgets         don't run widgets
  --no-agents-mcp      don't serve or inject the bizzi-agents MCP tools (agent-to-agent helpers)
  --log-level <level>  debug | info | warn | error (default: $BIZZI_LOG_LEVEL or info)
  --connect <url>      link to a hub (default: $BIZZI_HUB_URL, else the URL saved by "bizzi pair");
                       with no saved credential, $BIZZI_PAIR_CODE pairs on first start

Routing (route.suggest over this machine's workspaces): BIZZI_ROUTER_URL, BIZZI_ROUTER_MODEL and the
other BIZZI_ROUTER_* variables, as for "bizzi hub serve". The model only has to be reachable from this
machine; a hub without a classifier of its own borrows this one (route.score).

Prints one JSON "ready" line on stdout when listening; logs go to stderr.
SIGTERM/SIGINT drain running turns (up to $BIZZI_DRAIN_SECONDS, default 120) before exiting; a second
signal stops without waiting.
Turns still running then are continued automatically on the next start
(BIZZI_RESUME_INTERRUPTED=0 turns that off).`;

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
      'no-services': { type: 'boolean', default: false },
      'widgets-dir': { type: 'string' },
      'no-widgets': { type: 'boolean', default: false },
      'no-agents-mcp': { type: 'boolean', default: false },
      'log-level': { type: 'string' },
      connect: { type: 'string' },
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
  dropNpmScriptEnv(logger);
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
  adapters.push(...(await loadAdapters(logger, undefined, { dataDir })));

  // One knowledge store, shared by session-start injection and the knowledge.* methods.
  const knowledge = values['no-knowledge'] ? undefined : await createKnowledgeRuntime(dataDir, logger);

  // ---- services (@bizzi/services): agent install/login, secrets, knowledge methods
  const widgets = values['no-widgets'] ? false : values['widgets-dir'] ? { dir: resolveDir(values['widgets-dir']) } : {};
  const services = values['no-services'] ? undefined : await loadServices({ dataDir, logger, widgets, ...(knowledge ? { knowledge } : {}) });
  // ---- end services

  // ---- agent-to-agent MCP tools (@bizzi/orchestration), on a loopback port of their own
  const orchestration = values['no-agents-mcp'] ? undefined : await loadOrchestration(logger);
  // ---- one-pane routing among this machine's workspaces (a hub routes across machines itself)
  let routerOpts: RouterOptions;
  try {
    routerOpts = routerOptionsFromEnv();
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  const routing = createRoutingExtension({ ...routerOpts, logger: logger.child({ component: 'router' }) }, { dbPath: join(dataDir, 'routing.db') });
  // ---- container workspaces (topology.md §7): only with a configured daemon (BIZZI_DOCKER_HOST, …)
  const containers = createContainersExtension({ logger: logger.child({ component: 'containers' }) });
  const extensions: NodeExtension[] = [...(services?.extensions ?? []), ...(orchestration ? [orchestration] : []), routing, containers];

  // Untitled sessions are named from their first message; a configured utility model refines that.
  const suggestTitle = await loadTitleSuggester(dataDir, logger);

  const power = platformPowerBackend();
  const node = await createNode({
    dataDir,
    machineName: values.name,
    adapters,
    logger,
    version,
    ...(knowledge ? { prepareStart: knowledge.prepareStart } : {}),
    ...(extensions.length > 0 ? { extensions } : {}),
    // Turns cut off by the last shutdown continue on their own (updates.md §7); 0 turns that off.
    resumeInterrupted: process.env.BIZZI_RESUME_INTERRUPTED !== '0',
    ...(suggestTitle ? { suggestTitle } : {}),
    // Holds this machine awake while its agents work, per the machine's keep-awake setting (spec §8.1).
    ...(power ? { power } : {}),
  });
  knowledge?.bindMachine(() => node.machine);
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
  // The desktop app reads the ready line and may then quit, leaving this core running: its end of
  // the pipe closes, and a later stdout write must not take the node down with EPIPE.
  process.stdout.on('error', () => {});
  logger.log('info', 'node ready', { url: server.url, machineId: node.machine.id, dataDir, adapters: adapters.length });
  const hubUrl = values.connect || process.env.BIZZI_HUB_URL || undefined;
  const hubLink = startHubLink(node, { dataDir, url: hubUrl, pairCode: process.env.BIZZI_PAIR_CODE || undefined, logger });

  // First signal: drain, then stop. Second: stop now (running turns are cut off cleanly and continue
  // on the next start); the desktop app sends it when it hands over to a new core. Third: exit.
  let signals = 0;
  let hurry: () => void = () => {};
  const hurried = new Promise<false>((resolve) => (hurry = () => resolve(false)));
  const shutdown = async (signal: NodeJS.Signals) => {
    signals++;
    if (signals === 2) {
      logger.log('info', 'second signal; stopping without waiting for turns', { signal, activeTurns: node.sessions.activeTurns() });
      hurry();
      // Backstop: a stop that hangs must not keep the next core from starting.
      setTimeout(() => {
        logger.log('warn', 'stop took too long; exiting', {});
        removeServeJson();
        process.exit(1);
      }, STOP_BACKSTOP_MS).unref();
      return;
    }
    if (signals > 2) {
      logger.log('warn', 'third signal; exiting now', { signal });
      removeServeJson();
      process.exit(1);
    }
    logger.log('info', 'draining', { signal, activeTurns: node.sessions.activeTurns(), drainSeconds });
    try {
      const drained = await Promise.race([node.drain(drainSeconds * 1000), hurried]);
      if (!drained) logger.log('warn', 'drain timed out; stopping running turns', { activeTurns: node.sessions.activeTurns() });
      await hubLink?.close();
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

/**
 * Started from an npm script (`npm run dev`, or an app reopened by one), the node would pass npm's
 * script environment on to every agent session and terminal: `npm_config_local_prefix` and friends
 * point npm at bizzi's checkout, and PATH starts with its `node_modules/.bin`. Take it out of this
 * process's environment before anything is spawned; what the user set stays.
 */
export function dropNpmScriptEnv(logger: Logger, env: NodeJS.ProcessEnv = process.env): void {
  const { env: clean, removed, removedPath } = cleanNpmScriptEnv(env);
  if (!removed.length && !removedPath.length) return;
  for (const k of removed) delete env[k];
  if (clean.PATH !== undefined) env.PATH = clean.PATH;
  logger.log('info', 'dropped the npm script environment', { vars: removed.length, pathEntries: removedPath.length });
}
