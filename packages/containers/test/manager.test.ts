import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BizziError, type Logger, type WorkspaceContainer, type WorkspaceInfo } from '@bizzi/protocol';
import { ContainerManager, DEFAULT_IMAGE } from '../src/index.ts';
import { FakeDocker } from './fake-docker.ts';

const logger: Logger = { log() {}, child: () => logger };

function workspace(c: Partial<WorkspaceContainer> = {}, id = 'w_1'): WorkspaceInfo {
  return {
    id,
    machineId: 'm_1',
    name: 'acme',
    path: '/workspaces/acme',
    kind: 'container',
    container: { image: DEFAULT_IMAGE, imageSource: 'default', network: 'bridge', lifecycle: 'persistent', idleMinutes: 10, ...c },
    createdAt: '2026-11-25T00:00:00.000Z',
  };
}

function setup(opts: { now?: () => number; baseEnv?: Record<string, string> } = {}) {
  const docker = new FakeDocker();
  const manager = new ContainerManager({
    docker,
    machineId: 'm_1',
    logger,
    defaultImageContext: '/app/packages/containers/image',
    hostCwd: '/home/bizzi',
    baseEnv: opts.baseEnv ?? { PATH: '/usr/bin', HOME: '/home/bizzi' },
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { docker, manager };
}

test('first start builds the default image from its directory, creates, starts and runs post-create commands', async () => {
  const { docker, manager } = setup();
  const ws = workspace({ postCreate: ['npm ci', ['make', 'setup']] });
  await manager.ensureRunning(ws);
  assert.deepEqual(
    docker.calls.map((c) => c[0] === 'container' || c[0] === 'image' ? `${c[0]} ${c[1]}` : c[0]),
    ['container inspect', 'image inspect', 'build', 'create', 'start', 'exec', 'exec'],
  );
  assert.deepEqual(docker.of('build')[0], ['build', '--tag', DEFAULT_IMAGE, '/app/packages/containers/image']);
  assert.deepEqual(docker.of('exec')[0], ['exec', '--workdir', '/workspaces/acme', 'bizzi-ws-w_1', '/bin/sh', '-c', 'npm ci']);
  assert.equal(docker.containers.get('bizzi-ws-w_1')?.state, 'running');

  // Running already: just an inspect.
  docker.calls.length = 0;
  await manager.ensureRunning(ws);
  assert.deepEqual(docker.calls, [['container', 'inspect', 'bizzi-ws-w_1']]);

  // Stopped: started again, nothing recreated, post-create not re-run.
  docker.containers.get('bizzi-ws-w_1')!.state = 'exited';
  docker.calls.length = 0;
  await manager.ensureRunning(ws);
  assert.deepEqual(docker.calls, [['container', 'inspect', 'bizzi-ws-w_1'], ['start', 'bizzi-ws-w_1']]);
});

test('an explicit image is pulled, a devcontainer build is built; images already there are used', async () => {
  const { docker, manager } = setup();
  await manager.ensureRunning(workspace({ image: 'alpine:3.20', imageSource: 'explicit' }, 'w_a'));
  assert.deepEqual(docker.of('pull'), [['pull', 'alpine:3.20']]);

  await manager.ensureRunning(
    workspace({ image: 'bizzi-dc-123:latest', imageSource: 'devcontainer', build: { dockerfile: '/r/.devcontainer/Dockerfile', context: '/r' } }, 'w_b'),
  );
  assert.deepEqual(docker.of('build'), [['build', '--tag', 'bizzi-dc-123:latest', '--file', '/r/.devcontainer/Dockerfile', '/r']]);

  docker.calls.length = 0;
  await manager.ensureRunning(workspace({ image: 'alpine:3.20', imageSource: 'explicit' }, 'w_c'));
  assert.deepEqual(docker.of('pull'), []);

  // A different default image (BIZZI_CONTAINER_IMAGE) is pulled, not built from bizzi's directory.
  await manager.ensureRunning(workspace({ image: 'registry.example.com/agents:7', imageSource: 'default' }, 'w_d'));
  assert.deepEqual(docker.of('pull'), [['pull', 'registry.example.com/agents:7']]);
});

test('a failing post-create command removes the half-made container', async () => {
  const { docker, manager } = setup();
  docker.failing.set('exec', { code: 2, stdout: '', stderr: 'npm ERR! missing script' });
  await assert.rejects(manager.ensureRunning(workspace({ postCreate: ['npm run nope'] })), (err: BizziError) => {
    assert.equal(err.code, 'agent_unavailable');
    assert.match(err.message, /post-create command failed.*missing script/);
    return true;
  });
  assert.equal(docker.containers.size, 0);
  assert.deepEqual(docker.of('rm'), [['rm', '--force', 'bizzi-ws-w_1']]);
});

test('an unreachable daemon is agent_unavailable naming the daemon; status says unreachable', async () => {
  const { docker, manager } = setup();
  docker.down = true;
  await assert.rejects(manager.ensureRunning(workspace()), (err: BizziError) => {
    assert.equal(err.code, 'agent_unavailable');
    assert.match(err.message, /Docker daemon at tcp:\/\/fake-dind:2376 is not reachable/);
    return true;
  });
  const st = await manager.status(workspace(), 0);
  assert.equal(st.state, 'unreachable');
  assert.match(st.error ?? '', /Cannot connect/);
});

test('status, stop and remove', async () => {
  let now = Date.parse('2026-11-25T10:00:00.000Z');
  const { docker, manager } = setup({ now: () => now });
  const ws = workspace();
  assert.deepEqual(await manager.status(ws, 0), { workspaceId: 'w_1', name: 'bizzi-ws-w_1', state: 'absent', image: DEFAULT_IMAGE, liveSessions: 0 });
  await manager.ensureRunning(ws);
  now += 60_000;
  const st = await manager.status(ws, 0);
  assert.equal(st.state, 'running');
  assert.equal(st.id, 'c1');
  assert.equal(st.idleUntil, '2026-11-25T10:10:00.000Z');
  assert.equal((await manager.status(ws, 1)).idleUntil, undefined);

  await manager.stop(ws.id);
  assert.deepEqual(docker.of('stop'), [['stop', '--time', '10', 'bizzi-ws-w_1']]);
  assert.equal((await manager.status(ws, 0)).state, 'exited');
  await manager.stop(ws.id); // not running: nothing to do
  assert.equal(docker.of('stop').length, 1);

  await manager.remove(ws.id, ws.container);
  assert.equal((await manager.status(ws, 0)).state, 'absent');
  await manager.remove(ws.id); // already gone: fine
});

test('remove also drops an image built from devcontainer.json', async () => {
  const { docker, manager } = setup();
  const ws = workspace({ image: 'bizzi-dc-9:latest', imageSource: 'devcontainer', build: { context: '/r', dockerfile: '/r/Dockerfile' } });
  await manager.ensureRunning(ws);
  await manager.remove(ws.id, ws.container);
  assert.deepEqual(docker.of('image').at(-1), ['image', 'rm', 'bizzi-dc-9:latest']);
  assert.ok(!docker.images.has('bizzi-dc-9:latest'));
});

test('idle timer: persistent containers stop, ephemeral ones are removed, live sessions keep them', async () => {
  let now = 0;
  const { docker, manager } = setup({ now: () => now });
  const keep = workspace({ idleMinutes: 5 }, 'w_keep');
  const eph = workspace({ idleMinutes: 5, lifecycle: 'ephemeral' }, 'w_eph');
  const busy = workspace({ idleMinutes: 5 }, 'w_busy');
  const host: WorkspaceInfo = { ...workspace(), id: 'w_host', kind: 'git' };
  delete host.container;
  for (const ws of [keep, eph, busy]) await manager.ensureRunning(ws);
  const live = (id: string) => (id === 'w_busy' ? 1 : 0);
  const all = [keep, eph, busy, host];

  now = 4 * 60_000;
  await manager.sweep(all, live);
  assert.equal(docker.of('stop').length + docker.of('rm').length, 0);

  now = 5 * 60_000;
  await manager.sweep(all, live);
  assert.equal(docker.containers.get('bizzi-ws-w_keep')?.state, 'exited');
  assert.equal(docker.containers.has('bizzi-ws-w_eph'), false);
  assert.equal(docker.containers.get('bizzi-ws-w_busy')?.state, 'running');

  // Seen for the first time (e.g. after a node restart): the timer starts now.
  const { docker: d2, manager: m2 } = setup({ now: () => now });
  d2.images.add(DEFAULT_IMAGE);
  await new ContainerManager({ docker: d2, machineId: 'm_1', logger }).ensureRunning(keep);
  await m2.sweep([keep], () => 0);
  assert.equal(d2.containers.get('bizzi-ws-w_keep')?.state, 'running');
  now += 5 * 60_000;
  await m2.sweep([keep], () => 0);
  assert.equal(d2.containers.get('bizzi-ws-w_keep')?.state, 'exited');
});

test('launcher: docker exec with env passed by name, values in the CLI environment', () => {
  const { manager } = setup({ baseEnv: { PATH: '/usr/bin', HOME: '/home/bizzi', CLAUDE_CODE_OAUTH_TOKEN: 'tok', UNRELATED: 'x' } });
  const launcher = manager.launcher(workspace({ passEnv: ['CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY'] }));
  assert.equal(launcher.label, 'container bizzi-ws-w_1');
  const run = launcher.wrap({
    command: 'codex',
    args: ['app-server'],
    cwd: '/workspaces/acme',
    env: { PATH: '/usr/bin', HOME: '/home/bizzi', UNRELATED: 'x', NO_COLOR: '1', BIZZI_SESSION: 's_1' },
  });
  assert.equal(run.command, '/usr/bin/docker');
  assert.equal(run.cwd, '/home/bizzi');
  assert.deepEqual(run.args, [
    'exec',
    '--interactive',
    '--workdir',
    '/workspaces/acme',
    '--env',
    'BIZZI_SESSION',
    '--env',
    'CLAUDE_CODE_OAUTH_TOKEN',
    '--env',
    'NO_COLOR',
    'bizzi-ws-w_1',
    'codex',
    'app-server',
  ]);
  assert.ok(!run.args.some((a) => a.includes('tok')), 'secret values never appear in argv');
  assert.equal(run.env.CLAUDE_CODE_OAUTH_TOKEN, 'tok');
  assert.equal(run.env.DOCKER_HOST, 'tcp://fake-dind:2376');

  const tty = launcher.wrap({ command: 'bash', args: ['-l'], cwd: '/workspaces/acme', env: {}, tty: true });
  assert.ok(tty.args.includes('--tty'));

  assert.deepEqual(
    launcher.mapMcpServers!({ mem: { type: 'stdio', command: 'node' }, far: { type: 'http', url: 'https://mcp.example.com' } }),
    { far: { type: 'http', url: 'https://mcp.example.com' } },
  );
});

test('a host workspace has no container recipe', async () => {
  const { manager } = setup();
  const host: WorkspaceInfo = { ...workspace(), kind: 'git' };
  delete host.container;
  assert.throws(() => manager.launcher(host), /not a container workspace/);
  await assert.rejects(manager.ensureRunning(host), /not a container workspace/);
});
