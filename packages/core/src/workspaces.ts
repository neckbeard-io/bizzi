import { statSync } from 'node:fs';
import { mkdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { BizziError, GLOBAL_CHANNEL, newId, type LabelColor, type WorkspaceContainer, type WorkspaceInfo } from '@bizzi/protocol';
import type { EventBus } from './bus.ts';
import { branchExists, dirtyPaths, gitToplevel, isInsideGitRepo, isValidBranchName, runGit } from './git.ts';
import type { Store } from './store.ts';

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return join(os.homedir(), p.slice(2));
  return p;
}

export class Workspaces {
  readonly #store: Store;
  readonly #bus: EventBus;
  readonly #machineId: string;
  readonly #byId = new Map<string, WorkspaceInfo>();
  readonly #worktreeLocks = new Map<string, Promise<unknown>>();

  constructor(store: Store, bus: EventBus, machineId: string) {
    this.#store = store;
    this.#bus = bus;
    this.#machineId = machineId;
    for (const ws of store.listWorkspaces()) this.#byId.set(ws.id, ws);
  }

  list(): WorkspaceInfo[] {
    return [...this.#byId.values()];
  }

  get(id: string): WorkspaceInfo {
    const ws = this.#byId.get(id);
    if (!ws) throw new BizziError('not_found', `workspace ${id} not found`);
    return ws;
  }

  /**
   * Throws unless the workspace's directory exists on this machine. An agent spawned in a missing cwd
   * fails with ENOENT, which agent CLIs misreport as a missing or broken binary.
   */
  assertPresent(ws: WorkspaceInfo): void {
    const st = (() => {
      try {
        return statSync(ws.path);
      } catch {
        return undefined;
      }
    })();
    if (!st) throw new BizziError('not_found', `the folder of workspace ${ws.name} (${ws.path}) does not exist on this machine`, { workspaceId: ws.id });
    if (!st.isDirectory()) throw new BizziError('bad_request', `workspace ${ws.name} (${ws.path}) is not a directory`, { workspaceId: ws.id });
  }

  /**
   * Adopt an existing directory (or create it when `create`). Adopting a known path returns the existing
   * workspace. With `container` the workspace is of kind 'container' (topology.md §7); a directory is one
   * workspace, so a container workspace of a directory that is already a host workspace is a conflict.
   */
  async create(opts: { path: string; name?: string; create?: boolean; container?: WorkspaceContainer }): Promise<WorkspaceInfo> {
    const raw = expandHome(opts.path);
    if (!isAbsolute(raw)) throw new BizziError('bad_request', 'path must be absolute');
    const abs = resolve(raw);
    let st = await stat(abs).catch(() => undefined);
    if (!st) {
      if (!opts.create) throw new BizziError('not_found', `directory ${abs} does not exist`);
      await mkdir(abs, { recursive: true });
      st = await stat(abs);
    }
    if (!st.isDirectory()) throw new BizziError('bad_request', `${abs} is not a directory`);
    const real = await realpath(abs);

    const existing = this.list().find((w) => w.path === real);
    if (existing && opts.container && existing.kind !== 'container') {
      throw new BizziError('conflict', `${real} is already the workspace ${existing.name} (${existing.kind}); remove it first or use another directory`, {
        workspaceId: existing.id,
      });
    }
    if (existing) return existing;

    const ws: WorkspaceInfo = {
      id: newId('w'),
      machineId: this.#machineId,
      name: opts.name?.trim() || basename(real) || real,
      path: real,
      kind: opts.container ? 'container' : (await isInsideGitRepo(real)) ? 'git' : 'dir',
      createdAt: new Date().toISOString(),
    };
    if (opts.container) ws.container = opts.container;
    this.#store.putWorkspace(ws);
    this.#byId.set(ws.id, ws);
    this.#bus.append(GLOBAL_CHANNEL, { type: 'workspace.created', data: { workspace: ws } });
    return ws;
  }

  /** Registry-only removal; files are untouched. */
  remove(id: string): void {
    this.get(id);
    this.#store.deleteWorkspace(id);
    this.#byId.delete(id);
    this.#bus.append(GLOBAL_CHANNEL, { type: 'workspace.removed', data: { workspaceId: id } });
  }

  /**
   * Set user fields (already validated; `''` clears `color` / `icon`). Persists and emits
   * `workspace.updated` only when something changed. Returns the current record.
   */
  update(id: string, fields: { name?: string; color?: LabelColor | ''; icon?: string }): WorkspaceInfo {
    const cur = this.get(id);
    const next: WorkspaceInfo = { ...cur };
    if (fields.name !== undefined) next.name = fields.name;
    for (const k of ['color', 'icon'] as const) {
      const v = fields[k];
      if (v === undefined) continue;
      if (v) (next as Record<typeof k, string>)[k] = v;
      else delete next[k];
    }
    if (JSON.stringify(next) === JSON.stringify(cur)) return cur;
    this.#store.putWorkspace(next);
    this.#byId.set(id, next);
    this.#bus.append(GLOBAL_CHANNEL, { type: 'workspace.updated', data: { workspace: next } });
    return next;
  }

  /** Worktree workspaces created from `id`. */
  worktreesOf(id: string): WorkspaceInfo[] {
    return this.list().filter((w) => w.kind === 'worktree' && w.parentWorkspaceId === id);
  }

  /**
   * `git worktree add` plus a workspace of kind 'worktree' grouped under the repo workspace.
   *
   * The default location is a sibling of the repository: `<repo>.worktrees/<branch>` (slashes and other
   * unsafe characters in the branch become `-`; a numeric suffix avoids collisions). Creating a worktree
   * of a worktree workspace groups the new one under the same repo workspace. When a registered worktree
   * of the repo already has `branch` checked out, that workspace is returned.
   */
  createWorktree(opts: { workspaceId: string; branch: string; base?: string; path?: string; name?: string }): Promise<WorkspaceInfo> {
    const parent = this.#repoWorkspace(opts.workspaceId);
    // Serialized per repo so two creates of the same branch don't race in git.
    const prev = this.#worktreeLocks.get(parent.id) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.#createWorktree(parent, opts));
    this.#worktreeLocks.set(parent.id, next);
    void next.finally(() => {
      if (this.#worktreeLocks.get(parent.id) === next) this.#worktreeLocks.delete(parent.id);
    }).catch(() => {});
    return next;
  }

  /** The repo workspace a worktree hangs off (a worktree's own parent, else the workspace itself). */
  #repoWorkspace(id: string): WorkspaceInfo {
    const ws = this.get(id);
    if (ws.kind === 'worktree') {
      if (!ws.parentWorkspaceId) throw new BizziError('bad_request', `worktree workspace ${id} has no parent workspace`);
      return this.get(ws.parentWorkspaceId);
    }
    if (ws.kind !== 'git') throw new BizziError('bad_request', `workspace ${ws.name} is not a git repository`);
    return ws;
  }

  async #createWorktree(
    parent: WorkspaceInfo,
    opts: { branch: string; base?: string; path?: string; name?: string },
  ): Promise<WorkspaceInfo> {
    const branch = opts.branch.trim();
    const repo = await gitToplevel(parent.path);
    if (!repo) throw new BizziError('bad_request', `workspace ${parent.name} is not inside a git work tree`);
    if (!(await isValidBranchName(repo, branch))) throw new BizziError('bad_request', `invalid branch name: ${opts.branch}`);

    const existing = this.worktreesOf(parent.id).find((w) => w.branch === branch);
    if (existing) return existing;

    let target: string;
    if (opts.path !== undefined) {
      const raw = expandHome(opts.path);
      if (!isAbsolute(raw)) throw new BizziError('bad_request', 'path must be absolute');
      target = resolve(raw);
      if (await stat(target).catch(() => undefined)) throw new BizziError('conflict', `${target} already exists`);
    } else {
      const base = join(dirname(repo), `${basename(repo)}.worktrees`, sanitizeBranch(branch));
      target = base;
      for (let i = 2; await stat(target).catch(() => undefined); i++) target = `${base}-${i}`;
    }
    await mkdir(dirname(target), { recursive: true });

    const args = ['worktree', 'add'];
    if (await branchExists(repo, branch)) {
      if (opts.base !== undefined) throw new BizziError('bad_request', `branch ${branch} already exists; base only applies to new branches`);
      args.push(target, branch);
    } else {
      args.push('-b', branch, target);
      if (opts.base !== undefined) {
        if (!opts.base || opts.base.startsWith('-')) throw new BizziError('bad_request', 'invalid base');
        args.push(opts.base);
      }
    }
    const r = await runGit(repo, args);
    if (r.code !== 0) {
      const msg = r.stderr.trim() || `git worktree add exited with ${r.code}`;
      throw new BizziError(/already (checked out|used by worktree)/i.test(msg) ? 'conflict' : 'bad_request', msg);
    }

    const real = await realpath(target);
    const ws: WorkspaceInfo = {
      id: newId('w'),
      machineId: this.#machineId,
      name: opts.name?.trim() || `${parent.name} (${branch})`,
      path: real,
      kind: 'worktree',
      parentWorkspaceId: parent.id,
      branch,
      createdAt: new Date().toISOString(),
    };
    if (parent.projectId) ws.projectId = parent.projectId;
    this.#store.putWorkspace(ws);
    this.#byId.set(ws.id, ws);
    this.#bus.append(GLOBAL_CHANNEL, { type: 'workspace.created', data: { workspace: ws } });
    return ws;
  }

