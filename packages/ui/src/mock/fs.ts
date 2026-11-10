// Mock workspace picker (fs.browse / fs.complete / fs.suggest): a fake directory tree per machine.
// The laptop's home has src/ and repo/ with git repositories, hidden directories, an existing
// workspace (acme-shop), a symlink and an unreadable directory; mac-mini has a smaller tree.
import { BizziError } from '@bizzi/protocol';
import type { BrowseEntry } from '@bizzi/protocol';
import type { MockHost, MockModule } from './host.ts';

const METHODS = new Set(['fs.browse', 'fs.complete', 'fs.suggest']);
const ROOTS = ['src', 'repo', 'repos', 'code', 'projects', 'dev', 'Developer', 'work', 'git'];

/** A directory: `git` has a .git, `link` is a symlink to another absolute path, `locked` can't be read. */
interface Dir {
  git?: true;
  link?: string;
  locked?: true;
  children?: Record<string, Dir>;
}

const d = (children: Record<string, Dir> = {}): Dir => ({ children });
const repo = (children: Record<string, Dir> = {}): Dir => ({ git: true, children: { src: d(), ...children } });

function laptopTree(): Dir {
  return d({
    Users: d({
      dev: d({
        src: d({
          'acme-shop': repo({ docs: d(), tests: d(), node_modules: d() }),
          'acme-shop.worktrees': d({ 'feat-oauth': { git: true, children: {} } }),
          website: repo({ public: d() }),
          'api-gateway': repo(),
          'design-system': repo(),
          'Data-Pipelines': repo(),
          scratch: d(),
        }),
        repo: d({
          bizzi: repo({ packages: d(), apps: d(), docs: d() }),
          dotfiles: repo(),
          'infra-notes': d(),
          'rust-playground': repo(),
        }),
        research: d({ notes: d({ papers: d() }), datasets: d() }),
        Documents: d({ invoices: d() }),
        Downloads: d(),
        Desktop: d(),
        Library: d(),
        Pictures: d(),
        private: { locked: true, children: {} },
        projects: { link: '/Users/dev/src', children: {} },
        '.config': d({ nvim: d(), gh: d() }),
        '.ssh': d(),
        '.cache': d(),
        '.dotfiles-backup': repo(),
      }),
      Shared: d(),
    }),
    Applications: d(),
    opt: d({ homebrew: d() }),
    tmp: d(),
  });
}

function miniTree(): Dir {
  return d({
    Users: d({
      dev: d({
        src: d({ extensions: repo(), 'theme-lab': repo(), sandbox: d() }),
        Documents: d(),
        '.config': d(),
      }),
    }),
  });
}

const HOME = '/Users/dev';

export class MockFs implements MockModule {
  private readonly host: MockHost;
  private readonly trees = new Map<string, Dir>();

  constructor(host: MockHost) {
    this.host = host;
  }

  handles(method: string): boolean {
    return METHODS.has(method);
  }

  async handle(method: string, params: Record<string, unknown>): Promise<unknown> {
    const machine = this.host.requireOnline(params.machineId);
    await this.host.sleep(60);
    const tree = this.tree(machine.id);
    const showHidden = params.showHidden === true;
    switch (method) {
      case 'fs.browse': {
        const path = this.expand(typeof params.path === 'string' ? params.path : '~');
        const node = this.resolve(tree, path);
        if (!node) throw new BizziError('not_found', `${path} does not exist`, { path });
        if (node.locked) throw new BizziError('bad_request', `permission denied: ${path}`, { path, errno: 'EACCES' });
        const entries = this.list(machine.id, tree, path, node).filter((e) => showHidden || !e.hidden);
        const parent = path === '/' ? undefined : parentOf(path);
        return { path, ...(parent ? { parent } : {}), home: HOME, entries, truncated: false };
      }
      case 'fs.complete': {
        const prefix = typeof params.prefix === 'string' ? params.prefix : '';
        const limit = typeof params.limit === 'number' ? params.limit : 50;
        const { base, partial } = split(prefix);
        if (!base) throw new BizziError('bad_request', `prefix must be absolute or start with ~ (got ${prefix})`);
        const dirPath = this.expand(base);
        const node = this.resolve(tree, dirPath);
        if (!node) return { completions: [], base };
        if (node.locked) throw new BizziError('bad_request', `permission denied: ${dirPath}`, { path: dirPath, errno: 'EACCES' });
        const hidden = showHidden || partial.startsWith('.');
        const all = this.list(machine.id, tree, dirPath, node).filter((e) => hidden || !e.hidden);
        // macOS: case-insensitive, exact-case matches first.
        const exact = all.filter((e) => e.name.startsWith(partial));
        const folded = all.filter((e) => !e.name.startsWith(partial) && e.name.toLowerCase().startsWith(partial.toLowerCase()));
        return { completions: [...exact, ...folded].slice(0, limit), base };
      }
      case 'fs.suggest': {
        const out: BrowseEntry[] = [{ name: '~', path: HOME, kind: 'dir', suggest: 'home' }];
        const home = this.resolve(tree, HOME)!;
        for (const r of ROOTS) {
          const child = home.children?.[r];
          if (child) out.push({ name: r, path: `${HOME}/${r}`, kind: child.link ? 'symlink' : 'dir', suggest: 'root' });
        }
        const seen = new Set(out.map((e) => e.path));
        for (const w of this.host.workspaces().filter((x) => x.machineId === machine.id && x.kind !== 'worktree')) {
          const p = parentOf(w.path);
          if (seen.has(p) || !this.resolve(tree, p)) continue;
          seen.add(p);
          out.push({ name: p.split('/').pop() || p, path: p, kind: 'dir', suggest: 'recent' });
        }
        for (const e of [...out]) {
          if (e.kind === 'symlink') continue;
          const node = this.resolve(tree, e.path);
          for (const c of this.list(machine.id, tree, e.path, node!)) {
            if (c.git && !c.workspaceId && !c.hidden && !seen.has(c.path) && out.length < 20) {
              seen.add(c.path);
              out.push({ ...c, suggest: 'repo' });
            }
          }
        }
        return { entries: out };
      }
      default:
        throw new BizziError('unsupported', `mock does not implement ${method}`);
    }
  }

