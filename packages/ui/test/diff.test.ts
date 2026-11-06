import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffStats, parseUnifiedDiff } from '../src/lib/diff.ts';

const GIT_DIFF = `diff --git a/src/a.ts b/src/a.ts
index 3b18e51..a1c2f0d 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@ export function a() {
 const x = 1;
-const y = 2;
+const y = 3;
+const z = 4;
 return x;
 }
@@ -10,2 +11,2 @@
--- old dashes line
+++ new plus line
diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..8d1c8b6
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
\\ No newline at end of file
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/old/name.ts b/new/name.ts
similarity index 100%
rename from old/name.ts
rename to new/name.ts
diff --git a/img.png b/img.png
index 1..2 100644
Binary files a/img.png and b/img.png differ
`;

test('parses a multi-file git diff', () => {
  const files = parseUnifiedDiff(GIT_DIFF);
  assert.deepEqual(
    files.map((f) => [f.path, f.status, f.additions, f.deletions, f.binary]),
    [
      ['src/a.ts', 'modified', 3, 2, false],
      ['new.txt', 'added', 2, 0, false],
      ['gone.txt', 'deleted', 0, 1, false],
      ['new/name.ts', 'renamed', 0, 0, false],
      ['img.png', 'modified', 0, 0, true],
    ],
  );
  assert.equal(files[3]?.oldPath, 'old/name.ts');
  assert.deepEqual(diffStats(files), { files: 5, additions: 5, deletions: 3 });
});

test('numbers lines and treats ---/+++ inside a hunk as content', () => {
  const [a] = parseUnifiedDiff(GIT_DIFF);
  assert.ok(a);
  const lines = a.lines;
  assert.equal(lines[0]?.type, 'hunk');
  assert.deepEqual(lines[1], { type: 'context', text: 'const x = 1;', oldNo: 1, newNo: 1 });
  assert.deepEqual(lines[2], { type: 'del', text: 'const y = 2;', oldNo: 2 });
  assert.deepEqual(lines[3], { type: 'add', text: 'const y = 3;', newNo: 2 });
  assert.deepEqual(lines[4], { type: 'add', text: 'const z = 4;', newNo: 3 });
  assert.deepEqual(lines[5], { type: 'context', text: 'return x;', oldNo: 3, newNo: 4 });
  const del = lines.find((l) => l.text === '-- old dashes line');
  assert.deepEqual(del, { type: 'del', text: '-- old dashes line', oldNo: 10 });
  const add = lines.find((l) => l.text === '++ new plus line');
  assert.deepEqual(add, { type: 'add', text: '++ new plus line', newNo: 11 });
});

test('no-newline marker', () => {
  const files = parseUnifiedDiff(GIT_DIFF);
  const added = files[1];
  assert.equal(added?.lines.at(-1)?.type, 'noeol');
});

test('bare hunk uses the fallback path', () => {
  const files = parseUnifiedDiff('@@ -1 +1 @@\n-a\n+b\n', 'src/x.ts');
  assert.equal(files.length, 1);
  assert.equal(files[0]?.path, 'src/x.ts');
  assert.equal(files[0]?.status, 'modified');
  assert.deepEqual(diffStats(files), { files: 1, additions: 1, deletions: 1 });
});

test('plain diff -u without git headers, CRLF tolerant', () => {
  const text = '--- a.txt\t2026-01-01\r\n+++ b.txt\t2026-01-02\r\n@@ -1,2 +1,2 @@\r\n same\r\n-old\r\n+new\r\n';
  const [f] = parseUnifiedDiff(text);
  assert.equal(f?.path, 'b.txt');
  assert.equal(f?.oldPath, 'a.txt');
  assert.equal(f?.lines.length, 4);
});

test('empty input yields no files', () => {
  assert.deepEqual(parseUnifiedDiff(''), []);
});
