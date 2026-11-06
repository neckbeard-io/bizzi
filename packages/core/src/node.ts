// The node role: wires store, bus, workspaces, sessions and tools behind a method dispatcher.

import {
  BizziError,
  GLOBAL_CHANNEL,
  PROTOCOL_VERSION,
  newId,
  parseChannel,
  type AgentAdapter,
  type ChannelEvent,
  type Logger,
  type MachineInfo,
  type MethodName,
  type MethodParams,
  type MethodResult,
} from '@bizzi/protocol';
import { AdapterRegistry } from './agents.ts';
import { EventBus, type EventListener } from './bus.ts';
import { nullLogger } from './logger.ts';
import { buildMachineInfo } from './machine.ts';
import { asParams, oneOf, optBool, optInt, optString, reqBase64, reqInt, reqString, type Params } from './params.ts';
import { Sessions, type PrepareStart } from './sessions.ts';
import { Store } from './store.ts';
import { DEFAULT_MAX_BYTES, fsList, fsRead, gitDiff, gitStatus } from './tools.ts';
import { Workspaces } from './workspaces.ts';

export interface NodeOptions {
  /** Directory for node.db (created if missing). */
  dataDir: string;
  /** Display name for this machine (default: hostname). */
  machineName?: string;
  adapters: AgentAdapter[];
  logger?: Logger;
  /** bizzi version reported in MachineInfo and hello. */
  version: string;
  /** Hook to add env / MCP servers / system prompt text when an adapter session starts. */
  prepareStart?: PrepareStart;
  /** Grace period for adapters to confirm an interrupt (default 15 s). */
  interruptGraceMs?: number;
}

/** Methods served by the dispatcher (subscriptions are per-connection and handled separately). */
export type DispatchMethod = Exclude<MethodName, 'subscribe' | 'unsubscribe'>;

export interface Subscription {
  lastSeq: number;
  unsubscribe(): void;
}

export interface BizziNode {
  readonly machine: MachineInfo;
  readonly version: string;
  readonly logger: Logger;
  readonly bus: EventBus;
  readonly sessions: Sessions;
  readonly workspaces: Workspaces;
  readonly registry: AdapterRegistry;
  /** Typed in-process call. Throws BizziError. */
  call<M extends DispatchMethod>(method: M, params: MethodParams<M>): Promise<MethodResult<M>>;
  /** Untyped entry point used by transports: validates `method` and `params`. */
  dispatch(method: string, params: unknown): Promise<unknown>;
  /** In-process subscription: synchronous replay of seq > since, then live events. */
  subscribe(ch: string, since: number, listener: EventListener): Subscription;
  /** Throws not_found / bad_request when `ch` is not a channel of this node. */
  assertChannel(ch: string): void;
  /** Stop accepting new turns; wait up to timeoutMs for in-flight turns. Resolves true if all finished. */
  drain(timeoutMs: number): Promise<boolean>;
  readonly draining: boolean;
  /** Stop adapters and close the database. Idempotent. */
  close(): Promise<void>;
}

type Handler = (p: Params) => Promise<unknown> | unknown;

export async function createNode(opts: NodeOptions): Promise<BizziNode> {
  const logger = opts.logger ?? nullLogger;
  const store = new Store(opts.dataDir);
  try {
    const bus = new EventBus(store, logger.child({ component: 'bus' }));

    let machineId = store.getMeta('machineId');
    if (!machineId) {
      machineId = newId('m');
      store.setMeta('machineId', machineId);
    }
    const machine = buildMachineInfo({ id: machineId, name: opts.machineName, version: opts.version });
    const machineJson = JSON.stringify(machine);
    if (store.getMeta('machineInfo') !== machineJson) {
      store.setMeta('machineInfo', machineJson);
      bus.append(GLOBAL_CHANNEL, { type: 'machine.updated', data: { machine } });
    }

    const registry = new AdapterRegistry(opts.adapters, logger.child({ component: 'agents' }));
    const workspaces = new Workspaces(store, bus, machineId);
    const sessions = new Sessions({
      store,
      bus,
      workspaces,
      registry,
      machineId,
      logger,
      prepareStart: opts.prepareStart,
      interruptGraceMs: opts.interruptGraceMs,
    });
    sessions.load();
    return new Node(opts.version, machine, logger, store, bus, registry, workspaces, sessions);
  } catch (err) {
    store.close();
    throw err;
  }
}

