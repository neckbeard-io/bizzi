import { delimiter } from 'node:path';
import { type AgentKind, AGENT_KINDS, BizziError } from '@bizzi/protocol';
import { augmentedPath, findExecutable, homeDir, toolsDir as defaultToolsDir } from './path.ts';
import { currentPlatform, methodSupports, platformKey, resolveRecipePlatform } from './platform.ts';
import { defaultRecipes, type RecipeSet } from './recipes.ts';
import { brewBinFor, render, renderPath, shellQuote, TemplateError, type TemplateVars } from './template.ts';
import type { InstallAction, InstallPlan, MethodSpec, Platform, PlannedStep, Recipe, StepSpec } from './types.ts';

export interface PlanOptions {
  /** Recipe method id; default: the first method for this platform whose requirements are met. */
  method?: string;
  action?: InstallAction;
  /** Pin a version (`1.2.3`, or a channel like `stable` where the vendor supports it). */
  version?: string;
  /** Agent reported in progress events when planning a tool recipe (default: `shell`). */
  forAgent?: AgentKind;
  recipes?: RecipeSet;
  env?: NodeJS.ProcessEnv;
  home?: string;
  toolsDir?: string;
  /** Is a command available? Default: looked up on the augmented PATH. */
  hasCommand?: (command: string) => boolean;
  /** Append a `<binary> --version` check after install/update (default true). */
  verify?: boolean;
}

const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const DEFAULT_STEP_TIMEOUT = 15 * 60 * 1000;
const VERIFY_TIMEOUT = 30 * 1000;

/**
 * Ordered steps to install / update / uninstall a recipe's agent or tool on a platform.
 * Pure apart from the default `hasCommand` PATH lookup. Throws BizziError
 * (`not_found` unknown recipe, `unsupported` platform/method, `bad_request` bad version).
 */
export function planInstall(name: string, platform: Platform = currentPlatform(), methodOrOpts: string | PlanOptions = {}): InstallPlan {
  const opts: PlanOptions = typeof methodOrOpts === 'string' ? { method: methodOrOpts } : methodOrOpts;
  return planRecipe(name, platform, opts, new Set());
}

function planRecipe(name: string, platform: Platform, opts: PlanOptions, seen: Set<string>): InstallPlan {
  if (seen.has(name)) throw new BizziError('bad_request', `dependency cycle at "${name}"`);
  seen.add(name);
  const recipes = opts.recipes ?? defaultRecipes();
  const recipe = recipes.require(name);
  const action = opts.action ?? 'install';
  const plat = resolveRecipePlatform(recipe, platform);
  const key = platformKey(platform);
  if (!plat) throw new BizziError('unsupported', `${recipe.displayName} has no recipe for ${key}`);

  if (opts.version !== undefined && !VERSION_RE.test(opts.version)) {
    throw new BizziError('bad_request', `invalid version "${opts.version}"`);
  }
  const env = opts.env ?? process.env;
  const home = homeDir({ env, ...(opts.home ? { home: opts.home } : {}) });
  const tools = defaultToolsDir({ env, home, ...(opts.toolsDir ? { toolsDir: opts.toolsDir } : {}) });
  const hasCommand = opts.hasCommand ?? defaultHasCommand(env, home, tools, platform);

  const candidates = recipe.methods.filter((m) => methodSupports(m.platforms, plat.key) && stepsFor(m, action));
  const warnings: string[] = [];
  let method: MethodSpec | undefined;
  if (opts.method) {
    method = candidates.find((m) => m.id === opts.method);
    if (!method) {
      const exists = recipe.methods.some((m) => m.id === opts.method);
      throw new BizziError(
        exists ? 'unsupported' : 'not_found',
        exists
          ? `method "${opts.method}" of ${recipe.displayName} does not support ${action} on ${key}`
          : `${recipe.displayName} has no method "${opts.method}"`,
      );
    }
  } else {
    method = pickMethod(candidates, hasCommand, recipes);
    if (!method) throw new BizziError('unsupported', `${recipe.displayName}: no method can ${action} on ${key}`);
  }

  let version = opts.version;
  if (version === undefined && recipe.kind === 'tool' && action !== 'uninstall') version = recipe.defaultVersion;
  if (opts.version !== undefined && !method.pinnable) {
    warnings.push(`method "${method.id}" can't pin versions; it installs the latest release`);
    version = undefined;
  }

  const vars: TemplateVars = {
    version,
    home,
    toolsDir: tools,
    toolDir: version ? `${tools}/${recipe.name}/${version}` : undefined,
    name: recipe.name,
    os: platform.os,
    arch: platform.arch,
    libc: platform.libc ?? '',
    platform: plat.key,
    brewBin: brewBinFor(platform.os, platform.arch),
    ...(plat.spec.vars ?? {}),
  };

  const agent: AgentKind =
    recipe.kind === 'agent' && (AGENT_KINDS as readonly string[]).includes(recipe.name) ? (recipe.name as AgentKind) : (opts.forAgent ?? 'shell');

  const steps: PlannedStep[] = [];
  const extraPath: string[] = [];

  // Dependencies: requirements that are missing but provided by a bizzi tool recipe.
  if (action !== 'uninstall') {
    for (const req of method.requires ?? []) {
      if (hasCommand(req.command)) continue;
      if (!req.tool) {
        warnings.push(`requires "${req.command}", which was not found on PATH`);
        continue;
      }
      const dep = planRecipe(req.tool, platform, { ...opts, method: undefined, version: undefined, action: 'install', forAgent: agent, recipes }, seen);
      for (const s of dep.steps) steps.push({ ...s, phase: 'dependency' });
      extraPath.push(...dep.extraPath);
      warnings.push(...dep.warnings.map((w) => `${req.tool}: ${w}`));
    }
  }

  const specs = (stepsFor(method, action) ?? []).filter((s) => matchesWhen(s, version));
  specs.forEach((s, i) => steps.push(renderStep(s, vars, recipe, `${recipe.name}.${method.id}.${action}.${i + 1}`)));

  const binDir = renderOrThrow(() => renderPath(method.binDir ?? method.targetDir, vars), recipe);
  if (action !== 'uninstall') extraPath.unshift(binDir);

  if (action !== 'uninstall' && opts.verify !== false) {
    const argv = [recipe.detect.binaries[0] as string, ...recipe.detect.version.args];
    steps.push({
      id: `${recipe.name}.verify`,
      recipe: recipe.name,
      phase: 'verify',
      description: `Verify ${recipe.displayName} runs`,
      command: argv.map(shellQuote).join(' '),
      argv,
      env: {},
      requiresSudo: false,
      timeoutMs: VERIFY_TIMEOUT,
      allowFailure: false,
    });
  }

  return {
    agent,
    recipe: recipe.name,
    action,
    method: method.id,
    methodLabel: method.label,
    platform,
    platformKey: plat.key,
    ...(version ? { version } : {}),
    targetDir: renderOrThrow(() => renderPath(method.targetDir, vars), recipe),
    extraPath: [...new Set(extraPath)],
    requiresSudo: steps.some((s) => s.requiresSudo),
    steps,
    warnings,
  };
}

