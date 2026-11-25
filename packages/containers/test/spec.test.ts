import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WorkspaceContainer, WorkspaceInfo } from '@bizzi/protocol';
import {
  DISABLED_REASON,
  KEEPALIVE,
  buildArgs,
  containerName,
  createArgs,
  devcontainerTag,
  execArgs,
  forwardedEnv,
  hostnameFor,
  mountArg,
  parseInspect,
  postCreateArgs,
  reachableMcpServers,
  resolveDockerTarget,
} from '../src/index.ts';

const recipe: WorkspaceContainer = {
  image: 'bizzi/workspace:latest',
  imageSource: 'default',
  network: 'none',
  mounts: [{ source: '/srv/auth/codex.json', target: '/home/agent/.codex/auth.json', readOnly: true }],
  env: { CI: '1' },
  user: '1000:1000',
  lifecycle: 'persistent',
  idleMinutes: 30,
};
const ws: WorkspaceInfo = {
  id: 'w_abc',
  machineId: 'm_1',
  name: 'Acme PR 482',
  path: '/workspaces/acme',
  kind: 'container',
  container: recipe,
  createdAt: '2026-11-25T00:00:00.000Z',
};

test('createArgs: labels, init, workspace at the same path, mounts, env, user, keepalive entrypoint', () => {
  assert.deepEqual(createArgs(ws, recipe, { machineId: 'm_1' }), [
    'create',
    '--name',
    'bizzi-ws-w_abc',
    '--label',
    'bizzi.managed=1',
    '--label',
    'bizzi.workspace=w_abc',
    '--label',
    'bizzi.machine=m_1',
    '--init',
    '--hostname',
    'acme-pr-482',
    '--network',
    'none',
    '--mount',
    'type=bind,source=/workspaces/acme,target=/workspaces/acme',
    '--mount',
    'type=bind,source=/srv/auth/codex.json,target=/home/agent/.codex/auth.json,readonly',
    '--env',
    'CI=1',
    '--user',
    '1000:1000',
    '--workdir',
    '/workspaces/acme',
    '--entrypoint',
    '/bin/sh',
    'bizzi/workspace:latest',
    '-c',
    KEEPALIVE,
  ]);
});

test('createArgs defaults to the bridge network and no user', () => {
  const args = createArgs(ws, { ...recipe, network: '', user: undefined, mounts: undefined, env: undefined }, { machineId: 'm_1' });
  assert.equal(args[args.indexOf('--network') + 1], 'bridge');
  assert.ok(!args.includes('--user'));
  assert.equal(args.filter((a) => a === '--mount').length, 1);
});

test('mountArg quotes fields with commas or quotes (Docker parses --mount as CSV)', () => {
  assert.equal(mountArg({ source: '/a,b', target: '/c"d' }), 'type=bind,"source=/a,b","target=/c""d"');
});

test('containerName, hostnameFor and devcontainerTag are docker-safe', () => {
  assert.equal(containerName('w_1/x'), 'bizzi-ws-w_1-x');
  assert.equal(hostnameFor('  --Über Repo!! '), 'ber-repo');
  assert.equal(hostnameFor('!!!'), 'workspace');
  assert.equal(hostnameFor('x'.repeat(80)).length, 63);
  assert.match(devcontainerTag('/workspaces/acme'), /^bizzi-dc-[0-9a-f]{12}:latest$/);
  assert.equal(devcontainerTag('/a'), devcontainerTag('/a'));
});

test('execArgs: interactive, tty with other detach keys, env by name only', () => {
  assert.deepEqual(execArgs('bizzi-ws-w_abc', { command: 'codex', args: ['app-server'], cwd: '/workspaces/acme' }, ['A', 'B']), [
    'exec',
    '--interactive',
    '--workdir',
    '/workspaces/acme',
    '--env',
    'A',
    '--env',
    'B',
    'bizzi-ws-w_abc',
    'codex',
    'app-server',
  ]);
  const tty = execArgs('n', { command: 'sh', args: [], cwd: '/w', tty: true }, []);
  assert.deepEqual(tty.slice(0, 5), ['exec', '--interactive', '--tty', '--detach-keys', 'ctrl-],ctrl-]']);
});

test('forwardedEnv: only what the adapter added or changed, plus passEnv, never host-only variables', () => {
  const base = { PATH: '/usr/bin', HOME: '/home/me', LANG: 'C', ANTHROPIC_API_KEY: 'sk-node', BIZZI_TOKEN: 't', SECRET_ON_NODE: 'x' };
  const spec = {
    ...base,
    PATH: '/opt/x:/usr/bin', // changed, but host-only
    HOME: '/elsewhere',
    NO_COLOR: '1', // added by the adapter
    CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
    OPENAI_API_KEY: 'sk-secret-store', // agentEnv (secrets) added it
    DOCKER_HOST: 'unix:///var/run/docker.sock',
    XDG_CONFIG_HOME: '/x',
    UNSET: undefined,
  };
  assert.deepEqual(forwardedEnv(spec, base, ['ANTHROPIC_API_KEY', 'NOT_SET', 'DOCKER_CONFIG']), {
    NO_COLOR: '1',
    CLAUDE_CODE_ENTRYPOINT: 'sdk-ts',
    OPENAI_API_KEY: 'sk-secret-store',
    ANTHROPIC_API_KEY: 'sk-node',
  });
});

