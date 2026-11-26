// Adapter registry: adapter selection per (agent, mode) and the cached `agents.list` view.

import type {
  AgentAdapter,
  AgentCapabilities,
  AgentKind,
  AgentListing,
  AgentProbe,
  Logger,
  ModelOption,
  SessionMode,
} from '@bizzi/protocol';
import { BizziError, NO_CAPABILITIES } from '@bizzi/protocol';

export const PROBE_CACHE_MS = 60_000;
/** How long an agent's model list is reused (per installed version). */
export const MODELS_CACHE_MS = 30 * 60_000;

/**
 * Adds facts to a probe on every `agents.list` (e.g. @bizzi/services: install method, supported
 * versions, update/restart policies). Must be cheap and synchronous; a throwing decorator is skipped.
 */
export type ListingDecorator = (listing: AgentListing) => AgentListing;

export class AdapterRegistry {
  readonly adapters: readonly AgentAdapter[];
  readonly #logger: Logger;
  readonly #now: () => number;
  #cache?: { at: number; agents: AgentListing[] };
  #inflight?: Promise<AgentListing[]>;
  readonly #decorators = new Set<ListingDecorator>();
  readonly #probed = new Set<(agents: readonly AgentListing[]) => void>();
  readonly #models = new Map<AgentKind, { at: number; version: string | undefined; models: ModelOption[] }>();
  readonly #modelsInflight = new Map<AgentKind, Promise<ModelOption[]>>();
  /** The agent's secrets as sessions get them; `listModels` receives them (set by the node). */
  agentEnv?: (agent: AgentKind) => Record<string, string> | Promise<Record<string, string>>;

  constructor(adapters: readonly AgentAdapter[], logger: Logger, now: () => number = Date.now) {
    this.adapters = adapters;
    this.#logger = logger;
    this.#now = now;
  }

  /** First adapter for this agent whose capabilities include the mode. */
  select(agent: AgentKind, mode: SessionMode): AgentAdapter | undefined {
    return this.adapters.find((a) => a.agent === agent && safeCaps(a, mode).modes.includes(mode));
  }

  /** The mode to use when a client doesn't specify one: structured if any adapter offers it. */
  defaultMode(agent: AgentKind): SessionMode | undefined {
    if (this.select(agent, 'structured')) return 'structured';
    if (this.select(agent, 'terminal')) return 'terminal';
    return undefined;
  }

  kinds(): AgentKind[] {
    return [...new Set(this.adapters.map((a) => a.agent))];
  }

  /** Register a decorator; returns a function that removes it. */
  addDecorator(fn: ListingDecorator): () => void {
    this.#decorators.add(fn);
    return () => this.#decorators.delete(fn);
  }

  /**
   * Called after every completed probe of all agents (cache refresh), with the undecorated listings.
   * Returns a function that removes the listener. Listener errors are logged and ignored.
   */
  onProbed(fn: (agents: readonly AgentListing[]) => void): () => void {
    this.#probed.add(fn);
    return () => this.#probed.delete(fn);
  }

  /**
   * The last probe of an agent without decorators (and without probing). For code that runs inside
   * a decorator, where `lastKnown` would recurse.
   */
  lastProbe(agent: AgentKind): AgentListing | undefined {
    const l = this.#cache?.agents.find((a) => a.agent === agent);
    return l && { ...l };
  }

  /** The last probe of an agent (decorated), without probing. Undefined before the first probe. */
  lastKnown(agent: AgentKind): AgentListing | undefined {
    const l = this.#cache?.agents.find((a) => a.agent === agent);
    return l && this.#decorate(l);
  }

  /**
   * Refuse structured sessions on an install the last probe found `unsupported` (spec §7). Never
   * probes; without a probe yet, nothing is refused.
   */
  assertStartable(agent: AgentKind, mode: SessionMode): void {
    if (mode !== 'structured') return;
    const l = this.lastKnown(agent);
    if (l?.support !== 'unsupported') return;
    const why = l.supportReason ?? `this ${agent} version${l.version ? ` (${l.version})` : ''} is not supported`;
    throw new BizziError('unsupported', `${why}. Start a terminal-mode session instead, or fix the install first.`, {
      agent,
      version: l.version,
      remedies: l.remedies ?? [],
    });
  }

