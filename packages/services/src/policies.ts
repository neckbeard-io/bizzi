// Update and restart policies per agent on this machine (updates.md §6), persisted as a small JSON
// file in the node's data dir.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { BizziError, type AgentKind, type Logger, type RestartPolicy, type UpdatePolicy } from '@bizzi/protocol';

export const POLICIES_FILE = 'agent-policies.json';
export const UPDATE_POLICIES = ['auto', 'notify', 'pinned'] as const satisfies readonly UpdatePolicy[];
export const RESTART_POLICIES = ['when-idle', 'ask', 'manual'] as const satisfies readonly RestartPolicy[];

export interface AgentPolicies {
  update: UpdatePolicy;
  restart: RestartPolicy;
}

/**
 * updates.md §6 defaults: update `auto` (self-updating installs are only observed); restart
 * `when-idle` for agents with a structured adapter and a reliable resume, `ask` for terminal-only ones.
 */
export function defaultPolicies(agent: AgentKind): AgentPolicies {
  const structured = agent === 'claude' || agent === 'codex' || agent === 'opencode';
  return { update: 'auto', restart: structured ? 'when-idle' : 'ask' };
}

export interface PolicyStoreOptions {
  /** JSON file; omitted = in memory only. */
  path?: string;
  logger?: Logger;
}

export class PolicyStore {
  readonly #path: string | undefined;
  readonly #logger: Logger | undefined;
  readonly #byAgent = new Map<AgentKind, Partial<AgentPolicies>>();

  constructor(opts: PolicyStoreOptions = {}) {
    this.#path = opts.path;
    this.#logger = opts.logger;
    this.#load();
  }

  get(agent: AgentKind): AgentPolicies {
    return { ...defaultPolicies(agent), ...this.#byAgent.get(agent) };
  }

  /** Explicitly set values only (defaults excluded). */
  overrides(agent: AgentKind): Partial<AgentPolicies> {
    return { ...this.#byAgent.get(agent) };
  }

  set(agent: AgentKind, patch: Partial<AgentPolicies>): AgentPolicies {
    if (patch.update !== undefined && !(UPDATE_POLICIES as readonly string[]).includes(patch.update)) {
      throw new BizziError('bad_request', `update must be one of ${UPDATE_POLICIES.join(', ')}`);
    }
    if (patch.restart !== undefined && !(RESTART_POLICIES as readonly string[]).includes(patch.restart)) {
      throw new BizziError('bad_request', `restart must be one of ${RESTART_POLICIES.join(', ')}`);
    }
    const next = { ...this.#byAgent.get(agent) };
    if (patch.update !== undefined) next.update = patch.update;
    if (patch.restart !== undefined) next.restart = patch.restart;
    this.#byAgent.set(agent, next);
    this.#save();
    return this.get(agent);
  }

  #load(): void {
    if (!this.#path) return;
    let raw: string;
    try {
      raw = readFileSync(this.#path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.#logger?.log('warn', 'cannot read agent policies', { err: String(err) });
      return;
    }
    try {
      const data = JSON.parse(raw) as { agents?: Record<string, Partial<AgentPolicies>> };
      for (const [agent, p] of Object.entries(data.agents ?? {})) {
        const clean: Partial<AgentPolicies> = {};
        if ((UPDATE_POLICIES as readonly unknown[]).includes(p?.update)) clean.update = p.update as UpdatePolicy;
        if ((RESTART_POLICIES as readonly unknown[]).includes(p?.restart)) clean.restart = p.restart as RestartPolicy;
        this.#byAgent.set(agent as AgentKind, clean);
      }
    } catch (err) {
      this.#logger?.log('warn', 'agent policies file is not valid JSON; using defaults', { err: String(err) });
    }
  }

  #save(): void {
    if (!this.#path) return;
    const data = { version: 1, agents: Object.fromEntries(this.#byAgent) };
    mkdirSync(dirname(this.#path), { recursive: true });
    const tmp = `${this.#path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.#path);
  }
}
