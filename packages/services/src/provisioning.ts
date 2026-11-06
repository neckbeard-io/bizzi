// Provisioning extension (spec §7): agent.plan / agent.install from @bizzi/provision recipes, and
// per-agent secrets (agent.secrets / agent.setSecret / agent.deleteSecret) that are injected into
// the agent's environment at session start.

import { BizziError, ulid, type AgentKind, type InstallAction, type InstallPlan as WirePlan } from '@bizzi/protocol';
import {
  currentPlatform,
  planInstall,
  runPlan,
  type InstallPlan,
  type InstallProgress,
  type Platform,
  type PlanOptions,
  type RecipeSet,
  type RunOptions,
} from '@bizzi/provision';
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
}

export interface ProvisioningExtension extends NodeExtension {
  /** Resolves when no install is queued or running. */
  idle(): Promise<void>;
}

/** Map @bizzi/provision's plan to the wire `InstallPlan`. */
export function toWirePlan(plan: InstallPlan): WirePlan {
  const notes = [`${plan.methodLabel} on ${plan.platformKey}${plan.version ? `, version ${plan.version}` : ''}`, ...plan.warnings];
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

  function plan(p: Record<string, unknown>): InstallPlan {
    const agent = reqAgent(p);
    if (agent === 'shell') throw new BizziError('unsupported', 'the shell needs no install');
    const action = oneOf(p, 'action', ACTIONS);
    if (!action) throw new BizziError('bad_request', 'action is required');
    const planOpts: PlanOptions = { action };
    const method = optString(p, 'method');
    const version = optString(p, 'version');
    if (method) planOpts.method = method;
    if (version) planOpts.version = version;
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

  return {
    methods: {
      'agent.plan': (raw, ctx) => {
        const p = asParams(raw);
        checkMachine(p, ctx.node.machine.id);
        return { plan: toWirePlan(plan(p)) };
      },

      'agent.install': (raw, ctx) => {
        const p = asParams(raw);
        checkMachine(p, ctx.node.machine.id);
        const dryRun = optBool(p, 'dryRun') ?? false;
        const installPlan = plan(p);
        const jobId = `job_${ulid()}`;
        const agent: AgentKind = installPlan.agent;
        if (dryRun) {
          // Dry runs touch nothing, so they don't wait behind a real install.
          const job = execute(installPlan, jobId, true, ctx)
            .catch((err) => ctx.logger.log('error', 'dry run failed', { jobId, err: String(err) }))
            .finally(() => dryRuns.delete(job));
          dryRuns.add(job);
        } else {
          if (pending > 0) {
            ctx.emitGlobal({
              type: 'install.progress',
              data: { agent, jobId, stage: 'queued', message: 'waiting for another install to finish', step: 0, total: installPlan.steps.length },
            });
          }
          pending++;
          queue = queue
            .then(() => execute(installPlan, jobId, false, ctx))
            .catch((err) => {
              ctx.logger.log('error', 'install job failed', { jobId, err: String(err) });
              ctx.emitGlobal({ type: 'install.progress', data: { agent, jobId, stage: 'done', message: String(err), done: true, ok: false } });
            })
            .finally(() => {
              pending--;
            });
        }
        return { jobId, plan: toWirePlan(installPlan) };
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
