// Workspace picker: fs.browse / fs.complete / fs.suggest (spec §5.2, §10).
//
// Security: unlike fs.list / fs.read, these are NOT confined to a workspace. They run as the node's OS
// user and can list any directory that user can, which is the same trust a paired device already has
// through a terminal session (`session.create` mode 'terminal', agent 'shell'). They only ever return
// directory names (and symlinks that resolve to directories) plus a `.git` presence bit; they never read
// file contents, never write, and every call does bounded work (entry caps, a time budget for suggest).

import type { Dirent, Stats } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BizziError, type BrowseEntry, type MethodResult, type WorkspaceInfo } from '@bizzi/protocol';

/** Most entries one fs.browse returns; the rest are dropped and `truncated` is set. */
export const MAX_BROWSE_ENTRIES = 2000;
export const DEFAULT_COMPLETE_LIMIT = 50;
export const MAX_COMPLETE_LIMIT = 500;
/** Source roots fs.suggest looks for under home. */
export const SOURCE_ROOTS = ['src', 'repo', 'repos', 'code', 'projects', 'dev', 'Developer', 'work', 'git'];
const SUGGEST_RECENT = 8;
const SUGGEST_REPOS = 24;
const SUGGEST_SCAN_PER_ROOT = 400;
const SUGGEST_BUDGET_MS = 400;
/** Parallel stats per listing (git detection, symlink targets). */
const STAT_CONCURRENCY = 32;

export interface BrowserOptions {
  /** The node user's home (default os.homedir()). */
  home?: string;
  /** Match names ignoring case (default: true on darwin and win32, as their default filesystems are). */
  caseInsensitive?: boolean;
  /** Registered workspaces, to mark entries that already are one. */
  workspaces?: () => readonly WorkspaceInfo[];
  maxEntries?: number;
}

interface Candidate {
  name: string;
  /** Absolute, lexical. */
  path: string;
  dirent: Dirent;
}

export class FsBrowser {
  readonly home: string;
  readonly caseInsensitive: boolean;
  readonly #workspaces: () => readonly WorkspaceInfo[];
  readonly #maxEntries: number;
  readonly #path = path;

  constructor(opts: BrowserOptions = {}) {
    this.home = this.#path.resolve(opts.home ?? os.homedir());
    this.caseInsensitive = opts.caseInsensitive ?? (process.platform === 'darwin' || process.platform === 'win32');
    this.#workspaces = opts.workspaces ?? (() => []);
    this.#maxEntries = opts.maxEntries ?? MAX_BROWSE_ENTRIES;
  }

  /** `~` / `~/x` → home-based; must then be absolute. Returns a normalized absolute path. */
  expand(p: string): string {
    if (p.includes('\0')) throw new BizziError('bad_request', 'invalid path');
    const P = this.#path;
    let raw = p.trim();
    if (raw === '' || raw === '~') raw = this.home;
    else if (raw.startsWith('~/') || (P.sep === '\\' && raw.startsWith('~\\'))) raw = P.join(this.home, raw.slice(2));
    if (!P.isAbsolute(raw)) throw new BizziError('bad_request', `path must be absolute or start with ~ (got ${p})`);
    return P.resolve(raw);
  }

