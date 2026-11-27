import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addedBullets, closedVersion, commitNotes, devNotes, nextDevVersion, previousTag, versionSection } from '../changelog.ts';
import { buildNotes } from '../notes.ts';
import { resolveRelease } from '../resolve.ts';

const CHANGELOG = `# Changelog

Intro.

## Unreleased

### Added
- New thing one.
- New thing two.

### Fixed
- A fix.

## v0.2.0 — 2026-12-01

### Added
- Released thing.

## v0.1.0 — 2026-11-26

### Added
- First.
`;

const FRESH = `# Changelog\n\n## Unreleased\n\n### Added\n- Desktop builds.\n`;

test('closedVersion, versionSection', () => {
  assert.equal(closedVersion(CHANGELOG), '0.2.0');
  assert.equal(closedVersion(FRESH), null);
  assert.equal(versionSection(CHANGELOG, '0.2.0'), '### Added\n- Released thing.');
  assert.equal(versionSection(CHANGELOG, '0.1.0'), '### Added\n- First.');
  assert.equal(versionSection(CHANGELOG, '0.2'), null);
});

test('nextDevVersion bumps the patch and counts existing dev tags', () => {
  assert.equal(nextDevVersion(CHANGELOG, []), '0.2.1-dev.1');
  assert.equal(nextDevVersion(CHANGELOG, ['v0.2.1-dev.1', 'v0.2.1-dev.7', 'v0.2.0-dev.9', 'v0.2.10-dev.4']), '0.2.1-dev.8');
  assert.equal(nextDevVersion(FRESH, ['v0.1.0-dev.2']), '0.1.0-dev.3');
});

test('resolveRelease', () => {
  const base = { changelog: CHANGELOG, tags: ['v0.2.1-dev.1'] };
  assert.deepEqual(resolveRelease({ ...base, event: 'push', ref: 'main' }), { version: '0.2.0', channel: 'stable', publish: true });
  assert.deepEqual(resolveRelease({ ...base, event: 'push', ref: 'dev' }), { version: '0.2.1-dev.2', channel: 'dev', publish: true });
  assert.deepEqual(resolveRelease({ ...base, event: 'pull_request', ref: 'feat/x', prNumber: '12' }), { version: '0.2.1-pr.12', channel: 'dev', publish: false });
  assert.deepEqual(resolveRelease({ ...base, event: 'workflow_dispatch', ref: 'feat/x', inputVersion: 'v0.3.0-dev.1', inputPublish: 'false' }), {
    version: '0.3.0-dev.1',
    channel: 'dev',
    publish: false,
  });
  assert.throws(() => resolveRelease({ ...base, event: 'workflow_dispatch', ref: 'feat/x' }), /doesn't release from feat\/x/);
  assert.throws(() => resolveRelease({ changelog: FRESH, tags: [], event: 'push', ref: 'main' }), /no closed/);
  assert.throws(() => resolveRelease({ ...base, event: 'workflow_dispatch', ref: 'dev', inputVersion: '1.2' }), /not a version/);
});

test('devNotes groups new bullets under their Unreleased heading', () => {
  const notes = devNotes(CHANGELOG, ['- A fix.', '- New thing two.', '- Moved elsewhere.']);
  assert.equal(notes, '### Added\n- New thing two.\n\n### Fixed\n- A fix.\n\n### Other changes\n- Moved elsewhere.');
  assert.equal(devNotes(CHANGELOG, []), '');
  assert.deepEqual(addedBullets('+++ b/CHANGELOG.md\n+- New thing one.\n+### Added\n- old\n+\n'), ['- New thing one.']);
});

test('commitNotes reads Conventional Commit subjects', () => {
  assert.equal(
    commitNotes(['feat(ui): add a pill', 'fix: crash on start', 'chore: deps', 'docs: readme', 'perf(core): faster', 'Merge branch x']),
    '### Added\n- add a pill\n\n### Fixed\n- crash on start\n\n### Changed\n- perf(core): faster\n- Merge branch x',
  );
});

test('previousTag: the newest tag older than the version', () => {
  assert.equal(previousTag(['v0.1.0', 'v0.2.1-dev.1', 'v0.2.0', 'v0.2.1-dev.2', 'junk'], '0.2.1-dev.2'), 'v0.2.1-dev.1');
  assert.equal(previousTag([], '0.1.0-dev.1'), null);
});

test('buildNotes: stable needs its section, dev takes what is new', () => {
  const deps = (o: Partial<Parameters<typeof buildNotes>[2]> = {}) => ({ changelog: CHANGELOG, tags: () => ['v0.2.0'], diff: () => '+- New thing one.\n', subjects: () => ['feat: x'], ...o });
  assert.equal(buildNotes('0.2.0', 'stable', deps()), '### Added\n- Released thing.');
  assert.throws(() => buildNotes('0.3.0', 'stable', deps()), /Close the Unreleased section/);
  assert.equal(buildNotes('0.2.1-dev.1', 'dev', deps()), '### Added\n- New thing one.');
  assert.equal(buildNotes('0.2.1-dev.1', 'dev', deps({ diff: () => '' })), '### Added\n- x', 'falls back to commits');
  assert.equal(buildNotes('0.2.1-dev.1', 'dev', deps({ diff: () => '', subjects: () => ['chore: y'] })), 'Internal improvements and bug fixes.');
  assert.equal(buildNotes('0.1.0-dev.1', 'dev', { ...deps(), changelog: FRESH, tags: () => [] }), '### Added\n- Desktop builds.', 'first release: all of Unreleased');
});
