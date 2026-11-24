// The hub server: HTTP pairing/auth API (hub.ts), /healthz, the client endpoint /ws, the node endpoint
// /ws/node, optional static UI, and ntfy push.

import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { Duplex } from 'node:stream';
import { BizziError, type Logger, type PairResponse } from '@bizzi/protocol';
import { Router, type RouterOptions } from '@bizzi/routing';
import { WebSocketServer } from 'ws';
import { Auth, RateLimitedError, type AuthOptions } from './auth.ts';
import { HubBus } from './bus.ts';
import { ClientConn } from './client-conn.ts';
import { NodeLink } from './node-link.ts';
import { NtfyPusher } from './push.ts';
import { Relay } from './relay.ts';
import { HubStore } from './store.ts';
import { nullLogger } from './util.ts';

export interface HubOptions {
  /** Directory for hub.db and setup-code (created if missing). */
  dataDir: string;
  host?: string;
  port?: number;
  /** Public base URL as reached through the reverse proxy, e.g. https://bizzi.example.com. */
  publicUrl?: string;
  logger?: Logger;
  version: string;
  auth?: AuthOptions;
  /** Timeout for requests forwarded to a node (default 60 s). */
  requestTimeoutMs?: number;
  /** Close a socket that doesn't send hello / node.hello within this time (default 10 s). */
  helloTimeoutMs?: number;
  /** WebSocket ping interval (default 30 s). */
  pingIntervalMs?: number;
  /** Close a client whose send buffer exceeds this many bytes (default 16 MiB). */
  maxBufferedBytes?: number;
  /** Serve a built UI (index.html + assets) from this directory at `/`. */
  uiDir?: string;
  /** One-pane routing (spec §11.2): the logprob classifier and threshold. Default: explicit tokens only. */
  router?: RouterOptions;
  /** ntfy push notifications. */
  ntfy?: { url: string; token?: string; debounceMs?: number; minTurnMs?: number; fetch?: typeof fetch };
  /** Called with a freshly issued setup code (default: logged at warn level). */
  onSetupCode?: (code: string, file: string) => void;
}

export interface BizziHub {
  readonly host: string;
  readonly port: number;
  /** http://host:port */
  readonly url: string;
  /** ws://host:port/ws */
  readonly clientUrl: string;
  /** ws://host:port/ws/node */
  readonly nodeUrl: string;
  /** Path of the setup-code file. */
  readonly setupCodeFile: string;
  readonly relay: Relay;
  close(): Promise<void>;
}

const MAX_BODY = 64 * 1024;

