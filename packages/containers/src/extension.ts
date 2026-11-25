// container.* methods and the session-start hook for container workspaces (topology.md §7).
//   container.create  a workspace of kind 'container' (recipe: explicit image > devcontainer.json > bizzi's image)
//   container.status  the container's Docker state and idle timer
//   container.stop    stop it now
// A session in a container workspace gets a ProcessLauncher (`docker exec`) from prepareStart, which
// first creates and starts the container. An idle timer stops or removes containers nobody uses, and a
// removed workspace takes its container with it.

import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BizziNode, NodeExtension } from '@bizzi/core';
import {
  BizziError,
  GLOBAL_CHANNEL,
  type ChannelEvent,
  type ContainerLifecycle,
  type ContainerMount,
  type Logger,
  type WorkspaceContainer,
  type WorkspaceInfo,
} from '@bizzi/protocol';
import { CliDocker, resolveDockerTarget, type DockerRunner, type Env } from './docker.ts';
import { readDevcontainer } from './devcontainer.ts';
import { ContainerManager } from './manager.ts';
import { DEFAULT_IDLE_MINUTES, DEFAULT_IMAGE, DEFAULT_NETWORK, DEFAULT_PASS_ENV, MAX_IDLE_MINUTES, devcontainerTag } from './spec.ts';

/** bizzi's workspace image directory, shipped with this package. */
export const DEFAULT_IMAGE_CONTEXT = join(dirname(fileURLToPath(import.meta.url)), '..', 'image');

export interface ContainersExtensionOptions {
  /** The node's environment (daemon selection, BIZZI_CONTAINER_IMAGE, forwarded credentials). Default process.env. */
  env?: Env;
  /** Tests inject a fake; default the `docker` CLI against resolveDockerTarget(env). */
  docker?: DockerRunner;
  logger?: Logger;
  /** How often the idle timer looks at containers. Default 60 s; 0 turns it off (tests call sweep()). */
  sweepMs?: number;
  /** The node's uid:gid for `--user` (default from the process; undefined on Windows). */
  user?: string;
  now?: () => number;
}

export type ContainersExtension = NodeExtension & {
  /** Undefined when no Docker daemon is configured (methods answer `unsupported`). */
  readonly manager: ContainerManager | undefined;
  /** One idle-timer pass. */
  sweep(): Promise<void>;
};

const LIFECYCLES: readonly ContainerLifecycle[] = ['persistent', 'ephemeral'];
const IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._\/:@+-]{0,254}$/;
const NETWORK_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const USER_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,63})?$/;
const MAX_MOUNTS = 32;
const MAX_PASS_ENV = 64;

