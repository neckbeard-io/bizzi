// Decides what a release.yml run builds and publishes. Writes `key=value` lines to $GITHUB_OUTPUT
// (or prints them). Inputs come from the environment:
//
//   GITHUB_EVENT_NAME  push | workflow_dispatch | pull_request
//   GITHUB_REF_NAME    main | dev | <branch>
//   INPUT_VERSION      workflow_dispatch: explicit version without the v (optional)
//   INPUT_CHANNEL      workflow_dispatch: stable | dev (optional; inferred from the version)
//   INPUT_PUBLISH      workflow_dispatch: true | false
//   PR_NUMBER          pull_request: the PR number
//
// push to main → the closed `## vX.Y.Z` from CHANGELOG.md, stable
// push to dev  → the next vX.Y.Z-dev.N, dev (pre-release)
// pull_request → a build-only X.Y.Z-pr.N, nothing published

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { closedVersion, nextDevVersion } from './changelog.ts';

export interface ResolveInput {
  event: string;
  ref: string;
  changelog: string;
  tags: string[];
  inputVersion?: string;
  inputChannel?: string;
  inputPublish?: string;
  prNumber?: string;
}

export interface Resolved {
  version: string;
  channel: 'stable' | 'dev';
  publish: boolean;
}

export function resolveRelease(i: ResolveInput): Resolved {
  if (i.event === 'workflow_dispatch' && i.inputVersion?.trim()) {
    const version = i.inputVersion.trim().replace(/^v/, '');
    if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`not a version: ${version}`);
    const channel = i.inputChannel === 'dev' || i.inputChannel === 'stable' ? i.inputChannel : version.includes('-') ? 'dev' : 'stable';
    return { version, channel, publish: i.inputPublish !== 'false' };
  }
  if (i.event === 'pull_request') {
    const base = nextDevVersion(i.changelog, i.tags).replace(/-dev\.\d+$/, '');
    return { version: `${base}-pr.${i.prNumber || '0'}`, channel: 'dev', publish: false };
  }
  if (i.ref === 'main') {
    const version = closedVersion(i.changelog);
    if (!version) throw new Error('CHANGELOG.md has no closed "## vX.Y.Z — <date>" section to release from main.');
    return { version, channel: 'stable', publish: i.event === 'push' || i.inputPublish !== 'false' };
  }
  if (i.ref === 'dev') {
    return { version: nextDevVersion(i.changelog, i.tags), channel: 'dev', publish: i.event === 'push' || i.inputPublish !== 'false' };
  }
  throw new Error(`release.yml doesn't release from ${i.ref}; dispatch it with a version instead.`);
}

if (import.meta.main) {
  const env = process.env;
  const tags = execFileSync('git', ['tag', '--list', 'v*'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const r = resolveRelease({
    event: env['GITHUB_EVENT_NAME'] ?? 'workflow_dispatch',
    ref: env['GITHUB_REF_NAME'] ?? '',
    changelog: readFileSync('CHANGELOG.md', 'utf8'),
    tags,
    inputVersion: env['INPUT_VERSION'],
    inputChannel: env['INPUT_CHANNEL'],
    inputPublish: env['INPUT_PUBLISH'],
    prNumber: env['PR_NUMBER'],
  });
  const lines = [`version=${r.version}`, `channel=${r.channel}`, `publish=${r.publish}`, `prerelease=${r.channel === 'dev'}`];
  process.stderr.write(`release: ${lines.join(' ')}\n`);
  if (env['GITHUB_OUTPUT']) appendFileSync(env['GITHUB_OUTPUT'], `${lines.join('\n')}\n`);
  else process.stdout.write(`${lines.join('\n')}\n`);
}
