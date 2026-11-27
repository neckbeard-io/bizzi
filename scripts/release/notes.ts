// Prints the release body for a version: the changelog's words, then the standing install footer.
//
//   node scripts/release/notes.ts <version> <stable|dev>
//
// Stable: the `## v<version>` section of CHANGELOG.md. Missing or empty fails the run, before anything
// is published: write the changelog entry rather than editing this script.
// Dev: the changelog bullets added since the previous tag, grouped by heading; with none, the
// Conventional Commit subjects since that tag; with none of those either, a stock sentence.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { addedBullets, commitNotes, devNotes, previousTag, unreleasedSections, versionSection } from './changelog.ts';

export const FOOTER =
  '\n\n---\n\nDownloads for macOS, Linux and Windows are below. Installed copies update themselves; first-time installs: see the [README](https://github.com/neckbeard-io/bizzi#install).\n';

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

export function buildNotes(version: string, channel: string, deps: { changelog: string; tags: () => string[]; diff: (range: string) => string; subjects: (range: string) => string[] }): string {
  const own = versionSection(deps.changelog, version);
  if (own) return own;
  if (channel !== 'dev' && !version.includes('-')) {
    throw new Error(
      `CHANGELOG.md has no content under "## v${version}". Close the Unreleased section before releasing: ` +
        `rename it to "## v${version} — <YYYY-MM-DD>" and open a fresh "## Unreleased" above it.`,
    );
  }
  const prev = previousTag(deps.tags(), version);
  const range = prev ? `${prev}..HEAD` : null;
  // No earlier release: everything Unreleased is new.
  const added = range ? addedBullets(deps.diff(range)) : [...unreleasedSections(deps.changelog).values()].flat();
  return devNotes(deps.changelog, added) || commitNotes(deps.subjects(range ?? 'HEAD')) || 'Internal improvements and bug fixes.';
}

if (import.meta.main) {
  const [version, channel = 'stable'] = process.argv.slice(2);
  if (!version) throw new Error('usage: notes.ts <version> <stable|dev>');
  const body = buildNotes(version, channel, {
    changelog: readFileSync('CHANGELOG.md', 'utf8'),
    // Only tags this commit descends from: a tag on another branch says nothing about this one.
    tags: () => git('tag', '--merged', 'HEAD', '--list', 'v*').split('\n').filter(Boolean),
    diff: (range) => git('diff', range, '--', 'CHANGELOG.md'),
    subjects: (range) => git('log', range, '--pretty=format:%s').split('\n'),
  });
  process.stdout.write(body + FOOTER);
}
