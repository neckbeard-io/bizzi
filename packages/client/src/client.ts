import { BizziError, PROTOCOL_VERSION, decode, encode, isErrorResponse, isEvent, isResponse } from '@bizzi/protocol';
import type {
  ChannelEvent,
  ErrorObject,
  Logger,
  MachineInfo,
  MachineRole,
  MethodName,
  MethodParams,
  MethodResult,
  RequestMsg,
} from '@bizzi/protocol';
import { DEFAULT_BACKOFF, backoffDelay } from './backoff.ts';
import type { BackoffOptions } from './backoff.ts';
import type { TokenProvider } from './hub.ts';

/** The subset of the WebSocket API the client needs. Browsers, Node ≥ 22 and the UI mock all provide it. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type SocketFactory = (url: string) => WebSocketLike;

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface ConnectionInfo {
  state: ConnectionState;
  url: string | null;
  /** Consecutive failed attempts since the last successful handshake. */
  attempt: number;
  /** Epoch ms of the next reconnect attempt, when reconnecting. */
  nextRetryAt: number | null;
  lastError: ErrorObject | null;
  serverVersion: string | null;
  machine: MachineInfo | null;
  /** 'hub' when connected to a hub (multi-machine), 'node' for a single node; null until the handshake. */
  role: MachineRole | null;
  /** Epoch ms of the last successful handshake. */
  connectedAt: number | null;
  /** Number of successful handshakes (1 = first connect; >1 = reconnected). */
  sessions: number;
}

export interface GapInfo {
  ch: string;
  /** First missing seq. */
  from: number;
  /** Last missing seq. */
  to: number;
  /** 'detected' when first seen; 'skipped' when the hole did not fill within gapTimeoutMs. */
  state: 'detected' | 'skipped';
}

export interface ClientStats {
  received: number;
  delivered: number;
  duplicates: number;
  gaps: number;
}

export interface BizziClientOptions {
  clientName?: string;
  clientVersion?: string;
  requestTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  /** How long to wait for a seq hole to fill (after a re-subscribe) before skipping it. */
  gapTimeoutMs?: number;
  backoff?: Partial<BackoffOptions>;
  createSocket?: SocketFactory;
  logger?: Logger;
  random?: () => number;
}

export interface RequestOptions {
  timeoutMs?: number;
}

export type HelloResult = MethodResult<'hello'>;

interface PendingRequest {
  id: string;
  method: MethodName;
  params: unknown;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  sent: boolean;
}

interface ChannelState {
  /** Highest seq delivered contiguously. */
  lastSeq: number;
  /** Out-of-order events waiting for a hole to fill. */
  pending: Map<number, ChannelEvent>;
  wanted: boolean;
  gapTimer: ReturnType<typeof setTimeout> | null;
}

const OPEN = 1;

function defaultSocketFactory(url: string): WebSocketLike {
  const WS = (globalThis as unknown as { WebSocket?: new (url: string) => unknown }).WebSocket;
  if (!WS) throw new BizziError('internal', 'no global WebSocket in this runtime; pass createSocket');
  return new WS(url) as WebSocketLike;
}

const noopLogger: Logger = {
  log() {},
  child() {
    return noopLogger;
  },
};

function toBizziError(e: unknown): BizziError {
  if (e instanceof BizziError) return e;
  return new BizziError('internal', e instanceof Error ? e.message : String(e));
}

/**
 * Protocol client: handshake, typed requests with timeouts, auto-reconnect with jittered exponential
 * backoff, channel subscriptions with replay on reconnect, and (ch, seq) de-duplication + gap detection.
 * Pure TS; works in browsers, Electron renderers, Capacitor and Node.
 */
export class BizziClient {
  private readonly opts: Required<Omit<BizziClientOptions, 'backoff' | 'createSocket' | 'logger' | 'random'>>;
  private readonly backoff: BackoffOptions;
  private readonly createSocket: SocketFactory;
  private readonly logger: Logger;
  private readonly random: () => number;

