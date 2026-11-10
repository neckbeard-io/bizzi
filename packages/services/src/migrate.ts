// agent.migrate (spec §7 "Install method and migration"): switch an adopted install to the recipe's
// preferred method in four steps:
//   1. install with the preferred method;
//   2. check that its bin dir comes first on PATH for login and non-interactive shells (report only;
//      shell startup files are never edited);
//   3. re-probe, including the login state;
//   4. remove the old install, but only when no session is using the agent.

import { delimiter, dirname } from 'node:path';
import {
  BizziError,
  type AgentKind,
  type AgentListing,
  type InstallPlan as WirePlan,
  type InstallStep,
  type Logger,
  type SessionInfo,
} from '@bizzi/protocol';
import {
  augmentedPath,
  execCapture,
  findBinary,
  homeDir,
  methodBinDir,
  methodForPaths,
  planInstall,
  resolveExecutable,
  runPlan,
  type InstallPlan,
  type InstallProgress,
  type Platform,
  type PlanOptions,
  type RecipeSet,
} from '@bizzi/provision';

/** Session statuses with a live agent process. */
const LIVE: ReadonlySet<SessionInfo['status']> = new Set(['starting', 'running', 'waiting_input', 'waiting_approval', 'idle']);

export function liveSessionsOf(sessions: readonly SessionInfo[], agent: AgentKind): SessionInfo[] {
  return sessions.filter((s) => s.agent === agent && LIVE.has(s.status));
}

export interface MigrationPlan {
  agent: AgentKind;
  displayName: string;
  fromMethod: string;
  fromLabel: string;
  toMethod: string;
  toLabel: string;
  /** Real path of the install being replaced. */
  fromPath: string;
  binDir: string;
  binaries: string[];
  install: InstallPlan;
  uninstall: InstallPlan;
  wire: WirePlan;
}

export interface MigrationEnv {
  recipes: RecipeSet;
  platform: Platform;
  env: NodeJS.ProcessEnv;
  home?: string;
  toolsDir?: string;
  hasCommand?: (command: string) => boolean;
}

export const PATH_STEP_ID = 'migrate.path';
export const REPROBE_STEP_ID = 'migrate.reprobe';

/** Build the migration plan from the agent's current (decorated) listing. Throws BizziError. */
export function planMigration(listing: AgentListing, toMethodParam: string | undefined, m: MigrationEnv): MigrationPlan {
  const agent = listing.agent;
  if (agent === 'shell') throw new BizziError('unsupported', 'the shell has no install to migrate');
  const recipe = m.recipes.require(agent);
  if (!listing.installed) throw new BizziError('bad_request', `${recipe.displayName} is not installed; use agent.install`);
  const fromId = listing.method;
  const fromPath = listing.realPath ?? listing.path;
  if (!fromId || !fromPath) {
    throw new BizziError(
      'bad_request',
      `can't tell how ${recipe.displayName} was installed (${fromPath ?? 'unknown path'}), so bizzi won't remove it; install the preferred method with agent.install instead`,
    );
  }
  const toId = toMethodParam ?? listing.preferredMethod;
  if (!toId) throw new BizziError('unsupported', `${recipe.displayName} has no install method for this platform`);
  if (toId === fromId) throw new BizziError('conflict', `${recipe.displayName} is already installed with method "${toId}"`);
  const from = recipe.methods.find((x) => x.id === fromId);
  const to = recipe.methods.find((x) => x.id === toId);
  if (!from) throw new BizziError('not_found', `${recipe.displayName} has no method "${fromId}"`);
  if (!to) throw new BizziError('not_found', `${recipe.displayName} has no method "${toId}"`);

  const base: PlanOptions = {
    recipes: m.recipes,
    env: m.env,
    ...(m.home ? { home: m.home } : {}),
    ...(m.toolsDir ? { toolsDir: m.toolsDir } : {}),
    ...(m.hasCommand ? { hasCommand: m.hasCommand } : {}),
  };
  const install = planInstall(agent, m.platform, { ...base, action: 'install', method: toId });
  const uninstall = planInstall(agent, m.platform, { ...base, action: 'uninstall', method: fromId, installedPath: fromPath });
  const binDir = methodBinDir(recipe, to, { platform: m.platform, env: m.env, ...(m.home ? { home: m.home } : {}) }) ?? install.targetDir;

  const toStep = (s: { id: string; description: string; command: string; requiresSudo: boolean }): InstallStep => ({
    id: s.id,
    title: s.description,
    command: s.command,
    ...(s.requiresSudo ? { requiresSudo: true } : {}),
  });
  const steps: InstallStep[] = [
    ...install.steps.map(toStep),
    { id: PATH_STEP_ID, title: `Check that ${binDir} comes first on PATH in login and non-interactive shells` },
    { id: REPROBE_STEP_ID, title: `Re-probe ${recipe.displayName}, including its login state` },
    ...uninstall.steps.map((s) => ({ ...toStep(s), title: `Remove the old install: ${s.description}` })),
  ];
  const wire: WirePlan = {
    target: agent,
    action: 'install',
    method: toId,
    steps,
    notes: [
      `Switch ${recipe.displayName} from ${from.label} to ${to.label} on ${install.platformKey}`,
      `The old install (${fromPath}) is removed only when no session is using ${agent}; otherwise it is kept and the removal commands are shown.`,
      'Shell startup files are never edited: if PATH puts the old install first, the migration stops and says what to change.',
      ...install.warnings,
      ...uninstall.warnings.map((w) => `uninstall: ${w}`),
    ],
  };
  return {
    agent,
    displayName: recipe.displayName,
    fromMethod: fromId,
    fromLabel: from.label,
    toMethod: toId,
    toLabel: to.label,
    fromPath,
    binDir,
    binaries: recipe.detect.binaries,
    install,
    uninstall,
    wire,
  };
}

