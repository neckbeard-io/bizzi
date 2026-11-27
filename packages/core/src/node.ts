// The node role: wires store, bus, workspaces, sessions and tools behind a method dispatcher.

import {
  AGENT_KINDS,
  BizziError,
  GLOBAL_CHANNEL,
  PROTOCOL_VERSION,
  newId,
  parseChannel,
  type AgentAdapter,
  type AgentKind,
  type ChannelEvent,
  type GlobalEventBody,
  type LabelColor,
  type Logger,
  type MachineInfo,
  type MethodName,
  type MethodParams,
  type MethodResult,
  type HelperParent,
  type HelperStartRequest,
  type InputBlock,
  type NodeCaller,
  type SessionEventBody,
} from '@bizzi/protocol';
import { AdapterRegistry } from './agents.ts';
import { BaselineTracker, baselinesExtension } from './baselines.ts';
import { FsBrowser, MAX_COMPLETE_LIMIT, type BrowserOptions } from './browse.ts';
import { EventBus, type EventListener } from './bus.ts';
import { nullLogger } from './logger.ts';
import {
  applyMachineUserFields,
  buildMachineInfo,
  parseLabelColor,
  parseLabelIcon,
  parseMachineDescription,
  parseMachineTags,
  parseWorkspaceName,
  readMachineUserFields,
  type MachineUserFields,
} from './machine.ts';
import { parseBudget } from './budget.ts';
import { Forks } from './fork.ts';
import { HubPort } from './hub-port.ts';
import { DEFAULT_WAIT_MS, MAX_READ_TOKENS, MAX_WAIT_MS, OrchestrationSettingsStore, Orchestrator, WAIT_UNTIL } from './orchestration.ts';
import { Pipelines, pipelinesExtension } from './pipelines.ts';
import { KeepAwake, parseKeepAwakeSettings, readKeepAwakeSettings, type PowerBackend } from './power.ts';
import { Restarts } from './restart.ts';
import { asParams, oneOf, optBool, optInt, optString, reqBase64, reqInt, reqString, type Params } from './params.ts';
import { Sessions, composePrepareStart, validateCommand, type AgentEnvProvider, type PrepareStart } from './sessions.ts';
import { History } from './history.ts';
import { Store } from './store.ts';
import { themesExtension } from './themes.ts';
import { DEFAULT_MAX_BYTES, fsList, fsRead, gitDiff, gitStatus } from './tools.ts';
import { UsageTracker, usageExtension } from './usage.ts';
import { Workspaces } from './workspaces.ts';

/** Methods served by the dispatcher (subscriptions are per-connection and handled separately). */
export type DispatchMethod = Exclude<MethodName, 'subscribe' | 'unsubscribe'>;

/**
 * A bundle of method handlers plus lifecycle hooks plugged into the node (provisioning, knowledge,
 * secrets, login…). Extensions may only claim methods the core does not implement itself.
 */
export interface NodeExtension {
  /** Handlers for methods this extension owns (e.g. agent.*, knowledge.*). */
  methods: Partial<Record<DispatchMethod, (params: any, ctx: ExtensionContext) => unknown | Promise<unknown>>>;
  start?(ctx: ExtensionContext): void | Promise<void>;
  stop?(): void | Promise<void>;
  /** Runs after NodeOptions.prepareStart (and earlier extensions) when an adapter session starts; results are merged. */
  prepareStart?: PrepareStart;
  /** Add what this extension provides to the machine's MachineInfo (e.g. `routing`), before it's published. */
  describeMachine?(machine: MachineInfo): void;
}

