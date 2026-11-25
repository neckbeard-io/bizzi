import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryDirWatcher } from '../src/index.ts';
import type { DirWatchFn } from '../src/index.ts';
import { tempDir } from './helpers.ts';

interface FakeWatch {
  path: string;
  fire(): void;
  closed: boolean;
}

function fakeWatch(): { fn: DirWatchFn; all: FakeWatch[]; open(): string[]; fire(path: string): void } {
  const all: FakeWatch[] = [];
  const fn: DirWatchFn = (path, listener) => {
    const w: FakeWatch = { path, closed: false, fire: () => listener('rename', null) };
    all.push(w);
    return {
      close() {
        w.closed = true;
      },
    };
  };
  return {
    fn,
    all,
    open: () => all.filter((w) => !w.closed).map((w) => w.path).sort(),
    fire(path) {
      for (const w of all.filter((x) => !x.closed && x.path === path)) w.fire();
    },
  };
}

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test('a missing memory dir is watched through its deepest ancestor, then itself once it appears', async () => {
  const { dir: root, cleanup } = tempDir();
  try {
    const projects = join(root, 'projects');
    mkdirSync(projects);
    const mem = join(projects, '-repo-acme', 'memory');
    const fw = fakeWatch();
    const changes: string[] = [];
    const w = new MemoryDirWatcher({ root, debounceMs: 5, watchFn: fw.fn, onChange: (k) => changes.push(k) });
    w.update(new Map([['w1', mem]]));
    assert.deepEqual(w.watched(), { w1: projects });

    // Claude creates the project dir (transcripts) first: the watch moves down, no harvest yet.
    mkdirSync(join(projects, '-repo-acme'));
    fw.fire(projects);
    assert.deepEqual(fw.open(), [join(projects, '-repo-acme')]);
    await settle();
    assert.deepEqual(changes, []);

    // Then the memory dir: watched itself, and harvested (files may already be there).
    mkdirSync(mem);
    fw.fire(join(projects, '-repo-acme'));
    assert.deepEqual(w.watched(), { w1: mem });
    await settle();
    assert.deepEqual(changes, ['w1']);

    // Events in the dir are debounced into one harvest.
    fw.fire(mem);
    fw.fire(mem);
    fw.fire(mem);
    await settle();
    assert.deepEqual(changes, ['w1', 'w1']);

    // Removed: back up to the ancestor.
    rmSync(mem, { recursive: true });
    fw.fire(mem);
    assert.deepEqual(w.watched(), { w1: join(projects, '-repo-acme') });
    await settle();
    assert.deepEqual(changes, ['w1', 'w1']);

    // Dropped targets are closed.
    w.update(new Map());
    assert.deepEqual(fw.open(), []);
    assert.deepEqual(w.watched(), {});
    w.close();
  } finally {
    cleanup();
  }
});

test('rearm() picks up directories created without an event; nothing is watched above the root', async () => {
  const { dir: base, cleanup } = tempDir();
  try {
    const root = join(base, '.claude');
    const mem = join(root, 'projects', '-x', 'memory');
    const fw = fakeWatch();
    const changes: string[] = [];
    const w = new MemoryDirWatcher({ root, debounceMs: 5, watchFn: fw.fn, onChange: (k) => changes.push(k) });
    w.update(new Map([['w1', mem]]));
    assert.deepEqual(w.watched(), {}, 'root missing: nothing to watch');

    mkdirSync(mem, { recursive: true });
    w.rearm();
    assert.deepEqual(w.watched(), { w1: mem });
    await settle();
    assert.deepEqual(changes, ['w1']);
    w.rearm();
    await settle();
    assert.deepEqual(changes, ['w1'], 'no change, no harvest');

    // A dir outside the root is watched only when it exists.
    const outside = join(base, 'elsewhere', 'memory');
    w.update(new Map([['w1', mem], ['w2', outside]]));
    assert.deepEqual(w.watched(), { w1: mem });
    w.close();
    assert.deepEqual(fw.open(), []);
  } finally {
    cleanup();
  }
});
