// Pure builders for the docker commands behind a container workspace (topology.md §7): names, labels,
// `docker create`, `docker exec`, which environment crosses into the container, image builds.

import { createHash } from 'node:crypto';
import type { ContainerCommand, ContainerMount, ContainerState, McpServerSpec, WorkspaceContainer, WorkspaceInfo } from '@bizzi/protocol';
import type { Env } from './docker.ts';

export const LABEL_MANAGED = 'bizzi.managed';
export const LABEL_WORKSPACE = 'bizzi.workspace';
export const LABEL_MACHINE = 'bizzi.machine';

/** bizzi's workspace image (packages/containers/image), built into the daemon on first use. */
export const DEFAULT_IMAGE = 'bizzi/workspace:latest';
export const DEFAULT_NETWORK = 'bridge';
export const DEFAULT_IDLE_MINUTES = 30;
export const MAX_IDLE_MINUTES = 7 * 24 * 60;
/**
 * Agent credentials forwarded by default, when the node has them set: the long-lived tokens `claude
 * setup-token` prints, and API keys. A login file can be bind-mounted read-only instead (`mounts`).
 */
export const DEFAULT_PASS_ENV = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY'];

/**
 * Keeps the container alive between sessions; agents arrive with `docker exec`. With `--init` as PID 1
 * the shell gets SIGTERM on `docker stop` and exits at once.
 */
export const KEEPALIVE = 'trap "exit 0" TERM INT; while sleep 3600 & wait $!; do :; done';

/** Never forwarded into the container even when an adapter changed them: they describe this machine. */
const HOST_ONLY_ENV = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'PWD',
  'OLDPWD',
  'TMPDIR',
  'TMP',
  'TEMP',
  'HOSTNAME',
  'DISPLAY',
  'XAUTHORITY',
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'NODE_OPTIONS',
  'NODE_PATH',
  'BIZZI_TOKEN',
  'BIZZI_PAIR_CODE',
]);
const HOST_ONLY_PREFIXES = ['DOCKER_', 'XDG_', 'BIZZI_DOCKER_'];

export function containerName(workspaceId: string): string {
  return `bizzi-ws-${workspaceId.replace(/[^A-Za-z0-9_.-]/g, '-')}`;
}

/** Tag for an image built from a repo's devcontainer.json, stable per directory. */
export function devcontainerTag(path: string): string {
  return `bizzi-dc-${createHash('sha256').update(path).digest('hex').slice(0, 12)}:latest`;
}

/** A hostname from the workspace name: `acme-pr-482`. */
export function hostnameFor(name: string): string {
  const h = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/, '');
  return h || 'workspace';
}