export interface ExtensionContext {
  node: BizziNode;
  logger: Logger;
  emitGlobal(body: GlobalEventBody): void;
  /** Append an event to a session channel (e.g. login.prompt). */
  emitSession(sessionId: string, body: SessionEventBody): void;
  /** Extra env merged into StartSessionOptions.env for sessions of an agent (secrets). */
  setAgentEnvProvider(fn: (agent: AgentKind) => Record<string, string> | Promise<Record<string, string>>): void;
}

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
  /** Service extensions (provisioning, knowledge, secrets…); started in order, stopped in reverse. */
  extensions?: NodeExtension[];
  /** Workspace picker (fs.browse / fs.complete / fs.suggest) overrides; tests set `home` and `caseInsensitive`. */
  browse?: Pick<BrowserOptions, 'home' | 'caseInsensitive' | 'maxEntries'>;
  /**
   * After start, continue structured sessions whose turn the last shutdown or crash cut off
   * (`Sessions.resumeInterrupted`). Default true; `false` leaves them for the next message.
   */
  resumeInterrupted?: boolean;
  /** Delay before that resume, so the caller can finish wiring (default 1 s). */
  resumeDelayMs?: number;
  /**
   * Title model for untitled sessions: given the first message, returns a short title to replace the
   * one taken from the message (titles.ts). `agentEnv` gives an agent's stored secrets (API keys).
   */
  suggestTitle?: (text: string, ctx: { agentEnv: AgentEnvProvider }) => Promise<string | undefined>;
  /**
   * Holds the machine awake while agents work (spec §8.1; `platformPowerBackend()` from power.ts). Absent:
   * the keep-awake setting is stored but shows as unavailable. `bizzi serve` passes the OS's backend.
   */
  power?: PowerBackend;
  /** Keep-awake linger after the last work ends (default 90 s; tests shorten it). */
  keepAwakeLingerMs?: number;
}

/** Protocol methods the core doesn't implement; they answer `unsupported` unless an extension claims them. */
const UNIMPLEMENTED = [
  'agent.plan',
  'agent.install',
  'agent.login',
  'agent.setSecret',
  'agent.deleteSecret',
  'agent.secrets',
  'knowledge.list',
  'knowledge.add',
  'knowledge.update',
  'knowledge.forget',
  'knowledge.inbox',
  'knowledge.accept',
  'knowledge.reject',
  'knowledge.settings.get',
  'knowledge.settings.set',
  'knowledge.sync.pull',
  'knowledge.sync.push',
  // ---- knowledge: Add to AGENTS.md (knowledge.md §8)
  'knowledge.promote.preview',
  'knowledge.promote',
  'route.suggest',
  'route.score',
  'pairing.create',
  'devices.list',
  'device.revoke',
  // Protocol 1.2 additions; implemented by later phases or by extensions.
  'agent.migrate',
  'agent.policy.set',
  'usage.list',
  'widgets.list',
  'widget.refresh',
  'baselines.list',
  'themes.list',
  'theme.save',
  'theme.delete',
  'prefs.get',
  'prefs.set',
  // ---- pipelines (docs/pipelines.md): served by the built-in pipelinesExtension
  'pipelines.list',
  'pipeline.start',
  'pipeline.get',
  'pipeline.gate',
  'pipeline.cancel',
  'pipeline.delete',
  // ---- Web Push (tech-choices.md D9): hub only.
  'push.config',
  'push.register',
  'push.unregister',
  'push.test',
  // ---- one-pane mode (spec §11.2): served by @bizzi/routing's extension
  'route.record',
  'route.decisions',
  'route.rules.get',
  'route.rules.set',
  // ---- container workspaces (topology.md §7): @bizzi/containers
  'container.create',
  'container.status',
  'container.stop',
] as const satisfies readonly DispatchMethod[];

/** Methods taking an optional `machineId` (MachineTarget): ours is accepted, any other is not_found. */
const MACHINE_TARGET_METHODS: ReadonlySet<string> = new Set([
  'agents.list',
  'agents.models',
  'workspaces.list',
  'workspace.create',
  'sessions.list',
  'agent.plan',
  'agent.install',
  'agent.login',
  'agent.setSecret',
  'agent.deleteSecret',
  'agent.secrets',
  'knowledge.list',
  'knowledge.add',
  'knowledge.update',
  'knowledge.forget',
  'knowledge.inbox',
  'knowledge.accept',
  'knowledge.reject',
  'knowledge.settings.get',
  'knowledge.settings.set',
  'knowledge.sync.pull',
  'knowledge.sync.push',
  // ---- knowledge: Add to AGENTS.md (knowledge.md §8)
  'knowledge.promote.preview',
  'knowledge.promote',
  'route.score',
  'orchestration.settings.get',
  'orchestration.settings.set',
  'baselines.list',
  'fs.browse',
  'fs.complete',
  'fs.suggest',
  'machine.set',
  // ---- pipelines (docs/pipelines.md)
  'pipelines.list',
  'pipeline.get',
  'pipeline.gate',
  'pipeline.cancel',
  'pipeline.delete',
  // ---- container workspaces (topology.md §7)
  'container.create',
  // ---- cross-machine work (spec §12.4, topology.md §6): `machineId` is the target, i.e. this node
  'helper.start',
  'helper.send',
  'helper.interrupt',
  'helper.stop',
  'helper.wait',
  'helper.read',
  'fork.prepare',
  'fork.receive',
] satisfies DispatchMethod[]);

