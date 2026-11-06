import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { BizziError, PROTOCOL_VERSION } from '@bizzi/protocol';
import type { ChannelEvent, ErrorObject, GlobalEventBody, MachineInfo, MachineRole, RequestMsg, SessionEventBody } from '@bizzi/protocol';

export const MACHINE: MachineInfo = {
  id: 'm_1',
  name: 'test',
  hostname: 'test.local',
  os: 'linux',
  arch: 'arm64',
  headful: false,
  alwaysOn: true,
  tags: [],
  online: true,
  roles: ['node'],
  bizziVersion: '0.0.0',
};

type Handler = (params: Record<string, unknown>, conn: Conn) => unknown;

interface Conn {
  ws: WebSocket;
  authed: boolean;
  subs: Set<string>;
}

/** A tiny in-memory bizzi server for client tests. */
export class FakeServer {
  readonly wss: WebSocketServer;
  readonly logs = new Map<string, ChannelEvent[]>();
  readonly conns = new Set<Conn>();
  readonly requests: RequestMsg[] = [];
  token = 'secret';
  /** Accept any of these tokens too (hub tests rotate tokens). */
  readonly tokens = new Set<string>();
  helloCount = 0;
  /** What `hello` answers with. */
  helloMachine: MachineInfo = MACHINE;
  helloRole: MachineRole | undefined = undefined;
  /** Extra events replayed on subscribe below `since` (simulates a sloppy server; client must dedupe). */
  replayOverlap = 0;
  /** Methods that never get a response. */
  readonly blackhole = new Set<string>();
  readonly handlers = new Map<string, Handler>();

  private constructor(wss: WebSocketServer) {
    this.wss = wss;
    wss.on('connection', (ws) => this.onConnection(ws));
    this.handlers.set('workspaces.list', () => ({ workspaces: [] }));
    this.handlers.set('machines.list', () => ({ machines: [MACHINE] }));
    this.handlers.set('agents.list', () => ({ agents: [] }));
    this.handlers.set('sessions.list', () => ({ sessions: [] }));
  }

  static async start(): Promise<FakeServer> {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    return new FakeServer(wss);
  }

  get url(): string {
    const addr = this.wss.address();
    if (typeof addr === 'string' || !addr) throw new Error('no address');
    return `ws://127.0.0.1:${addr.port}/ws`;
  }

  async stop(): Promise<void> {
    for (const c of this.conns) c.ws.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  /** Abruptly drop every client connection. */
  dropAll(): void {
    for (const c of this.conns) c.ws.terminate();
    this.conns.clear();
  }

  /** Append an event to a channel log and send it to subscribers. */
  push(ch: string, body: SessionEventBody | GlobalEventBody, opts: { seq?: number; send?: boolean } = {}): ChannelEvent {
    let log = this.logs.get(ch);
    if (!log) this.logs.set(ch, (log = []));
    const seq = opts.seq ?? (log.at(-1)?.seq ?? 0) + 1;
    const ev = { ...body, ch, seq, ts: new Date().toISOString() } as ChannelEvent;
    log.push(ev);
    log.sort((a, b) => a.seq - b.seq);
    if (opts.send ?? true) {
      for (const c of this.conns) if (c.subs.has(ch)) c.ws.send(JSON.stringify(ev));
    }
    return ev;
  }

  /** Send an arbitrary event to every connection subscribed to its channel (no logging). */
  sendRaw(ev: ChannelEvent): void {
    for (const c of this.conns) if (c.subs.has(ev.ch)) c.ws.send(JSON.stringify(ev));
  }

  private onConnection(ws: WebSocket): void {
    const conn: Conn = { ws, authed: false, subs: new Set() };
    this.conns.add(conn);
    ws.on('close', () => this.conns.delete(conn));
    ws.on('message', (raw) => {
      const req = JSON.parse(String(raw)) as RequestMsg;
      this.requests.push(req);
      if (this.blackhole.has(req.method)) return;
      const reply = (result: unknown): void => ws.send(JSON.stringify({ id: req.id, result }));
      const fail = (error: ErrorObject): void => ws.send(JSON.stringify({ id: req.id, error }));
      const params = req.params as Record<string, unknown>;
      if (req.method === 'hello') {
        if (params.token !== this.token && !this.tokens.has(params.token as string)) return fail({ code: 'unauthorized', message: 'bad token' });
        conn.authed = true;
        this.helloCount++;
        const hello: Record<string, unknown> = { protocol: PROTOCOL_VERSION, serverVersion: 'fake', machine: this.helloMachine };
        if (this.helloRole) hello.role = this.helloRole;
        return reply(hello);
      }
      if (!conn.authed) return fail({ code: 'unauthorized', message: 'hello first' });
      if (req.method === 'subscribe') {
        const ch = params.ch as string;
        const since = (params.since as number | undefined) ?? 0;
        conn.subs.add(ch);
        const log = this.logs.get(ch) ?? [];
        for (const ev of log) if (ev.seq > since - this.replayOverlap) ws.send(JSON.stringify(ev));
        return reply({ ch, lastSeq: log.at(-1)?.seq ?? 0 });
      }
      if (req.method === 'unsubscribe') {
        conn.subs.delete(params.ch as string);
        return reply({});
      }
      const h = this.handlers.get(req.method);
      if (!h) return fail({ code: 'unsupported', message: `no handler for ${req.method}` });
      try {
        return reply(h(params, conn));
      } catch (e) {
        return fail(e instanceof BizziError ? e.toObject() : { code: 'internal', message: String(e) });
      }
    });
  }
}

export function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (cond()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timed out'));
      setTimeout(tick, 5);
    };
    tick();
  });
}
