// PATH handling for non-interactive environments. launchd, systemd and container entrypoints don't
// source the login shell, so binaries installed per-user (~/.local/bin, Homebrew, npm globals,
// bizzi's tool dir) are often missing from PATH. Everything here augments, never replaces.

import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { execCapture } from './exec.ts';
import type { Platform } from './types.ts';

export interface PathContext {
  env?: NodeJS.ProcessEnv;
  /** Defaults to env.HOME, then os.homedir(). */
  home?: string;
  /** Defaults to env.BIZZI_TOOLS_DIR, then `<home>/.bizzi/tools`. */
  toolsDir?: string;
  /** npm global prefix; its `bin` is added. `null` skips it. */
  npmPrefix?: string | null;
  platform?: Platform;
  /** Prepended before everything else (e.g. a freshly installed tool). */
  prepend?: string[];
}

export function homeDir(ctx: { env?: NodeJS.ProcessEnv; home?: string } = {}): string {
  return ctx.home ?? ctx.env?.HOME ?? process.env.HOME ?? homedir();
}

export function toolsDir(ctx: { env?: NodeJS.ProcessEnv; home?: string; toolsDir?: string } = {}): string {
  return ctx.toolsDir ?? ctx.env?.BIZZI_TOOLS_DIR ?? join(homeDir(ctx), '.bizzi', 'tools');
}

/** `<toolsDir>/<name>/bin` for every managed tool that has one. */
export function toolBinDirs(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((e) => !e.startsWith('.'))
    .sort()
    .map((e) => join(dir, e, 'bin'))
    .filter(isDir);
}

/** The extra directories, in order, without the inherited PATH. */
export function extraPathDirs(ctx: PathContext = {}): string[] {
  const env = ctx.env ?? process.env;
  const home = homeDir({ env, ...(ctx.home ? { home: ctx.home } : {}) });
  const os = ctx.platform?.os ?? process.platform;
  const dirs = [join(home, '.local', 'bin')];
  if (os === 'darwin') dirs.push('/opt/homebrew/bin', '/opt/homebrew/sbin');
  if (os === 'linux') dirs.push('/home/linuxbrew/.linuxbrew/bin');
  dirs.push('/usr/local/bin');
  const prefix = ctx.npmPrefix === undefined ? npmPrefixFromEnv(env) : ctx.npmPrefix;
  if (prefix) dirs.push(join(prefix, 'bin'));
  dirs.push(...toolBinDirs(toolsDir({ env, home, ...(ctx.toolsDir ? { toolsDir: ctx.toolsDir } : {}) })));
  return dirs;
}

/** prepend + inherited PATH + extras (deduplicated; inherited order wins). */
export function augmentedPath(ctx: PathContext = {}): string {
  const env = ctx.env ?? process.env;
  const inherited = (env.PATH ?? '').split(delimiter).filter(Boolean);
  const base = inherited.length ? inherited : ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  return dedupe([...(ctx.prepend ?? []), ...base, ...extraPathDirs(ctx)]).join(delimiter);
}

/** A copy of env with PATH augmented. */
export function augmentedEnv(ctx: PathContext = {}): NodeJS.ProcessEnv {
  const env = ctx.env ?? process.env;
  return { ...env, PATH: augmentedPath(ctx) };
}

export function npmPrefixFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  return env.NPM_CONFIG_PREFIX || env.npm_config_prefix || undefined;
}

let npmPrefixCache: Promise<string | undefined> | undefined;

/**
 * npm's global prefix: from the environment, else `npm prefix -g` (found via the augmented PATH,
 * 5 s timeout, cached for the process). Undefined when npm isn't available.
 */
export function resolveNpmPrefix(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const fromEnv = npmPrefixFromEnv(env);
  if (fromEnv) return Promise.resolve(fromEnv);
  npmPrefixCache ??= (async () => {
    const pathEnv = augmentedEnv({ env, npmPrefix: null });
    const npm = findExecutable('npm', (pathEnv.PATH ?? '').split(delimiter));
    if (!npm) return undefined;
    const r = await execCapture(npm, ['prefix', '-g'], { env: pathEnv, timeoutMs: 5000 });
    const out = r.stdout.trim();
    return r.code === 0 && out ? out : undefined;
  })();
  return npmPrefixCache;
}

export function resetNpmPrefixCache(): void {
  npmPrefixCache = undefined;
}

export function isExecutable(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function findExecutable(name: string, dirs: string[]): string | undefined {
  for (const d of dirs) {
    const candidate = join(d, name);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

/** First match for any of `names` (in order) across `dirs`. */
export function findBinary(names: string[], dirs: string[]): string | undefined {
  return findBinaries(names, dirs)[0];
}

/** Every match, in PATH order per name (deduplicated by path). */
export function findBinaries(names: string[], dirs: string[]): string[] {
  const out: string[] = [];
  for (const n of names) {
    for (const d of dirs) {
      const candidate = join(d, n);
      if (!out.includes(candidate) && isExecutable(candidate)) out.push(candidate);
    }
  }
  return out;
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}
