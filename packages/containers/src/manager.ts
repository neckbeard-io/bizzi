// Container lifecycle for container workspaces (topology.md §7): created and started by the first
// session, stopped (persistent) or removed (ephemeral) once no session has been live for the idle
// time, removed with the workspace. Docker is the source of truth; nothing is stored besides the
// workspace's recipe.

import { homedir } from 'node:os';
import { BizziError, type ContainerStatus, type Logger, type McpServerSpec, type ProcessLauncher, type WorkspaceContainer, type WorkspaceInfo } from '@bizzi/protocol';
import { dockerError, isNoSuch, type DockerRunner, type Env } from './docker.ts';
import {
  DEFAULT_IMAGE,
  buildArgs,
  containerName,
  createArgs,
  execArgs,
  forwardedEnv,
  parseInspect,
  postCreateArgs,
  reachableMcpServers,
  type Inspected,
} from './spec.ts';

const BUILD_TIMEOUT_MS = 30 * 60_000;
const STOP_TIMEOUT_S = 10;

export interface ContainerManagerOptions {
  docker: DockerRunner;
  machineId: string;
  logger: Logger;
  /** The node's own environment: what agent environments are compared against (spec.forwardedEnv). */
  baseEnv?: Env;
  /** Directory with the Dockerfile of DEFAULT_IMAGE, built into the daemon when it lacks the image. */
  defaultImageContext?: string;
  /** Working directory of the `docker` processes on this machine. */
  hostCwd?: string;
  now?: () => number;
}

export class ContainerManager {
  readonly docker: DockerRunner;
  readonly #o: ContainerManagerOptions;
  readonly #log: Logger;
  readonly #locks = new Map<string, Promise<unknown>>();
  /** Last time each workspace had a live session (or a container start), ms. */
  readonly #lastLive = new Map<string, number>();

  constructor(opts: ContainerManagerOptions) {
    this.#o = opts;
    this.docker = opts.docker;
    this.#log = opts.logger;
  }

