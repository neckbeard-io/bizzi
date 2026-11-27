// CHANGELOG.md → release versions and notes. Layout (docs/releasing.md):
//
//   ## Unreleased
//   ### Added
//   - a line per user-visible change, written with the change
//
//   ## v0.2.0 — 2026-12-01
//   ...

import { compareSemver } from '../../apps/desktop/src/update/semver.ts';

/** The newest closed version (`## vX.Y.Z — date`), or null when nothing was released yet. */
export function closedVersion(changelog: string): string | null {
  const m = /^## v(\d+\.\d+\.\d+)\b/m.exec(changelog);
  return m ? m[1]! : null;
}

/** The body of `## v<version>`, trimmed; null when there is no such section or it is empty. */
export function versionSection(changelog: string, version: string): string | null {
  const lines = changelog.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => new RegExp(`^## v${version.replace(/[.+]/g, '\\$&')}(\\s|$)`).test(l));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
  return body || null;
}

/** `## Unreleased`'s bullets under each `###` heading, in the changelog's order. */
export function unreleasedSections(changelog: string): Map<string, string[]> {
  const lines = changelog.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^## Unreleased\b/i.test(l));
  const out = new Map<string, string[]>();
  if (start === -1) return out;
  let heading: string | null = null;
  for (const raw of lines.slice(start + 1)) {
    if (raw.startsWith('## ')) break;
    if (raw.startsWith('### ')) {
      heading = raw.slice(4).trim();
      if (!out.has(heading)) out.set(heading, []);
    } else if (heading && raw.trim().startsWith('- ')) {
      out.get(heading)!.push(raw.trim());
    }
  }
  return out;
}

/** The next dev pre-release: the patch after the last closed version, numbered after existing tags. */
export function nextDevVersion(changelog: string, tags: string[]): string {
  const closed = closedVersion(changelog);
  const base = closed ? bumpPatch(closed) : '0.1.0';
  const re = new RegExp(`^v${base.replace(/\./g, '\\.')}-dev\\.(\\d+)$`);
  const n = Math.max(0, ...tags.map((t) => Number(re.exec(t)?.[1] ?? 0)));
  return `${base}-dev.${n + 1}`;
}

export function bumpPatch(v: string): string {
  const [a, b, c] = v.split('.').map(Number);
  return `${a}.${b}.${(c ?? 0) + 1}`;
}

/**
 * Dev release notes: the changelog bullets added since the previous release, grouped under the
 * Unreleased heading each sits beneath. Bullets that moved out of Unreleased go under "Other changes".
 */
export function devNotes(changelog: string, addedLines: string[]): string {
  const sections = unreleasedSections(changelog);
  const grouped = new Map<string, string[]>([...sections.keys()].map((h) => [h, []]));
  const other: string[] = [];
  for (const line of addedLines) {
    const home = [...sections].find(([, items]) => items.includes(line))?.[0];
    (home ? grouped.get(home)! : other).push(line);
  }
  const parts = [...grouped].filter(([, items]) => items.length).map(([h, items]) => `### ${h}\n${items.join('\n')}`);
  if (other.length) parts.push(`### Other changes\n${other.join('\n')}`);
  return parts.join('\n\n');
}

/** Bullets (`- …`) a unified diff of CHANGELOG.md adds. */
export function addedBullets(diff: string): string[] {
  return diff
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .map((l) => l.slice(1).trim())
    .filter((l) => l.startsWith('- '));
}

/** Fallback notes from Conventional Commit subjects, for a dev release whose changelog says nothing. */
export function commitNotes(subjects: string[]): string {
  const added: string[] = [];
  const fixed: string[] = [];
  const changed: string[] = [];
  for (const s of subjects.map((x) => x.trim()).filter(Boolean)) {
    const m = /^(\w+)(\([^)]*\))?!?:\s*(.*)$/.exec(s);
    const type = m?.[1] ?? '';
    const msg = m?.[3] ?? s;
    if (type === 'feat') added.push(`- ${msg}`);
    else if (type === 'fix') fixed.push(`- ${msg}`);
    else if (!['chore', 'ci', 'test', 'docs', 'style', 'build', 'refactor'].includes(type)) changed.push(`- ${s}`);
  }
  return [
    added.length ? `### Added\n${added.join('\n')}` : '',
    fixed.length ? `### Fixed\n${fixed.join('\n')}` : '',
    changed.length ? `### Changed\n${changed.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** The newest `v*` tag older than `version` among `tags` (callers pass tags reachable from HEAD). */
export function previousTag(tags: string[], version: string): string | null {
  const older = tags.filter((t) => /^v\d/.test(t) && compareSemver(t, version) < 0);
  older.sort((a, b) => compareSemver(b, a));
  return older[0] ?? null;
}