export async function startHub(opts: HubOptions): Promise<BizziHub> {
  const logger = (opts.logger ?? nullLogger).child({ component: 'hub' });
  const host = opts.host ?? '127.0.0.1';
  const store = new HubStore(opts.dataDir);
  const setupCodeFile = join(opts.dataDir, 'setup-code');
  let pusher: NtfyPusher | undefined;
  try {
    const bus = new HubBus(store, logger.child({ component: 'bus' }));
    const auth = new Auth(store, opts.auth);
    const relay = new Relay({
      store,
      bus,
      auth,
      logger,
      version: opts.version,
      router: new Router({ ...opts.router, logger: logger.child({ component: 'router' }) }),
      ...(opts.publicUrl ? { publicUrl: opts.publicUrl } : {}),
    });

    const setupCode = auth.issueSetupCode();
    if (setupCode) {
      writeFileSync(setupCodeFile, setupCode + '\n', { mode: 0o600 });
      if (opts.onSetupCode) opts.onSetupCode(setupCode, setupCodeFile);
      else logger.log('warn', 'no devices paired yet; pair your first device with this setup code', { setupCode, file: setupCodeFile });
    } else {
      rmSync(setupCodeFile, { force: true });
    }

    if (opts.ntfy?.url) {
      const n = opts.ntfy;
      pusher = new NtfyPusher({
        url: n.url,
        ...(n.token ? { token: n.token } : {}),
        ...(relay.publicUrl ? { publicUrl: relay.publicUrl } : {}),
        ...(n.debounceMs !== undefined ? { debounceMs: n.debounceMs } : {}),
        ...(n.minTurnMs !== undefined ? { minTurnMs: n.minTurnMs } : {}),
        ...(n.fetch ? { fetch: n.fetch } : {}),
        logger: logger.child({ component: 'push' }),
        state: {
          load: () => store.getMeta('push.usage'),
          save: (json) => {
            if (store.isOpen) store.setMeta('push.usage', json);
          },
        },
        describe: (sessionId) => {
          const s = store.getSession(sessionId)?.info;
          const machine = s ? relay.machineView(s.machineId)?.name : undefined;
          const label = s ? s.title || `${s.agent} session` : sessionId;
          return machine ? { session: label, machine } : { session: label };
        },
      });
      const p = pusher;
      bus.tap((ev) => p.handle(ev));
      logger.log('info', 'ntfy push enabled');
    }

    const http: Server = createServer((req, res) => {
      void handleHttp(req, res).catch((err: unknown) => {
        logger.log('error', 'http handler failed', { err });
        if (!res.headersSent) sendJson(res, 500, { error: { code: 'internal', message: 'internal error' } });
      });
    });

    async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const url = new URL(req.url ?? '/', 'http://x');
      const path = url.pathname;
      if (path.startsWith('/api/')) {
        res.setHeader('access-control-allow-origin', '*');
        res.setHeader('access-control-allow-headers', 'content-type');
        res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
        res.setHeader('cache-control', 'no-store');
        if (req.method === 'OPTIONS') {
          res.writeHead(204).end();
          return;
        }
        const handler = API[path];
        if (!handler) return sendJson(res, 404, { error: { code: 'not_found', message: `no such endpoint ${path}` } });
        if (req.method !== 'POST') return sendJson(res, 405, { error: { code: 'bad_request', message: 'use POST' } });
        try {
          const body = await readJson(req);
          sendJson(res, 200, handler(body, req));
        } catch (err) {
          sendError(res, err, logger);
        }
        return;
      }
      if (req.method === 'GET' && path === '/healthz') {
        return sendJson(res, 200, { ok: true, role: 'hub', version: opts.version });
      }
      if (opts.uiDir && (req.method === 'GET' || req.method === 'HEAD')) return serveStatic(opts.uiDir, path, req, res);
      sendJson(res, 404, { error: { code: 'not_found', message: 'not found' } });
    }

    const API: Record<string, (body: unknown, req: IncomingMessage) => unknown> = {
      '/api/pair': (body, req) => {
        const { device, replaced, setup } = auth.pair(body, clientKey(req));
        if (setup) rmSync(setupCodeFile, { force: true });
        logger.log('info', 'device paired', { deviceId: device.id, kind: device.kind, name: device.name, owner: Boolean(device.owner) });
        for (const old of replaced) relay.revokeDevice(old.id);
        relay.emitDevice(device);
        const base = relay.publicUrl ?? requestBase(req);
        const ws = base.replace(/^http/, 'ws');
        const out: PairResponse = { deviceId: device.id, kind: device.kind, owner: Boolean(device.owner), clientUrl: `${ws}/ws`, nodeUrl: `${ws}/ws/node` };
        return out;
      },
      '/api/auth/challenge': (body, req) => auth.challenge(body, clientKey(req)),
      '/api/auth/token': (body, req) => {
        const { token, expiresAt } = auth.token(body, clientKey(req));
        return { token, expiresAt };
      },
    };

    const conns = new Set<ClientConn>();
    const links = new Set<NodeLink>();
    const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
    http.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      if (path !== '/ws' && path !== '/ws/node') {
        socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const remote = clientKey(req);
        if (path === '/ws') {
          const conn = new ClientConn(ws, relay, {
            logger,
            maxBuffered: opts.maxBufferedBytes ?? 16 * 1024 * 1024,
            helloTimeoutMs: opts.helloTimeoutMs ?? 10_000,
            remote,
            baseUrl: requestBase(req),
          });
          conns.add(conn);
          ws.on('close', () => {
            conn.dispose();
            conns.delete(conn);
          });
        } else {
          const link = new NodeLink(ws, relay, {
            logger,
            helloTimeoutMs: opts.helloTimeoutMs ?? 10_000,
            requestTimeoutMs: opts.requestTimeoutMs ?? 60_000,
            remote,
          });
          links.add(link);
          ws.on('close', () => {
            link.dispose();
            links.delete(link);
          });
        }
      });
    });

    const pingTimer = setInterval(() => {
      for (const c of conns) c.heartbeat();
      for (const l of links) l.heartbeat();
    }, opts.pingIntervalMs ?? 30_000);
    pingTimer.unref();
    const sweepTimer = setInterval(() => store.sweep(Date.now()), 10 * 60_000);
    sweepTimer.unref();

    await new Promise<void>((resolveListen, reject) => {
      http.once('error', reject);
      http.listen(opts.port ?? 7777, host, () => {
        http.off('error', reject);
        resolveListen();
      });
    });
    const addr = http.address() as AddressInfo;
    const urlHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
    const base = `http://${urlHost}:${addr.port}`;
    logger.log('info', 'hub listening', { url: base, publicUrl: relay.publicUrl });
    let closing: Promise<void> | undefined;
    const p = pusher;
    return {
      host,
      port: addr.port,
      url: base,
      clientUrl: `${base.replace(/^http/, 'ws')}/ws`,
      nodeUrl: `${base.replace(/^http/, 'ws')}/ws/node`,
      setupCodeFile,
      relay,
      close() {
        closing ??= (async () => {
          clearInterval(pingTimer);
          clearInterval(sweepTimer);
          relay.closeAll();
          wss.close();
          await new Promise<void>((done) => {
            http.close(() => done());
            http.closeAllConnections();
          });
          await p?.close();
          store.close();
        })();
        return closing;
      },
    };
  } catch (err) {
    await pusher?.close();
    store.close();
    throw err;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function sendError(res: ServerResponse, err: unknown, logger: Logger): void {
  if (err instanceof RateLimitedError) {
    res.setHeader('retry-after', String(err.retryAfterSec));
    return sendJson(res, 429, { error: err.toObject() });
  }
  if (err instanceof BizziError) {
    const status = err.code === 'bad_request' ? 400 : err.code === 'unauthorized' ? 401 : err.code === 'not_found' ? 404 : err.code === 'conflict' ? 409 : 500;
    return sendJson(res, status, { error: err.toObject() });
  }
  logger.log('error', 'unhandled error in http request', { err });
  sendJson(res, 500, { error: { code: 'internal', message: 'internal error' } });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new BizziError('bad_request', 'request body too large');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new BizziError('bad_request', 'invalid JSON body');
  }
}