  async browse(opts: { path?: string; showHidden?: boolean } = {}): Promise<MethodResult<'fs.browse'>> {
    const dir = this.expand(opts.path ?? '~');
    let st: Stats;
    try {
      st = await stat(dir);
    } catch (err) {
      throw pathError(err, dir);
    }
    if (!st.isDirectory()) throw new BizziError('bad_request', `${dir} is not a directory`);
    let dirents: Dirent[];
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      throw pathError(err, dir);
    }
    const candidates: Candidate[] = [];
    for (const d of dirents) {
      if (!d.isDirectory() && !d.isSymbolicLink()) continue;
      if (!opts.showHidden && d.name.startsWith('.')) continue;
      candidates.push({ name: d.name, path: this.#path.join(dir, d.name), dirent: d });
    }
    candidates.sort((a, b) => compareNames(a.name, b.name));
    // Symlinks are only kept when they resolve to a directory, so cap after resolving, in sorted order.
    const { entries, truncated } = await this.#entries(dir, candidates, this.#maxEntries);
    const parent = this.#path.dirname(dir);
    const result: MethodResult<'fs.browse'> = { path: dir, home: this.home, entries, truncated };
    if (parent !== dir) result.parent = parent;
    return result;
  }

  async complete(opts: { prefix: string; limit?: number; showHidden?: boolean }): Promise<MethodResult<'fs.complete'>> {
    const { base, partial } = this.#splitPrefix(opts.prefix);
    const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_COMPLETE_LIMIT), MAX_COMPLETE_LIMIT);
    const dir = this.expand(base);
    let dirents: Dirent[];
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      // A directory that doesn't exist (yet) simply has no completions; permission errors are reported.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return { completions: [], base };
      throw pathError(err, dir);
    }
    const showHidden = opts.showHidden === true || partial.startsWith('.');
    const lower = partial.toLowerCase();
    const exact: Candidate[] = [];
    const folded: Candidate[] = [];
    for (const d of dirents) {
      if (!d.isDirectory() && !d.isSymbolicLink()) continue;
      if (!showHidden && d.name.startsWith('.')) continue;
      const c = { name: d.name, path: this.#path.join(dir, d.name), dirent: d };
      if (d.name.startsWith(partial)) exact.push(c);
      else if (this.caseInsensitive && d.name.toLowerCase().startsWith(lower)) folded.push(c);
    }
    exact.sort((a, b) => compareNames(a.name, b.name));
    folded.sort((a, b) => compareNames(a.name, b.name));
    const { entries } = await this.#entries(dir, [...exact, ...folded], limit);
    return { completions: entries, base };
  }

  /** Starting points (bounded by counts and a time budget; a slow or unreadable root is skipped). */
  async suggest(): Promise<MethodResult<'fs.suggest'>> {
    const deadline = Date.now() + SUGGEST_BUDGET_MS;
    const P = this.#path;
    const out: BrowseEntry[] = [];
    const seen = new Set<string>();
    const wsByReal = this.#workspaceIndex();
    const push = (e: BrowseEntry): void => {
      if (seen.has(e.path)) return;
      seen.add(e.path);
      out.push(e);
    };

    push({ name: '~', path: this.home, kind: 'dir', suggest: 'home' });

    const roots: string[] = [];
    await Promise.all(
      SOURCE_ROOTS.map(async (name) => {
        const p = P.join(this.home, name);
        const st = await stat(p).catch(() => undefined);
        if (st?.isDirectory()) roots.push(p);
      }),
    );
    roots.sort((a, b) => SOURCE_ROOTS.indexOf(P.basename(a)) - SOURCE_ROOTS.indexOf(P.basename(b)));
    for (const p of roots) push({ name: P.basename(p), path: p, kind: 'dir', suggest: 'root' });

    // Parents of existing workspaces, most recently added first (worktree folders are skipped).
    const recent = [...this.#workspaces()]
      .filter((w) => w.kind !== 'worktree')
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .map((w) => P.dirname(w.path))
      .filter((p, i, all) => all.indexOf(p) === i && p !== P.dirname(p));
    let recentCount = 0;
    for (const p of recent) {
      if (recentCount >= SUGGEST_RECENT || Date.now() > deadline) break;
      if (seen.has(p)) continue;
      const st = await stat(p).catch(() => undefined);
      if (!st?.isDirectory()) continue;
      push({ name: P.basename(p) || p, path: p, kind: 'dir', suggest: 'recent' });
      recentCount++;
    }

    // Git repositories one level under the roots and recent parents that aren't workspaces yet.
    const scan = [...roots, ...out.filter((e) => e.suggest === 'recent').map((e) => e.path)];
    let repos = 0;
    for (const root of scan) {
      if (repos >= SUGGEST_REPOS || Date.now() > deadline) break;
      const dirents = await readdir(root, { withFileTypes: true }).catch(() => [] as Dirent[]);
      const names = dirents
        .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && !d.name.startsWith('.'))
        .map((d) => d.name)
        .sort(compareNames)
        .slice(0, SUGGEST_SCAN_PER_ROOT);
      const found = await mapLimit(names, STAT_CONCURRENCY, async (name) => {
        if (Date.now() > deadline) return undefined;
        const p = P.join(root, name);
        if (!(await hasGit(p))) return undefined;
        const real = await realpath(p).catch(() => p);
        if (wsByReal.has(real)) return undefined;
        return p;
      });
      for (const p of found) {
        if (!p || repos >= SUGGEST_REPOS) continue;
        if (seen.has(p)) continue;
        push({ name: P.basename(p), path: p, kind: 'dir', git: true, suggest: 'repo' });
        repos++;
      }
    }

    // Decorate the non-repo entries (home, roots, recent) with git and workspace marks.
    await mapLimit(out, STAT_CONCURRENCY, async (e) => {
      if (e.suggest === 'repo') return;
      if (await hasGit(e.path)) e.git = true;
      const real = await realpath(e.path).catch(() => e.path);
      const ws = wsByReal.get(real);
      if (ws) e.workspaceId = ws;
    });
    return { entries: out };
  }

  /** Split a typed prefix into the directory part as typed (`~/`, `/a/b/`) and the partial name. */
  #splitPrefix(prefix: string): { base: string; partial: string } {
    if (prefix.includes('\0')) throw new BizziError('bad_request', 'invalid prefix');
    if (prefix === '' || prefix === '~') return { base: '~/', partial: '' };
    const seps = this.#path.sep === '\\' ? /[\\/]/g : /\//g;
    let cut = -1;
    for (const m of prefix.matchAll(seps)) cut = m.index;
    if (cut < 0) {
      // "C:" on Windows: complete inside the drive root.
      if (this.#path.sep === '\\' && /^[A-Za-z]:$/.test(prefix)) return { base: `${prefix}\\`, partial: '' };
      throw new BizziError('bad_request', `prefix must be absolute or start with ~ (got ${prefix})`);
    }
    return { base: prefix.slice(0, cut + 1), partial: prefix.slice(cut + 1) };
  }

  #workspaceIndex(): Map<string, string> {
    const m = new Map<string, string>();
    for (const w of this.#workspaces()) m.set(w.path, w.id);
    return m;
  }

  /**
   * Resolve candidates (in order) into entries until `cap` directories are found: symlinks must resolve
   * to a directory (dangling links and loops, ELOOP, are skipped), children we can't stat are skipped,
   * never thrown. Adds git / workspace / hidden marks.
   */
  async #entries(dir: string, candidates: Candidate[], cap: number): Promise<{ entries: BrowseEntry[]; truncated: boolean }> {
    const wsByReal = this.#workspaceIndex();
    // Real path of the listed directory, so a child's real path is a cheap join (workspaces store real paths).
    const realDir = await realpath(dir).catch(() => dir);
    const entries: BrowseEntry[] = [];
    let i = 0;
    while (i < candidates.length && entries.length < cap) {
      const batch = candidates.slice(i, i + Math.max(STAT_CONCURRENCY, cap - entries.length));
      i += batch.length;
      const resolved = await mapLimit(batch, STAT_CONCURRENCY, async (c): Promise<BrowseEntry | undefined> => {
        let real = this.#path.join(realDir, c.name);
        let kind: BrowseEntry['kind'] = 'dir';
        if (c.dirent.isSymbolicLink()) {
          const st = await stat(c.path).catch(() => undefined);
          if (!st?.isDirectory()) return undefined;
          kind = 'symlink';
          real = await realpath(c.path).catch(() => real);
        }
        const e: BrowseEntry = { name: c.name, path: c.path, kind };
        if (await hasGit(c.path)) e.git = true;
        const ws = wsByReal.get(real);
        if (ws) e.workspaceId = ws;
        if (c.name.startsWith('.')) e.hidden = true;
        return e;
      });
      for (const e of resolved) {
        if (!e) continue;
        if (entries.length >= cap) return { entries, truncated: true };
        entries.push(e);
      }
    }
    // More candidates left over means the cap cut the listing (they may all have been dangling links,
    // but a cheap over-report is better than resolving thousands of links to find out).
    return { entries, truncated: i < candidates.length };
  }
}

/** Case-insensitive first, then by code point, so `Apps` and `apps` stay stable. */
function compareNames(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la !== lb) return la < lb ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `.git` as a directory (repo) or a file (worktree / submodule); one stat, never read. */
async function hasGit(dir: string): Promise<boolean> {
  const st = await stat(path.join(dir, '.git')).catch(() => undefined);
  return st !== undefined && (st.isDirectory() || st.isFile());
}

function pathError(err: unknown, p: string): BizziError {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return new BizziError('not_found', `${p} does not exist`, { path: p });
  if (code === 'ENOTDIR') return new BizziError('bad_request', `${p} is not a directory`, { path: p });
  if (code === 'EACCES' || code === 'EPERM') return new BizziError('bad_request', `permission denied: ${p}`, { path: p, errno: code });
  if (code === 'ELOOP') return new BizziError('bad_request', `too many symbolic links: ${p}`, { path: p, errno: code });
  return new BizziError('internal', `cannot read ${p}: ${(err as Error).message}`, { path: p, errno: code });
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
