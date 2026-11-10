// What an existing install is (spec §7): its real path behind symlinks and shims, the recipe method
// that produced it, whether bizzi supports its version, and the remedies to offer. Pure apart from
// reading the file system (symlinks, shim scripts, Homebrew receipts).

import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { AgentRemedy, AgentSupport } from '@bizzi/protocol';
import { homeDir, toolsDir } from './path.ts';
import { currentPlatform, methodSupports, platformKey, resolveRecipePlatform } from './platform.ts';
import { resolveExecutable } from './shim.ts';
import { brewBinFor, renderPath, type TemplateVars } from './template.ts';
import type { MethodSpec, Platform, Recipe } from './types.ts';
import { assessSupport } from './versions.ts';

/** Template vars describing an adopted install (see template.ts ENGINE_VARS). */
export interface InstallFacts {
  /** Homebrew formula the binary came from: `opencode` (core) or `anomalyco/tap/opencode-v2`. */
  brewFormula?: string;
  brewCask?: string;
  /** npm global prefix the package lives under (the dir containing `lib/node_modules`). */
  npmPrefix?: string;
}

export interface InstallAssessment {
  realPath?: string;
  /** The binary was reached through a wrapper shim. */
  viaShim?: boolean;
  /** Recipe method whose pathHints match. */
  method?: string;
  /** First method of the recipe for this platform. */
  preferredMethod?: string;
  /** The detected method updates itself (e.g. Claude's native installer). */
  selfUpdates?: boolean;
  support?: AgentSupport;
  supportReason?: string;
  remedies?: AgentRemedy[];
  facts: InstallFacts;
  /** Absolute paths that change when this install updates (updates.md §2). */
  watch: string[];
  notes: string[];
}

export interface AssessOptions {
  platform?: Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** PATH-order dirs for shims that re-exec the next binary on PATH. */
  searchDirs?: string[];
}

/** The recipe's preferred method on this platform: the first one whose platform filter matches. */
export function preferredMethod(recipe: Recipe, platform: Platform = currentPlatform()): MethodSpec | undefined {
  const plat = resolveRecipePlatform(recipe, platform);
  if (!plat) return undefined;
  return recipe.methods.find((m) => methodSupports(m.platforms, plat.key));
}

/** Recipe method whose pathHints match any of the paths (checked in order). */
export function methodForPaths(recipe: Recipe, paths: readonly string[]): MethodSpec | undefined {
  for (const p of paths) {
    const m = recipe.methods.find((x) => x.pathHints?.some((h) => p.includes(h)));
    if (m) return m;
  }
  return undefined;
}

/**
 * Homebrew formula / cask and npm prefix from an install's real path. Formulae come from
 * `…/Cellar/<formula>/<version>/…`; the receipt's `source.tap` tells core (`opencode`) from a tap
 * (`anomalyco/tap/opencode-v2`). Casks from `…/Caskroom/<cask>/<version>/…`.
 */
export function installFacts(realPath: string): InstallFacts {
  const facts: InstallFacts = {};
  const parts = realPath.split(sep);
  const cellar = parts.lastIndexOf('Cellar');
  if (cellar >= 0 && parts[cellar + 1]) {
    const formula = parts[cellar + 1] as string;
    const version = parts[cellar + 2];
    let full = formula;
    if (version) {
      const receipt = join(parts.slice(0, cellar + 3).join(sep) || sep, 'INSTALL_RECEIPT.json');
      try {
        const tap = (JSON.parse(readFileSync(receipt, 'utf8')) as { source?: { tap?: unknown } }).source?.tap;
        if (typeof tap === 'string' && tap && tap !== 'homebrew/core') full = `${tap}/${formula}`;
      } catch {
        /* no receipt: assume homebrew/core */
      }
    }
    facts.brewFormula = full;
  }
  const caskroom = parts.lastIndexOf('Caskroom');
  if (caskroom >= 0 && parts[caskroom + 1]) facts.brewCask = parts[caskroom + 1] as string;
  const nm = realPath.indexOf(`${sep}lib${sep}node_modules${sep}`);
  if (nm > 0) facts.npmPrefix = realPath.slice(0, nm);
  return facts;
}

