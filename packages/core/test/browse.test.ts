import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { BizziError, type BrowseEntry } from '@bizzi/protocol';
import { createNode } from '../src/index.ts';
import { FsBrowser } from '../src/browse.ts';
import { FakeAdapter } from '../src/testing/index.ts';
import { tempDir } from './helpers.ts';

const rejectsWith = (code: string, re?: RegExp) => (err: unknown) =>
  err instanceof BizziError && err.code === code && (!re || re.test(err.message));
const names = (entries: BrowseEntry[]) => entries.map((e) => e.name);
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

/**
 * home/
 *   src/ (alpha/ with .git dir, beta/ plain, gamma/ with .git file = worktree)
 *   repo/
 *   react/  Rust/  notes.txt  .config/  .hidden-repo/.git
 *   link-src -> src   link-file -> notes.txt   dangling -> nowhere   loop-a <-> loop-b   up -> ..
 */
function fixture(t: { after: (fn: () => unknown) => void }) {
  const dir = tempDir('bizzi-browse-');
  t.after(() => {
    try {
      chmodSync(join(dir.path, 'home', 'locked'), 0o755);
    } catch {
      // not created
    }
    dir.cleanup();
  });
  const home = join(realpathSync(dir.path), 'home');
  for (const d of ['src/alpha/.git', 'src/beta', 'src/gamma', 'repo', 'react', 'Rust', '.config', '.hidden-repo/.git']) mkdirSync(join(home, d), { recursive: true });
  writeFileSync(join(home, 'src/gamma/.git'), 'gitdir: /elsewhere\n');
  writeFileSync(join(home, 'notes.txt'), 'never read');
  symlinkSync(join(home, 'src'), join(home, 'link-src'));
  symlinkSync(join(home, 'notes.txt'), join(home, 'link-file'));
  symlinkSync(join(home, 'nowhere'), join(home, 'dangling'));
  symlinkSync(join(home, 'loop-b'), join(home, 'loop-a'));
  symlinkSync(join(home, 'loop-a'), join(home, 'loop-b'));
  symlinkSync('..', join(home, 'up'));
  return { home, root: dir.path };
}

test('fs.browse: tilde, directories and symlinks to directories only, sorted', async (t) => {
  const { home } = fixture(t);
  const b = new FsBrowser({ home, caseInsensitive: false });
  const r = await b.browse();
  assert.equal(r.path, home);
  assert.equal(r.home, home);
  assert.equal(r.parent, join(home, '..'));
  assert.equal(r.truncated, false);
  // Files, dangling links, links to files and symlink loops are skipped; `up -> ..` is a directory.
  assert.deepEqual(names(r.entries), ['link-src', 'react', 'repo', 'Rust', 'src', 'up']);
  const link = r.entries.find((e) => e.name === 'link-src')!;
  assert.equal(link.kind, 'symlink');
  assert.equal(link.path, join(home, 'link-src'));
  assert.equal(r.entries.find((e) => e.name === 'src')!.kind, 'dir');

  const src = await b.browse({ path: '~/src' });
  assert.equal(src.path, join(home, 'src'));
  assert.deepEqual(
    src.entries.map((e) => [e.name, e.git ?? false]),
    [
      ['alpha', true],
      ['beta', false],
      ['gamma', true],
    ],
  );
  // Normalized: `..` and duplicate separators collapse.
  assert.equal((await b.browse({ path: `${home}/src/../repo//` })).path, join(home, 'repo'));
  assert.equal((await b.browse({ path: '~' })).path, home);
});

test('fs.browse: hidden directories only with showHidden, marked hidden', async (t) => {
  const { home } = fixture(t);
  const b = new FsBrowser({ home });
  assert.ok(!names((await b.browse()).entries).some((n) => n.startsWith('.')));
  const all = (await b.browse({ showHidden: true })).entries;
  const hidden = all.filter((e) => e.hidden);
  assert.deepEqual(names(hidden), ['.config', '.hidden-repo']);
  assert.equal(hidden.find((e) => e.name === '.hidden-repo')!.git, true);
  assert.equal(all.find((e) => e.name === 'src')!.hidden, undefined);
});