export interface ShellCheck {
  shell: 'login' | 'non-interactive';
  /** What `command -v <binary>` found. */
  found?: string;
  /** Where that resolves to behind symlinks and shims. */
  resolved?: string;
  ok: boolean;
}

export interface MigrationDeps extends MigrationEnv {
  run?: typeof runPlan;
  exec?: typeof execCapture;
  /** Login shell (default $SHELL, then /bin/sh). */
  shell?: string;
  /** Refresh the agent's probe (decorated); used for step 3 and after removal. */
  reprobe: () => Promise<AgentListing | undefined>;
  /** Sessions with a live process for this agent. */
  liveSessions: () => SessionInfo[];
  logger?: Logger;
  signal?: AbortSignal;
}

export interface MigrationResult {
  ok: boolean;
  message: string;
  /** The old install was kept (sessions still use it, or a check failed). */
  keptOld: boolean;
  checks?: ShellCheck[];
}

const BIN_MARK = '__BIZZI_BIN__';
const PATH_MARK = '__BIZZI_PATH__';

/** Step 2: which binary do a login shell and bizzi's own non-interactive PATH pick? */
export async function checkPathOrder(plan: MigrationPlan, deps: MigrationDeps): Promise<ShellCheck[]> {
  const exec = deps.exec ?? execCapture;
  const recipe = deps.recipes.require(plan.agent);
  const home = homeDir({ env: deps.env, ...(deps.home ? { home: deps.home } : {}) });
  const name = plan.binaries[0] as string;
  const isNew = (found: string, dirs: string[]): { resolved: string; ok: boolean } => {
    const r = resolveExecutable(found, { home, searchDirs: dirs, stopAt: (p) => methodForPaths(recipe, [p]) !== undefined });
    const method = methodForPaths(recipe, [r.realPath, ...r.chain.slice().reverse()]);
    return { resolved: r.realPath, ok: method?.id === plan.toMethod || dirname(found) === plan.binDir };
  };

  // Login shell, started the way launchd/systemd would: minimal env, profile files sourced.
  const shell = deps.shell ?? deps.env.SHELL ?? '/bin/sh';
  const loginEnv: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    SHELL: shell,
    TERM: 'dumb',
    ...(deps.env.USER ? { USER: deps.env.USER, LOGNAME: deps.env.USER } : {}),
  };
  const script = `printf '%s%s\\n' '${PATH_MARK}' "$PATH"; printf '%s%s\\n' '${BIN_MARK}' "$(command -v ${name} 2>/dev/null)"`;
  const r = await exec(shell, ['-l', '-c', script], { env: loginEnv, cwd: home, timeoutMs: 20_000 });
  const lines = r.stdout.split(/\r?\n/);
  const loginPath = lines.findLast((l) => l.startsWith(PATH_MARK))?.slice(PATH_MARK.length) ?? '';
  const loginFound = lines.findLast((l) => l.startsWith(BIN_MARK))?.slice(BIN_MARK.length).trim() || undefined;
  const login: ShellCheck = { shell: 'login', ok: false };
  if (loginFound?.startsWith('/')) {
    const v = isNew(loginFound, loginPath.split(delimiter).filter(Boolean));
    Object.assign(login, { found: loginFound, resolved: v.resolved, ok: v.ok });
  }

  // Non-interactive: the PATH bizzi itself gives agents (inherited + per-user dirs).
  const dirs = augmentedPath({ env: deps.env, home, platform: deps.platform }).split(delimiter).filter(Boolean);
  const found = findBinary(plan.binaries, dirs);
  const nonInteractive: ShellCheck = { shell: 'non-interactive', ok: false };
  if (found) {
    const v = isNew(found, dirs);
    Object.assign(nonInteractive, { found, resolved: v.resolved, ok: v.ok });
  }
  return [login, nonInteractive];
}

