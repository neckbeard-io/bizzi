// Provisioning extension (spec §7): agent.plan / agent.install / agent.migrate from @bizzi/provision
// recipes, and per-agent secrets (agent.secrets / agent.setSecret / agent.deleteSecret) that are
// injected into the agent's environment at session start.

import { BizziError, ulid, type AgentKind, type AgentListing, type InstallAction, type InstallPlan as WirePlan, type SessionInfo } from '@bizzi/protocol';
import {
  currentPlatform,
  defaultRecipes,
  execCapture,
  planInstall,
  runPlan,
  type InstallPlan,
  type InstallProgress,
  type Platform,
  type PlanOptions,
  type RecipeSet,
  type RunOptions,
} from '@bizzi/provision';
import { InstallAssessor } from './assess.ts';
import { liveSessionsOf, planMigration, runMigration, type MigrationDeps, type MigrationPlan } from './migrate.ts';
import { asParams, checkMachine, oneOf, optAgent, optBool, optString, reqAgent, reqString } from './params.ts';
import type { SecretStore } from './secrets/store.ts';
import type { ExtensionContext, NodeExtension } from './types.ts';

const ACTIONS = ['install', 'update', 'uninstall'] as const satisfies readonly InstallAction[];

export interface ProvisioningOptions {
  secrets: SecretStore;
  recipes?: RecipeSet;
  platform?: Platform;
  /** Base environment for planning and running (default process.env). */
  env?: NodeJS.ProcessEnv;
  home?: string;
  toolsDir?: string;
  /** Is a command on the (augmented) PATH? Default: provision's lookup. */
  hasCommand?: (command: string) => boolean;
  /** Refresh `agents.list` probes after a real install (default true). */
  refreshAfterInstall?: boolean;
  /** Override runPlan (tests). */
  runPlan?: typeof runPlan;
  /** Shared with the updates extension: install method / real path of adopted installs. */
  assessor?: InstallAssessor;
  /** Override execCapture for agent.migrate's login-shell PATH check (tests). */
  exec?: typeof execCapture;
  /** Login shell for that check (default $SHELL). */
  shell?: string;
  /** Sessions with a live process for an agent (default: the node's sessions). */
  liveSessions?: (agent: AgentKind, ctx: ExtensionContext) => SessionInfo[];
}

export interface ProvisioningExtension extends NodeExtension {
  /** Resolves when no install is queued or running. */
  idle(): Promise<void>;
}

/** Map @bizzi/provision's plan to the wire `InstallPlan`. */
export function toWirePlan(plan: InstallPlan): WirePlan {
  const expect = plan.steps.find((s) => s.expectVersion)?.expectVersion;
  const notes = [
    `${plan.methodLabel} on ${plan.platformKey}${plan.version ? `, version ${plan.version}` : ''}`,
    ...(expect ? [`Fails unless ${expect.displayName} ends up at ${expect.range}`] : []),
    ...plan.warnings,
  ];
  return {
    target: plan.recipe,
    action: plan.action,
    method: plan.method,
    steps: plan.steps.map((s) => ({
      id: s.id,
      title: s.description,
      command: s.command,
      ...(s.requiresSudo ? { requiresSudo: true } : {}),
    })),
    notes,
  };
}

