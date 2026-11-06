import { mkdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { BizziError, GLOBAL_CHANNEL, newId, type WorkspaceInfo } from '@bizzi/protocol';
import type { EventBus } from './bus.ts';
import { isInsideGitRepo } from './git.ts';
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

  /** Adopt an existing directory (or create it when `create`). Adopting a known path returns the existing workspace. */
  async create(opts: { path: string; name?: string; create?: boolean }): Promise<WorkspaceInfo> {
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
    if (existing) return existing;

    const ws: WorkspaceInfo = {
      id: newId('w'),
      machineId: this.#machineId,
      name: opts.name?.trim() || basename(real) || real,
      path: real,
      kind: (await isInsideGitRepo(real)) ? 'git' : 'dir',
      createdAt: new Date().toISOString(),
    };
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
}