function pathInstructions(plan: MigrationPlan, checks: ShellCheck[]): string {
  const bad = checks.filter((c) => !c.ok);
  const what = bad
    .map((c) =>
      c.found
        ? `in ${c.shell} shells \`${plan.binaries[0]}\` resolves to ${c.found}${c.resolved && c.resolved !== c.found ? ` (${c.resolved})` : ''}`
        : `in ${c.shell} shells \`${plan.binaries[0]}\` is not found`,
    )
    .join('; ');
  const lines = [
    `${plan.binDir} must come first on PATH, but ${what}.`,
    'bizzi does not edit shell startup files. Add this line to your shell profile (~/.zprofile for zsh, ~/.bash_profile for bash, ~/.profile otherwise), then run the migration again:',
    `  export PATH="${plan.binDir}:$PATH"`,
  ];
  if (bad.some((c) => c.shell === 'non-interactive')) {
    lines.push(
      "bizzi's own PATH comes from the environment it was started with (terminal, launchd plist or systemd unit); restart bizzi from a shell with the new PATH, or set PATH in its service definition.",
    );
  }
  lines.push(`The new install is in place; the old ${plan.fromMethod} install (${plan.fromPath}) was not touched.`);
  return lines.join('\n');
}

type Emit = (p: Omit<InstallProgress, 'agent'>) => void;

/**
 * Run a migration job. Progress uses the protocol's `install.progress` stages; sub-plan `done`
 * events are folded into `phase` events so only the final event has `done: true`. Never throws.
 */