export function createProvisioningExtension(opts: ProvisioningOptions): ProvisioningExtension {
  const secrets = opts.secrets;
  const run = opts.runPlan ?? runPlan;
  /** Tail of the per-machine install queue. */
  let queue: Promise<void> = Promise.resolve();
  let pending = 0;
  let stopped = false;
  const dryRuns = new Set<Promise<void>>();
  const assessor =
    opts.assessor ??
    new InstallAssessor({
      ...(opts.recipes ? { recipes: opts.recipes } : {}),
      ...(opts.platform ? { platform: opts.platform } : {}),
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.home ? { home: opts.home } : {}),
    });

  /** The agent's last probe with install facts (method, real path); never probes. */
  function current(agent: AgentKind, ctx: ExtensionContext): AgentListing | undefined {
    const l = ctx.node.registry.lastKnown(agent);
    return l && assessor.decorate(l);
  }

  function plan(p: Record<string, unknown>, ctx: ExtensionContext): InstallPlan {
    const agent = reqAgent(p);
    if (agent === 'shell') throw new BizziError('unsupported', 'the shell needs no install');
    const action = oneOf(p, 'action', ACTIONS);
    if (!action) throw new BizziError('bad_request', 'action is required');
    const planOpts: PlanOptions = { action };
    let method = optString(p, 'method');
    const version = optString(p, 'version');
    const remedy = optString(p, 'remedy');
    if (action !== 'install') {
      // Update / uninstall an adopted install the way it was installed (e.g. the Homebrew formula
      // the binary came from, not the recipe's default formula).
      const l = current(agent, ctx);
      if (l?.installed && l.method && (!method || method === l.method)) {
        const recipe = (opts.recipes ?? defaultRecipes()).get(agent);
        const m = recipe?.methods.find((x) => x.id === l.method);
        if (m && (action === 'uninstall' ? m.uninstall : true)) {
          method = l.method;
          if (l.realPath) planOpts.installedPath = l.realPath;
        }
      }
    }
    if (method) planOpts.method = method;
    if (version) planOpts.version = version;
    if (remedy) planOpts.remedy = remedy;
    if (opts.recipes) planOpts.recipes = opts.recipes;
    if (opts.env) planOpts.env = opts.env;
    if (opts.home) planOpts.home = opts.home;
    if (opts.toolsDir) planOpts.toolsDir = opts.toolsDir;
    if (opts.hasCommand) planOpts.hasCommand = opts.hasCommand;
    return planInstall(agent, opts.platform ?? currentPlatform(), planOpts);
  }

  async function execute(installPlan: InstallPlan, jobId: string, dryRun: boolean, ctx: ExtensionContext): Promise<void> {
    const total = installPlan.steps.length;
    let step = 0;
    const emit = (p: InstallProgress) => {
      if (p.stage === 'step') step++;
      const recipe = step > 0 ? installPlan.steps[step - 1]?.recipe : undefined;
      ctx.emitGlobal({
        type: 'install.progress',
        data: {
          ...p,
          ...(recipe && recipe !== installPlan.recipe ? { tool: recipe } : {}),
          jobId,
          step,
          total,
        },
      });
    };
    const runOpts: RunOptions = { dryRun, onProgress: emit, logger: ctx.logger };
    if (opts.env) runOpts.env = opts.env;
    ctx.logger.log('info', dryRun ? 'install dry run' : 'install started', {
      jobId,
      agent: installPlan.agent,
      action: installPlan.action,
      method: installPlan.method,
      ...(installPlan.remedy ? { remedy: installPlan.remedy } : {}),
    });
    const res = await run(installPlan, runOpts);
    ctx.logger.log(res.ok ? 'info' : 'warn', 'install finished', { jobId, ok: res.ok, dryRun, error: res.error });
    if (!dryRun && opts.refreshAfterInstall !== false && !stopped) {
      try {
        await ctx.node.call('agents.list', { refresh: true });
      } catch (err) {
        ctx.logger.log('debug', 'agents refresh after install failed', { err: String(err) });
      }
    }
  }

  /** Real installs (and migrations) run one at a time per machine. */
  function enqueue(agent: AgentKind, jobId: string, total: number, job: () => Promise<unknown>, ctx: ExtensionContext): void {
    if (pending > 0) {
      ctx.emitGlobal({
        type: 'install.progress',
        data: { agent, jobId, stage: 'queued', message: 'waiting for another install to finish', step: 0, total },
      });
    }
    pending++;
    queue = queue
      .then(async () => {
        await job();
      })
      .catch((err) => {
        ctx.logger.log('error', 'install job failed', { jobId, err: String(err) });
        ctx.emitGlobal({ type: 'install.progress', data: { agent, jobId, stage: 'done', message: String(err), done: true, ok: false } });
      })
      .finally(() => {
        pending--;
      });
  }

  function migrationEnv() {
    return {
      recipes: opts.recipes ?? defaultRecipes(),
      platform: opts.platform ?? currentPlatform(),
      env: opts.env ?? process.env,
      ...(opts.home ? { home: opts.home } : {}),
      ...(opts.toolsDir ? { toolsDir: opts.toolsDir } : {}),
      ...(opts.hasCommand ? { hasCommand: opts.hasCommand } : {}),
    };
  }

  async function migrate(migration: MigrationPlan, jobId: string, dryRun: boolean, ctx: ExtensionContext): Promise<void> {
    const agent = migration.agent;
    const deps: MigrationDeps = {
      ...migrationEnv(),
      run,
      ...(opts.exec ? { exec: opts.exec } : {}),
      ...(opts.shell ? { shell: opts.shell } : {}),
      logger: ctx.logger,
      reprobe: async () => {
        assessor.clear();
        const agents = await ctx.node.registry.list(true);
        const l = agents.find((a) => a.agent === agent);
        return l && assessor.decorate(l);
      },
      liveSessions: () => (opts.liveSessions ? opts.liveSessions(agent, ctx) : liveSessionsOf(ctx.node.sessions.list(), agent)),
    };
    ctx.logger.log('info', dryRun ? 'migration dry run' : 'migration started', { jobId, agent, from: migration.fromMethod, to: migration.toMethod });
    await runMigration(
      migration,
      deps,
      (p) => ctx.emitGlobal({ type: 'install.progress', data: { ...p, agent, jobId } }),
      dryRun,
    );
  }

  return {
    methods: {
      'agent.plan': (raw, ctx) => {
        const p = asParams(raw);
        checkMachine(p, ctx.node.machine.id);
        return { plan: toWirePlan(plan(p, ctx)) };
      },

      'agent.install': (raw, ctx) => {
        const p = asParams(raw);
        checkMachine(p, ctx.node.machine.id);
        const dryRun = optBool(p, 'dryRun') ?? false;
        const installPlan = plan(p, ctx);
        const jobId = `job_${ulid()}`;
        const agent: AgentKind = installPlan.agent;
        if (dryRun) {
          // Dry runs touch nothing, so they don't wait behind a real install.
          const job = execute(installPlan, jobId, true, ctx)
            .catch((err) => ctx.logger.log('error', 'dry run failed', { jobId, err: String(err) }))
            .finally(() => dryRuns.delete(job));
          dryRuns.add(job);
        } else {
          enqueue(agent, jobId, installPlan.steps.length, () => execute(installPlan, jobId, false, ctx), ctx);
        }
        return { jobId, plan: toWirePlan(installPlan) };
      },

      'agent.migrate': async (raw, ctx) => {
        const p = asParams(raw);
        checkMachine(p, ctx.node.machine.id);
        const agent = reqAgent(p);
        if (agent === 'shell') throw new BizziError('unsupported', 'the shell has no install to migrate');
        const dryRun = optBool(p, 'dryRun') ?? false;
        const listing = current(agent, ctx) ?? (await ctx.node.registry.list()).map((l) => assessor.decorate(l)).find((l) => l.agent === agent);
        if (!listing) throw new BizziError('agent_unavailable', `no adapter for ${agent} on this node`);
        const migration = planMigration(listing, optString(p, 'toMethod'), migrationEnv());
        const jobId = `job_${ulid()}`;
        const job = () => migrate(migration, jobId, dryRun, ctx);
        if (dryRun) {
          const j = job()
            .catch((err) => ctx.logger.log('error', 'migration dry run failed', { jobId, err: String(err) }))
            .finally(() => dryRuns.delete(j));
          dryRuns.add(j);
        } else {
          enqueue(agent, jobId, migration.wire.steps.length, job, ctx);
        }
        return { jobId, plan: migration.wire };
      },

      'agent.secrets': (raw, ctx) => {
        const p = asParams(raw);
        checkMachine(p, ctx.node.machine.id);
        return { secrets: secrets.list(optAgent(p)) };
      },

      'agent.setSecret': async (raw, ctx) => {
        const p = asParams(raw);
        checkMachine(p, ctx.node.machine.id);
        const value = p.value;
        if (typeof value !== 'string') throw new BizziError('bad_request', 'value must be a string');
        await secrets.set(reqAgent(p), reqString(p, 'name'), value);
        return {};
      },

      'agent.deleteSecret': async (raw, ctx) => {
        const p = asParams(raw);
        checkMachine(p, ctx.node.machine.id);
        await secrets.delete(reqAgent(p), reqString(p, 'name'));
        return {};
      },
    },

    start(ctx) {
      stopped = false;
      ctx.setAgentEnvProvider((agent) => secrets.env(agent));
    },

    async stop() {
      stopped = true;
      await Promise.all([queue, ...dryRuns]);
    },

    idle: async () => {
      // A job may enqueue while we wait; loop until the tail is stable.
      for (;;) {
        const tail = queue;
        await Promise.all([tail, ...dryRuns]);
        if (tail === queue && dryRuns.size === 0) return;
      }
    },
  };
}