export function createContainersExtension(opts: ContainersExtensionOptions = {}): ContainersExtension {
  const env = opts.env ?? process.env;
  const target = opts.docker ? undefined : resolveDockerTarget(env);
  const docker = opts.docker ?? (target?.enabled ? new CliDocker({ env: target.env, target: target.target }) : undefined);
  const disabledReason = target && !target.enabled ? target.reason : 'container workspaces are not available on this machine';
  const defaultImage = env.BIZZI_CONTAINER_IMAGE?.trim() || DEFAULT_IMAGE;
  const user = opts.user ?? defaultUser();
  let manager: ContainerManager | undefined;
  let node: BizziNode | undefined;
  let log: Logger = opts.logger ?? noopLogger;
  let timer: NodeJS.Timeout | undefined;
  let unsubscribe: (() => void) | undefined;
  /** Container workspaces by id, so a removal (event carries only the id) can remove the container. */
  const known = new Map<string, WorkspaceInfo>();

  const need = (): ContainerManager => {
    if (!manager) throw new BizziError('unsupported', disabledReason);
    return manager;
  };
  const live = (workspaceId: string): number =>
    node ? node.sessions.list(workspaceId).filter((s) => s.status !== 'ended' && s.status !== 'failed').length : 0;
  const containerWorkspace = (p: unknown): WorkspaceInfo => {
    const id = (p as { workspaceId?: unknown } | undefined)?.workspaceId;
    if (typeof id !== 'string' || !id) throw new BizziError('bad_request', 'workspaceId must be a non-empty string');
    const ws = node!.workspaces.get(id);
    if (ws.kind !== 'container') throw new BizziError('bad_request', `workspace ${ws.name} is not a container workspace`);
    return ws;
  };
  const sweep = async (): Promise<void> => {
    if (!manager || !node) return;
    await manager.sweep(node.workspaces.list(), live);
  };

  return {
    get manager() {
      return manager;
    },
    sweep,

    start(ctx) {
      node = ctx.node;
      log = opts.logger ?? ctx.logger.child({ component: 'containers' });
      if (docker) {
        manager = new ContainerManager({
          docker,
          machineId: ctx.node.machine.id,
          logger: log,
          baseEnv: env,
          defaultImageContext: DEFAULT_IMAGE_CONTEXT,
          ...(opts.now ? { now: opts.now } : {}),
        });
        log.log('info', 'container workspaces enabled', { docker: docker.target });
      }
      for (const ws of ctx.node.workspaces.list()) if (ws.kind === 'container') known.set(ws.id, ws);
      unsubscribe = ctx.node.subscribe(GLOBAL_CHANNEL, ctx.node.bus.lastSeq(GLOBAL_CHANNEL), (ev: ChannelEvent) => {
        if (ev.type === 'workspace.created') {
          const ws = (ev.data as { workspace: WorkspaceInfo }).workspace;
          if (ws.kind === 'container') known.set(ws.id, ws);
        } else if (ev.type === 'workspace.removed') {
          const id = (ev.data as { workspaceId: string }).workspaceId;
          const ws = known.get(id);
          if (!ws) return;
          known.delete(id);
          manager?.remove(id, ws.container).catch((err: unknown) => log.log('warn', 'removing the container failed', { workspaceId: id, err }));
        }
      }).unsubscribe;
      const every = opts.sweepMs ?? 60_000;
      if (manager && every > 0) {
        timer = setInterval(() => void sweep().catch((err: unknown) => log.log('debug', 'container sweep failed', { err })), every);
        timer.unref();
      }
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      unsubscribe?.();
      unsubscribe = undefined;
      // Containers outlive the node: persistent ones keep their state, and the idle timer of the next
      // start stops whatever nobody uses.
    },

    async prepareStart(_session, ws) {
      if (ws.kind !== 'container') return {};
      const m = need();
      await m.ensureRunning(ws);
      return { launcher: m.launcher(ws) };
    },

    methods: {
      'container.create': async (p: unknown) => {
        need();
        const params = (p ?? {}) as Record<string, unknown>;
        const { path, name, create, container, notes } = await buildRecipe(params, { defaultImage, user });
        const ws = await node!.workspaces.create({ path, create: create ?? false, container, ...(name ? { name } : {}) });
        if (ws.container !== container) notes.push('a container workspace for this directory already exists; its settings were kept');
        return notes.length > 0 ? { workspace: ws, notes } : { workspace: ws };
      },
      'container.status': async (p: unknown) => {
        const ws = containerWorkspace(p);
        return { container: await need().status(ws, live(ws.id)) };
      },
      'container.stop': async (p: unknown) => {
        const ws = containerWorkspace(p);
        const m = need();
        const force = (p as { force?: unknown }).force;
        if (force !== undefined && typeof force !== 'boolean') throw new BizziError('bad_request', 'force must be a boolean');
        const sessions = node!.sessions.list(ws.id).filter((s) => s.status !== 'ended' && s.status !== 'failed');
        if (sessions.length > 0 && !force) {
          throw new BizziError('conflict', `container has ${sessions.length} live session(s); stop them first or pass force`, {
            sessions: sessions.map((s) => s.id),
          });
        }
        for (const s of sessions) await node!.sessions.stop(s.id);
        await m.stop(ws.id);
        return { container: await m.status(ws, live(ws.id)) };
      },
    },
  };
}

