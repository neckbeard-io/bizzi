// Updates extension (spec §7, updates.md §2 and §6): decorates `agents.list` with install facts and
// policies, stores policies (`agent.policy.set`), watches installs for version changes, and
// optionally checks for and runs updates for agents whose update policy is `auto`.
//
// Restarting stale sessions is the core's job (@bizzi/core `Restarts`): every re-probe here refreshes
// the registry, which re-checks running sessions against the installed version, and the restart
// policy this extension puts on agents.list decides whether they restart on their own (`when-idle`).

import { ulid, type AgentKind, type AgentListing, type Logger } from '@bizzi/protocol';
import { compareVersions, latestVersion as provisionLatest } from '@bizzi/provision';
import { InstallAssessor } from './assess.ts';
import { asParams, checkMachine, oneOf, reqAgent } from './params.ts';
import { PolicyStore, RESTART_POLICIES, UPDATE_POLICIES } from './policies.ts';
import type { ExtensionContext, NodeExtension } from './types.ts';
import { InstallWatcher, type WatchFn } from './watch.ts';

export interface UpdatesOptions {
  assessor?: InstallAssessor;
  policies?: PolicyStore;
  /** Watch install paths for version changes (default false; `bizzi serve` turns it on). */
  watch?: boolean;
  /** Quiet period before a watched change triggers a re-probe (default 2 s). */
  debounceMs?: number;
  /** Re-probe every agent on this interval (default off). Also retries watches on missing dirs. */
  probeIntervalMs?: number;
  /**
   * Check for new versions on this interval and run the recipe's update for agents whose policy is
   * `auto` (default off). Self-updating installs (Claude native) are only observed.
   */
  autoUpdateIntervalMs?: number;
  /** Latest version lookup (default: @bizzi/provision's latestVersion, network). */
  latest?: (agent: AgentKind) => Promise<string | undefined>;
  watchFn?: WatchFn;
}

export interface UpdatesExtension extends NodeExtension {
  /** Installed version per agent, from the last probe (for stale-session checks). */
  installedVersions(): Partial<Record<AgentKind, string>>;
  installedVersion(agent: AgentKind): string | undefined;
  /** Re-probe now; resolves with the agents whose installed version or binary changed. */
  reprobe(reason?: string): Promise<AgentKind[]>;
  /** One auto-update pass (what the interval runs). Resolves with the agents an update was started for. */
  checkForUpdates(): Promise<AgentKind[]>;
  /** Paths watched per agent (diagnostics, tests). */
  watched(): Record<string, string[]>;
  policies: PolicyStore;
  assessor: InstallAssessor;
}

interface Seen {
  installed: boolean;
  version?: string;
  realPath?: string;
}