  #now(): number {
    return this.#o.now?.() ?? Date.now();
  }

  /** Serialize docker operations per workspace (create/start/stop/remove never interleave). */
  #locked<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#locks.get(workspaceId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.#locks.set(workspaceId, next);
    void next
      .finally(() => {
        if (this.#locks.get(workspaceId) === next) this.#locks.delete(workspaceId);
      })
      .catch(() => {});
    return next;
  }

  busy(workspaceId: string): boolean {
    return this.#locks.has(workspaceId);
  }

  /** Mark activity: the idle timer counts from here. */
  touch(workspaceId: string): void {
    this.#lastLive.set(workspaceId, this.#now());
  }

  async inspect(workspaceId: string): Promise<Inspected | undefined> {
    const r = await this.docker.run(['container', 'inspect', containerName(workspaceId)]);
    if (r.code === 0) {
      const info = parseInspect(r.stdout);
      if (info) return info;
      throw new BizziError('internal', `unexpected docker inspect output for ${containerName(workspaceId)}`);
    }
    if (isNoSuch(r)) return undefined;
    throw unreachable(this.docker, r);
  }

  /** Create (building or pulling the image first) and start the workspace's container if needed. */
  async ensureRunning(ws: WorkspaceInfo): Promise<void> {
    const c = recipe(ws);
    return this.#locked(ws.id, async () => {
      const name = containerName(ws.id);
      const info = await this.inspect(ws.id);
      if (!info) {
        await this.#ensureImage(c);
        const created = await this.docker.run(createArgs(ws, c, { machineId: this.#o.machineId }));
        if (created.code !== 0) throw new BizziError('agent_unavailable', `docker create ${name} failed: ${dockerError(created)}`);
        this.#log.log('info', 'container created', { workspaceId: ws.id, name, image: c.image });
        await this.#start(name);
        try {
          for (const cmd of c.postCreate ?? []) {
            const r = await this.docker.run(postCreateArgs(name, ws.path, cmd), { timeoutMs: BUILD_TIMEOUT_MS });
            if (r.code !== 0) throw new BizziError('agent_unavailable', `post-create command failed in ${name}: ${dockerError(r)}`);
          }
        } catch (err) {
          // Leave nothing half set up: the next session starts over.
          await this.docker.run(['rm', '--force', name]);
          throw err;
        }
      } else if (info.state === 'paused') {
        const r = await this.docker.run(['unpause', name]);
        if (r.code !== 0) throw new BizziError('agent_unavailable', `docker unpause ${name} failed: ${dockerError(r)}`);
      } else if (info.state !== 'running') {
        await this.#start(name);
      }
      this.touch(ws.id);
    });
  }

  async #start(name: string): Promise<void> {
    const r = await this.docker.run(['start', name]);
    if (r.code !== 0) throw new BizziError('agent_unavailable', `docker start ${name} failed: ${dockerError(r)}`);
  }

  async #ensureImage(c: WorkspaceContainer): Promise<void> {
    const have = await this.docker.run(['image', 'inspect', '--format', '{{.Id}}', c.image]);
    if (have.code === 0) return;
    if (!isNoSuch(have)) throw unreachable(this.docker, have);
    let args: string[];
    let what: string;
    if (c.build) {
      args = buildArgs(c.image, c.build);
      what = 'build';
    } else if (c.imageSource === 'default' && c.image === DEFAULT_IMAGE && this.#o.defaultImageContext) {
      args = buildArgs(c.image, { context: this.#o.defaultImageContext });
      what = 'build';
    } else {
      args = ['pull', c.image];
      what = 'pull';
    }
    this.#log.log('info', `container image: docker ${what}`, { image: c.image });
    const r = await this.docker.run(args, { timeoutMs: BUILD_TIMEOUT_MS });
    if (r.code !== 0) throw new BizziError('agent_unavailable', `docker ${what} ${c.image} failed: ${dockerError(r)}`);
  }

  /** Stop the container (it keeps its filesystem). No-op when it doesn't exist or isn't running. */
  stop(workspaceId: string): Promise<void> {
    return this.#locked(workspaceId, async () => {
      const info = await this.inspect(workspaceId);
      if (!info || (info.state !== 'running' && info.state !== 'paused' && info.state !== 'restarting')) return;
      const r = await this.docker.run(['stop', '--time', String(STOP_TIMEOUT_S), containerName(workspaceId)]);
      if (r.code !== 0 && !isNoSuch(r)) throw new BizziError('internal', `docker stop failed: ${dockerError(r)}`);
      this.#log.log('info', 'container stopped', { workspaceId });
    });
  }

  /** Remove the container (and an image built from the repo's devcontainer.json, if unused). */
  remove(workspaceId: string, c?: WorkspaceContainer): Promise<void> {
    return this.#locked(workspaceId, async () => {
      const r = await this.docker.run(['rm', '--force', '--volumes', containerName(workspaceId)]);
      if (r.code !== 0 && !isNoSuch(r)) throw new BizziError('internal', `docker rm failed: ${dockerError(r)}`);
      if (r.code === 0) this.#log.log('info', 'container removed', { workspaceId });
      if (c?.build) await this.docker.run(['image', 'rm', c.image]); // refused while another container uses it
      this.#lastLive.delete(workspaceId);
    });
  }

  async status(ws: WorkspaceInfo, liveSessions: number): Promise<ContainerStatus> {
    const c = recipe(ws);
    const out: ContainerStatus = { workspaceId: ws.id, name: containerName(ws.id), state: 'absent', image: c.image, liveSessions };
    let info: Inspected | undefined;
    try {
      info = await this.inspect(ws.id);
    } catch (err) {
      out.state = 'unreachable';
      out.error = (err as Error).message;
      return out;
    }
    if (!info) return out;
    out.state = info.state;
    if (info.id) out.id = info.id;
    if (info.startedAt) out.startedAt = info.startedAt;
    if (info.state === 'running' && liveSessions === 0) {
      const last = this.#lastLive.get(ws.id) ?? this.#now();
      out.idleUntil = new Date(last + c.idleMinutes * 60_000).toISOString();
    }
    return out;
  }

  /**
   * One pass of the idle timer: a container whose workspace has had no live session for `idleMinutes`
   * is stopped (persistent) or removed (ephemeral). A workspace seen for the first time starts its
   * timer now, so a node restart gives every container a full idle period.
   */
  async sweep(workspaces: readonly WorkspaceInfo[], liveSessions: (workspaceId: string) => number): Promise<void> {
    const now = this.#now();
    for (const ws of workspaces) {
      if (ws.kind !== 'container' || !ws.container) continue;
      if (liveSessions(ws.id) > 0 || this.busy(ws.id)) {
        this.touch(ws.id);
        continue;
      }
      const last = this.#lastLive.get(ws.id);
      if (last === undefined) {
        this.touch(ws.id);
        continue;
      }
      if (now - last < ws.container.idleMinutes * 60_000) continue;
      try {
        const info = await this.inspect(ws.id);
        if (!info) continue;
        if (liveSessions(ws.id) > 0) continue; // a session started meanwhile
        if (ws.container.lifecycle === 'ephemeral') await this.remove(ws.id, ws.container);
        else if (info.state === 'running' || info.state === 'paused') await this.stop(ws.id);
      } catch (err) {
        this.#log.log('debug', 'container idle check failed', { workspaceId: ws.id, err });
      }
    }
  }

  /** Runs agent processes in the workspace's container with `docker exec`. */
  launcher(ws: WorkspaceInfo): ProcessLauncher {
    const c = recipe(ws);
    const name = containerName(ws.id);
    const base = this.#o.baseEnv ?? process.env;
    const hostCwd = this.#o.hostCwd ?? homedir();
    const log = this.#log;
    return {
      label: `container ${name}`,
      wrap: (spec) => {
        const env = forwardedEnv(spec.env, base, c.passEnv ?? []);
        const names = Object.keys(env).sort();
        const run = this.docker.command(
          execArgs(name, { command: spec.command, args: spec.args, cwd: spec.cwd, ...(spec.tty ? { tty: true } : {}) }, names),
          env,
        );
        return { command: run.command, args: run.args, cwd: hostCwd, env: run.env };
      },
      mapMcpServers: (servers: Record<string, McpServerSpec>) => {
        const { kept, dropped } = reachableMcpServers(servers);
        if (dropped.length > 0) log.log('info', 'MCP servers not reachable from the container; left out', { container: name, dropped });
        return kept;
      },
    };
  }
}

export function recipe(ws: WorkspaceInfo): WorkspaceContainer {
  if (ws.kind !== 'container' || !ws.container) throw new BizziError('bad_request', `workspace ${ws.name} is not a container workspace`);
  return ws.container;
}

function unreachable(docker: DockerRunner, r: { code: number; stdout: string; stderr: string }): BizziError {
  return new BizziError('agent_unavailable', `Docker daemon at ${docker.target} is not reachable: ${dockerError(r)}`);
}