class Node implements BizziNode {
  readonly version: string;
  readonly machine: MachineInfo;
  readonly logger: Logger;
  readonly bus: EventBus;
  readonly registry: AdapterRegistry;
  readonly workspaces: Workspaces;
  readonly sessions: Sessions;
  readonly #store: Store;
  readonly #handlers: Record<DispatchMethod, Handler>;
  #closing?: Promise<void>;

  constructor(
    version: string,
    machine: MachineInfo,
    logger: Logger,
    store: Store,
    bus: EventBus,
    registry: AdapterRegistry,
    workspaces: Workspaces,
    sessions: Sessions,
  ) {
    this.version = version;
    this.machine = machine;
    this.logger = logger;
    this.#store = store;
    this.bus = bus;
    this.registry = registry;
    this.workspaces = workspaces;
    this.sessions = sessions;
    this.#handlers = this.#buildHandlers();
  }

  get draining(): boolean {
    return this.sessions.draining;
  }

  call<M extends DispatchMethod>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> {
    return this.dispatch(method, params) as Promise<MethodResult<M>>;
  }

  async dispatch(method: string, params: unknown): Promise<unknown> {
    if (this.#closing) throw new BizziError('machine_offline', 'node is shut down');
    if (method === 'subscribe' || method === 'unsubscribe') {
      throw new BizziError('bad_request', `${method} is handled by the transport; use node.subscribe in-process`);
    }
    const handler = Object.hasOwn(this.#handlers, method) ? this.#handlers[method as DispatchMethod] : undefined;
    if (!handler) throw new BizziError('unsupported', `unknown method ${method}`);
    return handler(asParams(params));
  }

  assertChannel(ch: string): void {
    const parsed = typeof ch === 'string' ? parseChannel(ch) : null;
    if (!parsed) throw new BizziError('bad_request', `invalid channel ${String(ch)}`);
    if (parsed.kind === 'session' && !this.sessions.has(parsed.sessionId)) {
      throw new BizziError('not_found', `session ${parsed.sessionId} not found`);
    }
  }

  subscribe(ch: string, since: number, listener: (ev: ChannelEvent) => void): Subscription {
    this.assertChannel(ch);
    return this.bus.subscribe(ch, since, listener);
  }

  async drain(timeoutMs: number): Promise<boolean> {
    this.sessions.beginDrain();
    return this.sessions.waitForTurns(timeoutMs);
  }

  close(): Promise<void> {
    this.#closing ??= (async () => {
      try {
        await this.sessions.close();
      } finally {
        this.#store.close();
      }
    })();
    return this.#closing;
  }

