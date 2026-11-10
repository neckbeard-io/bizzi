// Stale agent processes and restart policies (updates.md §2, §4 and §6). The restart sequence itself
// (§5) lives in Sessions.restartAgent; this module decides when to run it:
//
// - stale: the running version differs from the installed one, or the running executable is gone;
// - `when-idle`: restart automatically at the next safe point once an update is detected;
// - `ask`: nothing automatic; agents.list `staleSessions` and the session's `agentVersion` (the UI's
//   version chip) show it, and the user restarts with `session.restart`;
// - `manual`: only `session.restart`.
//
// Triggers: every completed probe (the updates extension re-probes when install paths change), and
// every `session.updated` (a session reaching a safe point).

import { existsSync } from 'node:fs';
import {
  BizziError,
  GLOBAL_CHANNEL,
  type AgentKind,
  type AgentListing,
  type Logger,
  type RestartPolicy,
} from '@bizzi/protocol';
import type { AdapterRegistry } from './agents.ts';
import type { EventBus } from './bus.ts';
import type { Sessions } from './sessions.ts';

/**
 * Agents whose restart unit is a shared server rather than one process per session (updates.md §3):
 * bizzi's private `opencode serve` is shared by every OpenCode session on the node. Replacing one
 * session's adapter session doesn't replace the server, so these are reported stale but never
 * restarted per session.
 */
export const SHARED_SERVER_AGENTS: readonly AgentKind[] = ['opencode'];

/**
 * Identifies an install as a restart sees it (version, real path, login state). A restart that
 * failed on one isn't retried automatically; fixing the login or installing another version is a
 * new install.
 */
export function installKey(probe: AgentListing | undefined): string {
  return [probe?.version ?? '?', probe?.realPath ?? probe?.path ?? '?', probe?.auth ?? '?'].join('\0');
}

/** Why the running process is stale, or undefined (updates.md §2). */
export function staleReason(
  running: { version?: string; path?: string },
  installed: AgentListing | undefined,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  if (running.path && !exists(running.path)) return `the running executable ${running.path} no longer exists`;
  if (installed?.installed && installed.version && running.version && installed.version !== running.version) {
    return `running ${running.version}, ${installed.version} installed`;
  }
  return undefined;
}

/** What's wrong with the installed binary for a restart onto it (updates.md §5 step 1), or undefined. */
export function precheckProblem(probe: AgentListing | undefined): string | undefined {
  if (!probe) return 'the agent could not be probed';
  if (!probe.installed) return 'the agent is no longer installed';
  if (!probe.version) return '`--version` did not report a version';
  if (probe.support === 'unsupported') return probe.supportReason ?? `version ${probe.version} is not supported`;
  if (probe.auth === 'missing' || probe.auth === 'expired') return `the login no longer works (auth: ${probe.auth})`;
  return undefined;
}

export interface RestartsDeps {
  sessions: Sessions;
  registry: AdapterRegistry;
  bus: EventBus;
  logger: Logger;
  /** Default SHARED_SERVER_AGENTS. */
  sharedServerAgents?: readonly AgentKind[];
}

export class Restarts {
  readonly #d: RestartsDeps;
  readonly #log: Logger;
  readonly #shared: ReadonlySet<AgentKind>;
  /** Sessions with a `session.restart` waiting for a safe point. */
  readonly #requested = new Set<string>();
  readonly #scheduled = new Set<string>();
  readonly #running = new Map<string, Promise<void>>();
  readonly #off: (() => void)[] = [];
  #closed = false;