  private ws: WebSocketLike | null = null;
  /** Bumped whenever a socket is abandoned, so stale callbacks are ignored. */
  private gen = 0;
  private url: string | null = null;
  private auth: string | TokenProvider | undefined;
  private token: string | undefined;
  /** Next token fetch must bypass the provider's cache (after an `unauthorized` hello). */
  private forceRefresh = false;
  /** One forced token refresh per connect cycle before `unauthorized` becomes fatal. */
  private authRetried = false;
  private userClosed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private nextId = 0;
  private readonly requests = new Map<string, PendingRequest>();
  private readonly channels = new Map<string, ChannelState>();
  private conn: ConnectionInfo = {
    state: 'idle',
    url: null,
    attempt: 0,
    nextRetryAt: null,
    lastError: null,
    serverVersion: null,
    machine: null,
    role: null,
    connectedAt: null,
    sessions: 0,
  };
  private connectWaiters: { resolve: (r: HelloResult) => void; reject: (e: BizziError) => void }[] = [];

  private readonly eventListeners = new Set<(ev: ChannelEvent) => void>();
  private readonly connListeners = new Set<(c: ConnectionInfo) => void>();
  private readonly gapListeners = new Set<(g: GapInfo) => void>();
  private readonly resetListeners = new Set<(ch: string) => void>();

  readonly stats: ClientStats = { received: 0, delivered: 0, duplicates: 0, gaps: 0 };

  constructor(options: BizziClientOptions = {}) {
    this.opts = {
      clientName: options.clientName ?? '@bizzi/client',
      clientVersion: options.clientVersion ?? '0.0.1',
      requestTimeoutMs: options.requestTimeoutMs ?? 15_000,
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? 10_000,
      gapTimeoutMs: options.gapTimeoutMs ?? 3_000,
    };
    this.backoff = { ...DEFAULT_BACKOFF, ...options.backoff };
    this.createSocket = options.createSocket ?? defaultSocketFactory;
    this.logger = options.logger ?? noopLogger;
    this.random = options.random ?? Math.random;
  }

  // ---------------------------------------------------------------- connection

  /**
   * Connect and keep the connection alive. Resolves after the first successful `hello`; rejects only on
   * fatal errors (unauthorized, protocol mismatch) or `close()`. Transient failures keep retrying.
   *
   * `auth` is a static token (local mode) or a TokenProvider (hub mode), asked for a token before every
   * (re)connect. An `unauthorized` hello with a provider is retried once with a forced refresh.
   */
  connect(url: string, auth?: string | TokenProvider): Promise<HelloResult> {
    this.close();
    this.userClosed = false;
    this.url = url;
    this.auth = auth;
    this.token = typeof auth === 'string' ? auth : undefined;
    this.forceRefresh = false;
    this.authRetried = false;
    this.setConn({ state: 'connecting', url, attempt: 0, nextRetryAt: null, lastError: null, sessions: 0 });
    const p = new Promise<HelloResult>((resolve, reject) => this.connectWaiters.push({ resolve, reject }));
    this.openSocket();
    return p;
  }

  /** Close for good (no reconnect). Pending requests are rejected. Channel cursors are kept. */
  close(): void {
    this.userClosed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.dropSocket();
    const err = new BizziError('internal', 'client closed');
    this.failRequests(err, true);
    this.rejectConnectWaiters(err);
    if (this.conn.state !== 'idle' && this.conn.state !== 'closed') this.setConn({ state: 'closed', nextRetryAt: null });
  }

  /** Skip the backoff wait and try now (e.g. on `online` / `visibilitychange`). */
  reconnectNow(): void {
    if (this.conn.state !== 'reconnecting' || this.userClosed) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (!this.ws) this.openSocket();
  }

  getConnection(): ConnectionInfo {
    return this.conn;
  }

  isOpen(): boolean {
    return this.conn.state === 'open' && this.ws !== null;
  }

  onConnection(l: (c: ConnectionInfo) => void): () => void {
    this.connListeners.add(l);
    return () => this.connListeners.delete(l);
  }

  /** Ordered, de-duplicated events from every subscribed channel. */
  onEvent(l: (ev: ChannelEvent) => void): () => void {
    this.eventListeners.add(l);
    return () => this.eventListeners.delete(l);
  }

  onGap(l: (g: GapInfo) => void): () => void {
    this.gapListeners.add(l);
    return () => this.gapListeners.delete(l);
  }

  /** The server's log for a channel is behind our cursor (server reset): the consumer must rebuild from 0. */
  onReset(l: (ch: string) => void): () => void {
    this.resetListeners.add(l);
    return () => this.resetListeners.delete(l);
  }