  /**
   * The models an agent offers (`agents.models`): the structured adapter's `listModels`, else any
   * adapter's fixed capability list. Cached per installed version for MODELS_CACHE_MS; a failed
   * listing is logged and answers the fixed list (often empty), without caching.
   */
  async models(agent: AgentKind, refresh = false): Promise<ModelOption[]> {
    const forKind = this.adapters.filter((a) => a.agent === agent);
    if (forKind.length === 0) throw new BizziError('agent_unavailable', `no adapter for ${agent}`);
    const version = this.lastProbe(agent)?.version;
    const hit = this.#models.get(agent);
    if (!refresh && hit && hit.version === version && this.#now() - hit.at < MODELS_CACHE_MS) return hit.models.map((m) => ({ ...m }));
    const running = this.#modelsInflight.get(agent);
    if (!refresh && running) return running;
    const fixed = (): ModelOption[] => {
      for (const a of forKind) {
        const m = safeCaps(a, 'structured').models;
        if (Array.isArray(m) && m.length > 0) return m.map((id) => ({ id }));
      }
      return [];
    };
    const lister = this.select(agent, 'structured') ?? forKind.find((a) => a.listModels);
    if (!lister?.listModels) return fixed();
    const env = this.agentEnv;
    const p = (async () => lister.listModels!(env ? { env: await env(agent) } : {}))().then(
      (models) => {
        if (this.#modelsInflight.get(agent) === p) this.#modelsInflight.delete(agent);
        const clean = dedupeModels(models);
        // An empty answer is often transient (an agent still loading its catalog): ask again next time.
        if (clean.length) this.#models.set(agent, { at: this.#now(), version, models: clean });
        else return fixed();
        return clean.map((m) => ({ ...m }));
      },
      (err: unknown) => {
        if (this.#modelsInflight.get(agent) === p) this.#modelsInflight.delete(agent);
        this.#logger.log('warn', 'listing models failed', { agent, err });
        return fixed();
      },
    );
    this.#modelsInflight.set(agent, p);
    return p;
  }

  async list(refresh = false): Promise<AgentListing[]> {
    return (await this.#list(refresh)).map((l) => this.#decorate(l));
  }

  #decorate(listing: AgentListing): AgentListing {
    let out = listing;
    for (const fn of this.#decorators) {
      try {
        out = fn({ ...out });
      } catch (err) {
        this.#logger.log('warn', 'agent listing decorator threw', { agent: listing.agent, err });
      }
    }
    return out;
  }

  async #list(refresh: boolean): Promise<AgentListing[]> {
    if (!refresh && this.#cache && this.#now() - this.#cache.at < PROBE_CACHE_MS) return this.#cache.agents;
    if (!refresh && this.#inflight) return this.#inflight;
    const p = this.#probeAll().then(
      (agents) => {
        this.#cache = { at: this.#now(), agents };
        if (this.#inflight === p) this.#inflight = undefined;
        for (const fn of this.#probed) {
          try {
            fn(agents);
          } catch (err) {
            this.#logger.log('warn', 'probe listener threw', { err });
          }
        }
        return agents;
      },
      (err: unknown) => {
        if (this.#inflight === p) this.#inflight = undefined;
        throw err;
      },
    );
    this.#inflight = p;
    return p;
  }

  async #probeAll(): Promise<AgentListing[]> {
    return Promise.all(
      this.kinds().map(async (agent) => {
        const forKind = this.adapters.filter((a) => a.agent === agent);
        const probe = await this.#probe(forKind[0]!);
        return { ...probe, agent, capabilities: mergeCapabilities(forKind) };
      }),
    );
  }

  async #probe(adapter: AgentAdapter): Promise<AgentProbe> {
    try {
      return await adapter.probe();
    } catch (err) {
      this.#logger.log('warn', 'adapter probe threw', { agent: adapter.agent, err });
      return { agent: adapter.agent, installed: false, auth: 'unknown', notes: [`probe failed: ${(err as Error).message}`] };
    }
  }
}

/** Drops entries without an id and repeats (first wins); keeps the adapter's order. */
function dedupeModels(models: readonly ModelOption[]): ModelOption[] {
  const seen = new Set<string>();
  const out: ModelOption[] = [];
  for (const m of models) {
    if (!m || typeof m.id !== 'string' || !m.id || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push({ ...m });
  }
  return out;
}

function safeCaps(a: AgentAdapter, mode: SessionMode): AgentCapabilities {
  try {
    return a.capabilities(mode);
  } catch {
    return NO_CAPABILITIES;
  }
}

/**
 * One capabilities object per agent kind. Each mode is answered by the adapter that would be
 * selected for it; feature fields come from the structured adapter when there is one (the terminal
 * adapter only contributes the mode and `terminal`).
 */
export function mergeCapabilities(adapters: readonly AgentAdapter[]): AgentCapabilities {
  const modes: SessionMode[] = [];
  let primary: AgentCapabilities | undefined;
  let terminal = false;
  for (const mode of ['structured', 'terminal'] as const) {
    const a = adapters.find((x) => safeCaps(x, mode).modes.includes(mode));
    if (!a) continue;
    const caps = safeCaps(a, mode);
    modes.push(mode);
    primary ??= caps;
    terminal ||= caps.terminal;
  }
  return { ...(primary ?? NO_CAPABILITIES), modes, terminal };
}
