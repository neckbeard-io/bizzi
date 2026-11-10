// File-system watches on the paths that change when an agent is updated (updates.md §2), with a
// per-agent debounce. Missing paths are tolerated: a path whose directory doesn't exist yet is
// picked up on the next `update()` (the periodic probe calls it).

import { watch as fsWatch, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { AgentKind, Logger } from '@bizzi/protocol';

export interface Watcher {
  close(): void;
  on?(event: 'error', listener: (err: Error) => void): unknown;
}

/** `fs.watch`-compatible (tests inject a fake). */
export type WatchFn = (path: string, listener: (event: string, filename: string | Buffer | null) => void) => Watcher;

export interface InstallWatcherOptions {
  /** Called once per agent after its paths have been quiet for `debounceMs`. */
  onChange: (agent: AgentKind) => void;
  debounceMs?: number;
  watchFn?: WatchFn;
  logger?: Logger;
}

interface Entry {
  /** Directory actually watched. */
  dir: string;
  /** Only events for this entry name count (watching a file through its directory). */
  name?: string;
  watcher: Watcher;
}

const defaultWatch: WatchFn = (path, listener) => fsWatch(path, { persistent: false }, listener);

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export class InstallWatcher {
  readonly #opts: InstallWatcherOptions;
  readonly #debounceMs: number;
  /** agent → watched path → entry */
  readonly #entries = new Map<AgentKind, Map<string, Entry>>();
  readonly #timers = new Map<AgentKind, NodeJS.Timeout>();
  #closed = false;

  constructor(opts: InstallWatcherOptions) {
    this.#opts = opts;
    this.#debounceMs = opts.debounceMs ?? 2000;
  }

  /** Paths currently watched per agent (the requested paths, not the parent dirs). */
  watched(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [agent, m] of this.#entries) if (m.size) out[agent] = [...m.keys()].sort();
    return out;
  }

  /** Watch exactly these paths per agent: new ones are added, dropped ones closed, failed ones retried. */
  update(targets: ReadonlyMap<AgentKind, readonly string[]>): void {
    if (this.#closed) return;
    for (const [agent, entries] of this.#entries) {
      const want = new Set(targets.get(agent) ?? []);
      for (const [path, e] of entries) {
        if (!want.has(path)) {
          e.watcher.close();
          entries.delete(path);
        }
      }
    }
    for (const [agent, paths] of targets) {
      let entries = this.#entries.get(agent);
      if (!entries) {
        entries = new Map();
        this.#entries.set(agent, entries);
      }
      for (const path of paths) {
        if (entries.has(path)) continue;
        const e = this.#watch(agent, path, entries);
        if (e) entries.set(path, e);
      }
    }
  }

  #watch(agent: AgentKind, path: string, entries: Map<string, Entry>): Entry | undefined {
    // A directory is watched itself; a file or symlink (or a not-yet-existing path) via its parent.
    const dir = isDir(path) ? path : dirname(path);
    const name = dir === path ? undefined : basename(path);
    if (!isDir(dir)) return undefined;
    try {
      const watcher = (this.#opts.watchFn ?? defaultWatch)(dir, (_event, filename) => {
        const f = filename === null ? null : String(filename);
        if (name && f !== null && f !== name) return;
        this.#trigger(agent);
      });
      watcher.on?.('error', (err) => {
        this.#opts.logger?.log('debug', 'install watch failed; will retry', { agent, path, err: String(err) });
        watcher.close();
        entries.delete(path);
      });
      return { dir, ...(name ? { name } : {}), watcher };
    } catch (err) {
      this.#opts.logger?.log('debug', 'cannot watch install path', { agent, path, err: String(err) });
      return undefined;
    }
  }

  #trigger(agent: AgentKind): void {
    if (this.#closed) return;
    const prev = this.#timers.get(agent);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      this.#timers.delete(agent);
      if (this.#closed) return;
      try {
        this.#opts.onChange(agent);
      } catch (err) {
        this.#opts.logger?.log('warn', 'install change handler threw', { agent, err: String(err) });
      }
    }, this.#debounceMs);
    t.unref();
    this.#timers.set(agent, t);
  }

  close(): void {
    this.#closed = true;
    for (const t of this.#timers.values()) clearTimeout(t);
    this.#timers.clear();
    for (const entries of this.#entries.values()) for (const e of entries.values()) e.watcher.close();
    this.#entries.clear();
  }
}
