import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { BizziError, type WorkspaceInfo } from '@bizzi/protocol';
import { sanitizeBranch } from '../src/index.ts';
import { makeNode, tempDir, waitFor } from './helpers.ts';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'bizzi test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'bizzi test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], { cwd, env: GIT_ENV, encoding: 'utf8' });
}

function makeRepo(root: string): string {
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  writeFileSync(join(repo, 'README.md'), 'hello\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  return realpathSync(repo);
}

async function rejects(p: Promise<unknown>, code: string, re?: RegExp): Promise<void> {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof BizziError, String(err));
    assert.equal(err.code, code, err.message);
    if (re) assert.match(err.message, re);
    return true;
  });
}

test('sanitizeBranch makes one safe path segment', () => {
  assert.equal(sanitizeBranch('feat/x y'), 'feat-x-y');
  assert.equal(sanitizeBranch('..weird'), 'weird');
  assert.equal(sanitizeBranch('///'), 'worktree');
});

test('worktree.create / remove: sibling path, kind worktree, idempotent, dirty refusal, force, branch kept', async (t) => {
  const tmp = tempDir();
  const node = await makeNode(join(tmp.path, 'data'));
  t.after(async () => {
    await node.close();
    tmp.cleanup();
  });
  const repo = makeRepo(tmp.path);
  const { workspace: parent } = await node.call('workspace.create', { path: repo });
  assert.equal(parent.kind, 'git');

  const { workspace: wt } = await node.call('worktree.create', { workspaceId: parent.id, branch: 'feat/review' });
  assert.equal(wt.kind, 'worktree');
  assert.equal(wt.parentWorkspaceId, parent.id);
  assert.equal(wt.branch, 'feat/review');
  assert.equal(wt.path, join(`${repo}.worktrees`, 'feat-review'));
  assert.equal(wt.name, `${parent.name} (feat/review)`);
  assert.ok(existsSync(join(wt.path, 'README.md')));
  assert.equal(git(wt.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'feat/review');

  // Same branch again: the existing workspace.
  const again = await node.call('worktree.create', { workspaceId: parent.id, branch: 'feat/review' });
  assert.equal(again.workspace.id, wt.id);
  // From the worktree workspace: still grouped under the repo workspace.
  const { workspace: wt2 } = await node.call('worktree.create', { workspaceId: wt.id, branch: 'other', name: 'Other' });
  assert.equal(wt2.parentWorkspaceId, parent.id);
  assert.equal(wt2.name, 'Other');
  // Orchestration settings: a worktree inherits its repo workspace's overrides, then its own.
  await node.call('orchestration.settings.set', { workspaceId: parent.id, settings: { maxDepth: 5, onLimit: 'queue' } });
  await node.call('orchestration.settings.set', { workspaceId: wt2.id, settings: { maxDepth: 1 } });
  const inherited = (await node.call('orchestration.settings.get', { workspaceId: wt2.id })).settings;
  assert.equal(inherited.maxDepth, 1);
  assert.equal(inherited.onLimit, 'queue');

  // Existing branch (not checked out anywhere) + explicit path.
  git(repo, 'branch', 'existing');
  const custom = join(tmp.path, 'custom-wt');
  const { workspace: wt3 } = await node.call('worktree.create', { workspaceId: parent.id, branch: 'existing', path: custom });
  assert.equal(wt3.path, realpathSync(custom));
  await rejects(node.call('worktree.create', { workspaceId: parent.id, branch: 'main' }), 'conflict', /already/);
  await rejects(node.call('worktree.create', { workspaceId: parent.id, branch: 'bad..name' }), 'bad_request', /invalid branch/);

  // Persisted across a restart.
  await node.close();
  const node2 = await makeNode(join(tmp.path, 'data'));
  t.after(() => node2.close());
  const listed = (await node2.call('workspaces.list', {})).workspaces.find((w: WorkspaceInfo) => w.id === wt.id);
  assert.deepEqual(listed, wt);

  // Parent removal is refused while worktrees exist.
  await rejects(node2.call('workspace.remove', { workspaceId: parent.id }), 'conflict', /worktree/);
  // worktree.remove only for worktrees.
  await rejects(node2.call('worktree.remove', { workspaceId: parent.id }), 'bad_request');

  // Dirty → refused; force → removed; branch kept.
  writeFileSync(join(wt.path, 'new.txt'), 'x\n');
  await rejects(node2.call('worktree.remove', { workspaceId: wt.id }), 'conflict', /uncommitted.*new\.txt/);
  assert.ok(existsSync(wt.path));
  await node2.call('worktree.remove', { workspaceId: wt.id, force: true });
  assert.ok(!existsSync(wt.path));
  assert.ok(!node2.workspaces.list().some((w) => w.id === wt.id));
  assert.equal(git(repo, 'branch', '--list', 'feat/review').trim(), 'feat/review');

  // Clean worktree: removed without force. A worktree whose directory is gone: pruned.
  await node2.call('worktree.remove', { workspaceId: wt2.id });
  execFileSync('rm', ['-rf', wt3.path]);
  await node2.call('worktree.remove', { workspaceId: wt3.id });
  assert.ok(!git(repo, 'worktree', 'list').includes('custom-wt'));
  await node2.call('workspace.remove', { workspaceId: parent.id });
});

test('worktree.remove refuses while a live session uses it; dir workspaces cannot have worktrees', async (t) => {
  const tmp = tempDir();
  const node = await makeNode(join(tmp.path, 'data'));
  t.after(async () => {
    await node.close();
    tmp.cleanup();
  });
  const repo = makeRepo(tmp.path);
  const { workspace: parent } = await node.call('workspace.create', { path: repo });
  const { workspace: wt } = await node.call('worktree.create', { workspaceId: parent.id, branch: 'busy' });
  const { session } = await node.call('session.create', { workspaceId: wt.id, agent: 'claude' });
  await waitFor(() => node.sessions.get(session.id).session.status === 'idle');
  await rejects(node.call('worktree.remove', { workspaceId: wt.id }), 'conflict', /live session/);
  await node.call('session.stop', { sessionId: session.id });
  await node.call('worktree.remove', { workspaceId: wt.id });

  const plain = join(tmp.path, 'plain');
  const { workspace: dir } = await node.call('workspace.create', { path: plain, create: true });
  await rejects(node.call('worktree.create', { workspaceId: dir.id, branch: 'x' }), 'bad_request', /not a git repository/);
});