  /** For workspace.create: true/false for an existing directory (git or not), undefined when missing. */
  isRepo(machineId: string, path: string): boolean | undefined {
    const node = this.resolve(this.tree(machineId), this.expand(path));
    return node ? Boolean(node.git) : undefined;
  }

  /** workspace.create { create: true }: make the directory (and missing parents). */
  mkdir(machineId: string, path: string): void {
    let node = this.tree(machineId);
    for (const seg of this.expand(path).split('/').filter(Boolean)) {
      node.children ??= {};
      node = node.children[seg] ??= d();
    }
  }

  private tree(machineId: string): Dir {
    let t = this.trees.get(machineId);
    if (!t) {
      t = machineId === 'm_mini' ? miniTree() : laptopTree();
      this.trees.set(machineId, t);
    }
    return t;
  }

  private expand(p: string): string {
    let s = p.trim();
    if (s === '' || s === '~') s = HOME;
    else if (s.startsWith('~/')) s = `${HOME}/${s.slice(2)}`;
    if (!s.startsWith('/')) throw new BizziError('bad_request', `path must be absolute or start with ~ (got ${p})`);
    const parts: string[] = [];
    for (const seg of s.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    return `/${parts.join('/')}`;
  }

  private resolve(tree: Dir, path: string, depth = 0): Dir | undefined {
    if (depth > 8) return undefined;
    let node: Dir | undefined = tree;
    for (const seg of path.split('/').filter(Boolean)) {
      node = node?.children?.[seg];
      if (node?.link) node = this.resolve(tree, node.link, depth + 1);
      if (!node) return undefined;
    }
    return node;
  }

  private list(machineId: string, tree: Dir, path: string, node: Dir): BrowseEntry[] {
    const byPath = new Map(this.host.workspaces().filter((w) => w.machineId === machineId).map((w) => [w.path, w.id]));
    const entries: BrowseEntry[] = [];
    for (const [name, child] of Object.entries(node.children ?? {})) {
      const p = path === '/' ? `/${name}` : `${path}/${name}`;
      const target = child.link ? this.resolve(tree, child.link) : child;
      const e: BrowseEntry = { name, path: p, kind: child.link ? 'symlink' : 'dir' };
      if (target?.git) e.git = true;
      const ws = byPath.get(child.link ?? p);
      if (ws) e.workspaceId = ws;
      if (name.startsWith('.')) e.hidden = true;
      entries.push(e);
    }
    return entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  }
}

function parentOf(p: string): string {
  const cut = p.lastIndexOf('/');
  return cut <= 0 ? '/' : p.slice(0, cut);
}

function split(prefix: string): { base: string; partial: string } {
  if (prefix === '' || prefix === '~') return { base: '~/', partial: '' };
  const cut = prefix.lastIndexOf('/');
  if (cut < 0) return { base: '', partial: prefix };
  return { base: prefix.slice(0, cut + 1), partial: prefix.slice(cut + 1) };
}