function stepsFor(m: MethodSpec, action: InstallAction): StepSpec[] | undefined {
  if (action === 'install') return m.install;
  if (action === 'update') return m.update ?? m.install;
  return m.uninstall;
}

function matchesWhen(s: StepSpec, version: string | undefined): boolean {
  if (s.when === 'pinned') return version !== undefined;
  if (s.when === 'unpinned') return version === undefined;
  return true;
}

function pickMethod(candidates: MethodSpec[], hasCommand: (c: string) => boolean, recipes: RecipeSet): MethodSpec | undefined {
  const unmet = (m: MethodSpec) => (m.requires ?? []).filter((r) => !hasCommand(r.command));
  return (
    candidates.find((m) => unmet(m).length === 0) ??
    candidates.find((m) => unmet(m).every((r) => r.tool && recipes.get(r.tool))) ??
    candidates[0]
  );
}

function renderStep(s: StepSpec, vars: TemplateVars, recipe: Recipe, id: string): PlannedStep {
  return renderOrThrow(() => {
    const run = s.run !== undefined ? render(s.run, vars, { shell: true }) : undefined;
    const argv = s.argv?.map((a) => render(a, vars));
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(s.env ?? {})) env[k] = renderPath(v, vars);
    const envPrefix = Object.entries(env)
      .map(([k, v]) => `${k}=${shellQuote(v)} `)
      .join('');
    const command = envPrefix + (run ?? (argv ?? []).map(shellQuote).join(' '));
    const step: PlannedStep = {
      id,
      recipe: recipe.name,
      phase: 'main',
      description: s.description,
      command,
      env,
      requiresSudo: s.requiresSudo,
      timeoutMs: s.timeoutMs ?? DEFAULT_STEP_TIMEOUT,
      allowFailure: s.allowFailure ?? false,
    };
    if (run !== undefined) step.run = run;
    if (argv) step.argv = argv;
    if (s.cwd) step.cwd = renderPath(s.cwd, vars);
    return step;
  }, recipe);
}

function renderOrThrow<T>(fn: () => T, recipe: Recipe): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof TemplateError) {
      throw new BizziError('bad_request', `${recipe.displayName}: ${e.message} (pin a version?)`, { variable: e.variable });
    }
    throw e;
  }
}

function defaultHasCommand(env: NodeJS.ProcessEnv, home: string, tools: string, platform: Platform): (c: string) => boolean {
  let dirs: string[] | undefined;
  return (c) => {
    dirs ??= augmentedPath({ env, home, toolsDir: tools, platform }).split(delimiter).filter(Boolean);
    return findExecutable(c, dirs) !== undefined;
  };
}
