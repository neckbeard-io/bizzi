// A scripted Docker CLI: keeps containers and images in memory and answers the subcommands the
// container manager uses, recording every call.

import type { ContainerState } from '@bizzi/protocol';
import type { DockerResult, DockerRunner, Env } from '../src/index.ts';

interface FakeContainer {
  id: string;
  image: string;
  state: ContainerState;
  args: string[];
}

const ok = (stdout = ''): DockerResult => ({ code: 0, stdout, stderr: '' });
const noSuch = (what: string): DockerResult => ({ code: 1, stdout: '', stderr: `Error response from daemon: No such ${what}` });

export class FakeDocker implements DockerRunner {
  readonly target = 'tcp://fake-dind:2376';
  readonly calls: string[][] = [];
  readonly containers = new Map<string, FakeContainer>();
  readonly images = new Set<string>();
  /** Every daemon call fails like an unreachable daemon. */
  down = false;
  /** Subcommands (e.g. 'exec', 'pull') that fail with this result. */
  readonly failing = new Map<string, DockerResult>();
  #next = 1;

  command(args: string[], env: Env = {}): { command: string; args: string[]; env: Env } {
    return { command: '/usr/bin/docker', args: [...args], env: { DOCKER_HOST: this.target, ...env } };
  }

  /** Calls whose first argument is `sub` (e.g. 'create'). */
  of(sub: string): string[][] {
    return this.calls.filter((c) => c[0] === sub);
  }

  async run(args: string[]): Promise<DockerResult> {
    this.calls.push([...args]);
    if (this.down) return { code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon at tcp://fake-dind:2376. Is the docker daemon running?' };
    const [sub, ...rest] = args;
    const fail = this.failing.get(sub!);
    if (fail) return fail;
    const last = rest[rest.length - 1]!;
    switch (sub) {
      case 'container': {
        const c = this.containers.get(last);
        if (!c) return noSuch(`container: ${last}`);
        const startedAt = c.state === 'running' ? '2026-11-25T10:00:00.000Z' : '0001-01-01T00:00:00Z';
        return ok(JSON.stringify([{ Id: c.id, State: { Status: c.state, StartedAt: startedAt }, Config: { Image: c.image } }]));
      }
      case 'image':
        if (rest[0] === 'inspect') return this.images.has(last) ? ok('sha256:abc\n') : noSuch(`image: ${last}`);
        if (rest[0] === 'rm') return this.images.delete(last) ? ok() : noSuch(`image: ${last}`);
        return ok();
      case 'pull':
      case 'build': {
        const tag = sub === 'pull' ? last : rest[rest.indexOf('--tag') + 1]!;
        this.images.add(tag);
        return ok();
      }
      case 'create': {
        const name = rest[rest.indexOf('--name') + 1]!;
        if (this.containers.has(name)) return { code: 1, stdout: '', stderr: `Conflict. The container name "/${name}" is already in use` };
        const image = rest[rest.indexOf('/bin/sh') + 1]!;
        if (!this.images.has(image)) return noSuch(`image: ${image}`);
        const id = `c${this.#next++}`;
        this.containers.set(name, { id, image, state: 'created', args: [...args] });
        return ok(`${id}\n`);
      }
      case 'start':
      case 'unpause':
      case 'stop': {
        const c = this.containers.get(last);
        if (!c) return noSuch(`container: ${last}`);
        c.state = sub === 'stop' ? 'exited' : 'running';
        return ok(`${last}\n`);
      }
      case 'rm':
        return this.containers.delete(last) ? ok(`${last}\n`) : noSuch(`container: ${last}`);
      case 'exec': {
        const name = rest.find((a) => this.containers.has(a));
        if (!name || this.containers.get(name)!.state !== 'running') return { code: 1, stdout: '', stderr: 'container is not running' };
        return ok();
      }
      default:
        return { code: 125, stdout: '', stderr: `fake docker: unknown command ${sub}` };
    }
  }
}
