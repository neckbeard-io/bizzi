// `bizzi hub serve`: run the hub role. `bizzi hub code`: mint a pairing code locally (admin access via the data dir).

import os from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createJsonLogger, isLogLevel } from '@bizzi/core';
import { Auth, HubStore, startHub, type HubOptions } from '@bizzi/hub';
import type { DeviceKind } from '@bizzi/protocol';
import { routerOptionsFromEnv } from '@bizzi/routing';
import { resolveDir, UsageError } from './util.ts';

export const HUB_HELP = `Usage: bizzi hub <command> [options]

Commands:
  serve    run the hub (pairing/auth API, client relay, node links, event-log replica, push)
  code     create a one-time pairing code directly in the hub's database

bizzi hub serve [options]
  --host <host>         listen address (default 0.0.0.0)
  --port <port>         listen port, 0 for any free port (default 7777)
  --data-dir <dir>      data directory (default: $BIZZI_HUB_DATA_DIR or ~/.bizzi-hub)
  --public-url <url>    public base URL behind the proxy (default: $BIZZI_PUBLIC_URL)
  --ui-dir <dir>        serve a built UI at / (default: $BIZZI_UI_DIR)
  --log-level <level>   debug | info | warn | error (default: $BIZZI_LOG_LEVEL or info)
  Push: set BIZZI_NTFY_URL (ntfy topic URL) and optionally BIZZI_NTFY_TOKEN.
  Routing: set BIZZI_ROUTER_URL and BIZZI_ROUTER_MODEL (an OpenAI-compatible endpoint that returns
  logprobs), optionally BIZZI_ROUTER_API_KEY, BIZZI_ROUTER_BODY (JSON) and BIZZI_ROUTER_THRESHOLD.
  Without a URL the hub borrows the classifier of an online node that has one (always-on first);
  BIZZI_ROUTER_VIA=<machine> names the one to try first.
  On first start (no devices yet) a setup code is printed to stderr and written to <data-dir>/setup-code.

bizzi hub code [options]
  --kind <node|device>  what the code pairs (default node)
  --name <name>         label for the code
  --ttl <minutes>       validity (default 60)
  --data-dir <dir>      hub data directory (default: $BIZZI_HUB_DATA_DIR or ~/.bizzi-hub)`;

export function defaultHubDataDir(): string {
  return process.env.BIZZI_HUB_DATA_DIR || join(os.homedir(), '.bizzi-hub');
}

export async function hub(argv: string[], version: string): Promise<void> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case 'serve':
      return hubServe(rest, version);
    case 'code':
      return hubCode(rest);
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HUB_HELP + '\n');
      return;
    default:
      throw new UsageError(`unknown hub command: ${sub}\n\n${HUB_HELP}`);
  }
}

function parsePort(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new UsageError(`invalid port: ${v}`);
  return n;
}

async function hubServe(argv: string[], version: string): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      host: { type: 'string', default: '0.0.0.0' },
      port: { type: 'string', default: '7777' },
      'data-dir': { type: 'string' },
      'public-url': { type: 'string' },
      'ui-dir': { type: 'string' },
      'log-level': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(HUB_HELP + '\n');
    return;
  }
  const level = values['log-level'] ?? process.env.BIZZI_LOG_LEVEL ?? 'info';
  if (!isLogLevel(level)) throw new UsageError(`invalid log level: ${level}`);
  const logger = createJsonLogger({ level });
  const publicUrl = values['public-url'] || process.env.BIZZI_PUBLIC_URL || undefined;
  if (publicUrl && !/^https?:\/\/[^/]+/.test(publicUrl)) throw new UsageError(`invalid public URL: ${publicUrl}`);
  const uiDir = values['ui-dir'] || process.env.BIZZI_UI_DIR || undefined;
  const dataDir = resolveDir(values['data-dir'] ?? defaultHubDataDir());

  const opts: HubOptions = {
    dataDir,
    host: values.host,
    port: parsePort(values.port),
    logger,
    version,
    onSetupCode: (code, file) => {
      logger.log('warn', 'no devices paired yet; pair your first device with the setup code', { setupCode: code, file });
      process.stderr.write(`\n  bizzi hub: no devices paired yet.\n  Setup code: ${code}   (also in ${file})\n\n`);
    },
  };
  if (publicUrl) opts.publicUrl = publicUrl;
  if (uiDir) opts.uiDir = resolveDir(uiDir);
  if (process.env.BIZZI_NTFY_URL) {
    opts.ntfy = { url: process.env.BIZZI_NTFY_URL };
    if (process.env.BIZZI_NTFY_TOKEN) opts.ntfy.token = process.env.BIZZI_NTFY_TOKEN;
  }
  try {
    opts.router = routerOptionsFromEnv();
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  if (opts.router.backend) logger.log('info', 'routing classifier enabled', { url: opts.router.backend.url, model: opts.router.backend.model });
  else logger.log('info', "routing borrows a node's classifier when one is online", opts.router.via ? { via: opts.router.via } : {});
  const server = await startHub(opts);
  process.stdout.write(
    JSON.stringify({ event: 'hub-ready', url: server.url, clientUrl: server.clientUrl, nodeUrl: server.nodeUrl, pid: process.pid }) + '\n',
  );

  let stopping = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (stopping) process.exit(1);
    stopping = true;
    logger.log('info', 'hub stopping', { signal });
    try {
      await server.close();
    } catch (err) {
      logger.log('error', 'error during shutdown', { err });
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', (s) => void shutdown(s));
  process.on('SIGINT', (s) => void shutdown(s));
}

async function hubCode(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      kind: { type: 'string', default: 'node' },
      name: { type: 'string' },
      ttl: { type: 'string', default: '60' },
      'data-dir': { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(HUB_HELP + '\n');
    return;
  }
  const kind = values.kind as DeviceKind;
  if (kind !== 'node' && kind !== 'device') throw new UsageError(`--kind must be node or device`);
  const ttl = Number(values.ttl);
  if (!Number.isFinite(ttl) || ttl <= 0) throw new UsageError(`invalid --ttl: ${values.ttl}`);
  const store = new HubStore(resolveDir(values['data-dir'] ?? defaultHubDataDir()));
  try {
    const auth = new Auth(store, { pairingTtlMs: ttl * 60_000 });
    const opts: { name?: string; createdBy: string } = { createdBy: 'cli' };
    if (values.name) opts.name = values.name;
    const { code, expiresAt } = auth.createPairingCode(kind, opts);
    process.stdout.write(values.json ? JSON.stringify({ code, kind, expiresAt }) + '\n' : `${code}\n`);
    if (!values.json) process.stderr.write(`one-time ${kind} pairing code, valid until ${expiresAt}\n`);
  } finally {
    store.close();
  }
}
