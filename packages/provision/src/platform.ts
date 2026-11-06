import { existsSync } from 'node:fs';
import { arch as osArch, platform as osPlatform } from 'node:os';
import { filterMatches } from './schema.ts';
import type { ArchName, OsName, Platform, PlatformSpec, Recipe } from './types.ts';

let cached: Platform | undefined;

/** The platform this process runs on (libc detected on Linux). */
export function currentPlatform(): Platform {
  if (cached) return cached;
  const os = toOs(osPlatform());
  const arch = toArch(osArch());
  cached = os === 'linux' ? { os, arch, libc: detectLibc() } : { os, arch };
  return cached;
}

function toOs(p: string): OsName {
  if (p === 'darwin' || p === 'linux') return p;
  // Recipes only cover darwin/linux; other OSes simply match no recipe platform.
  return p as OsName;
}

function toArch(a: string): ArchName {
  if (a === 'arm64' || a === 'aarch64') return 'arm64';
  if (a === 'x64' || a === 'x86_64' || a === 'amd64') return 'x64';
  return a as ArchName;
}

function detectLibc(): 'glibc' | 'musl' {
  const report = (process.report?.getReport?.() ?? {}) as { header?: { glibcVersionRuntime?: string } };
  if (report.header?.glibcVersionRuntime) return 'glibc';
  for (const f of ['/lib/ld-musl-x86_64.so.1', '/lib/ld-musl-aarch64.so.1', '/lib/libc.musl-x86_64.so.1', '/lib/libc.musl-aarch64.so.1']) {
    if (existsSync(f)) return 'musl';
  }
  return 'glibc';
}

/** `darwin-arm64`, `linux-x64`, `linux-arm64-musl`. */
export function platformKey(p: Platform): string {
  return `${p.os}-${p.arch}${p.os === 'linux' && p.libc === 'musl' ? '-musl' : ''}`;
}

export function parsePlatform(key: string): Platform {
  const m = /^(darwin|linux)-(arm64|x64)(-musl)?$/.exec(key);
  if (!m) throw new Error(`invalid platform "${key}"`);
  const os = m[1] as OsName;
  const arch = m[2] as ArchName;
  return os === 'linux' ? { os, arch, libc: m[3] ? 'musl' : 'glibc' } : { os, arch };
}

/**
 * The recipe's platform entry for `p`: the exact key, or, on musl systems, the plain `os-arch` key
 * when the recipe declares no `-musl` keys at all (its Linux builds are static or libc-agnostic).
 * A recipe that lists some `-musl` keys supports exactly those. Undefined when unsupported.
 */
export function resolveRecipePlatform(recipe: Recipe, p: Platform): { key: string; spec: PlatformSpec } | undefined {
  const exact = platformKey(p);
  const spec = recipe.platforms[exact];
  if (spec) return { key: exact, spec };
  const base = `${p.os}-${p.arch}`;
  const declaresMusl = Object.keys(recipe.platforms).some((k) => k.endsWith('-musl'));
  const baseSpec = recipe.platforms[base];
  if (baseSpec && base !== exact && !declaresMusl) return { key: base, spec: baseSpec };
  return undefined;
}

export function methodSupports(filters: string[] | undefined, key: string): boolean {
  return !filters || filters.some((f) => filterMatches(f, key));
}
