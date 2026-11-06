// Client-protocol server: HTTP /healthz and WebSocket /ws (hello + token auth, requests, subscriptions).

import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import {
  BizziError,
  PROTOCOL_VERSION,
  type ChannelEvent,
  type ErrorObject,
  type Logger,
  type ServerMsg,
} from '@bizzi/protocol';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { REPLAY_PAGE } from './bus.ts';
import type { BizziNode } from './node.ts';

export interface ServerOptions {
  host?: string;
  port?: number;
  /** Shared secret clients must present in `hello`. */
  token: string;
  logger?: Logger;
  /** Close a connection whose send buffer exceeds this many bytes (default 16 MiB). */
  maxBufferedBytes?: number;
  /** Close a connection that doesn't send `hello` within this time (default 10 s). */
  helloTimeoutMs?: number;
  /** WebSocket ping interval (default 30 s). */
  pingIntervalMs?: number;
}

export interface BizziServer {
  readonly host: string;
  readonly port: number;
  /** ws://host:port/ws (wildcard hosts are reported as loopback). */
  readonly url: string;
  readonly connections: number;
  close(): Promise<void>;
}

export const CLOSE_UNAUTHORIZED = 4401;
export const DEFAULT_MAX_BUFFERED = 16 * 1024 * 1024;
const REPLAY_HIGH_WATER = 4 * 1024 * 1024;

export function startServer(node: BizziNode, opts: ServerOptions): Promise<BizziServer> {
  if (!opts.token) throw new BizziError('bad_request', 'a token is required');
  const logger = (opts.logger ?? node.logger).child({ component: 'server' });
  const host = opts.host ?? '127.0.0.1';
  const tokenDigest = digest(opts.token);
  const maxBuffered = opts.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED;
  const conns = new Set<Connection>();

  const http: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'GET' && url.pathname === '/healthz') {
      const body = JSON.stringify({ ok: true, protocol: PROTOCOL_VERSION, version: node.version, draining: node.draining });
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(body);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not found"}');
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  http.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/ws') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn = new Connection(ws, node, {
        logger,
        tokenDigest,
        maxBuffered,
        helloTimeoutMs: opts.helloTimeoutMs ?? 10_000,
        remote: req.socket.remoteAddress,
      });
      conns.add(conn);
      ws.on('close', () => {
        conn.dispose();
        conns.delete(conn);
      });
    });
  });

  const pingTimer = setInterval(() => {
    for (const c of conns) c.heartbeat();
  }, opts.pingIntervalMs ?? 30_000);
  pingTimer.unref();

  return new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(opts.port ?? 7777, host, () => {
      http.off('error', reject);
      const addr = http.address() as AddressInfo;
      const urlHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
      const url = `ws://${urlHost}:${addr.port}/ws`;
      logger.log('info', 'listening', { url });
      let closing: Promise<void> | undefined;
      resolve({
        host,
        port: addr.port,
        url,
        get connections() {
          return conns.size;
        },
        close() {
          closing ??= new Promise<void>((done) => {
            clearInterval(pingTimer);
            for (const c of conns) c.close(1001, 'server shutting down');
            wss.close();
            http.close(() => done());
            http.closeAllConnections();
          });
          return closing;
        },
      });
    });
  });
}

function digest(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest();
}

interface ConnOptions {
  logger: Logger;
  tokenDigest: Buffer;
  maxBuffered: number;
  helloTimeoutMs: number;
  remote?: string;
}

interface ChannelSub {
  /** Highest seq sent to this client. */
  cursor: number;
  /** True while history is being replayed; live events are skipped (replay reads them from the store). */
  replaying: boolean;
  cancelled: boolean;
  off: () => void;
}

class Connection {
  readonly #ws: WebSocket;
  readonly #node: BizziNode;
  readonly #o: ConnOptions;
  #log: Logger;
  #authed = false;
  #alive = true;
  #closed = false;
  readonly #subs = new Map<string, ChannelSub>();
  #helloTimer?: NodeJS.Timeout;