/** container.create params → the workspace path and recipe, plus notes about what was ignored. */
export async function buildRecipe(
  p: Record<string, unknown>,
  defaults: { defaultImage: string; user?: string },
): Promise<{ path: string; name?: string; create?: boolean; container: WorkspaceContainer; notes: string[] }> {
  const rawPath = p.path;
  if (typeof rawPath !== 'string' || !rawPath) throw new BizziError('bad_request', 'path must be a non-empty string');
  const name = optStr(p, 'name');
  const create = optBool(p, 'create');
  const expanded = rawPath === '~' ? os.homedir() : rawPath.startsWith('~/') ? join(os.homedir(), rawPath.slice(2)) : rawPath;
  if (!isAbsolute(expanded)) throw new BizziError('bad_request', 'path must be absolute');
  const abs = resolve(expanded);
  const exists = Boolean(await stat(abs).catch(() => undefined));
  const real = exists ? await realpath(abs) : abs;
  const notes: string[] = [];

  const image = optStr(p, 'image');
  if (image !== undefined && !IMAGE_RE.test(image)) throw new BizziError('bad_request', `invalid image reference: ${image}`);
  const network = optStr(p, 'network') ?? DEFAULT_NETWORK;
  if (!NETWORK_RE.test(network)) throw new BizziError('bad_request', `invalid network name: ${network}`);
  const lifecycle = optStr(p, 'lifecycle') ?? 'persistent';
  if (!LIFECYCLES.includes(lifecycle as ContainerLifecycle)) throw new BizziError('bad_request', `lifecycle must be one of ${LIFECYCLES.join(', ')}`);
  const idle = p.idleMinutes ?? DEFAULT_IDLE_MINUTES;
  if (typeof idle !== 'number' || !Number.isInteger(idle) || idle < 1 || idle > MAX_IDLE_MINUTES) {
    throw new BizziError('bad_request', `idleMinutes must be an integer between 1 and ${MAX_IDLE_MINUTES}`);
  }
  const mounts = parseMounts(p.mounts);
  const passEnv = p.passEnv === undefined ? [...DEFAULT_PASS_ENV] : parsePassEnv(p.passEnv);
  const userParam = optStr(p, 'user');
  if (userParam !== undefined && !USER_RE.test(userParam)) throw new BizziError('bad_request', `invalid user: ${userParam}`);

  const container: WorkspaceContainer = {
    image: image ?? defaults.defaultImage,
    imageSource: image ? 'explicit' : 'default',
    network,
    lifecycle: lifecycle as ContainerLifecycle,
    idleMinutes: idle,
  };
  if (!image && exists) {
    let dc;
    try {
      dc = await readDevcontainer(real);
    } catch (err) {
      throw new BizziError('bad_request', `cannot read devcontainer.json: ${(err as Error).message}`);
    }
    if (dc) {
      notes.push(...dc.notes.map((n) => `devcontainer.json: ${n}`));
      if (dc.image || dc.build) {
        container.imageSource = 'devcontainer';
        if (dc.image) container.image = dc.image;
        else {
          container.image = devcontainerTag(real);
          container.build = dc.build!;
        }
      }
      if (dc.env) container.env = dc.env;
      if (dc.user && userParam === undefined) container.user = dc.user;
      if (dc.postCreate) container.postCreate = dc.postCreate;
    }
  }
  if (userParam !== undefined) container.user = userParam;
  // bizzi's image (and any image without its own user) runs as the node's user, so files in the
  // workspace stay the user's on the host.
  else if (!container.user && container.imageSource !== 'devcontainer' && defaults.user) container.user = defaults.user;

  const all = [...mounts];
  if (exists) {
    const common = await gitCommonDir(real);
    if (common && !inside(real, common) && !all.some((m) => m.target === common)) {
      // A git worktree: its .git file points at the main repository's git dir, which must be there too.
      all.push({ source: common, target: common });
    }
  }
  if (all.length > 0) container.mounts = all;
  if (passEnv.length > 0) container.passEnv = passEnv;
  const out: { path: string; name?: string; create?: boolean; container: WorkspaceContainer; notes: string[] } = { path: real, container, notes };
  if (name !== undefined) out.name = name;
  if (create !== undefined) out.create = create;
  return out;
}

function parseMounts(v: unknown): ContainerMount[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > MAX_MOUNTS) throw new BizziError('bad_request', `mounts must be an array of at most ${MAX_MOUNTS}`);
  return v.map((m, i) => {
    const o = (m ?? {}) as Record<string, unknown>;
    const source = o.source;
    const target = o.target;
    if (typeof source !== 'string' || !isAbsolute(source) || typeof target !== 'string' || !isAbsolute(target)) {
      throw new BizziError('bad_request', `mounts[${i}]: source and target must be absolute paths`);
    }
    if (o.readOnly !== undefined && typeof o.readOnly !== 'boolean') throw new BizziError('bad_request', `mounts[${i}].readOnly must be a boolean`);
    return { source: resolve(source), target: resolve(target), ...(o.readOnly ? { readOnly: true } : {}) };
  });
}

function parsePassEnv(v: unknown): string[] {
  if (!Array.isArray(v) || v.length > MAX_PASS_ENV || !v.every((k) => typeof k === 'string' && ENV_NAME_RE.test(k))) {
    throw new BizziError('bad_request', `passEnv must be an array of at most ${MAX_PASS_ENV} environment variable names`);
  }
  return [...new Set(v as string[])];
}

function optStr(p: Record<string, unknown>, key: string): string | undefined {
  const v = p[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new BizziError('bad_request', `${key} must be a string`);
  return v.trim() || undefined;
}

function optBool(p: Record<string, unknown>, key: string): boolean | undefined {
  const v = p[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw new BizziError('bad_request', `${key} must be a boolean`);
  return v;
}

function inside(dir: string, p: string): boolean {
  const rel = relative(dir, p);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The repository's common git dir (absolute), when `dir` is inside a work tree. */
function gitCommonDir(dir: string): Promise<string | undefined> {
  return new Promise((done) => {
    execFile('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { timeout: 10_000 }, (err, stdout) => {
      const out = String(stdout ?? '').trim();
      done(err || !out ? undefined : out);
    });
  });
}

function defaultUser(): string | undefined {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  return uid === undefined || gid === undefined ? undefined : `${uid}:${gid}`;
}

const noopLogger: Logger = {
  log() {},
  child() {
    return noopLogger;
  },
};
