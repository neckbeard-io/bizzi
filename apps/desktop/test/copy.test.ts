import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copiesDir, ensureCoreCopy, pruneCoreCopies, readCoreId } from '../src/core/copy.ts';

function resources(t: { after: (fn: () => void) => void }, id = 'abcdef0123456789'): { res: string; data: string } {
  const root = mkdtempSync(join(tmpdir(), 'bizzi-core-copy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const res = join(root, 'Resources');
  mkdirSync(join(res, 'core', 'apps', 'cli', 'src'), { recursive: true });
  mkdirSync(join(res, 'node', 'bin'), { recursive: true });
  writeFileSync(join(res, 'core', 'apps', 'cli', 'src', 'main.ts'), '// entry\n');
  writeFileSync(join(res, 'core', 'core-id'), id + '\n');
  writeFileSync(join(res, 'node', 'bin', 'node'), 'binary');
  return { res, data: join(root, 'data') };
}

test('readCoreId reads the stamped id and rejects junk', (t) => {
  const { res } = resources(t);
  assert.equal(readCoreId(res), 'abcdef0123456789');
  writeFileSync(join(res, 'core', 'core-id'), '../../etc\n');
  assert.equal(readCoreId(res), null);
  assert.equal(readCoreId(join(res, 'missing')), null);
});

for (const platform of ['darwin', 'linux'] as const) {
  test(`ensureCoreCopy lays out core and node under <data>/core/<id> once (${platform})`, async (t) => {
    const { res, data } = resources(t);
    const dir = await ensureCoreCopy(res, data, 'abcdef0123456789', { platform });
    assert.equal(dir, join(copiesDir(data), 'abcdef0123456789'));
    assert.equal(readFileSync(join(dir, 'core', 'apps', 'cli', 'src', 'main.ts'), 'utf8'), '// entry\n');
    assert.equal(readFileSync(join(dir, 'node', 'bin', 'node'), 'utf8'), 'binary');
    // Already complete: not copied again (the bundle may have changed under it since).
    writeFileSync(join(res, 'node', 'bin', 'node'), 'changed');
    await ensureCoreCopy(res, data, 'abcdef0123456789', { platform });
    assert.equal(readFileSync(join(dir, 'node', 'bin', 'node'), 'utf8'), 'binary');
    assert.deepEqual(readdirSync(copiesDir(data)), ['abcdef0123456789'], 'no temp dirs left behind');
  });
}

test('a failed copy leaves nothing that looks complete', async (t) => {
  const { res, data } = resources(t);
  await assert.rejects(
    ensureCoreCopy(res, data, 'abcdef0123456789', {
      copyTree: async (_from, to) => {
        mkdirSync(to, { recursive: true });
        throw new Error('disk full');
      },
    }),
    /disk full/,
  );
  assert.deepEqual(existsSync(copiesDir(data)) ? readdirSync(copiesDir(data)) : [], []);
});

test('pruneCoreCopies keeps the current and the running core', (t) => {
  const { data } = resources(t);
  for (const name of ['aaaa', 'bbbb', 'cccc', 'dddd.tmp-1-2']) mkdirSync(join(copiesDir(data), name), { recursive: true });
  assert.deepEqual(pruneCoreCopies(data, ['aaaa', 'cccc', null]).sort(), ['bbbb', 'dddd.tmp-1-2']);
  assert.deepEqual(readdirSync(copiesDir(data)).sort(), ['aaaa', 'cccc']);
});