test('fs.browse: errors for the requested path', async (t) => {
  const { home } = fixture(t);
  const b = new FsBrowser({ home });
  await assert.rejects(b.browse({ path: 'relative/dir' }), rejectsWith('bad_request', /absolute/));
  await assert.rejects(b.browse({ path: '~/missing' }), rejectsWith('not_found'));
  await assert.rejects(b.browse({ path: '~/notes.txt' }), rejectsWith('bad_request', /not a directory/));
  await assert.rejects(b.browse({ path: '~/loop-a' }), rejectsWith('bad_request'));
  await assert.rejects(b.browse({ path: `${home}\0x` }), rejectsWith('bad_request'));
});

test('fs.browse: an unreadable child is listed; browsing it says permission denied', { skip: isRoot || process.platform === 'win32' }, async (t) => {
  const { home } = fixture(t);
  mkdirSync(join(home, 'locked', 'inner'), { recursive: true });
  chmodSync(join(home, 'locked'), 0o000);
  const b = new FsBrowser({ home });
  const r = await b.browse();
  const locked = r.entries.find((e) => e.name === 'locked');
  assert.ok(locked, 'locked directory listed');
  assert.equal(locked.git, undefined);
  await assert.rejects(b.browse({ path: '~/locked' }), rejectsWith('bad_request', /permission denied/));
  await assert.rejects(b.complete({ prefix: '~/locked/i' }), rejectsWith('bad_request', /permission denied/));
});

test('fs.browse: entry cap sets truncated', async (t) => {
  const { root } = fixture(t);
  const many = join(root, 'many');
  for (let i = 0; i < 12; i++) mkdirSync(join(many, `d${String(i).padStart(2, '0')}`), { recursive: true });
  const b = new FsBrowser({ home: root, maxEntries: 5 });
  const r = await b.browse({ path: many });
  assert.equal(r.truncated, true);
  assert.deepEqual(names(r.entries), ['d00', 'd01', 'd02', 'd03', 'd04']);
  const big = new FsBrowser({ home: root, maxEntries: 12 });
  assert.equal((await big.browse({ path: many })).truncated, false);
});

test('fs.complete: shell-like, base keeps the typed form, case behavior behind a flag', async (t) => {
  const { home } = fixture(t);
  const cs = new FsBrowser({ home, caseInsensitive: false });
  const ci = new FsBrowser({ home, caseInsensitive: true });

  const re = await cs.complete({ prefix: '~/re' });
  assert.equal(re.base, '~/');
  assert.deepEqual(names(re.completions), ['react', 'repo']);
  assert.equal(re.completions[1]!.path, join(home, 'repo'));

  // Exact-case matches first, then case-folded ones (only when case-insensitive).
  assert.deepEqual(names((await cs.complete({ prefix: '~/r' })).completions), ['react', 'repo']);
  assert.deepEqual(names((await ci.complete({ prefix: '~/r' })).completions), ['react', 'repo', 'Rust']);
  assert.deepEqual(names((await ci.complete({ prefix: '~/R' })).completions), ['Rust', 'react', 'repo']);

  // A trailing separator lists the directory; absolute prefixes keep their form.
  const src = await cs.complete({ prefix: `${home}/src/` });
  assert.equal(src.base, `${home}/src/`);
  assert.deepEqual(names(src.completions), ['alpha', 'beta', 'gamma']);
  assert.equal(src.completions[0]!.git, true);
  assert.deepEqual(names((await cs.complete({ prefix: `${home}/src/b` })).completions), ['beta']);

  // Bare `~` (and empty) complete inside home.
  assert.equal((await cs.complete({ prefix: '~' })).base, '~/');
  assert.ok(names((await cs.complete({ prefix: '' })).completions).includes('src'));

  // Hidden only when asked or when the typed name starts with '.'.
  assert.deepEqual(names((await cs.complete({ prefix: '~/' })).completions).filter((n) => n.startsWith('.')), []);
  assert.deepEqual(names((await cs.complete({ prefix: '~/.' })).completions), ['.config', '.hidden-repo']);
  assert.ok(names((await cs.complete({ prefix: '~/', showHidden: true })).completions).includes('.config'));

  // Symlinks to directories complete; links to files, dangling links and loops don't.
  assert.deepEqual(names((await cs.complete({ prefix: '~/l' })).completions), ['link-src']);
  assert.deepEqual(names((await cs.complete({ prefix: '~/d' })).completions), []);

  // limit, a missing directory, a relative prefix.
  assert.equal((await cs.complete({ prefix: '~/', limit: 2 })).completions.length, 2);
  assert.deepEqual(await cs.complete({ prefix: '~/missing/x' }), { completions: [], base: '~/missing/' });
  await assert.rejects(cs.complete({ prefix: 'src/a' }), rejectsWith('bad_request'));
});

