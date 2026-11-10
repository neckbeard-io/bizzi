import { readFileSync, statSync } from 'node:fs';
import { delimiter, dirname } from 'node:path';
import type { AgentAuthState, AgentKind, AgentProbe, AgentRemedy, AgentSupport, Logger } from '@bizzi/protocol';
import { assessInstall, methodForPaths, type InstallFacts } from './install.ts';
import { execCapture, type ExecResult } from './exec.ts';
import { compareVersions, dig, type FetchFn, latestVersion } from './latest.ts';
import { augmentedEnv, findBinaries, homeDir, isExecutable, resolveNpmPrefix, toolsDir as defaultToolsDir } from './path.ts';

const MAX_CANDIDATES = 4;
import { currentPlatform, platformKey, resolveRecipePlatform } from './platform.ts';
import { defaultRecipes, type RecipeSet } from './recipes.ts';
import { brewBinFor, renderPath, type TemplateVars } from './template.ts';
import type { AuthCommand, AuthSpec, Platform, Recipe } from './types.ts';

export interface ProbeOptions {
  home?: string;
  toolsDir?: string;
  /** npm global prefix; undefined = resolve (env, then `npm prefix -g`), null = skip. */
  npmPrefix?: string | null;
  platform?: Platform;
  recipes?: RecipeSet;
  /** Version command timeout (default: recipe value or 5 s). */
  timeoutMs?: number;
  /** Auth status command timeout (default: recipe value or 10 s). */
  authTimeoutMs?: number;
  /** Latest version: true = fetch (cached), 'cached' = cache only (default), false = skip. */
  latest?: boolean | 'cached';
  fetch?: FetchFn;
  /** Run the recipe's auth status command (default true). */
  auth?: boolean;
  /** Also run auth commands that aren't marked side-effect free (default false). */
  allowSideEffectAuth?: boolean;
  logger?: Logger;
}

export interface ToolProbe {
  name: string;
  installed: boolean;
  path?: string;
  realPath?: string;
  version?: string;
  latestVersion?: string;
  updateAvailable?: boolean;
  /** Install method guessed from the binary's real location (recipe method id). */
  method?: string;
  /** The recipe's first method on this platform. */
  preferredMethod?: string;
  /** The detected method updates itself. */
  selfUpdates?: boolean;
  support?: AgentSupport;
  supportReason?: string;
  remedies?: AgentRemedy[];
  /** Homebrew formula / cask, npm prefix of the install (for update/uninstall plans). */
  facts?: InstallFacts;
  /** Paths that change when the install updates. */
  watch?: string[];
  /** Found via the process's own PATH (false: only via bizzi's augmented PATH / search paths). */
  onInheritedPath?: boolean;
  auth: AgentAuthState;
  account?: string;
  notes: string[];
}

/** Probe an agent. Never throws. */
export async function probe(agent: AgentKind, env: NodeJS.ProcessEnv = process.env, opts: ProbeOptions = {}): Promise<AgentProbe> {
  if (agent === 'shell') return probeShell(env);
  const t = await probeTool(agent, env, opts);
  const out: AgentProbe = { agent, installed: t.installed, auth: t.auth };
  if (t.path) out.path = t.path;
  if (t.version) out.version = t.version;
  if (t.latestVersion) out.latestVersion = t.latestVersion;
  if (t.account) out.account = t.account;
  if (t.realPath) out.realPath = t.realPath;
  if (t.method) out.method = t.method;
  if (t.preferredMethod) out.preferredMethod = t.preferredMethod;
  if (t.updateAvailable) out.updateAvailable = true;
  if (t.installed && t.onInheritedPath !== undefined) out.onPath = t.onInheritedPath;
  if (t.support) out.support = t.support;
  if (t.supportReason) out.supportReason = t.supportReason;
  if (t.remedies?.length) out.remedies = t.remedies;
  if (t.notes.length) out.notes = t.notes;
  return out;
}

