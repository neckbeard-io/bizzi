import type { Logger } from '@bizzi/protocol';
import { currentPlatform, platformKey, resolveRecipePlatform } from './platform.ts';
import { defaultRecipes, type RecipeSet } from './recipes.ts';
import { brewBinFor, render } from './template.ts';
import { compareVersions } from './versions.ts';

export { compareVersions };
import type { LatestSource, Platform, Recipe } from './types.ts';

export type FetchFn = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface LatestOptions {
  platform?: Platform;
  recipes?: RecipeSet;
  /** Injected for tests; defaults to global fetch. */
  fetch?: FetchFn;
  /** Cache lifetime (default 1 h). Failures are cached for a tenth of it. */
  ttlMs?: number;
  /** Ignore the cache. */
  force?: boolean;
  /** Only answer from the cache; never hit the network. */
  cacheOnly?: boolean;
  /** Per request (default 8 s). */
  timeoutMs?: number;
  logger?: Logger;
}

interface CacheEntry {
  version: string | undefined;
  at: number;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<string | undefined>>();
const DEFAULT_TTL = 60 * 60 * 1000;

export function clearLatestVersionCache(): void {
  cache.clear();
  inflight.clear();
}

/**
 * Latest published version of a recipe's agent/tool, trying each `latest` source in order.
 * Cached per recipe + platform. Never throws; undefined when every source failed.
 */
export async function latestVersion(name: string, opts: LatestOptions = {}): Promise<string | undefined> {
  const recipe = (opts.recipes ?? defaultRecipes()).get(name);
  if (!recipe) return undefined;
  const platform = opts.platform ?? currentPlatform();
  const key = `${name}@${platformKey(platform)}`;
  const ttl = opts.ttlMs ?? DEFAULT_TTL;
  const hit = cache.get(key);
  if (hit && !opts.force) {
    const age = Date.now() - hit.at;
    if (age < (hit.version === undefined ? ttl / 10 : ttl)) return hit.version;
  }
  if (opts.cacheOnly) return hit?.version;
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = resolveLatest(recipe, platform, opts)
    .catch(() => undefined)
    .then((version) => {
      cache.set(key, { version, at: Date.now() });
      inflight.delete(key);
      return version;
    });
  inflight.set(key, p);
  return p;
}

async function resolveLatest(recipe: Recipe, platform: Platform, opts: LatestOptions): Promise<string | undefined> {
  const vars: Record<string, string> = {
    name: recipe.name,
    os: platform.os,
    arch: platform.arch,
    platform: platformKey(platform),
    brewBin: brewBinFor(platform.os, platform.arch),
    ...(resolveRecipePlatform(recipe, platform)?.spec.vars ?? {}),
  };
  for (const src of recipe.latest) {
    try {
      const v = await fromSource(src, vars, opts);
      if (v) return v;
    } catch (e) {
      opts.logger?.log('debug', 'latest version source failed', { recipe: recipe.name, source: src.type, error: String(e) });
    }
  }
  return undefined;
}

async function get(url: string, opts: LatestOptions, accept: string): Promise<string> {
  const f: FetchFn = opts.fetch ?? (globalThis.fetch as unknown as FetchFn);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8000);
  try {
    const res = await f(url, { headers: { accept, 'user-agent': 'bizzi-provision' }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

const VERSION_RE = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/;

function cleanVersion(raw: string, regex?: string): string | undefined {
  const m = new RegExp(regex ?? VERSION_RE.source).exec(raw.trim());
  if (!m) return undefined;
  return (m[1] ?? m[0]).replace(/^v/, '');
}

async function fromSource(src: LatestSource, vars: Record<string, string>, opts: LatestOptions): Promise<string | undefined> {
  switch (src.type) {
    case 'npm': {
      const registry = (src.registry ?? 'https://registry.npmjs.org').replace(/\/$/, '');
      const body = await get(`${registry}/${src.package.replace('/', '%2f')}/${src.distTag ?? 'latest'}`, opts, 'application/json');
      const v = (JSON.parse(body) as { version?: unknown }).version;
      return typeof v === 'string' ? cleanVersion(v) : undefined;
    }
    case 'github': {
      const body = await get(`https://api.github.com/repos/${src.repo}/releases/latest`, opts, 'application/vnd.github+json');
      const tag = (JSON.parse(body) as { tag_name?: unknown }).tag_name;
      if (typeof tag !== 'string') return undefined;
      const stripped = src.tagPrefix && tag.startsWith(src.tagPrefix) ? tag.slice(src.tagPrefix.length) : tag;
      return cleanVersion(stripped);
    }
    case 'url': {
      const body = await get(render(src.url, vars), opts, src.format === 'json' ? 'application/json' : 'text/plain');
      let value: unknown = body;
      if (src.format === 'json') {
        value = JSON.parse(body);
        if (src.jsonPath) value = dig(value, src.jsonPath);
      }
      if (typeof value !== 'string') return undefined;
      return cleanVersion(value, src.regex);
    }
    case 'node-dist': {
      const body = await get(src.url ?? 'https://nodejs.org/dist/index.json', opts, 'application/json');
      const list = JSON.parse(body) as { version: string; lts: string | false }[];
      const pick = list.find((r) => (src.lts ? r.lts !== false : !r.version.includes('-')));
      return pick ? cleanVersion(pick.version) : undefined;
    }
  }
}

export function dig(value: unknown, path: string): unknown {
  let cur = value;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

