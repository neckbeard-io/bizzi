// SemVer 2.0 precedence for release tags: v0.5.5 < v0.5.6-dev.1 < v0.5.6-dev.2 < v0.5.6.
// Also used by scripts/release (version resolution), so it has no Electron imports.

export interface SemVer {
  core: [number, number, number];
  prerelease: string[];
}

/** Parses `1.2.3`, `v1.2.3-dev.4`, `1.2.3+build`; missing parts are 0. Null when it isn't a version. */
export function parseSemver(version: string): SemVer | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim());
  if (!m) return null;
  return {
    core: [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)],
    prerelease: m[4] ? m[4].split('.') : [],
  };
}

/** > 0 when a is newer than b, < 0 when older, 0 when equal. Unparseable versions sort lowest. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 0; i < 3; i++) {
    const d = pa.core[i]! - pb.core[i]!;
    if (d !== 0) return d;
  }
  // A release outranks its own pre-releases.
  if (pa.prerelease.length === 0 || pb.prerelease.length === 0) return pb.prerelease.length - pa.prerelease.length;
  const n = Math.min(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < n; i++) {
    const x = pa.prerelease[i]!;
    const y = pb.prerelease[i]!;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
    } else if (nx !== ny) {
      return nx ? -1 : 1; // numeric identifiers rank below alphanumeric ones
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return pa.prerelease.length - pb.prerelease.length;
}

export function isPrerelease(version: string): boolean {
  return (parseSemver(version)?.prerelease.length ?? 0) > 0;
}