  constructor(deps: RestartsDeps) {
    this.#d = deps;
    this.#log = deps.logger.child({ component: 'restarts' });
    this.#shared = new Set(deps.sharedServerAgents ?? SHARED_SERVER_AGENTS);
    this.#off.push(
      deps.bus.on(GLOBAL_CHANNEL, (ev) => {
        if (ev.type === 'session.updated') this.#schedule(ev.data.session.id);
        else if (ev.type === 'session.removed') this.#requested.delete(ev.data.sessionId);
      }),
      deps.registry.onProbed(() => this.checkAll()),
      deps.registry.addDecorator((l) => ({ ...l, staleSessions: this.staleCount(l.agent) })),
    );
  }

  /** Why the session's agent process is stale, or undefined (also when nothing is running). */
  stale(id: string): string | undefined {
    const proc = this.#d.sessions.agentProcess(id);
    if (!proc.running) return undefined;
    const agent = this.#d.sessions.get(id).session.agent;
    // Undecorated: this runs inside the agents.list decorator.
    return staleReason(proc, this.#d.registry.lastProbe(agent));
  }

  /** Running sessions of `agent` on a stale process (AgentProbe.staleSessions). */
  staleCount(agent: AgentKind): number {
    let n = 0;
    for (const s of this.#d.sessions.list()) if (s.agent === agent && this.stale(s.id)) n++;
    return n;
  }

  /** Restart policy for an agent (services decorate agents.list with it); `manual` when nobody says. */
  policy(agent: AgentKind): RestartPolicy {
    return this.#d.registry.lastKnown(agent)?.restartPolicy ?? 'manual';
  }

  /**
   * `session.restart`: restart the agent process on the installed version at the next safe point
   * (now, if the session is at one). Returns once the request is accepted; progress shows as
   * `session.restarting` / `session.restarted`. A session whose agent isn't running needs nothing:
   * its next start runs the installed version.
   */
  request(id: string): void {
    const { session } = this.#d.sessions.get(id);
    if (session.status === 'ended') throw new BizziError('conflict', 'session has ended');
    if (this.#shared.has(session.agent)) {
      throw new BizziError('unsupported', `${session.agent} sessions share one agent server; restart the server instead (not supported yet)`);
    }
    const blocker = this.#d.sessions.restartBlocker(id);
    if (blocker) throw new BizziError('unsupported', `cannot restart: ${blocker}`);
    if (!this.#d.sessions.agentProcess(id).running) return;
    this.#requested.add(id);
    this.#schedule(id);
  }

  /** Is a `session.restart` waiting for a safe point? */
  isRequested(id: string): boolean {
    return this.#requested.has(id);
  }

  /** Re-evaluate every session (after a probe: the installed version may have changed). */
  checkAll(): void {
    for (const s of this.#d.sessions.list()) this.#schedule(s.id);
  }

  /** Resolves once no restart started by this manager is in flight (tests, shutdown). */
  async settled(): Promise<void> {
    while (this.#running.size > 0 || this.#scheduled.size > 0) {
      await Promise.all([...this.#running.values()]);
      await new Promise((r) => setImmediate(r));
    }
  }

  close(): void {
    this.#closed = true;
    for (const off of this.#off.splice(0)) off();
    this.#requested.clear();
  }

  #schedule(id: string): void {
    if (this.#closed || this.#scheduled.has(id)) return;
    this.#scheduled.add(id);
    // Bus listeners run before the session's derived state settles; decide on the next tick.
    setImmediate(() => {
      this.#scheduled.delete(id);
      try {
        this.#consider(id);
      } catch (err) {
        this.#log.log('warn', 'restart check failed', { sessionId: id, err });
      }
    });
  }

  #consider(id: string): void {
    const s = this.#d.sessions;
    if (this.#closed || this.#running.has(id) || !s.has(id) || s.draining || s.isRestarting(id)) return;
    const manual = this.#requested.has(id);
    const proc = s.agentProcess(id);
    if (!proc.running) {
      // Nothing to replace: the next start runs the installed version.
      this.#requested.delete(id);
      return;
    }
    const { session } = s.get(id);
    let reason: string;
    if (manual) {
      reason = 'restart requested';
    } else {
      const why = this.stale(id);
      if (!why || this.#shared.has(session.agent) || this.policy(session.agent) !== 'when-idle') return;
      // No automatic retries on an install a restart already failed on.
      if (proc.restartFailedFor !== undefined && proc.restartFailedFor === installKey(this.#d.registry.lastProbe(session.agent))) return;
      reason = `update detected: ${why}`;
    }
    if (s.restartBlocker(id)) {
      this.#requested.delete(id);
      return;
    }
    // Not at a safe point: the next session.updated (turn completed, approval answered…) looks again.
    if (s.unsafeReason(id)) return;
    this.#requested.delete(id);
    this.#log.log('info', 'restarting agent process', { sessionId: id, agent: session.agent, reason });
    const p = s
      .restartAgent(id, { reason })
      .then(
        (outcome) => {
          if (!outcome.ok) this.#log.log('warn', 'agent restart did not complete', { sessionId: id, ...outcome });
        },
        (err: unknown) => this.#log.log('warn', 'agent restart refused', { sessionId: id, err }),
      )
      .finally(() => {
        this.#running.delete(id);
      });
    this.#running.set(id, p);
  }
}