/** Probe every agent kind (in parallel). */
export async function probeAll(env: NodeJS.ProcessEnv = process.env, opts: ProbeOptions = {}): Promise<AgentProbe[]> {
  const kinds: AgentKind[] = ['claude', 'codex', 'opencode', 'agy', 'shell'];
  return Promise.all(kinds.map((k) => probe(k, env, opts)));
}

function probeShell(env: NodeJS.ProcessEnv): AgentProbe {
  const candidates = [env.SHELL, '/bin/bash', '/bin/zsh', '/bin/sh'].filter((s): s is string => !!s);
  const path = candidates.find(isExecutable);
  return path ? { agent: 'shell', installed: true, path, auth: 'ok' } : { agent: 'shell', installed: false, auth: 'unknown' };
}

/** Probe any recipe (agent or tool). Never throws. */
export async function probeTool(name: string, env: NodeJS.ProcessEnv = process.env, opts: ProbeOptions = {}): Promise<ToolProbe> {
  try {
    const recipe = (opts.recipes ?? defaultRecipes()).get(name);
    if (!recipe) return { name, installed: false, auth: 'unknown', notes: [`no recipe for "${name}"`] };
    return await probeRecipe(recipe, env, opts);
  } catch (e) {
    opts.logger?.log('warn', 'probe failed', { name, error: String(e) });
    return { name, installed: false, auth: 'unknown', notes: [`probe failed: ${(e as Error).message}`] };
  }
}

async function probeRecipe(recipe: Recipe, env: NodeJS.ProcessEnv, opts: ProbeOptions): Promise<ToolProbe> {
  const platform = opts.platform ?? currentPlatform();
  const home = homeDir({ env, ...(opts.home ? { home: opts.home } : {}) });
  const tools = defaultToolsDir({ env, home, ...(opts.toolsDir ? { toolsDir: opts.toolsDir } : {}) });
  const npmPrefix = opts.npmPrefix !== undefined ? opts.npmPrefix : await resolveNpmPrefix(env).catch(() => undefined);
  const pathEnv = augmentedEnv({ env, home, toolsDir: tools, npmPrefix: npmPrefix ?? null, platform });
  const vars: TemplateVars = {
    home,
    toolsDir: tools,
    name: recipe.name,
    os: platform.os,
    arch: platform.arch,
    libc: platform.libc ?? '',
    platform: platformKey(platform),
    brewBin: brewBinFor(platform.os, platform.arch),
    ...(resolveRecipePlatform(recipe, platform)?.spec.vars ?? {}),
  };
  const searchDirs = [
    ...(pathEnv.PATH ?? '').split(delimiter).filter(Boolean),
    ...(recipe.detect.searchPaths ?? []).map((p) => safeRenderPath(p, vars)).filter((p): p is string => !!p),
  ];

  const result: ToolProbe = { name: recipe.name, installed: false, auth: 'unknown', notes: [] };
  if (!resolveRecipePlatform(recipe, platform)) result.notes.push(`no recipe support for ${platformKey(platform)}`);

  const latestP = latestFor(recipe.name, platform, opts);

  // Try candidates in PATH order until one runs: wrappers and shims (terminal integrations,
  // stale symlinks) can shadow the real binary or exist without it.
  let bin: string | undefined;
  const broken: string[] = [];
  for (const candidate of findBinaries(recipe.detect.binaries, searchDirs).slice(0, MAX_CANDIDATES)) {
    const vr = await execCapture(candidate, recipe.detect.version.args, {
      env: pathEnv,
      timeoutMs: opts.timeoutMs ?? recipe.detect.version.timeoutMs ?? 5000,
    });
    const version = parseVersion(vr, recipe.detect.version.regex);
    if (version) {
      bin = candidate;
      result.version = version;
      break;
    }
    if (vr.code === 0 && !bin) {
      // Runs, but the version output didn't match: keep looking, fall back to this one.
      bin = candidate;
      result.notes.push(`could not parse the version printed by ${candidate}`);
      continue;
    }
    broken.push(`${candidate} (${versionFailure(vr)})`);
  }
  if (broken.length) result.notes.push(`skipped binaries that failed to run: ${broken.join('; ')}`);

  if (bin) {
    result.installed = true;
    result.path = bin;
    const inherited = new Set((env.PATH ?? '').split(delimiter).filter(Boolean));
    result.onInheritedPath = inherited.has(dirname(bin));
    if (!result.onInheritedPath) {
      result.notes.push(`found at ${bin}, outside this process's PATH; bizzi adds ${dirname(bin)} when it starts agents`);
    }
  }
  const assessment = assessInstall(recipe, { ...(bin ? { path: bin } : {}), ...(result.version ? { version: result.version } : {}) }, {
    platform,
    env,
    home,
    searchDirs,
  });
  if (assessment.realPath) result.realPath = assessment.realPath;
  if (assessment.method) result.method = assessment.method;
  if (assessment.preferredMethod) result.preferredMethod = assessment.preferredMethod;
  if (assessment.selfUpdates) result.selfUpdates = true;
  if (bin && assessment.support) result.support = assessment.support;
  if (bin && assessment.supportReason) result.supportReason = assessment.supportReason;
  if (bin && assessment.remedies) result.remedies = assessment.remedies;
  if (Object.keys(assessment.facts).length) result.facts = assessment.facts;
  if (assessment.watch.length) result.watch = assessment.watch;
  result.notes.push(...assessment.notes);

  if (recipe.auth) {
    const a = await probeAuth(recipe.auth, bin, recipe, pathEnv, vars, opts);
    result.auth = a.state;
    if (a.account) result.account = a.account;
    if (a.note) result.notes.push(a.note);
  } else {
    result.auth = 'ok';
  }

  const latest = await latestP;
  if (latest) {
    result.latestVersion = latest;
    if (result.version && compareVersions(result.version, latest) < 0) {
      result.updateAvailable = true;
      result.notes.push(`update available: ${result.version} → ${latest}`);
    }
  }
  return result;
}

