import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { BizziError } from '@bizzi/protocol';
import { parseBranchLine, parsePorcelainZ } from '../src/index.ts';
import { makeNode, tempDir } from './helpers.ts';

const rejectsWith = (code: string) => (err: unknown) => err instanceof BizziError && err.code === code;

async function setup(t: { after: (fn: () => unknown) => void }) {
  const dir = tempDir();
  const root = join(dir.path, 'ws');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'README.md'), '# hello\n');
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(root, 'bin.dat'), Buffer.from([0, 1, 2, 255]));
  writeFileSync(join(dir.path, 'secret.txt'), 'outside');
  symlinkSync(join(dir.path, 'secret.txt'), join(root, 'escape'));
  symlinkSync(join(root, 'src'), join(root, 'inner-link'));
  const node = await makeNode(join(dir.path, 'data'));
  t.after(async () => {
    await node.close();
    dir.cleanup();
  });
  const { workspace } = await node.call('workspace.create', { path: root });
  return { node, workspace, root, dir };
}

test('fs.list and fs.read inside the workspace', async (t) => {
  const { node, workspace } = await setup(t);
  const { entries } = await node.call('fs.list', { workspaceId: workspace.id });
  assert.deepEqual(
    entries.map((e) => [e.name, e.type]),
    [
      ['src', 'dir'],
      ['bin.dat', 'file'],
      ['escape', 'symlink'],
      ['inner-link', 'symlink'],
      ['README.md', 'file'],
    ],
  );
  assert.equal(entries.find((e) => e.name === 'README.md')?.size, 8);
  assert.deepEqual((await node.call('fs.list', { workspaceId: workspace.id, path: 'src' })).entries.map((e) => e.name), ['a.ts']);
  // Symlinks that stay inside the workspace are followed.
  assert.deepEqual((await node.call('fs.list', { workspaceId: workspace.id, path: 'inner-link' })).entries.map((e) => e.name), ['a.ts']);

  const text = await node.call('fs.read', { workspaceId: workspace.id, path: 'README.md' });
  assert.deepEqual(text, { content: '# hello\n', encoding: 'utf8', truncated: false });
  const trunc = await node.call('fs.read', { workspaceId: workspace.id, path: 'README.md', maxBytes: 3 });
  assert.deepEqual(trunc, { content: '# h', encoding: 'utf8', truncated: true });
  const bin = await node.call('fs.read', { workspaceId: workspace.id, path: 'bin.dat' });
  assert.equal(bin.encoding, 'base64');
  assert.deepEqual([...Buffer.from(bin.content, 'base64')], [0, 1, 2, 255]);
  await assert.rejects(node.call('fs.read', { workspaceId: workspace.id, path: 'src' }), rejectsWith('bad_request'));
  await assert.rejects(node.call('fs.read', { workspaceId: workspace.id, path: 'missing.txt' }), rejectsWith('not_found'));
});

test('fs rejects traversal and symlink escapes', async (t) => {
  const { node, workspace, dir } = await setup(t);
  for (const path of ['../secret.txt', 'src/../../secret.txt', join(dir.path, 'secret.txt'), '/etc/passwd', 'escape']) {
    await assert.rejects(node.call('fs.read', { workspaceId: workspace.id, path }), rejectsWith('bad_request'), path);
  }
  await assert.rejects(node.call('fs.list', { workspaceId: workspace.id, path: '..' }), rejectsWith('bad_request'));
  await assert.rejects(node.call('fs.list', { workspaceId: 'w_missing' }), rejectsWith('not_found'));
  await assert.rejects(node.call('git.diff', { workspaceId: workspace.id, path: '../x' }), rejectsWith('bad_request'));
});

test('git.status and git.diff on a temp repo', async (t) => {
  const { node, workspace, root } = await setup(t);
  assert.deepEqual(await node.call('git.status', { workspaceId: workspace.id }), { isRepo: false, files: [] });

  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
      cwd: root,
      encoding: 'utf8',
    });
  git('init', '-q', '-b', 'main');
  git('add', 'README.md', 'src');
  git('commit', '-q', '-m', 'init');
  writeFileSync(join(root, 'README.md'), '# hello\nworld\n');
  writeFileSync(join(root, 'new file.txt'), 'x');
  git('mv', 'src/a.ts', 'src/b.ts');

  const st = await node.call('git.status', { workspaceId: workspace.id });
  assert.equal(st.isRepo, true);
  assert.equal(st.branch, 'main');
  const byPath = Object.fromEntries(st.files.map((f) => [f.path, f.status]));
  assert.equal(byPath['README.md'], ' M');
  assert.equal(byPath['new file.txt'], '??');
  assert.equal(byPath['src/b.ts'], 'R ');
  assert.equal(byPath['src/a.ts'], undefined);

  const { diff } = await node.call('git.diff', { workspaceId: workspace.id });
  assert.match(diff, /\+world/);
  const staged = await node.call('git.diff', { workspaceId: workspace.id, staged: true });
  assert.match(staged.diff, /rename to src\/b\.ts/);
  const one = await node.call('git.diff', { workspaceId: workspace.id, path: 'src' });
  assert.equal(one.diff, '');

  // A workspace adopted inside a repo is kind 'git'.
  const { workspace: sub } = await node.call('workspace.create', { path: join(root, 'src') });
  assert.equal(sub.kind, 'git');
});

test('porcelain branch header parsing', () => {
  assert.deepEqual(parseBranchLine('main...origin/main [ahead 2, behind 3]'), { branch: 'main', ahead: 2, behind: 3 });
  assert.deepEqual(parseBranchLine('main...origin/main'), { branch: 'main', ahead: 0, behind: 0 });
  assert.deepEqual(parseBranchLine('feature/x...origin/feature/x [gone]'), { branch: 'feature/x', ahead: 0, behind: 0 });
  assert.deepEqual(parseBranchLine('main'), { branch: 'main' });
  assert.deepEqual(parseBranchLine('No commits yet on main'), { branch: 'main' });
  assert.deepEqual(parseBranchLine('HEAD (no branch)'), {});
  assert.deepEqual(parsePorcelainZ('## dev\0R  new.ts\0old.ts\0 M a b.ts\0'), {
    branch: 'dev',
    files: [
      { path: 'new.ts', status: 'R ' },
      { path: 'a b.ts', status: ' M' },
    ],
  });
});