/** One `--mount` value. Docker parses it as CSV, so fields with commas or quotes are quoted. */
export function mountArg(m: ContainerMount): string {
  const field = (s: string) => (/[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return [field('type=bind'), field(`source=${m.source}`), field(`target=${m.target}`), ...(m.readOnly ? ['readonly'] : [])].join(',');
}

/** The mounts of a workspace's container: its directory at the same path, then the recipe's own. */
export function workspaceMounts(ws: Pick<WorkspaceInfo, 'path'>, c: Pick<WorkspaceContainer, 'mounts'>): ContainerMount[] {
  return [{ source: ws.path, target: ws.path }, ...(c.mounts ?? [])];
}

export interface CreateOptions {
  machineId: string;
}

/** `docker create …` for a workspace. Started separately; agents attach with `docker exec`. */
export function createArgs(ws: WorkspaceInfo, c: WorkspaceContainer, opts: CreateOptions): string[] {
  const args = [
    'create',
    '--name',
    containerName(ws.id),
    '--label',
    `${LABEL_MANAGED}=1`,
    '--label',
    `${LABEL_WORKSPACE}=${ws.id}`,
    '--label',
    `${LABEL_MACHINE}=${opts.machineId}`,
    '--init',
    '--hostname',
    hostnameFor(ws.name),
    '--network',
    c.network || DEFAULT_NETWORK,
  ];
  for (const m of workspaceMounts(ws, c)) args.push('--mount', mountArg(m));
  for (const [k, v] of Object.entries(c.env ?? {})) args.push('--env', `${k}=${v}`);
  if (c.user) args.push('--user', c.user);
  args.push('--workdir', ws.path, '--entrypoint', '/bin/sh', c.image, '-c', KEEPALIVE);
  return args;
}

/**
 * The variables an agent process gets inside the container: what the adapter added or changed relative
 * to the node's own environment (bizzi's injections, the agent's secrets, SDK markers), plus the
 * recipe's `passEnv` names the node has. Host-only variables never cross.
 */
export function forwardedEnv(spec: Env, base: Env, passEnv: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const hostOnly = (k: string) => HOST_ONLY_ENV.has(k) || HOST_ONLY_PREFIXES.some((p) => k.startsWith(p));
  for (const [k, v] of Object.entries(spec)) {
    if (v === undefined || hostOnly(k) || base[k] === v) continue;
    out[k] = v;
  }
  for (const k of passEnv) {
    const v = spec[k] ?? base[k];
    if (v !== undefined && v !== '' && !hostOnly(k)) out[k] = v;
  }
  return out;
}

/**
 * `docker exec …` for one agent process. Variables are passed by name only (`--env NAME`), so their
 * values travel in the CLI's environment and never show up in a process listing.
 */
export function execArgs(name: string, run: { command: string; args: string[]; cwd: string; tty?: boolean; user?: string }, envNames: readonly string[]): string[] {
  const args = ['exec', '--interactive'];
  // Ctrl-P Ctrl-Q (Docker's default) would detach a terminal session mid-typing; pick a rarer sequence.
  if (run.tty) args.push('--tty', '--detach-keys', 'ctrl-],ctrl-]');
  args.push('--workdir', run.cwd);
  if (run.user) args.push('--user', run.user);
  for (const k of envNames) args.push('--env', k);
  args.push(name, run.command, ...run.args);
  return args;
}

/** `docker exec` argv for one post-create command (a shell line runs under `sh -c`). */
export function postCreateArgs(name: string, cwd: string, cmd: ContainerCommand): string[] {
  const argv = typeof cmd === 'string' ? ['/bin/sh', '-c', cmd] : cmd;
  return ['exec', '--workdir', cwd, name, ...argv];
}

/** `docker build` for a devcontainer.json `build` section, or for bizzi's own image directory. */
export function buildArgs(tag: string, b: { dockerfile?: string; context: string; args?: Record<string, string> }): string[] {
  const args = ['build', '--tag', tag];
  if (b.dockerfile) args.push('--file', b.dockerfile);
  for (const [k, v] of Object.entries(b.args ?? {})) args.push('--build-arg', `${k}=${v}`);
  args.push(b.context);
  return args;
}

const KNOWN_STATES: ReadonlySet<string> = new Set(['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead']);

export interface Inspected {
  id: string;
  state: ContainerState;
  image: string;
  startedAt?: string;
}

/** `docker container inspect <name>` output (a JSON array of one). */
export function parseInspect(stdout: string): Inspected | undefined {
  let rows: unknown;
  try {
    rows = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const row = Array.isArray(rows) ? (rows[0] as Record<string, any> | undefined) : undefined;
  if (!row || typeof row !== 'object') return undefined;
  const status = String(row.State?.Status ?? '');
  const out: Inspected = {
    id: String(row.Id ?? ''),
    state: (KNOWN_STATES.has(status) ? status : 'dead') as ContainerState,
    image: String(row.Config?.Image ?? ''),
  };
  const started = row.State?.StartedAt;
  if (typeof started === 'string' && started && !started.startsWith('0001-')) out.startedAt = started;
  return out;
}

const LOOPBACK = /^(localhost|127(?:\.\d+){3}|\[::1\]|::1|0\.0\.0\.0)$/i;

/**
 * MCP servers the node injects that an agent inside the container can still reach: http servers on
 * another host. stdio servers name host executables and loopback servers listen on the node itself.
 */
export function reachableMcpServers(servers: Record<string, McpServerSpec>): { kept: Record<string, McpServerSpec>; dropped: string[] } {
  const kept: Record<string, McpServerSpec> = {};
  const dropped: string[] = [];
  for (const [name, s] of Object.entries(servers)) {
    let ok = false;
    if (s.type === 'http') {
      try {
        ok = !LOOPBACK.test(new URL(s.url).hostname);
      } catch {
        ok = false;
      }
    }
    if (ok) kept[name] = s;
    else dropped.push(name);
  }
  return { kept, dropped };
}
