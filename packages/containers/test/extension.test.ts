import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createNode, type BizziNode } from '@bizzi/core';
import { FakeAdapter } from '@bizzi/core/testing';
import type { BizziError } from '@bizzi/protocol';
import { DEFAULT_IMAGE, DEFAULT_PASS_ENV, createContainersExtension } from '../src/index.ts';
import { FakeDocker } from './fake-docker.ts';

async function waitFor<T>(fn: () => T | undefined | false, what = 'condition'): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const code = (c: string) => (err: BizziError) => {
  assert.equal(err.code, c);
  return true;
};

async function setup(t: { after: (fn: () => unknown) => void }, env: Record<string, string> = {}) {
  const root = realpathSync(mkdtempSync(join(os.tmpdir(), 'bizzi-containers-')));
  const docker = new FakeDocker();
  const adapter = new FakeAdapter({ probe: { support: 'ok' } });
  const ext = createContainersExtension({ docker, sweepMs: 0, user: '1000:1000', env: { PATH: '/usr/bin', ...env } });
  const node: BizziNode = await createNode({
    dataDir: join(root, 'data'),
    adapters: [adapter],
    version: '0.0.0-test',
    machineName: 'server-a',
    // Like the knowledge injection: a stdio server on the node, unreachable from a container.
    prepareStart: () => ({ mcpServers: { 'bizzi-memory': { type: 'stdio', command: process.execPath, args: ['/app/mcp.ts'] } } }),
    extensions: [ext],
  });
  t.after(async () => {
    await node.close();
    rmSync(root, { recursive: true, force: true });
  });
  const dir = join(root, 'acme');
  mkdirSync(dir);
  return { root, dir, docker, adapter, ext, node };
}

test('container.create records the recipe; nothing runs until the first session', async (t) => {
  const { dir, docker, node } = await setup(t);
  const { workspace, notes } = await node.call('container.create', { path: dir, name: 'acme-pr-482', idleMinutes: 15 });
  assert.equal(workspace.kind, 'container');
  assert.equal(workspace.name, 'acme-pr-482');
  assert.equal(workspace.path, dir);
  assert.deepEqual(workspace.container, {
    image: DEFAULT_IMAGE,
    imageSource: 'default',
    network: 'bridge',
    lifecycle: 'persistent',
    idleMinutes: 15,
    user: '1000:1000',
    passEnv: DEFAULT_PASS_ENV,
  });
  assert.equal(notes, undefined);
  assert.deepEqual(docker.calls, []);

  // Same directory again: the existing container workspace, also for workspace.create.
  const again = await node.call('container.create', { path: dir, image: 'alpine:3.20' });
  assert.equal(again.workspace.id, workspace.id);
  assert.deepEqual(again.notes, ['a container workspace for this directory already exists; its settings were kept']);
  assert.equal((await node.call('workspace.create', { path: dir })).workspace.id, workspace.id);

  const st = await node.call('container.status', { workspaceId: workspace.id });
  assert.equal(st.container.state, 'absent');

  // A directory that is already a host workspace is one workspace: no container workspace of it.
  const hostDir = join(dir, '..', 'host');
  mkdirSync(hostDir);
  const hostWs = await node.call('workspace.create', { path: hostDir });
  await assert.rejects(node.call('container.create', { path: hostDir }), code('conflict'));
  await assert.rejects(node.call('container.status', { workspaceId: hostWs.workspace.id }), code('bad_request'));
});