  #buildHandlers(): Record<DispatchMethod, Handler> {
    const s = this.sessions;
    const ws = this.workspaces;
    return {
      hello: () => ({ protocol: PROTOCOL_VERSION, serverVersion: this.version, machine: this.machine }),
      'machines.list': () => ({ machines: [this.machine] }),
      'agents.list': async (p) => ({ agents: await this.registry.list(optBool(p, 'refresh') ?? false) }),

      'workspaces.list': () => ({ workspaces: ws.list() }),
      'workspace.create': async (p) => {
        const opts: { path: string; name?: string; create?: boolean } = { path: reqString(p, 'path') };
        const name = optString(p, 'name');
        const create = optBool(p, 'create');
        if (name !== undefined) opts.name = name;
        if (create !== undefined) opts.create = create;
        return { workspace: await ws.create(opts) };
      },
      'workspace.remove': async (p) => {
        const id = reqString(p, 'workspaceId');
        ws.get(id);
        const busy = s.busyInWorkspace(id);
        if (busy.length > 0) {
          throw new BizziError('conflict', `workspace has ${busy.length} busy session(s); stop them first`);
        }
        for (const session of s.list(id)) {
          if (session.status !== 'ended' && session.status !== 'failed') await s.stop(session.id);
        }
        ws.remove(id);
        return {};
      },

      'sessions.list': (p) => ({ sessions: s.list(optString(p, 'workspaceId')) }),
      'session.get': (p) => s.get(reqString(p, 'sessionId')),
      'session.create': async (p) => {
        const params: MethodParams<'session.create'> = {
          workspaceId: reqString(p, 'workspaceId'),
          agent: reqString(p, 'agent') as MethodParams<'session.create'>['agent'],
        };
        const mode = oneOf(p, 'mode', ['structured', 'terminal'] as const);
        if (mode) params.mode = mode;
        for (const k of ['model', 'permissionMode', 'effort', 'title', 'resumeRef'] as const) {
          const v = optString(p, k);
          if (v) params[k] = v;
        }
        const cols = optInt(p, 'cols', 1, 10_000);
        const rows = optInt(p, 'rows', 1, 10_000);
        if (cols) params.cols = cols;
        if (rows) params.rows = rows;
        return { session: await s.create(params) };
      },
      'session.send': (p) => s.send(reqString(p, 'sessionId'), p.input as never),
      'session.steer': async (p) => {
        await s.steer(reqString(p, 'sessionId'), p.input as never);
        return {};
      },
      'session.interrupt': async (p) => {
        await s.interrupt(reqString(p, 'sessionId'));
        return {};
      },
      'session.stop': async (p) => {
        await s.stop(reqString(p, 'sessionId'));
        return {};
      },
      'session.set': async (p) => {
        const params: MethodParams<'session.set'> = { sessionId: reqString(p, 'sessionId') };
        for (const k of ['model', 'permissionMode', 'effort'] as const) {
          const v = optString(p, k);
          if (v !== undefined) params[k] = v;
        }
        return { session: await s.set(params) };
      },
      'approval.respond': async (p) => {
        const decision = oneOf(p, 'decision', ['allow', 'allow_always', 'deny'] as const);
        if (!decision) throw new BizziError('bad_request', 'decision is required');
        const params: MethodParams<'approval.respond'> = {
          sessionId: reqString(p, 'sessionId'),
          approvalId: reqString(p, 'approvalId'),
          decision,
        };
        const message = optString(p, 'message');
        if (message !== undefined) params.message = message;
        if (p.editedInput !== undefined) params.editedInput = p.editedInput;
        await s.respondApproval(params);
        return {};
      },

      'term.input': (p) => {
        s.termInput(reqString(p, 'sessionId'), reqBase64(p, 'dataBase64'));
        return {};
      },
      'term.resize': (p) => {
        s.termResize(reqString(p, 'sessionId'), reqInt(p, 'cols', 1, 10_000), reqInt(p, 'rows', 1, 10_000));
        return {};
      },

      'fs.list': (p) => fsList(ws.get(reqString(p, 'workspaceId')), optString(p, 'path')),
      'fs.read': (p) =>
        fsRead(ws.get(reqString(p, 'workspaceId')), reqString(p, 'path'), optInt(p, 'maxBytes', 0) ?? DEFAULT_MAX_BYTES),
      'git.status': (p) => gitStatus(ws.get(reqString(p, 'workspaceId'))),
      'git.diff': (p) => {
        const opts: { path?: string; staged?: boolean } = {};
        const path = optString(p, 'path');
        const staged = optBool(p, 'staged');
        if (path !== undefined) opts.path = path;
        if (staged !== undefined) opts.staged = staged;
        return gitDiff(ws.get(reqString(p, 'workspaceId')), opts);
      },
    };
  }
}
