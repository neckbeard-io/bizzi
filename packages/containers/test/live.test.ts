// Against a real Docker daemon. Opt in: BIZZI_LIVE=1 plus a daemon the way the node picks one
// (BIZZI_DOCKER_HOST, DOCKER_HOST, or BIZZI_CONTAINERS=1 for this machine's default context).
// BIZZI_LIVE_CONTAINER_IMAGE picks the image (default alpine:3.20, pulled when missing). The workspace
// directory is made under BIZZI_LIVE_TMP (default the OS temp dir): with a VM-backed daemon (Docker
// Desktop, colima) it must be a directory the VM shares.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Logger, WorkspaceInfo } from '@bizzi/protocol';
import { CliDocker, ContainerManager, cleanEnv, resolveDockerTarget } from '../src/index.ts';

const target = resolveDockerTarget(process.env);
const skip = process.env.BIZZI_LIVE !== '1' ? 'set BIZZI_LIVE=1' : !target.enabled ? target.reason : false;
const logger: Logger = { log() {}, child: () => logger };

test('live: create, exec with forwarded env, stop and remove a real container', { skip, timeout: 10 * 60_000 }, async () => {
  if (!target.enabled) return;
  const dir = realpathSync(mkdtempSync(join(process.env.BIZZI_LIVE_TMP ?? os.tmpdir(), 'bizzi-live-ws-')));
  const docker = new CliDocker({ env: target.env, target: target.target });
  const manager = new ContainerManager({ docker, machineId: 'm_live', logger, baseEnv: process.env });
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  const ws: WorkspaceInfo = {
    id: `w_live${Date.now().toString(36)}`,
    machineId: 'm_live',
    name: 'live',
    path: dir,
    kind: 'container',
    container: {
      image: process.env.BIZZI_LIVE_CONTAINER_IMAGE ?? 'alpine:3.20',
      imageSource: 'explicit',
      network: 'none',
      lifecycle: 'ephemeral',
      idleMinutes: 1,
      ...(uid !== undefined && gid !== undefined ? { user: `${uid}:${gid}` } : {}),
      postCreate: ['echo created > .bizzi-live'],
    },
    createdAt: new Date().toISOString(),
  };
  try {
    await manager.ensureRunning(ws);
    assert.equal((await manager.status(ws, 0)).state, 'running');
    assert.equal(readFileSync(join(dir, '.bizzi-live'), 'utf8').trim(), 'created');

    const run = manager.launcher(ws).wrap({
      command: 'sh',
      args: ['-c', 'echo "$PWD|$BIZZI_LIVE_VALUE"; cat'],
      cwd: dir,
      env: { ...process.env, BIZZI_LIVE_VALUE: 'from-the-node' },
    });
    const child = spawn(run.command, run.args, { cwd: run.cwd, env: cleanEnv(run.env), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stdin.end('stdin works\n');
    const code = await new Promise<number | null>((r) => child.on('close', r));
    assert.equal(code, 0);
    assert.equal(out, `${dir}|from-the-node\nstdin works\n`);

    await manager.stop(ws.id);
    assert.equal((await manager.status(ws, 0)).state, 'exited');
    await manager.ensureRunning(ws);
    assert.equal((await manager.status(ws, 0)).state, 'running');
  } finally {
    await manager.remove(ws.id, ws.container);
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal((await manager.status(ws, 0)).state, 'absent');
});