export function createUpdatesExtension(opts: UpdatesOptions = {}): UpdatesExtension {
  const assessor = opts.assessor ?? new InstallAssessor();
  const policies = opts.policies ?? new PolicyStore();
  const latest = new Map<AgentKind, string>();
  const attempted = new Map<AgentKind, string>();
  const seen = new Map<AgentKind, Seen>();
  let ctx: ExtensionContext | undefined;
  let logger: Logger | undefined;
  let watcher: InstallWatcher | undefined;
  let removeDecorator: (() => void) | undefined;
  const timers: NodeJS.Timeout[] = [];
  let probing: Promise<AgentKind[]> | undefined;
  let again = false;
  let stopped = false;

  function decorate(l: AgentListing): AgentListing {
    const out = assessor.decorate(l);
    const p = policies.get(l.agent);
    out.updatePolicy = p.update;
    out.restartPolicy = p.restart;
    const newest = latest.get(l.agent);
    if (newest && !out.latestVersion) out.latestVersion = newest;
    if (out.installed && out.version && out.latestVersion && compareVersions(out.version, out.latestVersion) < 0) out.updateAvailable = true;
    return out;
  }

  /** Record what each agent looks like now; returns the agents that changed since the last record. */
  function record(agents: AgentListing[]): AgentKind[] {
    const changed: AgentKind[] = [];
    for (const a of agents) {
      const now: Seen = { installed: a.installed, ...(a.version ? { version: a.version } : {}), ...(a.realPath ? { realPath: a.realPath } : {}) };
      const before = seen.get(a.agent);
      seen.set(a.agent, now);
      if (before && (before.installed !== now.installed || before.version !== now.version || before.realPath !== now.realPath)) {
        changed.push(a.agent);
        announce(a.agent, before, now);
      }
    }
    if (watcher) {
      const targets = new Map<AgentKind, string[]>();
      for (const a of agents) targets.set(a.agent, assessor.assess(a)?.watch ?? []);
      watcher.update(targets);
    }
    return changed;
  }

  function announce(agent: AgentKind, before: Seen, now: Seen): void {
    const c = ctx;
    if (!c) return;
    const message = !now.installed
      ? `${agent} was removed`
      : !before.installed
        ? `${agent} ${now.version ?? ''} was installed`.replace(/ +/g, ' ')
        : before.version !== now.version
          ? `${agent} ${before.version ?? '?'} → ${now.version ?? '?'} installed`
          : `${agent} now runs ${now.realPath ?? '?'}`;
    c.logger.log('info', 'agent install changed', { agent, from: before.version, to: now.version, realPath: now.realPath });
    // Clients reload the agent list when an install job finishes; a detected change looks the same.
    c.emitGlobal({ type: 'install.progress', data: { agent, jobId: `watch_${ulid()}`, stage: 'detected', message, done: true, ok: true } });
    c.emitGlobal({ type: 'machine.updated', data: { machine: c.node.machine } });
  }

  async function probeOnce(reason: string): Promise<AgentKind[]> {
    const c = ctx;
    if (!c || stopped) return [];
    assessor.clear();
    logger?.log('debug', 're-probing agents', { reason });
    const agents = await c.node.registry.list(true);
    return record(agents);
  }

  function reprobe(reason = 'manual'): Promise<AgentKind[]> {
    if (probing) {
      again = true;
      return probing;
    }
    const run = async (): Promise<AgentKind[]> => {
      const changed: AgentKind[] = [];
      try {
        do {
          again = false;
          changed.push(...(await probeOnce(reason)));
        } while (again && !stopped);
      } catch (err) {
        logger?.log('warn', 're-probe failed', { reason, err: String(err) });
      } finally {
        probing = undefined;
      }
      return [...new Set(changed)];
    };
    probing = run();
    return probing;
  }

  async function checkForUpdates(): Promise<AgentKind[]> {
    const c = ctx;
    if (!c || stopped) return [];
    const lookup = opts.latest ?? ((agent: AgentKind) => provisionLatest(agent, { recipes: assessor.recipes, platform: assessor.platform }));
    const started: AgentKind[] = [];
    const agents = await c.node.registry.list();
    for (const a of agents) {
      if (a.agent === 'shell' || !a.installed || !a.version) continue;
      let newest: string | undefined;
      try {
        newest = await lookup(a.agent);
      } catch (err) {
        logger?.log('debug', 'latest version lookup failed', { agent: a.agent, err: String(err) });
      }
      if (!newest) continue;
      latest.set(a.agent, newest);
      if (compareVersions(a.version, newest) >= 0) continue;
      const p = policies.get(a.agent);
      if (p.update !== 'auto') continue; // notify: updateAvailable is enough · pinned: leave it alone
      const assessed = assessor.assess(a);
      if (assessed?.selfUpdates) continue; // its own updater handles it; bizzi only observes
      if (!assessed?.method) {
        logger?.log('info', 'update available but the install method is unknown; not updating', { agent: a.agent, version: a.version, latest: newest });
        continue;
      }
      if (attempted.get(a.agent) === newest) continue; // one attempt per release
      attempted.set(a.agent, newest);
      try {
        await c.node.call('agent.install', { agent: a.agent, action: 'update', method: assessed.method });
        started.push(a.agent);
        logger?.log('info', 'auto-update started', { agent: a.agent, from: a.version, to: newest, method: assessed.method });
      } catch (err) {
        logger?.log('warn', 'auto-update could not start', { agent: a.agent, err: String(err) });
      }
    }
    return started;
  }

  function every(ms: number, fn: () => unknown): void {
    const t = setInterval(() => {
      if (!stopped) void Promise.resolve().then(fn);
    }, ms);
    t.unref();
    timers.push(t);
  }

  return {
    policies,
    assessor,
    methods: {
      'agent.policy.set': async (raw, c) => {
        const p = asParams(raw);
        checkMachine(p, c.node.machine.id);
        const agent = reqAgent(p);
        const update = oneOf(p, 'update', UPDATE_POLICIES);
        const restart = oneOf(p, 'restart', RESTART_POLICIES);
        policies.set(agent, { ...(update ? { update } : {}), ...(restart ? { restart } : {}) });
        const listing =
          c.node.registry.lastKnown(agent) ??
          (await c.node.registry.list()).find((a) => a.agent === agent) ??
          decorate({ agent, installed: false, auth: 'unknown' });
        return { agent: listing };
      },
    },

    start(c) {
      stopped = false;
      ctx = c;
      logger = c.logger;
      removeDecorator = c.node.registry.addDecorator(decorate);
      if (opts.watch) {
        watcher = new InstallWatcher({
          onChange: (agent) => void reprobe(`files changed (${agent})`),
          debounceMs: opts.debounceMs ?? 2000,
          ...(opts.watchFn ? { watchFn: opts.watchFn } : {}),
          logger: c.logger,
        });
        // Initial probe in the background: sets up the watches and the "last seen" versions.
        void reprobe('start');
      }
      if (opts.probeIntervalMs) every(opts.probeIntervalMs, () => reprobe('interval'));
      if (opts.autoUpdateIntervalMs) every(opts.autoUpdateIntervalMs, () => checkForUpdates().catch((err) => logger?.log('warn', 'update check failed', { err: String(err) })));
    },

    async stop() {
      stopped = true;
      for (const t of timers.splice(0)) clearInterval(t);
      watcher?.close();
      watcher = undefined;
      removeDecorator?.();
      removeDecorator = undefined;
      await probing;
      ctx = undefined;
    },

    installedVersions,
    installedVersion: (agent) => installedVersions()[agent],
    reprobe,
    checkForUpdates,
    watched: () => watcher?.watched() ?? {},
  };

  function installedVersions(): Partial<Record<AgentKind, string>> {
    const out: Partial<Record<AgentKind, string>> = {};
    // The registry's last probe is the freshest; what this extension recorded fills the gaps.
    for (const agent of ctx?.node.registry.kinds() ?? []) {
      const l = ctx?.node.registry.lastKnown(agent);
      if (l?.installed && l.version) out[agent] = l.version;
    }
    for (const [agent, s] of seen) if (s.installed && s.version && !out[agent]) out[agent] = s.version;
    return out;
  }
}