function latestFor(name: string, platform: Platform, opts: ProbeOptions): Promise<string | undefined> {
  const mode = opts.latest ?? 'cached';
  if (mode === false) return Promise.resolve(undefined);
  return latestVersion(name, {
    platform,
    ...(opts.recipes ? { recipes: opts.recipes } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
    cacheOnly: mode === 'cached',
  });
}

function safeRenderPath(p: string, vars: TemplateVars): string | undefined {
  try {
    return renderPath(p, vars);
  } catch {
    return undefined;
  }
}

/** Recipe method whose pathHints match the binary's real path. */
export function guessMethod(recipe: Recipe, realPath: string): string | undefined {
  return methodForPaths(recipe, [realPath])?.id;
}

export function parseVersion(r: Pick<ExecResult, 'stdout' | 'stderr'>, regex: string): string | undefined {
  const m = new RegExp(regex, 'm').exec(`${r.stdout}\n${r.stderr}`);
  if (!m) return undefined;
  return (m[1] ?? m[0]).replace(/^v/, '');
}

function versionFailure(r: ExecResult): string {
  if (r.timedOut) return 'version command timed out';
  if (r.error) return `failed to start: ${r.error}`;
  return `exit ${r.code ?? r.signal}`;
}

interface AuthResult {
  state: AgentAuthState;
  account?: string;
  note?: string;
}

async function probeAuth(
  spec: AuthSpec,
  bin: string | undefined,
  recipe: Recipe,
  env: NodeJS.ProcessEnv,
  vars: TemplateVars,
  opts: ProbeOptions,
): Promise<AuthResult> {
  const cmd = spec.command;
  let note: string | undefined;
  if (cmd && bin && opts.auth !== false && (cmd.sideEffectFree || opts.allowSideEffectAuth)) {
    const [first, ...rest] = cmd.argv;
    const file = first && recipe.detect.binaries.includes(first) ? bin : (first ?? bin);
    const r = await execCapture(file, rest, { env, timeoutMs: opts.authTimeoutMs ?? cmd.timeoutMs ?? 10_000 });
    const verdict = evaluateAuthCommand(cmd, r);
    if (verdict) return verdict;
    note = r.timedOut ? 'auth status command timed out' : `auth status inconclusive (exit ${r.code})`;
  }
  const rule = evaluateAuthRules(spec, env, vars);
  if (rule) return { ...rule, ...(note ? { note } : {}) };
  return { state: spec.absent, ...(note ? { note } : {}) };
}

/** Interpret an auth status command's result. Undefined when inconclusive. */
export function evaluateAuthCommand(cmd: AuthCommand, r: ExecResult): AuthResult | undefined {
  if (r.timedOut || r.error || r.aborted) return undefined;
  const text = `${r.stdout}\n${r.stderr}`;
  let account: string | undefined;
  if (cmd.accountRegex) {
    const m = new RegExp(cmd.accountRegex, 'm').exec(text);
    if (m) account = (m[1] ?? m[0]).trim();
  }
  const withAccount = (state: AgentAuthState): AuthResult => (account ? { state, account } : { state });

  if (cmd.expiredRegex && new RegExp(cmd.expiredRegex, 'im').test(text)) return withAccount('expired');

  if (cmd.format === 'json') {
    const data = parseJsonLoose(r.stdout);
    if (data !== undefined) {
      if (cmd.accountField) {
        const a = dig(data, cmd.accountField);
        if (typeof a === 'string' && a) account = a;
      }
      if (!account && cmd.methodField) {
        const m = dig(data, cmd.methodField);
        if (typeof m === 'string' && m && m !== 'none') account = m;
      }
      if (cmd.loggedInField) {
        const v = dig(data, cmd.loggedInField);
        if (v === true) return withAccount('ok');
        if (v === false) return withAccount('missing');
      }
      if (cmd.nonEmptyMeansOk) {
        const nonEmpty = Array.isArray(data) ? data.length > 0 : typeof data === 'object' && data !== null && Object.keys(data).length > 0;
        return withAccount(nonEmpty ? 'ok' : 'missing');
      }
    }
  }
  if (cmd.missingRegex && new RegExp(cmd.missingRegex, 'im').test(text)) return withAccount('missing');
  if (cmd.okRegex && new RegExp(cmd.okRegex, 'im').test(text)) return withAccount('ok');
  if (r.code !== null && cmd.okExitCodes?.includes(r.code)) return withAccount('ok');
  if (r.code !== null && cmd.missingExitCodes?.includes(r.code)) return withAccount('missing');
  return undefined;
}

function parseJsonLoose(s: string): unknown {
  const start = s.search(/[{[]/);
  if (start < 0) return undefined;
  try {
    return JSON.parse(s.slice(start));
  } catch {
    return undefined;
  }
}

/** First matching heuristic rule → ok. */
export function evaluateAuthRules(spec: AuthSpec, env: NodeJS.ProcessEnv, vars: TemplateVars): AuthResult | undefined {
  for (const rule of spec.rules ?? []) {
    if (rule.env && !rule.env.every((k) => !!env[k])) continue;
    if (rule.file) {
      const path = safeRenderPath(rule.file, vars);
      if (!path || !nonEmptyFile(path)) continue;
      if (rule.jsonField !== undefined) {
        try {
          const v = dig(JSON.parse(readFileSync(path, 'utf8')), rule.jsonField);
          if (String(v) !== rule.equals) continue;
        } catch {
          continue;
        }
      }
    }
    return rule.account ? { state: 'ok', account: rule.account } : { state: 'ok' };
  }
  return undefined;
}

function nonEmptyFile(p: string): boolean {
  try {
    const s = statSync(p);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}