  constructor(ws: WebSocket, node: BizziNode, o: ConnOptions) {
    this.#ws = ws;
    this.#node = node;
    this.#o = o;
    this.#log = o.logger.child({ remote: o.remote });
    this.#helloTimer = setTimeout(() => this.#reject(undefined, 'hello timeout'), o.helloTimeoutMs);
    ws.on('message', (data: RawData, isBinary: boolean) => this.#onMessage(data, isBinary));
    ws.on('pong', () => {
      this.#alive = true;
    });
    ws.on('error', (err) => this.#log.log('debug', 'websocket error', { err }));
  }

  heartbeat(): void {
    if (!this.#alive) {
      this.#ws.terminate();
      return;
    }
    this.#alive = false;
    try {
      this.#ws.ping();
    } catch {
      // socket already closing
    }
  }

  close(code: number, reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.dispose();
    this.#ws.close(code, reason);
    // Don't wait forever for the peer's close frame.
    setTimeout(() => this.#ws.terminate(), 2000).unref();
  }

  dispose(): void {
    this.#closed = true;
    clearTimeout(this.#helloTimer);
    for (const sub of this.#subs.values()) {
      sub.cancelled = true;
      sub.off();
    }
    this.#subs.clear();
  }

  #send(msg: ServerMsg): void {
    if (this.#closed || this.#ws.readyState !== WebSocket.OPEN) return;
    this.#ws.send(JSON.stringify(msg));
    if (this.#ws.bufferedAmount > this.#o.maxBuffered) {
      this.#log.log('warn', 'closing slow connection', { bufferedAmount: this.#ws.bufferedAmount });
      this.#closed = true;
      this.dispose();
      this.#ws.terminate();
    }
  }

  #reject(id: string | undefined, message: string): void {
    if (this.#closed) return;
    this.#log.log('info', 'rejecting connection', { reason: message });
    this.#send({ id: id ?? '', error: { code: 'unauthorized', message } });
    this.close(CLOSE_UNAUTHORIZED, 'unauthorized');
  }

  #onMessage(data: RawData, isBinary: boolean): void {
    if (this.#closed) return;
    const text = isBinary ? null : rawToString(data);
    let msg: { id?: unknown; method?: unknown; params?: unknown } | undefined;
    try {
      const v: unknown = text === null ? undefined : JSON.parse(text);
      if (v && typeof v === 'object' && !Array.isArray(v)) msg = v as typeof msg;
    } catch {
      // handled below
    }
    const id = typeof msg?.id === 'string' ? msg.id : undefined;
    if (!msg || id === undefined || typeof msg.method !== 'string') {
      if (!this.#authed) return this.#reject(id, 'expected hello');
      this.#send({ id: id ?? '', error: { code: 'bad_request', message: 'not a bizzi request' } });
      return;
    }
    if (!this.#authed) {
      if (msg.method !== 'hello') return this.#reject(id, 'expected hello');
      return this.#hello(id, msg.params);
    }
    void this.#handle(id, msg.method, msg.params);
  }

  #hello(id: string, params: unknown): void {
    const p = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;
    if (p.protocol !== PROTOCOL_VERSION) return this.#reject(id, `unsupported protocol (server speaks ${PROTOCOL_VERSION})`);
    const token = typeof p.token === 'string' ? p.token : '';
    if (!timingSafeEqual(digest(token), this.#o.tokenDigest)) return this.#reject(id, 'invalid token');
    clearTimeout(this.#helloTimer);
    this.#authed = true;
    const client = p.client as { name?: unknown; version?: unknown } | undefined;
    this.#log = this.#log.child({ client: typeof client?.name === 'string' ? client.name : undefined });
    this.#log.log('debug', 'client connected');
    this.#send({ id, result: { protocol: PROTOCOL_VERSION, serverVersion: this.#node.version, machine: this.#node.machine } });
  }

  async #handle(id: string, method: string, params: unknown): Promise<void> {
    try {
      let result: unknown;
      if (method === 'subscribe') result = this.#subscribe(params);
      else if (method === 'unsubscribe') result = this.#unsubscribe(params);
      else result = await this.#node.dispatch(method, params);
      this.#send({ id, result } as ServerMsg);
      if (method === 'subscribe') void this.#pump((result as { ch: string }).ch);
    } catch (err) {
      this.#send({ id, error: toErrorObject(err, this.#log, method) });
    }
  }

  #subscribe(params: unknown): { ch: string; lastSeq: number } {
    const p = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;
    const ch = p.ch;
    if (typeof ch !== 'string') throw new BizziError('bad_request', 'ch must be a string');
    const since = p.since ?? 0;
    if (typeof since !== 'number' || !Number.isInteger(since) || since < 0) {
      throw new BizziError('bad_request', 'since must be a non-negative integer');
    }
    this.#node.assertChannel(ch);
    const previous = this.#subs.get(ch);
    if (previous) {
      previous.cancelled = true;
      previous.off();
    }

    const sub: ChannelSub = { cursor: since, replaying: true, cancelled: false, off: () => {} };
    // Live listener is attached before replay starts; while replaying it ignores events (the
    // replay loop reads them from the store), afterwards it forwards anything past the cursor.
    sub.off = this.#node.bus.on(ch, (ev: ChannelEvent) => {
      if (sub.cancelled || sub.replaying || ev.seq <= sub.cursor) return;
      sub.cursor = ev.seq;
      this.#send(ev);
    });
    this.#subs.set(ch, sub);
    return { ch, lastSeq: this.#node.bus.lastSeq(ch) };
  }

  /** Replay history page by page (yielding to the event loop and respecting backpressure), then go live. */
  async #pump(ch: string): Promise<void> {
    const sub = this.#subs.get(ch);
    if (!sub) return;
    try {
      for (;;) {
        if (sub.cancelled || this.#closed) return;
        // No await between this check and flipping `replaying`, so no live event can slip through.
        if (sub.cursor >= this.#node.bus.lastSeq(ch)) {
          sub.replaying = false;
          return;
        }
        const page = this.#node.bus.replay(ch, sub.cursor, REPLAY_PAGE);
        if (page.length === 0) {
          sub.replaying = false;
          return;
        }
        for (const ev of page) {
          this.#send(ev);
          sub.cursor = ev.seq;
        }
        await this.#waitForDrain();
      }
    } catch (err) {
      this.#log.log('error', 'replay failed', { ch, err });
      this.close(1011, 'replay failed');
    }
  }

  async #waitForDrain(): Promise<void> {
    await new Promise((r) => setImmediate(r));
    while (!this.#closed && this.#ws.bufferedAmount > REPLAY_HIGH_WATER) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  #unsubscribe(params: unknown): Record<string, never> {
    const p = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;
    if (typeof p.ch !== 'string') throw new BizziError('bad_request', 'ch must be a string');
    const sub = this.#subs.get(p.ch);
    if (sub) {
      sub.cancelled = true;
      sub.off();
      this.#subs.delete(p.ch);
    }
    return {};
  }
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

export function toErrorObject(err: unknown, logger: Logger, method?: string): ErrorObject {
  if (err instanceof BizziError) return err.toObject();
  logger.log('error', 'unhandled error in request', { method, err });
  return { code: 'internal', message: err instanceof Error ? err.message : String(err) };
}