  // ---------------------------------------------------------------- requests

  request<M extends MethodName>(method: M, params: MethodParams<M>, options: RequestOptions = {}): Promise<MethodResult<M>> {
    if (this.userClosed || this.conn.state === 'idle') {
      return Promise.reject(new BizziError('machine_offline', 'not connected'));
    }
    return this.enqueue(method, params, options.timeoutMs ?? this.opts.requestTimeoutMs, false) as Promise<MethodResult<M>>;
  }

  private enqueue(method: MethodName, params: unknown, timeoutMs: number, direct: boolean): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = `r_${++this.nextId}`;
      const timer = setTimeout(() => {
        this.requests.delete(id);
        reject(new BizziError('internal', `${method} timed out after ${timeoutMs} ms`, { timeout: true }));
      }, timeoutMs);
      const req: PendingRequest = { id, method, params, resolve, reject, timer, sent: false };
      this.requests.set(id, req);
      // Requests made while (re)connecting wait for the handshake; `hello`/`subscribe` go out directly.
      if (direct || this.isOpen()) this.transmit(req);
    });
  }

  private transmit(req: PendingRequest): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== OPEN) return;
    req.sent = true;
    const msg = { id: req.id, method: req.method, params: req.params } as RequestMsg;
    try {
      ws.send(encode(msg));
    } catch (e) {
      req.sent = false;
      this.logger.log('warn', 'send failed', { method: req.method, error: String(e) });
    }
  }

  private failRequests(err: BizziError, includeQueued: boolean): void {
    for (const [id, req] of this.requests) {
      if (!req.sent && !includeQueued) continue;
      clearTimeout(req.timer);
      this.requests.delete(id);
      req.reject(err);
    }
  }

  // ---------------------------------------------------------------- channels

  /**
   * Subscribe to a channel. Replays events after the last delivered seq (or `since` when given), then
   * streams live events. The subscription survives reconnects.
   */
  async subscribe(ch: string, options: { since?: number } = {}): Promise<void> {
    const st = this.channel(ch);
    if (options.since !== undefined) {
      st.lastSeq = options.since;
      st.pending.clear();
    }
    st.wanted = true;
    if (this.isOpen()) await this.sendSubscribe(ch);
  }

  async unsubscribe(ch: string): Promise<void> {
    const st = this.channels.get(ch);
    if (!st || !st.wanted) return;
    st.wanted = false;
    if (st.gapTimer) clearTimeout(st.gapTimer);
    st.gapTimer = null;
    st.pending.clear();
    if (this.isOpen()) {
      try {
        await this.enqueue('unsubscribe', { ch }, this.opts.requestTimeoutMs, true);
      } catch (e) {
        this.logger.log('debug', 'unsubscribe failed', { ch, error: String(e) });
      }
    }
  }

  /** Forget a channel's cursor (the next subscribe replays from the start). */
  resetChannel(ch: string): void {
    const st = this.channels.get(ch);
    if (!st) return;
    st.lastSeq = 0;
    st.pending.clear();
  }

  lastSeq(ch: string): number {
    return this.channels.get(ch)?.lastSeq ?? 0;
  }

  isSubscribed(ch: string): boolean {
    return this.channels.get(ch)?.wanted ?? false;
  }

  private channel(ch: string): ChannelState {
    let st = this.channels.get(ch);
    if (!st) {
      st = { lastSeq: 0, pending: new Map(), wanted: false, gapTimer: null };
      this.channels.set(ch, st);
    }
    return st;
  }

  private async sendSubscribe(ch: string): Promise<void> {
    const st = this.channel(ch);
    const since = st.lastSeq;
    const res = (await this.enqueue('subscribe', { ch, since }, this.opts.requestTimeoutMs, true)) as MethodResult<'subscribe'>;
    if (res.lastSeq < since && st.lastSeq >= since) {
      // The server's log is behind our cursor: it was reset or we talk to a different server.
      this.logger.log('warn', 'channel reset by server', { ch, since, serverLastSeq: res.lastSeq });
      st.lastSeq = 0;
      st.pending.clear();
      for (const l of this.resetListeners) this.safe(() => l(ch));
      await this.enqueue('subscribe', { ch, since: 0 }, this.opts.requestTimeoutMs, true);
    }
  }

  // ---------------------------------------------------------------- socket lifecycle

  private openSocket(): void {
    if (!this.url || this.userClosed) return;
    const gen = ++this.gen;
    const auth = this.auth;
    if (auth !== undefined && typeof auth !== 'string') {
      const force = this.forceRefresh;
      this.forceRefresh = false;
      auth.getToken(force ? { forceRefresh: true } : {}).then(
        (token) => {
          if (gen !== this.gen || this.userClosed) return;
          this.token = token;
          this.wireSocket(gen);
        },
        (e: unknown) => {
          if (gen !== this.gen || this.userClosed) return;
          const err = toBizziError(e);
          if (err.code === 'unauthorized') this.fatal(err);
          else this.socketDown(gen, err.toObject());
        },
      );
      return;
    }
    this.wireSocket(gen);
  }

  private wireSocket(gen: number): void {
    if (!this.url) return;
    let ws: WebSocketLike;
    try {
      ws = this.createSocket(this.url);
    } catch (e) {
      this.socketDown(gen, { code: 'machine_offline', message: e instanceof Error ? e.message : String(e) });
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (gen === this.gen) this.handshake(gen);
    };
    ws.onmessage = (ev) => {
      if (gen === this.gen && typeof ev.data === 'string') this.onMessage(ev.data);
    };
    ws.onclose = (ev) => {
      if (gen === this.gen) {
        this.socketDown(gen, { code: 'machine_offline', message: `connection closed${ev.code ? ` (${ev.code})` : ''}` });
      }
    };
    ws.onerror = () => {
      // A close event follows; nothing to do here.
    };
  }

  private handshake(gen: number): void {
    const params: MethodParams<'hello'> = {
      protocol: PROTOCOL_VERSION,
      client: { name: this.opts.clientName, version: this.opts.clientVersion },
    };
    if (this.token !== undefined) params.token = this.token;
    this.enqueue('hello', params, this.opts.handshakeTimeoutMs, true).then(
      (raw) => {
        if (gen !== this.gen) return;
        const res = raw as HelloResult;
        this.authRetried = false;
        if (res.protocol !== PROTOCOL_VERSION) {
          this.fatal(new BizziError('unsupported', `server speaks ${res.protocol}, client needs ${PROTOCOL_VERSION}`));
          return;
        }
        this.setConn({
          state: 'open',
          attempt: 0,
          nextRetryAt: null,
          lastError: null,
          serverVersion: res.serverVersion,
          machine: res.machine,
          role: res.role ?? (res.machine.roles.includes('hub') && !res.machine.roles.includes('node') ? 'hub' : 'node'),
          connectedAt: Date.now(),
          sessions: this.conn.sessions + 1,
        });
        const waiters = this.connectWaiters;
        this.connectWaiters = [];
        for (const w of waiters) w.resolve(res);
        // Re-subscribe every channel from its cursor (replay), then flush requests queued while offline.
        for (const [ch, st] of this.channels) {
          if (!st.wanted) continue;
          this.sendSubscribe(ch).catch((e) => this.logger.log('warn', 're-subscribe failed', { ch, error: String(e) }));
        }
        for (const req of this.requests.values()) if (!req.sent) this.transmit(req);
      },
      (e: unknown) => {
        if (gen !== this.gen) return;
        const err = toBizziError(e);
        if (err.code === 'unauthorized' && this.auth !== undefined && typeof this.auth !== 'string' && !this.authRetried) {
          // The cached token may have expired or been revoked server-side: fetch a fresh one once.
          this.authRetried = true;
          this.forceRefresh = true;
          this.dropSocket();
          this.openSocket();
          return;
        }
        if (err.code === 'unauthorized' || err.code === 'unsupported' || err.code === 'bad_request') {
          this.fatal(err);
        } else {
          this.dropSocket();
          this.socketDown(gen, err.toObject());
        }
      },
    );
  }

  private fatal(err: BizziError): void {
    this.userClosed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.dropSocket();
    this.failRequests(err, true);
    this.rejectConnectWaiters(err);
    this.setConn({ state: 'closed', lastError: err.toObject(), nextRetryAt: null });
  }

  private rejectConnectWaiters(err: BizziError): void {
    const waiters = this.connectWaiters;
    this.connectWaiters = [];
    for (const w of waiters) w.reject(err);
  }

  private dropSocket(): void {
    const ws = this.ws;
    this.ws = null;
    this.gen++;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try {
      ws.close(1000, 'client closing');
    } catch {
      // already closed
    }
  }

  private socketDown(gen: number, error: ErrorObject): void {
    if (gen !== this.gen && this.ws !== null) return;
    if (this.ws) {
      this.ws.onopen = this.ws.onmessage = this.ws.onclose = this.ws.onerror = null;
      this.ws = null;
    }
    this.gen++;
    // In-flight requests may or may not have been applied; the caller decides whether to retry.
    this.failRequests(new BizziError('machine_offline', error.message), false);
    for (const st of this.channels.values()) {
      if (st.gapTimer) clearTimeout(st.gapTimer);
      st.gapTimer = null;
    }
    if (this.userClosed) return;
    const attempt = this.conn.attempt;
    const delay = backoffDelay(attempt, this.backoff, this.random);
    this.setConn({ state: 'reconnecting', attempt: attempt + 1, nextRetryAt: Date.now() + delay, lastError: error });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  // ---------------------------------------------------------------- inbound

  private onMessage(text: string): void {
    let msg: ReturnType<typeof decode>;
    try {
      msg = decode(text);
    } catch (e) {
      this.logger.log('warn', 'bad message from server', { error: String(e) });
      return;
    }
    if (isResponse(msg)) {
      const req = this.requests.get(msg.id);
      if (!req) return;
      this.requests.delete(msg.id);
      clearTimeout(req.timer);
      if (isErrorResponse(msg)) req.reject(new BizziError(msg.error.code, msg.error.message, msg.error.data));
      else req.resolve(msg.result);
      return;
    }
    if (isEvent(msg)) this.onChannelEvent(msg);
  }

  private onChannelEvent(ev: ChannelEvent): void {
    this.stats.received++;
    const st = this.channel(ev.ch);
    if (ev.seq <= st.lastSeq || st.pending.has(ev.seq)) {
      this.stats.duplicates++;
      return;
    }
    if (ev.seq === st.lastSeq + 1) {
      this.deliver(st, ev);
      this.drain(st);
      if (st.pending.size === 0 && st.gapTimer) {
        clearTimeout(st.gapTimer);
        st.gapTimer = null;
      }
      return;
    }
    // Hole: hold the event, ask the server to replay from our cursor, and skip the hole if it persists.
    st.pending.set(ev.seq, ev);
    if (st.gapTimer) return;
    this.stats.gaps++;
    const gap: GapInfo = { ch: ev.ch, from: st.lastSeq + 1, to: ev.seq - 1, state: 'detected' };
    for (const l of this.gapListeners) this.safe(() => l(gap));
    if (st.wanted && this.isOpen()) {
      this.sendSubscribe(ev.ch).catch((e) => this.logger.log('warn', 'gap re-subscribe failed', { ch: ev.ch, error: String(e) }));
    }
    st.gapTimer = setTimeout(() => {
      st.gapTimer = null;
      if (st.pending.size === 0) return;
      const first = Math.min(...st.pending.keys());
      const skipped: GapInfo = { ch: ev.ch, from: st.lastSeq + 1, to: first - 1, state: 'skipped' };
      for (const l of this.gapListeners) this.safe(() => l(skipped));
      st.lastSeq = first - 1;
      this.drain(st);
    }, this.opts.gapTimeoutMs);
  }

  private drain(st: ChannelState): void {
    for (;;) {
      const next = st.pending.get(st.lastSeq + 1);
      if (!next) return;
      st.pending.delete(next.seq);
      this.deliver(st, next);
    }
  }

  private deliver(st: ChannelState, ev: ChannelEvent): void {
    st.lastSeq = ev.seq;
    this.stats.delivered++;
    for (const l of this.eventListeners) this.safe(() => l(ev));
  }

  private setConn(patch: Partial<ConnectionInfo>): void {
    this.conn = { ...this.conn, ...patch };
    const c = this.conn;
    for (const l of this.connListeners) this.safe(() => l(c));
  }

  private safe(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.logger.log('error', 'listener threw', { error: e instanceof Error ? (e.stack ?? e.message) : String(e) });
    }
  }
}