test('fs.suggest: home, source roots, recent parents and repos that are not workspaces yet', async (t) => {
  const { home } = fixture(t);
  mkdirSync(join(home, 'repo', 'one', '.git'), { recursive: true });
  mkdirSync(join(home, 'elsewhere', 'proj'), { recursive: true });
  const ws = [
    { id: 'w_alpha', machineId: 'm', name: 'alpha', path: join(home, 'src', 'alpha'), kind: 'git' as const, createdAt: '2026-01-01T00:00:00Z' },
    { id: 'w_proj', machineId: 'm', name: 'proj', path: join(home, 'elsewhere', 'proj'), kind: 'dir' as const, createdAt: '2026-02-01T00:00:00Z' },
  ];
  const b = new FsBrowser({ home, workspaces: () => ws });
  const { entries } = await b.suggest();
  const by = (s: BrowseEntry['suggest']) => entries.filter((e) => e.suggest === s).map((e) => e.path);
  assert.deepEqual(by('home'), [home]);
  assert.deepEqual(by('root'), [join(home, 'src'), join(home, 'repo')]);
  // src is already a root, so only elsewhere is a "recent" parent.
  assert.deepEqual(by('recent'), [join(home, 'elsewhere')]);
  // alpha is a workspace already; gamma has a .git file (worktree); one is under ~/repo.
  assert.deepEqual(by('repo').sort(), [join(home, 'repo', 'one'), join(home, 'src', 'gamma')].sort());
  assert.ok(entries.every((e) => e.kind === 'dir'));
});

test('node: fs.browse marks workspaces, checks machineId; fs.complete validates params', async (t) => {
  const { home, root } = fixture(t);
  const node = await createNode({ dataDir: join(root, 'data'), adapters: [new FakeAdapter()], version: '0', browse: { home, caseInsensitive: false } });
  t.after(() => node.close());
  const { workspace } = await node.call('workspace.create', { path: join(home, 'src', 'alpha') });
  const r = await node.call('fs.browse', { path: '~/src', machineId: node.machine.id });
  assert.equal(r.entries.find((e) => e.name === 'alpha')?.workspaceId, workspace.id);
  assert.equal(r.entries.find((e) => e.name === 'beta')?.workspaceId, undefined);
  // Through a symlinked parent the real path still matches.
  const viaLink = await node.call('fs.browse', { path: '~/link-src' });
  assert.equal(viaLink.entries.find((e) => e.name === 'alpha')?.workspaceId, workspace.id);
  await assert.rejects(node.call('fs.browse', { machineId: 'm_other' }), rejectsWith('not_found'));
  await assert.rejects(node.dispatch('fs.complete', {}), rejectsWith('bad_request'));
  await assert.rejects(node.dispatch('fs.complete', { prefix: '~/', limit: 0 }), rejectsWith('bad_request'));
  await assert.rejects(node.dispatch('fs.browse', { showHidden: 'yes' }), rejectsWith('bad_request'));
  const { completions } = await node.call('fs.complete', { prefix: '~/src/al' });
  assert.equal(completions[0]?.workspaceId, workspace.id);
  const { entries } = await node.call('fs.suggest', {});
  assert.ok(entries.some((e) => e.path === join(home, 'src', 'gamma') && e.suggest === 'repo'));
});