const DISPOSE_TIMEOUT_MS = 10_000;

/** Meta key for the machine's user-owned fields (tags, description), which survive restarts. */
const MACHINE_USER_META = 'machineUser';
/** Meta key for the keep-awake setting (spec §8.1). */
const KEEP_AWAKE_META = 'keepAwake';

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
  /** Per-login usage snapshots (usage.md §3); extensions report widget-backed logins here. */
  readonly usage: UsageTracker;
  /** Learned starting context per agent, model and workspace (usage.md §2). */
  readonly baselines: BaselineTracker;
  /** Agent-to-agent helpers and their guardrails (spec §12). */
  readonly orchestration: Orchestrator;
  /** Stale agent processes and restart policies (updates.md). */
  readonly restarts: Restarts;
  /** Node → hub requests (spec §5.4); the hub link attaches its transport here. */
  readonly hub: HubPort;
  /** Forks onto other machines (topology.md §6). */
  readonly forks: Forks;
  /** Keeping the machine awake while agents work (spec §8.1). */
  readonly keepAwake: KeepAwake;
  /** Read-only views over every session on this node for agents (sessions_overview, session_peek). */
  readonly history: History;
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
  /** Stop extensions and adapters, dispose adapters and close the database. Idempotent. */
  close(): Promise<void>;
}

type Handler = (p: Params) => Promise<unknown> | unknown;