test('container.create validates its parameters', async (t) => {
  const { dir, node } = await setup(t);
  for (const bad of [
    { path: 'relative/dir' },
    { path: dir, image: '-v /:/host' },
    { path: dir, network: 'a b' },
    { path: dir, lifecycle: 'forever' },
    { path: dir, idleMinutes: 0 },
    { path: dir, mounts: [{ source: 'rel', target: '/x' }] },
    { path: dir, passEnv: ['NOT-A-NAME'] },
    { path: dir, user: 'root;rm' },
  ]) {
    await assert.rejects(node.dispatch('container.create', bad), code('bad_request'), JSON.stringify(bad));
  }
  await assert.rejects(node.call('container.create', { path: join(dir, 'missing') }), code('not_found'));
  const made = await node.call('container.create', { path: join(dir, 'new'), create: true, network: 'none', passEnv: [] });
  assert.equal(made.workspace.container?.network, 'none');
  assert.equal(made.workspace.container?.passEnv, undefined);
});

test('a session starts the container and runs through docker exec; MCP servers on the node are left out', async (t) => {
  const { dir, docker, adapter, node } = await setup(t);
  const { workspace } = await node.call('container.create', { path: dir });
  const { session } = await node.call('session.create', { workspaceId: workspace.id, agent: 'claude' });
  await node.call('session.send', { sessionId: session.id, input: [{ type: 'text', text: 'hi' }] });
  const start = await waitFor(() => adapter.starts[0], 'adapter start');
  assert.equal(start.cwd, dir);
  assert.equal(start.launcher?.label, `container bizzi-ws-${workspace.id}`);
  assert.equal(start.mcpServers, undefined);
  assert.equal(docker.containers.get(`bizzi-ws-${workspace.id}`)?.state, 'running');
  const create = docker.of('create')[0]!;
  assert.ok(create.includes(`type=bind,source=${dir},target=${dir}`));
  assert.ok(create.includes('1000:1000'));

  const run = start.launcher!.wrap({ command: 'claude', args: ['--print'], cwd: dir, env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' } });
  assert.deepEqual(run.args.slice(-3), [`bizzi-ws-${workspace.id}`, 'claude', '--print']);

  const st = await node.call('container.status', { workspaceId: workspace.id });
  assert.equal(st.container.state, 'running');
  assert.equal(st.container.liveSessions, 1);

  // Host workspaces are untouched by the extension.
  const hostDir = join(dir, '..', 'host');
  mkdirSync(hostDir);
  const host = await node.call('workspace.create', { path: hostDir });
  const hs = await node.call('session.create', { workspaceId: host.workspace.id, agent: 'claude' });
  await node.call('session.send', { sessionId: hs.session.id, input: [{ type: 'text', text: 'hi' }] });
  const hostStart = await waitFor(() => adapter.starts[1], 'host start');
  assert.equal(hostStart.launcher, undefined);
  assert.ok(hostStart.mcpServers?.['bizzi-memory']);
});

test('container.stop refuses live sessions unless forced; workspace.remove removes the container', async (t) => {
  const { dir, docker, adapter, node } = await setup(t);
  const { workspace } = await node.call('container.create', { path: dir });
  const { session } = await node.call('session.create', { workspaceId: workspace.id, agent: 'claude' });
  await node.call('session.send', { sessionId: session.id, input: [{ type: 'text', text: 'hi' }] });
  await waitFor(() => adapter.starts[0], 'adapter start');
  await waitFor(() => node.sessions.list(workspace.id)[0]?.status === 'idle', 'idle');

  await assert.rejects(node.call('container.stop', { workspaceId: workspace.id }), code('conflict'));
  const stopped = await node.call('container.stop', { workspaceId: workspace.id, force: true });
  assert.equal(stopped.container.state, 'exited');
  assert.equal(stopped.container.liveSessions, 0);
  assert.equal(node.sessions.list(workspace.id)[0]?.status, 'ended');

  await node.call('workspace.remove', { workspaceId: workspace.id });
  await waitFor(() => !docker.containers.has(`bizzi-ws-${workspace.id}`), 'container removed');
});

test('the idle timer stops a container whose sessions have ended', async (t) => {
  const { dir, docker, adapter, ext, node } = await setup(t);
  const { workspace } = await node.call('container.create', { path: dir, idleMinutes: 1 });
  const { session } = await node.call('session.create', { workspaceId: workspace.id, agent: 'claude' });
  await node.call('session.send', { sessionId: session.id, input: [{ type: 'text', text: 'hi' }] });
  await waitFor(() => adapter.starts[0], 'adapter start');
  await ext.sweep();
  assert.equal(docker.containers.get(`bizzi-ws-${workspace.id}`)?.state, 'running');
  await node.call('session.stop', { sessionId: session.id });
  await ext.sweep(); // idle timer runs from the last live moment: not yet
  assert.equal(docker.containers.get(`bizzi-ws-${workspace.id}`)?.state, 'running');
  // Pretend a minute passed.
  const realNow = Date.now;
  Date.now = () => realNow() + 61_000;
  try {
    await ext.sweep();
  } finally {
    Date.now = realNow;
  }
  assert.equal(docker.containers.get(`bizzi-ws-${workspace.id}`)?.state, 'exited');
});

test('a devcontainer.json decides the image, env, user and create commands', async (t) => {
  const { dir, node } = await setup(t);
  mkdirSync(join(dir, '.devcontainer'));
  writeFileSync(
    join(dir, '.devcontainer', 'devcontainer.json'),
    `{
      // JSONC
      "build": { "dockerfile": "Dockerfile", "context": ".." },
      "containerEnv": { "APP_ENV": "dev" },
      "remoteUser": "vscode",
      "postCreateCommand": "npm ci",
      "forwardPorts": [3000],
    }`,
  );
  const { workspace, notes } = await node.call('container.create', { path: dir });
  const c = workspace.container!;
  assert.equal(c.imageSource, 'devcontainer');
  assert.match(c.image, /^bizzi-dc-[0-9a-f]{12}:latest$/);
  assert.deepEqual(c.build, { dockerfile: join(dir, '.devcontainer', 'Dockerfile'), context: dir });
  assert.deepEqual(c.env, { APP_ENV: 'dev' });
  assert.equal(c.user, 'vscode');
  assert.deepEqual(c.postCreate, ['npm ci']);
  assert.deepEqual(notes, ['devcontainer.json: forwardPorts is ignored']);

  // An explicit image wins over the repo's devcontainer.json.
  const other = join(dir, '..', 'other');
  mkdirSync(other);
  writeFileSync(join(other, '.devcontainer.json'), '{ "image": "from-devcontainer" }');
  const explicit = await node.call('container.create', { path: other, image: 'alpine:3.20' });
  assert.equal(explicit.workspace.container?.image, 'alpine:3.20');
  assert.equal(explicit.workspace.container?.imageSource, 'explicit');
});

test('a git worktree also mounts the main repository git dir', async (t) => {
  const { root, node } = await setup(t);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const wt = join(root, 'repo-pr');
  git(repo, 'worktree', 'add', '-q', '-b', 'pr', wt);
  const { workspace } = await node.call('container.create', { path: wt });
  assert.deepEqual(workspace.container?.mounts, [{ source: join(repo, '.git'), target: join(repo, '.git') }]);

  const plain = await node.call('container.create', { path: repo });
  assert.equal(plain.workspace.container?.mounts, undefined);
});

test('without a configured daemon the methods answer unsupported', async (t) => {
  const root = mkdtempSync(join(os.tmpdir(), 'bizzi-containers-'));
  const ext = createContainersExtension({ env: {}, sweepMs: 0 });
  const node = await createNode({ dataDir: root, adapters: [new FakeAdapter()], version: '0.0.0-test', extensions: [ext] });
  t.after(async () => {
    await node.close();
    rmSync(root, { recursive: true, force: true });
  });
  assert.equal(ext.manager, undefined);
  await assert.rejects(node.call('container.create', { path: root }), (err: BizziError) => {
    assert.equal(err.code, 'unsupported');
    assert.match(err.message, /BIZZI_DOCKER_HOST/);
    return true;
  });
});
