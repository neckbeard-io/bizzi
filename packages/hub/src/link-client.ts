// Node side of the hub link: dial /ws/node, authenticate with node.hello, then serve the hub's requests
// through node.dispatch and its subscriptions from the node's event log (replay, then live). The node's
// log is the outbox: after any reconnect the hub re-subscribes from the last seq it stored.
// Reconnects with jittered exponential backoff; the local server is unaffected by link state.
// When the hub advertises node requests, the link also carries the node's own requests to the hub
// (`n:` ids) through `node.hub` (spec §5.4); they fail with machine_offline when the socket drops.

import type { BizziNode, HubTransport } from '@bizzi/core';
import {
  BizziError,
  HUB_FEATURE_NODE_REQUESTS,
  NODE_REQUEST_PREFIX,
  PROTOCOL_VERSION,
  type ChannelEvent,
  type ErrorObject,
  type Logger,
  type NodeHelloMsg,
} from '@bizzi/protocol';
import WebSocket, { type RawData } from 'ws';
import { rawToString } from './client-conn.ts';
import { requestToken } from './credentials.ts';
import type { Ed25519PrivateJwk } from './crypto.ts';
import { nullLogger } from './util.ts';

export type HubLinkState = 'connecting' | 'connected' | 'disconnected' | 'closed';

export interface HubLinkOptions {
  /** Node link URL, e.g. wss://bizzi.example.com/ws/node (the HTTP API is derived from it). */
  url: string;
  credentials: { deviceId: string; privateKey: Ed25519PrivateJwk };
  logger?: Logger;
  /** First reconnect delay (default 500 ms); doubles per failure up to maxBackoffMs (default 30 s), full jitter. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Ping interval; the link is dropped when a ping goes unanswered (default 30 s). */
  pingIntervalMs?: number;
  /** Refresh the token this long before it expires (default 5 min). */
  refreshBeforeMs?: number;
  onStateChange?: (state: HubLinkState) => void;
  fetch?: typeof fetch;
}

export interface HubLink {
  readonly state: HubLinkState;
  /** Resolves when the link is connected (welcomed by the hub); rejects on timeout or close. */
  waitConnected(timeoutMs?: number): Promise<void>;
  /** Drop the current socket (for tests); the link reconnects. */
  reconnect(): void;
  /** Stop for good. */
  close(): Promise<void>;
}

const REPLAY_PAGE = 500;
const REPLAY_HIGH_WATER = 4 * 1024 * 1024;

export function connectToHub(node: BizziNode, opts: HubLinkOptions): HubLink {
  return new LinkClient(node, opts);
}

interface Sub {
  cursor: number;
  replaying: boolean;
  cancelled: boolean;
  off: () => void;
}

class LinkClient implements HubLink {
  readonly #node: BizziNode;
  readonly #o: HubLinkOptions;
  readonly #log: Logger;
  #state: HubLinkState = 'connecting';
  #ws?: WebSocket;
  #token?: { token: string; expiresAt: number };
  #refreshTimer?: NodeJS.Timeout;
  #sleep?: { timer: NodeJS.Timeout; resolve: () => void };
  #closed = false;
  readonly #loop: Promise<void>;
  readonly #waiters = new Set<{ resolve: () => void; reject: (e: Error) => void }>();

  constructor(node: BizziNode, o: HubLinkOptions) {
    this.#node = node;
    this.#o = o;
    this.#log = (o.logger ?? node.logger ?? nullLogger).child({ component: 'hub-link', hub: o.url });
    this.#loop = this.#run();
  }

  get state(): HubLinkState {
    return this.#state;
  }