export async function createNode(opts: NodeOptions): Promise<BizziNode> {
  const logger = opts.logger ?? nullLogger;
  const store = new Store(opts.dataDir);
  let node: Node | undefined;
  try {
    const bus = new EventBus(store, logger.child({ component: 'bus' }));

    let machineId = store.getMeta('machineId');
    if (!machineId) {
      machineId = newId('m');
      store.setMeta('machineId', machineId);
    }
    const machine = buildMachineInfo({ id: machineId, name: opts.machineName, version: opts.version });
    applyMachineUserFields(machine, readMachineUserFields(store.getMeta(MACHINE_USER_META)));
    for (const ext of opts.extensions ?? []) ext.describeMachine?.(machine);
    const publishMachine = (): void => {
      const machineJson = JSON.stringify(machine);
      if (store.getMeta('machineInfo') !== machineJson) {
        store.setMeta('machineInfo', machineJson);
        bus.append(GLOBAL_CHANNEL, { type: 'machine.updated', data: { machine: { ...machine } } });
      }
    };
    const keepAwake = new KeepAwake({
      ...(opts.power ? { backend: opts.power } : {}),
      settings: readKeepAwakeSettings(store.getMeta(KEEP_AWAKE_META)),
      logger: logger.child({ component: 'power' }),
      ...(opts.keepAwakeLingerMs !== undefined ? { lingerMs: opts.keepAwakeLingerMs } : {}),
      onChange: (state) => {
        machine.keepAwake = state;
        if (store.isOpen) publishMachine();
      },
    });
    machine.keepAwake = keepAwake.state();
    publishMachine();

    const envProviders = new Map<NodeExtension, AgentEnvProvider>();
    const agentEnv: AgentEnvProvider = async (agent) => {
      const env: Record<string, string> = {};
      for (const fn of envProviders.values()) Object.assign(env, await fn(agent));
      return env;
    };

    const registry = new AdapterRegistry(opts.adapters, logger.child({ component: 'agents' }));
    registry.agentEnv = agentEnv;
    const workspaces = new Workspaces(store, bus, machineId);
    const settings = new OrchestrationSettingsStore(store, workspaces);
    // NodeOptions.prepareStart first, then each extension's, merged.
    const startHooks: PrepareStart[] = opts.prepareStart ? [opts.prepareStart] : [];
    const sessions = new Sessions({
      store,
      bus,
      workspaces,
      registry,
      machineId,
      logger,
      prepareStart: composePrepareStart(() => startHooks),
      interruptGraceMs: opts.interruptGraceMs,
      agentEnv,
      treeBudgetUsd: (workspaceId) => settings.effective(workspaceId).treeBudgetUsd,
      probeBilling: async (agent) => (await registry.list()).find((a) => a.agent === agent)?.billing,
      ...(opts.suggestTitle ? { suggestTitle: (text: string) => opts.suggestTitle!(text, { agentEnv }) } : {}),
    });
    sessions.load();
    // Count the work that may hold the machine awake on every session change (coalesced per tick).
    let countQueued = false;
    const countWork = (): void => {
      countQueued = false;
      let turns = 0;
      let background = 0;
      for (const s of sessions.list()) {
        if (s.status === 'running') turns++;
        else if (s.background?.length) background++;
      }
      keepAwake.update({ turns, background });
    };
    bus.on(GLOBAL_CHANNEL, (ev) => {
      if (countQueued || (ev.type !== 'session.created' && ev.type !== 'session.updated' && ev.type !== 'session.removed')) return;
      countQueued = true;
      queueMicrotask(countWork);
    });
    countWork();
    const hub = new HubPort();
    const orchestration = new Orchestrator({ sessions, workspaces, registry, settings, bus, logger, store, machine, hub });
    const restarts = new Restarts({ sessions, registry, bus, logger });
    for (const ext of opts.extensions ?? []) if (ext.prepareStart) startHooks.push(ext.prepareStart);
    // Runs as the node's OS user, like a terminal session (spec §10); see browse.ts.
    const browser = new FsBrowser({ ...opts.browse, workspaces: () => workspaces.list() });
    node = new Node(opts.version, machine, logger, store, bus, registry, workspaces, sessions, orchestration, restarts, browser);
    node.hub = hub;
    node.keepAwake = keepAwake;
    node.forks = new Forks({ sessions, workspaces, registry, bus, hub, machine, dataDir: opts.dataDir, logger });
    const self = node;
    node.history = new History({ store, sessions, workspaces, orchestration, hub, machine: () => self.machine });
    const usage = new UsageTracker({ dbPath: store.path, bus, machineId, logger: logger.child({ component: 'usage' }) });
    node.usage = usage;
    const baselines = new BaselineTracker({
      dbPath: store.path,
      bus,
      machineId,
      logger: logger.child({ component: 'baselines' }),
      session: (id) => (sessions.has(id) ? sessions.get(id).session : undefined),
      workspace: (id) => {
        try {
          return workspaces.get(id);
        } catch {
          return undefined;
        }
      },
    });
    node.baselines = baselines;
    const n = node;
    // Built-ins served through the extension mechanism (usage.list, baselines.list, themes.*), started first.
    const pipelines = new Pipelines({ dbPath: store.path, bus, sessions, workspaces, registry, orchestration, machineId, logger });
    const builtins = [usageExtension(usage), baselinesExtension(baselines), themesExtension(store.path), pipelinesExtension(pipelines)];
    const contexts = [...builtins, ...(opts.extensions ?? [])].map((ext): [NodeExtension, ExtensionContext] => [
      ext,
      {
        node: n,
        logger: logger.child({ component: 'extension' }),
        emitGlobal: (body) => {
          bus.append(GLOBAL_CHANNEL, body);
        },
        emitSession: (sessionId, body) => sessions.emit(sessionId, body),
        setAgentEnvProvider: (fn) => {
          envProviders.set(ext, fn);
        },
      },
    ]);
    node.registerExtensions(contexts);
    await node.startExtensions(contexts);
    // After extensions and a beat for the caller's wiring (`bizzi serve` binds knowledge to the
    // machine and starts listening): a resumed agent needs their session-start hooks.
    if (opts.resumeInterrupted !== false) {
      const t = setTimeout(() => {
        void sessions.resumeInterrupted().catch((err: unknown) => logger.log('warn', 'resuming interrupted turns failed', { err }));
      }, opts.resumeDelayMs ?? 1000);
      t.unref();
    }
    return node;
  } catch (err) {
    if (node) await node.close().catch(() => {});
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
  /** Assigned by createNode right after construction. */
  usage!: UsageTracker;
  baselines!: BaselineTracker;
  readonly orchestration: Orchestrator;
  readonly restarts: Restarts;
  hub!: HubPort;
  forks!: Forks;
  keepAwake!: KeepAwake;
  history!: History;
  readonly #browser: FsBrowser;
  readonly #store: Store;
  readonly #handlers: Record<DispatchMethod, Handler>;
  readonly #builtins: ReadonlySet<string>;
  readonly #started: NodeExtension[] = [];
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
    orchestration: Orchestrator,
    restarts: Restarts,
    browser: FsBrowser,
  ) {
    this.#browser = browser;
    this.version = version;
    this.machine = machine;
    this.logger = logger;
    this.#store = store;
    this.bus = bus;
    this.registry = registry;
    this.workspaces = workspaces;
    this.sessions = sessions;
    this.orchestration = orchestration;
    this.restarts = restarts;
    const implemented = this.#implemented();
    this.#builtins = new Set(Object.keys(implemented));
    this.#handlers = { ...this.#unimplemented(), ...implemented };
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
    const p = asParams(params);
    if (MACHINE_TARGET_METHODS.has(method)) this.#checkMachineTarget(p);
    return handler(p);
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
        for (const ext of this.#started.splice(0).reverse()) {
          try {
            await ext.stop?.();
          } catch (err) {
            this.logger.log('warn', 'extension stop failed', { err });
          }
        }
        this.keepAwake?.close();
        this.orchestration.close();
        this.restarts.close();
        await this.sessions.close();
        await Promise.all(
          this.registry.adapters.map(async (a) => {
            if (!a.dispose) return;
            try {
              await withTimeout(a.dispose(), DISPOSE_TIMEOUT_MS);
            } catch (err) {
              this.logger.log('warn', 'adapter dispose failed', { agent: a.agent, err });
            }
          }),
        );
      } finally {
        this.#store.close();
      }
    })();
    return this.#closing;
  }

  /** Install extension handlers. Throws if one claims a built-in, unknown or already-claimed method. */
  registerExtensions(contexts: readonly [NodeExtension, ExtensionContext][]): void {
    const claimed = new Set<string>();
    const add: Partial<Record<DispatchMethod, Handler>> = {};
    for (const [ext, ctx] of contexts) {
      for (const [method, fn] of Object.entries(ext.methods ?? {})) {
        if (fn === undefined) continue;
        if (typeof fn !== 'function') throw new BizziError('bad_request', `extension handler for ${method} is not a function`);
        if (!Object.hasOwn(this.#handlers, method)) {
          throw new BizziError('bad_request', `extension claims ${method}, which is not a protocol method`);
        }
        if (this.#builtins.has(method)) throw new BizziError('conflict', `extension cannot override built-in method ${method}`);
        if (claimed.has(method)) throw new BizziError('conflict', `method ${method} is claimed by more than one extension`);
        claimed.add(method);
        add[method as DispatchMethod] = (p) => fn(p, ctx);
      }
    }
    Object.assign(this.#handlers, add);
  }

  /** Start extensions in order; on failure the caller closes the node (stopping those already started). */
  async startExtensions(contexts: readonly [NodeExtension, ExtensionContext][]): Promise<void> {
    for (const [ext, ctx] of contexts) {
      await ext.start?.(ctx);
      this.#started.push(ext);
    }
  }

  #checkMachineTarget(p: Params): void {
    const id = p.machineId;
    if (id === undefined || id === null) return;
    if (typeof id !== 'string') throw new BizziError('bad_request', 'machineId must be a string');
    if (id !== this.machine.id) throw new BizziError('not_found', `machine ${id} is not this node (${this.machine.id})`);
  }

  /** Protocol methods without a core implementation; they answer `unsupported`. */
  #unimplemented(): Record<DispatchMethod, Handler> {
    const notYet: Handler = () => {
      throw new BizziError('unsupported', 'not implemented on this node');
    };
    return Object.fromEntries(UNIMPLEMENTED.map((m) => [m, notYet])) as Record<DispatchMethod, Handler>;
  }

  #implemented(): Omit<Record<DispatchMethod, Handler>, (typeof UNIMPLEMENTED)[number]> {
    const s = this.sessions;
    const ws = this.workspaces;
    return {
      hello: () => ({ protocol: PROTOCOL_VERSION, serverVersion: this.version, machine: this.machine, role: 'node' }),
      'machines.list': () => ({ machines: [this.machine] }),
      'machine.set': (p) => {
        const cur = readMachineUserFields(this.#store.getMeta(MACHINE_USER_META));
        const next: MachineUserFields = { tags: p.tags === undefined ? cur.tags : parseMachineTags(p.tags) };
        const description = p.description === undefined ? cur.description : parseMachineDescription(p.description);
        if (description) next.description = description;
        const color = p.color === undefined ? cur.color : parseLabelColor(p.color);
        if (color) next.color = color;
        const keepAwake = p.keepAwake === undefined ? undefined : parseKeepAwakeSettings(p.keepAwake, this.keepAwake.settings);
        this.#store.setMeta(MACHINE_USER_META, JSON.stringify(next));
        applyMachineUserFields(this.machine, next);
        if (keepAwake) {
          this.#store.setMeta(KEEP_AWAKE_META, JSON.stringify(keepAwake));
          // Publishes machine.updated (with the user fields above) when the state changes.
          this.keepAwake.setSettings(keepAwake);
        }
        const machineJson = JSON.stringify(this.machine);
        if (this.#store.getMeta('machineInfo') !== machineJson) {
          this.#store.setMeta('machineInfo', machineJson);
          this.bus.append(GLOBAL_CHANNEL, { type: 'machine.updated', data: { machine: { ...this.machine } } });
        }
        return { machine: { ...this.machine, tags: [...this.machine.tags], ...(this.machine.keepAwake ? { keepAwake: { ...this.machine.keepAwake } } : {}) } };
      },
      'agents.list': async (p) => ({ agents: await this.registry.list(optBool(p, 'refresh') ?? false) }),
      'agents.models': async (p) => {
        const agent = reqString(p, 'agent');
        if (!AGENT_KINDS.includes(agent as AgentKind)) throw new BizziError('bad_request', `unknown agent ${agent}`);
        return { models: await this.registry.models(agent as AgentKind, optBool(p, 'refresh') ?? false) };
      },

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
        // A repo workspace with worktree workspaces under it is refused rather than orphaning them.
        const worktrees = ws.worktreesOf(id);
        if (worktrees.length > 0) {
          throw new BizziError('conflict', `workspace has ${worktrees.length} worktree workspace(s); remove them first (worktree.remove)`, {
            worktrees: worktrees.map((w) => w.id),
          });
        }
        const busy = s.busyInWorkspace(id);
        if (busy.length > 0) {
          throw new BizziError('conflict', `workspace has ${busy.length} busy session(s); stop them first`);
        }
        for (const session of s.list(id)) {
          if (session.status !== 'ended' && session.status !== 'failed') await s.stop(session.id);
        }
        ws.remove(id);
        this.orchestration.settings.forget(id);
        return {};
      },
      'workspace.set': (p) => {
        const fields: { name?: string; color?: LabelColor | ''; icon?: string } = {};
        if (p.name !== undefined) fields.name = parseWorkspaceName(p.name);
        if (p.color !== undefined) fields.color = parseLabelColor(p.color) ?? '';
        if (p.icon !== undefined) fields.icon = parseLabelIcon(p.icon) ?? '';
        return { workspace: ws.update(reqString(p, 'workspaceId'), fields) };
      },
      'worktree.create': async (p) => {
        const opts: MethodParams<'worktree.create'> = { workspaceId: reqString(p, 'workspaceId'), branch: reqString(p, 'branch') };
        for (const k of ['base', 'path', 'name'] as const) {
          const v = optString(p, k);
          if (v) opts[k] = v;
        }
        return { workspace: await ws.createWorktree(opts) };
      },
      'worktree.remove': async (p) => {
        const id = reqString(p, 'workspaceId');
        const target = ws.get(id);
        if (target.kind !== 'worktree') throw new BizziError('bad_request', `workspace ${target.name} is not a worktree (use workspace.remove)`);
        const live = s.list(id).filter((x) => x.status !== 'ended' && x.status !== 'failed');
        if (live.length > 0) {
          throw new BizziError('conflict', `worktree is used by ${live.length} live session(s); stop them first`, { sessions: live.map((x) => x.id) });
        }
        await ws.removeWorktree(id, optBool(p, 'force') ?? false);
        this.orchestration.settings.forget(id);
        return {};
      },

      'sessions.list': (p) => {
        const spawnedBy = optString(p, 'spawnedBy');
        return { sessions: s.list(optString(p, 'workspaceId'), spawnedBy !== undefined ? { spawnedBy } : {}) };
      },
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
        if (p.command !== undefined && p.command !== null) {
          validateCommand(p.command);
          params.command = p.command;
        }
        const budget = parseBudget(p.budget);
        if (budget) params.budget = budget;
        const group = optString(p, 'group')?.trim();
        if (group) {
          if (group.length > 128) throw new BizziError('bad_request', 'group must be at most 128 characters');
          params.group = group;
        }
        return { session: await s.create(params) };
      },
      'session.fork': async (p) => ({ session: await s.fork(reqString(p, 'sessionId'), optString(p, 'title') || undefined) }),
      'session.delete': async (p) => {
        await s.delete(reqString(p, 'sessionId'));
        return {};
      },
      'session.send': (p) => s.send(reqString(p, 'sessionId'), p.input as never),
      'session.steer': async (p) => {
        await s.steer(reqString(p, 'sessionId'), p.input as never);
        return {};
      },
      'session.markSeen': (p) => ({ seenThrough: s.markSeen(reqString(p, 'sessionId'), reqInt(p, 'seq')) }),
      'session.interrupt': async (p) => {
        await s.interrupt(reqString(p, 'sessionId'));
        return {};
      },
      'session.stop': async (p) => {
        await s.stop(reqString(p, 'sessionId'));
        return {};
      },
      'session.reopen': (p) => ({ session: s.reopen(reqString(p, 'sessionId')) }),
      'session.set': async (p) => {
        const params: MethodParams<'session.set'> = { sessionId: reqString(p, 'sessionId') };
        for (const k of ['model', 'permissionMode', 'effort'] as const) {
          const v = optString(p, k);
          if (v !== undefined) params[k] = v;
        }
        // An empty object (or null) clears the budget.
        if (p.budget !== undefined) params.budget = parseBudget(p.budget) ?? {};
        const title = optString(p, 'title');
        if (title !== undefined) {
          if (title.length > 200) throw new BizziError('bad_request', 'title is too long (200 characters at most)');
          params.title = title;
        }
        return { session: await s.set(params) };
      },
      'session.clear': async (p) => {
        await s.clear(reqString(p, 'sessionId'));
        return {};
      },
      'session.restart': (p) => {
        this.restarts.request(reqString(p, 'sessionId'));
        return {};
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
      'question.respond': async (p) => {
        const params: MethodParams<'question.respond'> = {
          sessionId: reqString(p, 'sessionId'),
          questionId: reqString(p, 'questionId'),
        };
        const cancel = optBool(p, 'cancel');
        if (cancel !== undefined) params.cancel = cancel;
        if (p.answers !== undefined && p.answers !== null) params.answers = p.answers as never;
        await s.respondQuestion(params);
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
      'term.snapshot': (p) => s.terminalSnapshot(reqString(p, 'sessionId')),

      'orchestration.settings.get': (p) => ({ settings: this.orchestration.settings.get(optString(p, 'workspaceId')) }),
      'orchestration.settings.set': (p) => {
        if (!p.settings || typeof p.settings !== 'object' || Array.isArray(p.settings)) {
          throw new BizziError('bad_request', 'settings must be an object');
        }
        const settings = this.orchestration.settings.set(optString(p, 'workspaceId'), p.settings);
        // A raised tree cap releases sessions held for budget.
        s.recheckBudgets();
        return { settings };
      },

      // ---- cross-machine work (spec §12.4, topology.md §6)
      'session.forkTo': (p) => {
        const params: MethodParams<'session.forkTo'> = { sessionId: reqString(p, 'sessionId'), toMachineId: reqString(p, 'toMachineId') };
        for (const k of ['toWorkspaceId', 'toPath', 'title', 'prompt', 'branch'] as const) {
          const v = optString(p, k);
          if (v) params[k] = v;
        }
        const agent = optString(p, 'agent');
        if (agent) params.agent = agent as MethodParams<'session.forkTo'>['agent'];
        return this.forks.forkTo(params);
      },
      'helper.start': (p) => this.orchestration.startForRemote(p.caller as NodeCaller, p.parent as HelperParent, p.request as HelperStartRequest),
      'helper.send': (p) => this.orchestration.remoteSend(p.caller as NodeCaller, reqString(p, 'parentId'), reqString(p, 'sessionId'), p.input as InputBlock[]),
      'helper.interrupt': async (p) => {
        await this.orchestration.remoteInterrupt(p.caller as NodeCaller, reqString(p, 'parentId'), reqString(p, 'sessionId'));
        return {};
      },
      'helper.stop': async (p) => {
        await this.orchestration.remoteStop(p.caller as NodeCaller, reqString(p, 'parentId'), reqString(p, 'sessionId'));
        return {};
      },
      'helper.wait': (p) =>
        this.orchestration.remoteWait(
          p.caller as NodeCaller,
          reqString(p, 'parentId'),
          reqString(p, 'sessionId'),
          oneOf(p, 'until', WAIT_UNTIL) ?? 'done',
          optInt(p, 'timeoutMs', 0, MAX_WAIT_MS) ?? DEFAULT_WAIT_MS,
        ),
      'helper.read': (p) => {
        const opts: { since?: number; maxTokens?: number; detail?: 'summary' | 'full' | 'diff'; path?: string } = {};
        const since = optInt(p, 'since', 0);
        const maxTokens = optInt(p, 'maxTokens', 100, MAX_READ_TOKENS);
        const detail = oneOf(p, 'detail', ['summary', 'full', 'diff'] as const);
        const path = optString(p, 'path');
        if (since !== undefined) opts.since = since;
        if (maxTokens !== undefined) opts.maxTokens = maxTokens;
        if (detail) opts.detail = detail;
        if (path) opts.path = path;
        return this.orchestration.remoteRead(p.caller as NodeCaller, reqString(p, 'parentId'), reqString(p, 'sessionId'), opts);
      },
      'fork.prepare': (p) => this.forks.prepare(p.caller as NodeCaller, p as unknown as MethodParams<'fork.prepare'>),
      'fork.receive': (p) => this.forks.receive(p.caller as NodeCaller, p as unknown as MethodParams<'fork.receive'>),

      'fs.list': (p) => fsList(ws.get(reqString(p, 'workspaceId')), optString(p, 'path')),
      'fs.read': (p) =>
        fsRead(ws.get(reqString(p, 'workspaceId')), reqString(p, 'path'), optInt(p, 'maxBytes', 0) ?? DEFAULT_MAX_BYTES),
      'fs.browse': (p) => {
        const opts: { path?: string; showHidden?: boolean } = {};
        const path = optString(p, 'path');
        const showHidden = optBool(p, 'showHidden');
        if (path !== undefined) opts.path = path;
        if (showHidden !== undefined) opts.showHidden = showHidden;
        return this.#browser.browse(opts);
      },
      'fs.complete': (p) => {
        const prefix = optString(p, 'prefix');
        if (prefix === undefined) throw new BizziError('bad_request', 'prefix must be a string');
        const opts: { prefix: string; limit?: number; showHidden?: boolean } = { prefix };
        const limit = optInt(p, 'limit', 1, MAX_COMPLETE_LIMIT);
        const showHidden = optBool(p, 'showHidden');
        if (limit !== undefined) opts.limit = limit;
        if (showHidden !== undefined) opts.showHidden = showHidden;
        return this.#browser.complete(opts);
      },
      'fs.suggest': () => this.#browser.suggest(),
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

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
