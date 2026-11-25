// Hub side of the node link (/ws/node). After NodeHelloMsg / NodeWelcomeMsg the hub acts as a client of
// the node: it subscribes the node's `global` channel and every session channel from the last seq it
// stored, stores and fans out what arrives, and forwards client requests with `h:`-prefixed ids.
// The node may also send requests (`n:` ids, HUB_FEATURE_NODE_REQUESTS): Relay.handleNode answers them.

import {
  BizziError,
  GLOBAL_CHANNEL,
  HUB_FEATURE_NODE_REQUESTS,
  HUB_REQUEST_PREFIX,
  PROTOCOL_VERSION,
  isEvent,
  isRequest,
  isResponse,
  type ErrorObject,
  type ChannelEvent,
  type GlobalEvent,
  type Logger,
  type MachineInfo,
  type NodeHelloMsg,
  type NodeWelcomeMsg,
  type RequestMsg,
  type ResponseMsg,
  type SessionInfo,
  type WorkspaceInfo,
} from '@bizzi/protocol';
import { WebSocket, type RawData } from 'ws';
import { CLOSE_UNAUTHORIZED, rawToString } from './client-conn.ts';
import type { LinkHandle, Relay } from './relay.ts';
import type { DeviceRow } from './store.ts';

export interface NodeLinkOptions {
  logger: Logger;
  helloTimeoutMs: number;
  requestTimeoutMs: number;
  remote?: string;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class NodeLink implements LinkHandle {
  readonly #ws: WebSocket;
  readonly #relay: Relay;
  readonly #o: NodeLinkOptions;
  #log: Logger;
  #device?: DeviceRow;
  #machine?: MachineInfo;
  #attached = false;
  #closed = false;
  #alive = true;
  #n = 0;
  readonly #pending = new Map<string, Pending>();
  readonly #watched = new Set<string>();
  #helloTimer?: NodeJS.Timeout;

  constructor(ws: WebSocket, relay: Relay, o: NodeLinkOptions) {
    this.#ws = ws;
    this.#relay = relay;
    this.#o = o;
    this.#log = o.logger.child({ remote: o.remote, link: 'node' });
    this.#helloTimer = setTimeout(() => this.#reject('node.hello timeout'), o.helloTimeoutMs);
    ws.on('message', (data: RawData, isBinary: boolean) => this.#onMessage(data, isBinary));
    ws.on('pong', () => {
      this.#alive = true;
    });
    ws.on('error', (err) => this.#log.log('debug', 'websocket error', { err }));
  }

  get machineId(): string {
    return this.#machine?.id ?? '';
  }

  get deviceId(): string {
    return this.#device?.id ?? '';
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

  /** Called on socket close (and by close()). Idempotent. */
  dispose(): void {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#helloTimer);
    const err = new BizziError('machine_offline', `machine ${this.machineId} disconnected`);
    for (const p of this.#pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.#pending.clear();
    if (this.#attached) this.#relay.detachLink(this);
  }

  request(method: string, params: unknown, opts: { timeoutMs?: number } = {}): Promise<unknown> {
    if (this.#closed || this.#ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new BizziError('machine_offline', `machine ${this.machineId} is offline`));
    }
    const id = `${HUB_REQUEST_PREFIX}${++this.#n}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new BizziError('machine_offline', `machine ${this.machineId} did not answer ${method} in time`));
      }, opts.timeoutMs ?? this.#o.requestTimeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  watch(ch: string): void {
    if (this.#closed || this.#watched.has(ch)) return;
    this.#watched.add(ch);
    this.request('subscribe', { ch, since: this.#relay.bus.lastSeq(ch) }).catch((err: unknown) => {
      this.#watched.delete(ch);
      const code = err instanceof BizziError ? err.code : undefined;
      if (code !== 'not_found' && code !== 'machine_offline') this.#log.log('warn', 'subscribe over link failed', { ch, err });
    });
  }

  forget(ch: string): void {
    if (!this.#watched.delete(ch) || this.#closed) return;
    this.request('unsubscribe', { ch }).catch(() => {});
  }

  #reject(reason: string): void {
    if (this.#closed) return;
    this.#log.log('info', 'rejecting node', { reason });
    this.close(CLOSE_UNAUTHORIZED, reason.slice(0, 120));
  }

  #onMessage(data: RawData, isBinary: boolean): void {
    if (this.#closed || isBinary) return;
    let msg: unknown;
    try {
      msg = JSON.parse(rawToString(data));
    } catch {
      this.#log.log('warn', 'invalid JSON from node');
      return;
    }
    if (!this.#attached) return this.#hello(msg as Partial<NodeHelloMsg>);
    if (isEvent(msg)) return this.#onEvent(msg);
    if (isResponse(msg)) return this.#onResponse(msg);
    if (isRequest(msg)) return void this.#onNodeRequest(msg);
    this.#log.log('debug', 'ignoring unexpected frame from node');
  }

  #hello(msg: Partial<NodeHelloMsg>): void {
    if (msg?.type !== 'node.hello') return this.#reject('expected node.hello');
    if (msg.protocol !== PROTOCOL_VERSION) return this.#reject(`unsupported protocol (hub speaks ${PROTOCOL_VERSION})`);
    let device: DeviceRow;
    try {
      device = this.#relay.auth.authenticate(msg.token);
    } catch (err) {
      return this.#reject(err instanceof Error ? err.message : 'invalid token');
    }
    if (device.kind !== 'node') return this.#reject('token is not for a node');
    const machine = msg.machine;
    if (!machine || typeof machine !== 'object' || typeof machine.id !== 'string' || typeof machine.name !== 'string') {
      return this.#reject('machine info is required');
    }
    if (device.machineId && device.machineId !== machine.id) return this.#reject('machine id does not match the paired node');
    clearTimeout(this.#helloTimer);
    this.#device = device;
    this.#machine = machine;
    this.#log = this.#log.child({ machineId: machine.id });
    const welcome: NodeWelcomeMsg = { type: 'node.welcome', hubVersion: this.#relay.version, features: [HUB_FEATURE_NODE_REQUESTS] };
    this.#ws.send(JSON.stringify(welcome));
    this.#attached = true;
    this.#relay.attachLink(this, machine);
    void this.#sync();
  }

  /** Initial sync: global since our cursor, then every session channel since its stored seq. */
  async #sync(): Promise<void> {
    try {
      await this.request('subscribe', { ch: GLOBAL_CHANNEL, since: this.#relay.store.nodeCursor(this.machineId) });
      const [{ workspaces }, { sessions }] = (await Promise.all([
        this.request('workspaces.list', {}),
        this.request('sessions.list', {}),
      ])) as [{ workspaces: WorkspaceInfo[] }, { sessions: SessionInfo[] }];
      if (this.#closed) return;
      this.#relay.reconcile(this, workspaces, sessions);
      this.#log.log('info', 'node synced', { workspaces: workspaces.length, sessions: sessions.length });
    } catch (err) {
      if (this.#closed) return;
      this.#log.log('warn', 'node sync failed; dropping link', { err });
      this.close(1011, 'sync failed');
    }
  }

  #onEvent(ev: ChannelEvent): void {
    try {
      if (ev.ch === GLOBAL_CHANNEL) this.#relay.ingestNodeGlobal(this, ev as GlobalEvent);
      else if (ev.ch.startsWith('session:')) this.#relay.ingestSessionEvent(this, ev);
    } catch (err) {
      // Storage failure: drop the link so the node replays from our last stored cursor on reconnect.
      this.#log.log('error', 'failed to ingest event; dropping link', { ch: ev.ch, seq: ev.seq, err });
      this.close(1011, 'ingest failed');
    }
  }

  /** A request from the node (spec §5.4): authenticated as this link's machine; answered on the same socket. */
  async #onNodeRequest(msg: RequestMsg): Promise<void> {
    let reply: { id: string; result: unknown } | { id: string; error: ErrorObject };
    try {
      reply = { id: msg.id, result: (await this.#relay.handleNode(this, msg.method, msg.params)) ?? {} };
    } catch (err) {
      if (!(err instanceof BizziError)) this.#log.log('error', 'unhandled error serving node request', { method: msg.method, err });
      reply = {
        id: msg.id,
        error: err instanceof BizziError ? err.toObject() : { code: 'internal', message: err instanceof Error ? err.message : String(err) },
      };
    }
    if (this.#closed || this.#ws.readyState !== WebSocket.OPEN) return;
    this.#ws.send(JSON.stringify(reply));
  }

  #onResponse(msg: ResponseMsg): void {
    const p = this.#pending.get(msg.id);
    if (!p) return;
    this.#pending.delete(msg.id);
    clearTimeout(p.timer);
    if ('error' in msg) p.reject(new BizziError(msg.error.code, msg.error.message, msg.error.data));
    else p.resolve(msg.result);
  }
}
