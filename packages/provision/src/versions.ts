// Version ranges for recipes' supported/tested versions (spec §7). A small subset of npm semver
// ranges: comparators `>=`, `>`, `<=`, `<`, `=` (or a bare version) joined by spaces (AND), and
// alternatives joined by `||` (OR). `*` matches anything. Versions compare with compareVersions.

import type { AgentRemedy, AgentSupport } from '@bizzi/protocol';
import type { Recipe } from './types.ts';

export type RangeOp = '>=' | '>' | '<=' | '<' | '=';

export interface Comparator {
  op: RangeOp;
  version: string;
}

/** OR of ANDs. */
export type Range = Comparator[][];

/** Numeric semver-ish comparison; prerelease sorts before release. */
export function compareVersions(a: string, b: string): number {
  const [ma = '', pa] = a.replace(/^v/, '').split('-', 2);
  const [mb = '', pb] = b.replace(/^v/, '').split('-', 2);
  const na = ma.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const nb = mb.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (na[i] ?? 0) - (nb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  if (pa === pb) return 0;
  if (pa === undefined) return 1;
  if (pb === undefined) return -1;
  return pa < pb ? -1 : 1;
}

const COMPARATOR_RE = /^(>=|<=|>|<|=)?\s*v?(\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.]+)?)$/;

/** Parse a range. Throws Error with a readable message on invalid input. */
export function parseRange(range: string): Range {
  const alternatives = range.split('||').map((a) => a.trim());
  if (alternatives.some((a) => a === '')) throw new Error(`invalid version range "${range}": empty alternative`);
  return alternatives.map((alt) => {
    if (alt === '*') return [];
    // Glue operators to their versions (">= 2.0.0" → ">=2.0.0") before splitting on spaces.
    const tokens = alt.replace(/(>=|<=|>|<|=)\s+/g, '$1').split(/\s+/);
    return tokens.map((t) => {
      const m = COMPARATOR_RE.exec(t);
      if (!m) throw new Error(`invalid version range "${range}": cannot parse "${t}"`);
      return { op: (m[1] ?? '=') as RangeOp, version: m[2] as string };
    });
  });
}

function test(version: string, c: Comparator): boolean {
  const d = compareVersions(version, c.version);
  switch (c.op) {
    case '>=':
      return d >= 0;
    case '>':
      return d > 0;
    case '<=':
      return d <= 0;
    case '<':
      return d < 0;
    case '=':
      return d === 0;
  }
}

/** Does `version` satisfy `range`? Throws on an invalid range. */
export function satisfies(version: string, range: string | Range): boolean {
  const parsed = typeof range === 'string' ? parseRange(range) : range;
  return parsed.some((alt) => alt.every((c) => test(version, c)));
}

/** True when the version is above every alternative's upper bound (i.e. newer than the range). */
function newerThan(version: string, range: Range): boolean {
  return range.every((alt) => alt.some((c) => (c.op === '<' || c.op === '<=' || c.op === '=') && !test(version, c)));
}

export interface SupportVerdict {
  support: AgentSupport;
  reason?: string;
  remedies?: AgentRemedy[];
}

/**
 * Check an installed version against a recipe's `support` block. Undefined when the recipe
 * declares no supported versions. An unknown version is `untested` (never refused).
 */
export function assessSupport(recipe: Recipe, version: string | undefined): SupportVerdict | undefined {
  const spec = recipe.support;
  if (!spec) return undefined;
  if (!version) return { support: 'untested', reason: `could not read the ${recipe.displayName} version` };
  if (!satisfies(version, spec.versions)) {
    const reason = spec.unsupported?.reason ?? `${recipe.displayName} ${version} is not supported (bizzi supports ${spec.versions})`;
    const remedies = spec.unsupported?.remedies;
    return { support: 'unsupported', reason, ...(remedies?.length ? { remedies: remedies.map((r) => ({ ...r })) } : {}) };
  }
  if (spec.tested) {
    const tested = parseRange(spec.tested);
    if (!satisfies(version, tested)) {
      const rel = newerThan(version, tested) ? 'newer than' : 'outside';
      return { support: 'untested', reason: `${recipe.displayName} ${version} is ${rel} the versions bizzi was tested with (${spec.tested})` };
    }
  }
  return { support: 'ok' };
}
