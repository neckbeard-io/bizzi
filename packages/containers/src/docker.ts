// The Docker CLI as container workspaces use it (topology.md §7): which daemon, and running `docker …`.
//
// The daemon is never the host's socket by default. It is the one named by BIZZI_DOCKER_HOST (the dind
// sidecar of the compose profile, topology.md §2.2), or DOCKER_HOST, or, only with BIZZI_CONTAINERS=1,
// the CLI's own default (Docker Desktop / OrbStack / Podman on a desktop machine).

import { spawn } from 'node:child_process';

export type Env = Record<string, string | undefined>;

export interface DockerResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface DockerRunner {
  /** `docker <args>` to completion. Never throws: a spawn failure is code 127 with the error in stderr. */
  run(args: string[], opts?: { timeoutMs?: number; input?: string }): Promise<DockerResult>;
  /** What to spawn for a long-lived `docker <args>` (exec), with `env` added to the CLI's environment. */
  command(args: string[], env?: Env): { command: string; args: string[]; env: Env };
  /** Where commands go, for messages: `tcp://dind:2376`, `default context`. */
  readonly target: string;
}

export type DockerTarget =
  | { enabled: true; env: Env; target: string }
  | { enabled: false; reason: string };

export const DISABLED_REASON =
  'container workspaces need a Docker daemon: set BIZZI_DOCKER_HOST (e.g. the dind sidecar, tcp://dind:2376) ' +
  "or BIZZI_CONTAINERS=1 to use this machine's default Docker context";

/**
 * Pick the daemon from the node's environment. BIZZI_DOCKER_HOST (+ BIZZI_DOCKER_TLS_VERIFY,
 * BIZZI_DOCKER_CERT_PATH) wins and becomes DOCKER_HOST for the CLI only; then DOCKER_HOST; then the
 * CLI default when BIZZI_CONTAINERS=1. BIZZI_CONTAINERS=0 turns the feature off.
 */
export function resolveDockerTarget(env: Env = process.env): DockerTarget {
  const flag = env.BIZZI_CONTAINERS?.trim();
  if (flag === '0') return { enabled: false, reason: 'container workspaces are turned off on this machine (BIZZI_CONTAINERS=0)' };
  const bizziHost = env.BIZZI_DOCKER_HOST?.trim();
  if (bizziHost) {
    const out: Env = { ...env, DOCKER_HOST: bizziHost, DOCKER_CONTEXT: undefined };
    const verify = env.BIZZI_DOCKER_TLS_VERIFY?.trim();
    const certs = env.BIZZI_DOCKER_CERT_PATH?.trim();
    out.DOCKER_TLS_VERIFY = verify && verify !== '0' ? '1' : undefined;
    out.DOCKER_CERT_PATH = certs || undefined;
    return { enabled: true, env: out, target: bizziHost };
  }
  const host = env.DOCKER_HOST?.trim();
  if (host) return { enabled: true, env: { ...env }, target: host };
  if (flag === '1') return { enabled: true, env: { ...env }, target: env.DOCKER_CONTEXT?.trim() ? `context ${env.DOCKER_CONTEXT}` : 'default context' };
  return { enabled: false, reason: DISABLED_REASON };
}

const OUTPUT_LIMIT = 1024 * 1024;

/** The `docker` binary against one daemon. */
export class CliDocker implements DockerRunner {
  readonly target: string;
  readonly #path: string;
  readonly #env: Env;

  constructor(opts: { env: Env; target: string; dockerPath?: string }) {
    this.#env = opts.env;
    this.target = opts.target;
    this.#path = opts.dockerPath ?? 'docker';
  }

  command(args: string[], env: Env = {}): { command: string; args: string[]; env: Env } {
    return { command: this.#path, args: [...args], env: { ...this.#env, ...env } };
  }

  run(args: string[], opts: { timeoutMs?: number; input?: string } = {}): Promise<DockerResult> {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let done = false;
      const finish = (r: DockerResult): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(r);
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(this.#path, args, { env: cleanEnv(this.#env), stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (err) {
        finish({ code: 127, stdout: '', stderr: `cannot run ${this.#path}: ${(err as Error).message}` });
        return;
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish({ code: 124, stdout, stderr: `${stderr}\ndocker ${args[0] ?? ''} timed out after ${opts.timeoutMs} ms`.trim() });
      }, opts.timeoutMs ?? 60_000);
      child.stdout!.setEncoding('utf8');
      child.stderr!.setEncoding('utf8');
      child.stdout!.on('data', (d: string) => {
        if (stdout.length < OUTPUT_LIMIT) stdout += d;
      });
      child.stderr!.on('data', (d: string) => {
        stderr = (stderr + d).slice(-OUTPUT_LIMIT);
      });
      child.on('error', (err) => finish({ code: 127, stdout, stderr: `cannot run ${this.#path}: ${err.message}` }));
      child.on('close', (code) => finish({ code: code ?? 1, stdout, stderr }));
      child.stdin!.on('error', () => {});
      child.stdin!.end(opts.input ?? '');
    });
  }
}

/** Drop undefined values (spawn would pass the string "undefined"). */
export function cleanEnv(env: Env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}

/** Last lines of a docker error, for messages. */
export function dockerError(r: DockerResult, max = 600): string {
  const s = (r.stderr.trim() || r.stdout.trim() || `exit code ${r.code}`).replace(/\s+\n/g, '\n');
  return s.length > max ? `…${s.slice(s.length - max)}` : s;
}

/** The CLI's "no such container / image" answer, as opposed to a daemon that can't be reached. */
export function isNoSuch(r: DockerResult): boolean {
  return r.code !== 0 && /no such (container|image|object)|not found/i.test(r.stderr) && !/cannot connect|connection refused|error during connect/i.test(r.stderr);
}
