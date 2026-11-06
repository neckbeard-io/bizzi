// Client endpoint (/ws): the ordinary client protocol, authenticated with a hub-issued device token.
// Subscriptions are served from the hub's replica (replay, then live relay); everything else goes
// through the Relay (hub-only methods, index-served lists, forwarding to the owning node).

import { BizziError, PROTOCOL_VERSION, type ChannelEvent, type ErrorObject, type Logger, type ServerMsg } from '@bizzi/protocol';
import { WebSocket, type RawData } from 'ws';
import { REPLAY_PAGE } from './bus.ts';
import type { ClientHandle, Relay } from './relay.ts';
import type { DeviceRow } from './store.ts';

export const CLOSE_UNAUTHORIZED = 4401;
const REPLAY_HIGH_WATER = 4 * 1024 * 1024;

export interface ClientConnOptions {
  logger: Logger;
  maxBuffered: number;
  helloTimeoutMs: number;
  remote?: string;
  /** Base URL derived from the upgrade request (for pairUrl when no publicUrl is configured). */
  baseUrl?: string;
}

interface ChannelSub {
  cursor: number;
  replaying: boolean;
  cancelled: boolean;
  off: () => void;
}

export class ClientConn implements ClientHandle {
  readonly #ws: WebSocket;
  readonly #relay: Relay;
  readonly #o: ClientConnOptions;
  #log: Logger;
  #device?: DeviceRow;
  #alive = true;
  #closed = false;
  readonly #subs = new Map<string, ChannelSub>();
  #helloTimer?: NodeJS.Timeout;

  constructor(ws: WebSocket, relay: Relay, o: ClientConnOptions) {
    this.#ws = ws;
    this.#relay = relay;
    this.#o = o;
    this.#log = o.logger.child({ remote: o.remote });
    this.#helloTimer = setTimeout(() => this.#reject(undefined, 'hello timeout'), o.helloTimeoutMs);
    ws.on('message', (data: RawData, isBinary: boolean) => this.#onMessage(data, isBinary));
    ws.on('pong', () => {
      this.#alive = true;
    });
    ws.on('error', (err) => this.#log.log('debug', 'websocket error', { err }));
  }

  get device(): DeviceRow {
    if (!this.#device) throw new Error('not authenticated');
    return this.#device;
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
      // closing
    }
  }

  close(code: number, reason: string): void {
    if (this.#closed) return;
    this.dispose();
    this.#ws.close(code, reason);
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
    if (this.#device) this.#relay.removeClient(this);
  }

  #send(msg: ServerMsg): void {
    if (this.#closed || this.#ws.readyState !== WebSocket.OPEN) return;
    this.#ws.send(JSON.stringify(msg));
    if (this.#ws.bufferedAmount > this.#o.maxBuffered) {
      this.#log.log('warn', 'closing slow connection', { bufferedAmount: this.#ws.bufferedAmount });
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
    let msg: { id?: unknown; method?: unknown; params?: unknown } | undefined;
    try {
      const v: unknown = isBinary ? undefined : JSON.parse(rawToString(data));
      if (v && typeof v === 'object' && !Array.isArray(v)) msg = v as typeof msg;
    } catch {
      // handled below
    }
    const id = typeof msg?.id === 'string' ? msg.id : undefined;
    if (!msg || id === undefined || typeof msg.method !== 'string') {
      if (!this.#device) return this.#reject(id, 'expected hello');
      this.#send({ id: id ?? '', error: { code: 'bad_request', message: 'not a bizzi request' } });
      return;
    }
    if (!this.#device) {
      if (msg.method !== 'hello') return this.#reject(id, 'expected hello');
      return this.#hello(id, msg.params);
    }
    void this.#handle(id, msg.method, msg.params);
  }

  #hello(id: string, params: unknown): void {
    const p = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;
    if (p.protocol !== PROTOCOL_VERSION) return this.#reject(id, `unsupported protocol (hub speaks ${PROTOCOL_VERSION})`);
    let device: DeviceRow;
    try {
      device = this.#relay.auth.authenticate(p.token);
    } catch (err) {
      return this.#reject(id, err instanceof Error ? err.message : 'invalid token');
    }
    clearTimeout(this.#helloTimer);
    this.#device = device;
    this.#relay.addClient(this);
    this.#relay.store.touchDevice(device.id, new Date().toISOString());
    const client = p.client as { name?: unknown } | undefined;
    this.#log = this.#log.child({ deviceId: device.id, client: typeof client?.name === 'string' ? client.name : undefined });
    this.#log.log('debug', 'client connected');
    this.#send({ id, result: this.#relay.helloResult() } as ServerMsg);
  }

  async #handle(id: string, method: string, params: unknown): Promise<void> {
    try {
      let result: unknown;
      if (method === 'subscribe') result = this.#subscribe(params);
      else if (method === 'unsubscribe') result = this.#unsubscribe(params);
      else {
        const ctx: { baseUrl?: string } = {};
        if (this.#o.baseUrl) ctx.baseUrl = this.#o.baseUrl;
        result = await this.#relay.handle(this.device, method, params, ctx);
      }
      this.#send({ id, result } as ServerMsg);
      if (method === 'subscribe') void this.#pump((result as { ch: string }).ch);
    } catch (err) {
      this.#send({ id, error: toErrorObject(err, this.#log, method) });
    }
  }

  #subscribe(params: unknown): { ch: string; lastSeq: number } {
    const p = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;
    const ch = p.ch;
    this.#relay.assertChannel(ch);
    const since = p.since ?? 0;
    if (typeof since !== 'number' || !Number.isInteger(since) || since < 0) {
      throw new BizziError('bad_request', 'since must be a non-negative integer');
    }
    const previous = this.#subs.get(ch);
    if (previous) {
      previous.cancelled = true;
      previous.off();
    }
    const bus = this.#relay.bus;
    const sub: ChannelSub = { cursor: since, replaying: true, cancelled: false, off: () => {} };
    sub.off = bus.on(ch, (ev: ChannelEvent) => {
      if (sub.cancelled || sub.replaying || ev.seq <= sub.cursor) return;
      sub.cursor = ev.seq;
      this.#send(ev);
    });
    this.#subs.set(ch, sub);
    return { ch, lastSeq: bus.lastSeq(ch) };
  }

  async #pump(ch: string): Promise<void> {
    const sub = this.#subs.get(ch);
    if (!sub) return;
    const bus = this.#relay.bus;
    try {
      for (;;) {
        if (sub.cancelled || this.#closed) return;
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
          this.#send(ev);
          sub.cursor = ev.seq;
        }
        await new Promise((r) => setImmediate(r));
        while (!this.#closed && this.#ws.bufferedAmount > REPLAY_HIGH_WATER) await new Promise((r) => setTimeout(r, 10));
      }
    } catch (err) {
      this.#log.log('error', 'replay failed', { ch, err });
      this.close(1011, 'replay failed');
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

export function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

export function toErrorObject(err: unknown, logger: Logger, method?: string): ErrorObject {
  if (err instanceof BizziError) return err.toObject();
  logger.log('error', 'unhandled error in request', { method, err });
  return { code: 'internal', message: err instanceof Error ? err.message : String(err) };
}