/** Rate-limit key: the peer address, or the proxy-reported client when the peer is a local proxy. */
function clientKey(req: IncomingMessage): string {
  const remote = req.socket.remoteAddress ?? 'unknown';
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff && isPrivate(remote)) {
    const parts = xff.split(',').map((s) => s.trim()).filter(Boolean);
    const last = parts[parts.length - 1];
    if (last) return last;
  }
  return remote;
}

function isPrivate(addr: string): boolean {
  const a = addr.replace(/^::ffff:/, '');
  return (
    a === '::1' ||
    a.startsWith('127.') ||
    a.startsWith('10.') ||
    a.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(a) ||
    a.startsWith('fc') ||
    a.startsWith('fd')
  );
}

/** http(s)://host as the client sees it (honours X-Forwarded-Proto/Host from the proxy). */
function requestBase(req: IncomingMessage): string {
  const header = (name: string) => {
    const v = req.headers[name];
    return (Array.isArray(v) ? v[0] : v)?.split(',')[0]?.trim();
  };
  const proto = header('x-forwarded-proto') === 'https' ? 'https' : 'http';
  const host = header('x-forwarded-host') ?? req.headers.host ?? 'localhost';
  return `${proto}://${host}`;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** Static files with SPA fallback to index.html. */
function serveStatic(dir: string, path: string, req: IncomingMessage, res: ServerResponse): void {
  const root = resolve(dir);
  let file = normalize(join(root, decodeURIComponent(path)));
  if (file !== root && !file.startsWith(root + sep)) {
    res.writeHead(400).end();
    return;
  }
  const isFile = (f: string) => {
    try {
      return statSync(f).isFile();
    } catch {
      return false;
    }
  };
  if (!isFile(file)) file = join(root, 'index.html');
  if (!isFile(file)) {
    sendJson(res, 404, { error: { code: 'not_found', message: 'not found' } });
    return;
  }
  const body = readFileSync(file);
  const immutable = file.includes(`${sep}assets${sep}`);
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'content-length': body.length,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}