test('postCreateArgs: a shell line runs under sh -c, an argv as is', () => {
  assert.deepEqual(postCreateArgs('n', '/w', 'npm ci && npm test'), ['exec', '--workdir', '/w', 'n', '/bin/sh', '-c', 'npm ci && npm test']);
  assert.deepEqual(postCreateArgs('n', '/w', ['make', 'setup']), ['exec', '--workdir', '/w', 'n', 'make', 'setup']);
});

test('buildArgs', () => {
  assert.deepEqual(buildArgs('t:1', { dockerfile: '/r/.devcontainer/Dockerfile', context: '/r', args: { V: '2' } }), [
    'build',
    '--tag',
    't:1',
    '--file',
    '/r/.devcontainer/Dockerfile',
    '--build-arg',
    'V=2',
    '/r',
  ]);
  assert.deepEqual(buildArgs('t', { context: '/img' }), ['build', '--tag', 't', '/img']);
});

test('parseInspect', () => {
  const out = JSON.stringify([{ Id: 'abc', State: { Status: 'running', StartedAt: '2026-11-25T10:00:00Z' }, Config: { Image: 'alpine' } }]);
  assert.deepEqual(parseInspect(out), { id: 'abc', state: 'running', image: 'alpine', startedAt: '2026-11-25T10:00:00Z' });
  const created = JSON.stringify([{ Id: 'x', State: { Status: 'created', StartedAt: '0001-01-01T00:00:00Z' }, Config: { Image: 'i' } }]);
  assert.deepEqual(parseInspect(created), { id: 'x', state: 'created', image: 'i' });
  assert.equal(parseInspect('not json'), undefined);
  assert.equal(parseInspect('[]'), undefined);
});

test('reachableMcpServers keeps only http servers off this machine', () => {
  const { kept, dropped } = reachableMcpServers({
    memory: { type: 'stdio', command: '/usr/bin/node', args: ['/app/mcp.ts'] },
    agents: { type: 'http', url: 'http://127.0.0.1:41234/mcp' },
    local6: { type: 'http', url: 'http://[::1]:3000/mcp' },
    remote: { type: 'http', url: 'https://mcp.example.com/mcp' },
    broken: { type: 'http', url: 'not a url' },
  });
  assert.deepEqual(Object.keys(kept), ['remote']);
  assert.deepEqual(dropped, ['memory', 'agents', 'local6', 'broken']);
});

test('resolveDockerTarget never falls back to the host socket by itself', () => {
  assert.deepEqual(resolveDockerTarget({}), { enabled: false, reason: DISABLED_REASON });
  assert.equal(resolveDockerTarget({ BIZZI_CONTAINERS: '0', DOCKER_HOST: 'tcp://x:2375' }).enabled, false);

  const dind = resolveDockerTarget({
    BIZZI_DOCKER_HOST: 'tcp://dind:2376',
    BIZZI_DOCKER_TLS_VERIFY: '1',
    BIZZI_DOCKER_CERT_PATH: '/certs/client',
    DOCKER_CONTEXT: 'desktop-linux',
    PATH: '/usr/bin',
  });
  assert.ok(dind.enabled);
  assert.equal(dind.target, 'tcp://dind:2376');
  assert.equal(dind.env.DOCKER_HOST, 'tcp://dind:2376');
  assert.equal(dind.env.DOCKER_TLS_VERIFY, '1');
  assert.equal(dind.env.DOCKER_CERT_PATH, '/certs/client');
  assert.equal(dind.env.DOCKER_CONTEXT, undefined);
  assert.equal(dind.env.PATH, '/usr/bin');

  const plain = resolveDockerTarget({ BIZZI_DOCKER_HOST: 'tcp://dind:2375', BIZZI_DOCKER_TLS_VERIFY: '0' });
  assert.ok(plain.enabled);
  assert.equal(plain.env.DOCKER_TLS_VERIFY, undefined);

  const host = resolveDockerTarget({ DOCKER_HOST: 'ssh://builder' });
  assert.ok(host.enabled);
  assert.equal(host.target, 'ssh://builder');

  const local = resolveDockerTarget({ BIZZI_CONTAINERS: '1' });
  assert.ok(local.enabled);
  assert.equal(local.target, 'default context');
});