/** Directories / files to watch for this install (method `watch` paths plus package dirs). */
export function watchPaths(method: MethodSpec | undefined, realPath: string | undefined, vars: TemplateVars): string[] {
  const out: string[] = [];
  for (const w of method?.watch ?? []) {
    try {
      out.push(renderPath(w, vars));
    } catch {
      /* a var without value on this platform */
    }
  }
  if (realPath) {
    const parts = realPath.split(sep);
    for (const anchor of ['Cellar', 'Caskroom']) {
      const i = parts.lastIndexOf(anchor);
      // …/Cellar/<name>: version dirs appear and disappear there on upgrade.
      if (i >= 0 && parts[i + 1]) out.push(parts.slice(0, i + 2).join(sep));
    }
    const nm = realPath.indexOf(`${sep}lib${sep}node_modules${sep}`);
    if (nm > 0) {
      const rest = realPath.slice(nm + `${sep}lib${sep}node_modules${sep}`.length).split(sep);
      const pkg = rest[0]?.startsWith('@') ? rest.slice(0, 2) : rest.slice(0, 1);
      out.push(join(realPath.slice(0, nm), 'lib', 'node_modules', ...pkg));
    }
  }
  return [...new Set(out)];
}

/**
 * Assess an install found by a probe: real path, method, support, remedies, facts and watch paths.
 * `path` undefined (not installed) still reports the preferred method. Never throws.
 */
export function assessInstall(
  recipe: Recipe,
  found: { path?: string; version?: string },
  opts: AssessOptions = {},
): InstallAssessment {
  const platform = opts.platform ?? currentPlatform();
  const env = opts.env ?? process.env;
  const home = homeDir({ env, ...(opts.home ? { home: opts.home } : {}) });
  const out: InstallAssessment = { facts: {}, watch: [], notes: [] };
  const preferred = preferredMethod(recipe, platform);
  if (preferred) out.preferredMethod = preferred.id;
  const vars: TemplateVars = {
    home,
    toolsDir: toolsDir({ env, home }),
    name: recipe.name,
    os: platform.os,
    arch: platform.arch,
    libc: platform.libc ?? '',
    platform: platformKey(platform),
    brewBin: brewBinFor(platform.os, platform.arch),
    ...(resolveRecipePlatform(recipe, platform)?.spec.vars ?? {}),
  };
  if (!found.path) {
    out.watch = recipe.methods.flatMap((m) => watchPaths(m, undefined, vars));
    out.watch = [...new Set(out.watch)];
    return out;
  }

  const hinted = (p: string) => recipe.methods.some((m) => m.pathHints?.some((h) => p.includes(h)));
  const resolved = resolveExecutable(found.path, { home, stopAt: hinted, ...(opts.searchDirs ? { searchDirs: opts.searchDirs } : {}) });
  out.realPath = resolved.realPath;
  if (resolved.viaShim) {
    out.viaShim = true;
    out.notes.push(`${found.path} is a wrapper; it runs ${resolved.realPath}`);
  }
  if (resolved.unresolved) out.notes.push(`could not tell which binary the wrapper ${resolved.realPath} runs`);
  const method = methodForPaths(recipe, [resolved.realPath, ...resolved.chain.slice().reverse(), found.path]);
  if (method) {
    out.method = method.id;
    if (method.selfUpdates) out.selfUpdates = true;
  }
  out.facts = installFacts(resolved.realPath);
  out.watch = watchPaths(method, resolved.realPath, vars);

  const remedies: AgentRemedy[] = [];
  const verdict = assessSupport(recipe, found.version);
  if (verdict) {
    out.support = verdict.support;
    if (verdict.reason) out.supportReason = verdict.reason;
    remedies.push(...(verdict.remedies ?? []));
  }
  const migrate = recipe.support?.migrate;
  if (migrate && method && preferred && method.id !== preferred.id && migrate.from.includes(method.id)) {
    remedies.push({ kind: 'migrate', title: migrate.title, method: preferred.id });
    if (migrate.reason) out.notes.push(migrate.reason);
  }
  if (remedies.length) out.remedies = remedies;
  return out;
}

/** The directory a method installs its binary into, rendered for this platform. */
export function methodBinDir(recipe: Recipe, method: MethodSpec, opts: { platform?: Platform; env?: NodeJS.ProcessEnv; home?: string } = {}): string | undefined {
  const platform = opts.platform ?? currentPlatform();
  const home = homeDir({ env: opts.env ?? process.env, ...(opts.home ? { home: opts.home } : {}) });
  try {
    return renderPath(method.binDir ?? method.targetDir, {
      home,
      toolsDir: toolsDir({ env: opts.env ?? process.env, home }),
      name: recipe.name,
      os: platform.os,
      arch: platform.arch,
      libc: platform.libc ?? '',
      platform: platformKey(platform),
      brewBin: brewBinFor(platform.os, platform.arch),
      ...(resolveRecipePlatform(recipe, platform)?.spec.vars ?? {}),
    });
  } catch {
    return undefined;
  }
}
