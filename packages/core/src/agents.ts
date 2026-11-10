// Adapter registry: adapter selection per (agent, mode) and the cached `agents.list` view.

import type {
  AgentAdapter,
  AgentCapabilities,
  AgentKind,
  AgentListing,
  AgentProbe,
  Logger,
  SessionMode,
} from '@bizzi/protocol';
import { BizziError, NO_CAPABILITIES } from '@bizzi/protocol';

export const PROBE_CACHE_MS = 60_000;

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