  waitConnected(timeoutMs = 30_000): Promise<void> {
    if (this.#state === 'connected') return Promise.resolve();
    if (this.#closed) return Promise.reject(new Error('hub link closed'));
    return new Promise((resolve, reject) => {
      const w = {
        resolve: () => {
          clearTimeout(t);
          resolve();
        },
        reject: (e: Error) => {
          clearTimeout(t);
          reject(e);
        },
      };
      const t = setTimeout(() => {
        this.#waiters.delete(w);
        reject(new Error('timed out waiting for the hub link'));
      }, timeoutMs);
      this.#waiters.add(w);
    });
  }

  reconnect(): void {
    this.#ws?.terminate();
  }

  async close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      clearTimeout(this.#refreshTimer);
      if (this.#sleep) {
        clearTimeout(this.#sleep.timer);
        this.#sleep.resolve();
      }
      this.#ws?.close(1000, 'node shutting down');
      setTimeout(() => this.#ws?.terminate(), 1000).unref();
      for (const w of this.#waiters) w.reject(new Error('hub link closed'));
      this.#waiters.clear();
    }
    await this.#loop;
  }

  #setState(s: HubLinkState): void {
    if (this.#state === s) return;
    this.#state = s;
    if (s === 'connected') {
      for (const w of this.#waiters) w.resolve();
      this.#waiters.clear();
    }
    this.#o.onStateChange?.(s);
  }

  async #run(): Promise<void> {
    let attempt = 0;
    while (!this.#closed) {
      this.#setState('connecting');
      let welcomed = false;
      try {
        const token = await this.#getToken();
        if (this.#closed) break;
        const r = await this.#connectOnce(token);
        welcomed = r.welcomed;
        if (r.code === 4401 || r.code === 4403) {
          this.#token = undefined;
          this.#log.log('warn', 'hub rejected the node', { code: r.code, reason: r.reason });
        } else if (welcomed) {
          this.#log.log('info', 'hub link closed', { code: r.code, reason: r.reason });
        }
      } catch (err) {
        const unauthorized = err instanceof BizziError && err.code === 'unauthorized';
        if (unauthorized) this.#token = undefined;
        this.#log.log(unauthorized ? 'warn' : 'info', 'hub link attempt failed', { err: (err as Error).message });
      }
      if (this.#closed) break;
      this.#setState('disconnected');
      attempt = welcomed ? 0 : attempt + 1;
      const min = this.#o.minBackoffMs ?? 500;
      const max = this.#o.maxBackoffMs ?? 30_000;
      const cap = Math.min(max, min * 2 ** Math.min(attempt, 16));
      const delay = welcomed ? min * Math.random() : min / 2 + Math.random() * (cap - min / 2);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.#sleep = undefined;
          resolve();
        }, delay);
        this.#sleep = { timer, resolve };
      });
    }
    clearTimeout(this.#refreshTimer);
    this.#setState('closed');
  }

  async #getToken(): Promise<string> {
    const margin = this.#o.refreshBeforeMs ?? 5 * 60_000;
    if (this.#token && this.#token.expiresAt - Date.now() > Math.min(margin, 60_000)) return this.#token.token;
    return this.#refreshToken();
  }

  async #refreshToken(): Promise<string> {
    const req: Parameters<typeof requestToken>[0] = {
      hubUrl: this.#o.url,
      deviceId: this.#o.credentials.deviceId,
      privateKey: this.#o.credentials.privateKey,
    };
    if (this.#o.fetch) req.fetch = this.#o.fetch;
    const res = await requestToken(req);
    const expiresAt = Date.parse(res.expiresAt);
    this.#token = { token: res.token, expiresAt };
    // Keep a valid token ready for the next reconnect.
    clearTimeout(this.#refreshTimer);
    const margin = this.#o.refreshBeforeMs ?? 5 * 60_000;
    const inMs = Math.max(10_000, expiresAt - Date.now() - margin);
    this.#refreshTimer = setTimeout(() => {
      if (this.#closed) return;
      this.#refreshToken().catch((err: unknown) => this.#log.log('debug', 'token refresh failed', { err: (err as Error).message }));
    }, inMs);
    this.#refreshTimer.unref();
    return res.token;
  }

  /** One connection: resolves when the socket closes. */
  #connectOnce(token: string): Promise<{ welcomed: boolean; code: number; reason: string }> {
    return new Promise((resolve) => {
      const ws = new WebSocket(this.#o.url, { handshakeTimeout: 15_000, maxPayload: 64 * 1024 * 1024 });
      this.#ws = ws;
      let welcomed = false;
      let alive = true;
      const subs = new Map<string, Sub>();
      // Requests this node sent to the hub over this socket (spec §5.4).
      const outgoing = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
      let n = 0;
      let transport: HubTransport | undefined;
      let ping: NodeJS.Timeout | undefined;
      const helloTimer = setTimeout(() => ws.terminate(), 15_000);

      const send = (msg: unknown) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      };

      ws.on('open', () => {
        const hello: NodeHelloMsg = { type: 'node.hello', protocol: PROTOCOL_VERSION, token, machine: this.#node.machine };
        send(hello);
        ping = setInterval(() => {
          if (!alive) {
            ws.terminate();
            return;
          }
          alive = false;
          try {
            ws.ping();
          } catch {
            // closing
          }
        }, this.#o.pingIntervalMs ?? 30_000);
        ping.unref();
      });
      ws.on('pong', () => {
        alive = true;
      });
      ws.on('message', (data: RawData, isBinary: boolean) => {
        if (isBinary) return;
        alive = true;
        let msg: { type?: unknown; id?: unknown; method?: unknown; params?: unknown };
        try {
          msg = JSON.parse(rawToString(data)) as typeof msg;
        } catch {
          return;
        }
        if (!welcomed) {
          if (msg?.type === 'node.welcome') {
            welcomed = true;
            clearTimeout(helloTimer);
            const features = (msg as { features?: unknown }).features;
            const nodeRequests = Array.isArray(features) && features.includes(HUB_FEATURE_NODE_REQUESTS);
            this.#log.log('info', 'hub link connected', { hubVersion: (msg as { hubVersion?: unknown }).hubVersion, nodeRequests });
            if (nodeRequests) {
              transport = {
                request: (method, params, timeoutMs) => {
                  if (ws.readyState !== WebSocket.OPEN) return Promise.reject(new BizziError('machine_offline', 'the hub link is down'));
                  const id = `${NODE_REQUEST_PREFIX}${++n}`;
                  return new Promise((resolve, reject) => {
                    const timer = setTimeout(() => {
                      outgoing.delete(id);
                      reject(new BizziError('machine_offline', `the hub did not answer ${method} in time`));
                    }, timeoutMs);
                    outgoing.set(id, { resolve, reject, timer });
                    send({ id, method, params });
                  });
                },
              };
              this.#node.hub?.attach(transport);
            } else {
              this.#node.hub?.markUnsupported();
            }
            this.#setState('connected');
          }
          return;
        }
        if (typeof msg?.id === 'string' && msg.id.startsWith(NODE_REQUEST_PREFIX) && typeof msg.method !== 'string') {
          const p = outgoing.get(msg.id);
          if (!p) return;
          outgoing.delete(msg.id);
          clearTimeout(p.timer);
          const r = msg as { result?: unknown; error?: ErrorObject };
          if (r.error) p.reject(new BizziError(r.error.code, r.error.message, r.error.data));
          else p.resolve(r.result);
          return;
        }
        if (typeof msg?.id !== 'string' || typeof msg.method !== 'string') return;
        void this.#serve(msg.id, msg.method, msg.params, subs, send, ws);
      });
      ws.on('error', (err) => this.#log.log('debug', 'hub socket error', { err: err.message }));
      ws.on('close', (code, reason) => {
        clearTimeout(helloTimer);
        clearInterval(ping);
        for (const s of subs.values()) {
          s.cancelled = true;
          s.off();
        }
        subs.clear();
        if (transport) this.#node.hub?.detach(transport);
        else if (welcomed) this.#node.hub?.detach();
        const lost = new BizziError('machine_offline', 'lost the hub link');
        for (const p of outgoing.values()) {
          clearTimeout(p.timer);
          p.reject(lost);
        }
        outgoing.clear();
        if (this.#ws === ws) this.#ws = undefined;
        resolve({ welcomed, code, reason: reason.toString() });
      });
    });
  }

  async #serve(
    id: string,
    method: string,
    params: unknown,
    subs: Map<string, Sub>,
    send: (msg: unknown) => void,
    ws: WebSocket,
  ): Promise<void> {
    try {
      const p = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;
      if (method === 'subscribe') {
        const ch = p.ch;
        if (typeof ch !== 'string') throw new BizziError('bad_request', 'ch must be a string');
        const since = p.since ?? 0;
        if (typeof since !== 'number' || !Number.isInteger(since) || since < 0) {
          throw new BizziError('bad_request', 'since must be a non-negative integer');
        }
        this.#node.assertChannel(ch);
        const prev = subs.get(ch);
        if (prev) {
          prev.cancelled = true;
          prev.off();
        }
        const bus = this.#node.bus;
        const sub: Sub = { cursor: since, replaying: true, cancelled: false, off: () => {} };
        sub.off = bus.on(ch, (ev: ChannelEvent) => {
          if (sub.cancelled || sub.replaying || ev.seq <= sub.cursor) return;
          sub.cursor = ev.seq;
          send(ev);
        });
        subs.set(ch, sub);
        send({ id, result: { ch, lastSeq: bus.lastSeq(ch) } });
        await this.#pump(ch, sub, send, ws);
        return;
      }
      if (method === 'unsubscribe') {
        const ch = p.ch;
        if (typeof ch !== 'string') throw new BizziError('bad_request', 'ch must be a string');
        const sub = subs.get(ch);
        if (sub) {
          sub.cancelled = true;
          sub.off();
          subs.delete(ch);
        }
        send({ id, result: {} });
        return;
      }
      const result = await this.#node.dispatch(method, params);
      send({ id, result });
    } catch (err) {
      const error: ErrorObject =
        err instanceof BizziError ? err.toObject() : { code: 'internal', message: err instanceof Error ? err.message : String(err) };
      if (!(err instanceof BizziError)) this.#log.log('error', 'unhandled error serving hub request', { method, err });
      send({ id, error });
    }
  }

  /** Replay page by page with backpressure, then flip to live (same scheme as the core server). */
  async #pump(ch: string, sub: Sub, send: (msg: unknown) => void, ws: WebSocket): Promise<void> {
    const bus = this.#node.bus;
    for (;;) {
      if (sub.cancelled || ws.readyState !== WebSocket.OPEN) return;
      if (sub.cursor >= bus.lastSeq(ch)) {
        sub.replaying = false;
        return;
      }
      const page = bus.replay(ch, sub.cursor, REPLAY_PAGE);
      if (page.length === 0) {
        sub.replaying = false;
        return;
      }
      for (const ev of page) {
        send(ev);
        sub.cursor = ev.seq;
      }
      await new Promise((r) => setImmediate(r));
      while (ws.readyState === WebSocket.OPEN && ws.bufferedAmount > REPLAY_HIGH_WATER) await new Promise((r) => setTimeout(r, 10));
    }
  }
}
