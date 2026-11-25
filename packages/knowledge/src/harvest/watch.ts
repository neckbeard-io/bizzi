// Watches agent memory directories so harvest runs when an agent saves a memory, including from
// agent sessions bizzi didn't start (a plain `claude` in a terminal; knowledge.md §8).
//
// A memory directory usually doesn't exist until the agent's first memory in that directory, so a
// missing one is watched through its deepest existing ancestor (never above `root`, e.g.
// ~/.claude). Any event there re-arms: once the directory appears it is watched itself and
// `onChange` fires (files may already be in it). If it disappears, the watch moves back up.
// `rearm()` retries targets whose whole chain was missing (call it now and then).

import { watch as fsWatch, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { Logger } from '@bizzi/protocol';

export interface DirWatcher {
  close(): void;
  on?(event: 'error', listener: (err: Error) => void): unknown;
}

/** `fs.watch`-compatible (tests inject a fake). */
export type DirWatchFn = (path: string, listener: (event: string, filename: string | Buffer | null) => void) => DirWatcher;

export interface MemoryDirWatcherOptions {
  /** Highest directory ever watched while waiting for a memory directory to appear. */
  root: string;
  /** Called with the target's key once its directory has been quiet for `debounceMs`. */
  onChange: (key: string) => void;
  debounceMs?: number;
  watchFn?: DirWatchFn;
  logger?: Logger;
}

interface Target {
  dir: string;
  /** Path currently watched: `dir` itself or an ancestor. */
  watching?: string;
  watcher?: DirWatcher;
}

const defaultWatch: DirWatchFn = (path, listener) => fsWatch(path, { persistent: false }, listener);

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function within(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export class MemoryDirWatcher {
  readonly #opts: MemoryDirWatcherOptions;
  readonly #root: string;
  readonly #debounceMs: number;
  readonly #targets = new Map<string, Target>();
  readonly #timers = new Map<string, NodeJS.Timeout>();
  #closed = false;

  constructor(opts: MemoryDirWatcherOptions) {
    this.#opts = opts;
    this.#root = resolve(opts.root);
    this.#debounceMs = opts.debounceMs ?? 1000;
  }

  /** key → path being watched for it (the directory itself, or the ancestor waiting for it). */
  watched(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, t] of this.#targets) if (t.watching) out[key] = t.watching;
    return out;
  }

  /** Watch exactly these directories (key → dir): new ones are added, dropped ones closed. */
  update(targets: ReadonlyMap<string, string>): void {
    if (this.#closed) return;
    for (const [key, t] of this.#targets) {
      const want = targets.get(key);
      if (want === undefined || resolve(want) !== t.dir) {
        this.#unwatch(t);
        this.#targets.delete(key);
        const timer = this.#timers.get(key);
        if (timer) clearTimeout(timer);
        this.#timers.delete(key);
      }
    }
    for (const [key, dir] of targets) {
      if (this.#targets.has(key)) continue;
      const t: Target = { dir: resolve(dir) };
      this.#targets.set(key, t);
      this.#arm(key, t);
    }
  }

  /** Re-evaluate every target (directories created or removed without an event we saw). */
  rearm(): void {
    if (this.#closed) return;
    for (const [key, t] of this.#targets) {
      const was = t.watching;
      this.#arm(key, t);
      if (t.watching === t.dir && was !== t.dir) this.#schedule(key);
    }
  }

  close(): void {
    this.#closed = true;
    for (const t of this.#timers.values()) clearTimeout(t);
    this.#timers.clear();
    for (const t of this.#targets.values()) this.#unwatch(t);
    this.#targets.clear();
  }

  /** Deepest existing directory on the way from `dir` up to the root (or `dir` alone when outside it). */
  #deepest(dir: string): string | undefined {
    if (isDir(dir)) return dir;
    if (!within(this.#root, dir)) return undefined;
    let cur = dir;
    while (cur !== this.#root) {
      const up = dirname(cur);
      if (up === cur) return undefined;
      cur = up;
      if (isDir(cur)) return cur;
    }
    return undefined;
  }

  #unwatch(t: Target): void {
    t.watcher?.close();
    delete t.watcher;
    delete t.watching;
  }

  #arm(key: string, t: Target): void {
    const want = this.#deepest(t.dir);
    if (want === t.watching && t.watcher) return;
    this.#unwatch(t);
    if (want === undefined) return;
    try {
      const watcher = (this.#opts.watchFn ?? defaultWatch)(want, () => this.#onEvent(key, t, watcher));
      watcher.on?.('error', (err) => {
        this.#opts.logger?.log('debug', 'memory dir watch failed; will retry', { key, path: want, err: String(err) });
        if (t.watcher === watcher) this.#unwatch(t);
      });
      t.watcher = watcher;
      t.watching = want;
    } catch (err) {
      this.#opts.logger?.log('debug', 'cannot watch memory dir', { key, path: want, err: String(err) });
    }
  }

  #onEvent(key: string, t: Target, from: DirWatcher): void {
    if (this.#closed || t.watcher !== from || this.#targets.get(key) !== t) return;
    this.#arm(key, t);
    if (t.watching === t.dir) this.#schedule(key);
  }

  #schedule(key: string): void {
    if (this.#closed) return;
    const prev = this.#timers.get(key);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      this.#timers.delete(key);
      if (this.#closed || !this.#targets.has(key)) return;
      try {
        this.#opts.onChange(key);
      } catch (err) {
        this.#opts.logger?.log('warn', 'memory change handler threw', { key, err: String(err) });
      }
    }, this.#debounceMs);
    timer.unref();
    this.#timers.set(key, timer);
  }
}
