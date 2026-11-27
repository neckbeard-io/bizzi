import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveWorkspaceSpecifier, workspacePackages } from '../src/workspaces-hook.ts';

const repo = fileURLToPath(new URL('../../../', import.meta.url));

test('workspacePackages finds every @bizzi package with its exports', () => {
  const pkgs = workspacePackages(repo);
  assert.equal(pkgs.get('@bizzi/core')?.dir, join(repo, 'packages', 'core'));
  assert.equal(pkgs.get('@bizzi/cli')?.dir, join(repo, 'apps', 'cli'));
});

test('resolveWorkspaceSpecifier maps names and subpath exports to source files', () => {
  const pkgs = workspacePackages(repo);
  assert.equal(resolveWorkspaceSpecifier('@bizzi/protocol', pkgs), join(repo, 'packages', 'protocol', 'src', 'index.ts'));
  assert.equal(resolveWorkspaceSpecifier('@bizzi/core/testing', pkgs), join(repo, 'packages', 'core', 'src', 'testing', 'index.ts'));
  assert.equal(resolveWorkspaceSpecifier('@bizzi/core/nope', pkgs), null, 'not an export');
  assert.equal(resolveWorkspaceSpecifier('@bizzi/unknown', pkgs), null);
  assert.equal(resolveWorkspaceSpecifier('ws', pkgs), null);
});