export async function runMigration(plan: MigrationPlan, deps: MigrationDeps, emitRaw: Emit, dryRun = false): Promise<MigrationResult> {
  const run = deps.run ?? runPlan;
  const total = plan.wire.steps.length;
  let step = 0;
  const emit = (p: Omit<InstallProgress, 'agent'>) => {
    if (p.stage === 'step') step++;
    emitRaw({ ...p, step, total });
  };
  const finish = (r: MigrationResult): MigrationResult => {
    emit({ stage: 'done', message: r.message, done: true, ok: r.ok });
    deps.logger?.log(r.ok ? 'info' : 'warn', 'migration finished', { agent: plan.agent, ok: r.ok, keptOld: r.keptOld, dryRun });
    return r;
  };
  const sub = (p: InstallProgress) => {
    if (p.stage === 'done') {
      emit({ stage: 'phase', ...(p.message !== undefined ? { message: p.message } : {}), ...(p.ok !== undefined ? { ok: p.ok } : {}) });
      return;
    }
    const { agent: _agent, ...rest } = p;
    emit(rest);
  };
  emit({
    stage: 'plan',
    message: `${dryRun ? '[dry-run] ' : ''}migrate ${plan.agent} from ${plan.fromLabel} to ${plan.toLabel}: ${total} step(s)`,
  });

  if (dryRun) {
    for (const s of plan.wire.steps) emit({ stage: 'step', message: `[${step + 1}/${total}] ${s.title}${s.command ? `\n$ ${s.command}` : ''}` });
    return finish({ ok: true, keptOld: true, message: `[dry-run] migrate ${plan.agent}: nothing was changed` });
  }

  // 1. Install with the preferred method.
  const installed = await run(plan.install, { onProgress: sub, env: deps.env, ...(deps.signal ? { signal: deps.signal } : {}), ...(deps.logger ? { logger: deps.logger } : {}) });
  if (!installed.ok) {
    return finish({ ok: false, keptOld: true, message: `installing with ${plan.toLabel} failed: ${installed.error ?? 'unknown error'}; the old install was not touched` });
  }

  // 2. PATH order.
  emit({ stage: 'step', message: `[${step + 1}/${total}] ${plan.wire.steps.find((s) => s.id === PATH_STEP_ID)?.title ?? 'Check PATH'}` });
  const checks = await checkPathOrder(plan, deps);
  for (const c of checks) {
    emit({ stage: 'output', message: `${c.shell}: ${c.found ?? 'not found'}${c.resolved && c.resolved !== c.found ? ` → ${c.resolved}` : ''} ${c.ok ? '(ok)' : '(old install first)'}` });
  }
  if (checks.some((c) => !c.ok)) return finish({ ok: false, keptOld: true, message: pathInstructions(plan, checks), checks });

  // 3. Re-probe, including login.
  emit({ stage: 'step', message: `[${step + 1}/${total}] ${plan.wire.steps.find((s) => s.id === REPROBE_STEP_ID)?.title ?? 'Re-probe'}` });
  const probed = await deps.reprobe().catch(() => undefined);
  if (!probed?.installed) {
    return finish({ ok: false, keptOld: true, message: `${plan.displayName} is not found after installing it with ${plan.toLabel}; the old install was kept`, checks });
  }
  emit({ stage: 'output', message: `${probed.path ?? '?'} ${probed.version ?? ''} via ${probed.method ?? 'unknown method'}, auth ${probed.auth}${probed.account ? ` (${probed.account})` : ''}` });
  if (probed.method !== plan.toMethod) {
    return finish({
      ok: false,
      keptOld: true,
      message: `bizzi still finds the ${probed.method ?? 'unknown'} install (${probed.realPath ?? probed.path}) first; the old install was kept`,
      checks,
    });
  }
  if (probed.auth === 'missing' || probed.auth === 'expired') {
    return finish({
      ok: false,
      keptOld: true,
      message: `${plan.displayName} now runs from ${plan.toLabel} but is not logged in (auth ${probed.auth}). Log in (agent.login) and run the migration again; the old install was kept.`,
      checks,
    });
  }

  // 4. Remove the old install once nothing uses it.
  const live = deps.liveSessions();
  if (live.length > 0) {
    const cmds = plan.uninstall.steps.map((s) => `  ${s.command}`).join('\n');
    return finish({
      ok: true,
      keptOld: true,
      message: `${plan.displayName} now runs from ${plan.toLabel}. The old ${plan.fromMethod} install was kept because ${live.length} session(s) still use ${plan.agent}; remove it once they end (agent.install with action uninstall and method ${plan.fromMethod}), or run:\n${cmds}`,
      checks,
    });
  }
  const removed = await run(plan.uninstall, { onProgress: sub, env: deps.env, ...(deps.signal ? { signal: deps.signal } : {}), ...(deps.logger ? { logger: deps.logger } : {}) });
  await deps.reprobe().catch(() => undefined);
  if (!removed.ok) {
    return finish({ ok: false, keptOld: true, message: `${plan.displayName} now runs from ${plan.toLabel}, but removing the old install failed: ${removed.error ?? 'unknown error'}`, checks });
  }
  return finish({ ok: true, keptOld: false, message: `${plan.displayName} now runs from ${plan.toLabel}; the old ${plan.fromMethod} install was removed`, checks });
}