  /**
   * `git worktree remove` plus the workspace. Never deletes the branch. Refuses on uncommitted changes or
   * untracked files unless `force`. The caller checks that no live session uses the workspace.
   */
  async removeWorktree(id: string, force = false): Promise<void> {
    const ws = this.get(id);
    if (ws.kind !== 'worktree') throw new BizziError('bad_request', `workspace ${ws.name} is not a worktree (use workspace.remove)`);
    const parent = ws.parentWorkspaceId ? this.#byId.get(ws.parentWorkspaceId) : undefined;
    const exists = Boolean(await stat(ws.path).catch(() => undefined));
    if (exists) {
      if (!force) {
        let dirty: string[];
        try {
          dirty = await dirtyPaths(ws.path);
        } catch (err) {
          throw new BizziError('conflict', `cannot check ${ws.path} for changes: ${(err as Error).message}`);
        }
        if (dirty.length > 0) {
          const list = dirty.slice(0, 5).join(', ') + (dirty.length > 5 ? `, … (${dirty.length} in all)` : '');
          throw new BizziError('conflict', `worktree has uncommitted changes (${list}); commit them or pass force`, { paths: dirty });
        }
      }
      const cwd = parent?.path ?? ws.path;
      const r = await runGit(cwd, ['worktree', 'remove', ...(force ? ['--force'] : []), ws.path]);
      if (r.code !== 0) throw new BizziError('conflict', r.stderr.trim() || `git worktree remove exited with ${r.code}`);
    } else if (parent) {
      // The directory is already gone: drop git's bookkeeping for it.
      await runGit(parent.path, ['worktree', 'prune']).catch(() => undefined);
    }
    this.remove(id);
  }
}

/** A branch name as one safe path segment: `feat/x y` → `feat-x-y`. */
export function sanitizeBranch(branch: string): string {
  const s = branch.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').replace(/-+$/, '');
  return s || 'worktree';
}
