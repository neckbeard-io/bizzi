import assert from 'node:assert/strict';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createNode } from '@bizzi/core';
import { FakeAdapter } from '@bizzi/core/testing';
import type { MethodResult } from '@bizzi/protocol';
import { connectToHub, pairWithHub } from '../src/index.ts';
import { makeHub, pairDevice, setupCode, tempDir, TestClient, tokenFor, waitFor } from './helpers.ts';

test('hub routes fs.browse / fs.complete / fs.suggest by machineId; offline → machine_offline', async (t) => {
  const hubDir = tempDir();
  const nodeDir = tempDir();
  const homeDir = tempDir('bizzi-hub-home-');
  const home = realpathSync(homeDir.path);
  mkdirSync(join(home, 'src', 'app', '.git'), { recursive: true });
  mkdirSync(join(home, 'repo'), { recursive: true });

  const hub = await makeHub(hubDir.path, { requestTimeoutMs: 5000 });
  const owner = await pairDevice(hub, setupCode(hub), 'phone');
  const client = await TestClient.connect(hub.clientUrl, await tokenFor(hub, owner));
  const node = await createNode({ dataDir: nodeDir.path, adapters: [new FakeAdapter()], version: '0', machineName: 'alpha', browse: { home, caseInsensitive: false } });
  const { code } = await client.call<{ code: string }>('pairing.create', { kind: 'node', name: 'alpha' });
  const { credential } = await pairWithHub({ hubUrl: hub.url, code, kind: 'node', name: 'alpha', machineId: node.machine.id });
  const link = connectToHub(node, { url: hub.nodeUrl, credentials: credential, minBackoffMs: 20 });
  t.after(async () => {
    await link.close();
    client.close();
    await hub.close();
    await node.close();
    for (const d of [hubDir, nodeDir, homeDir]) d.cleanup();
  });
  await link.waitConnected(5000);
  const machineId = node.machine.id;

  const browsed = await client.call<MethodResult<'fs.browse'>>('fs.browse', { machineId, path: '~/src' });
  assert.equal(browsed.path, join(home, 'src'));
  assert.deepEqual(browsed.entries.map((e) => [e.name, e.git]), [['app', true]]);

  const done = await client.call<MethodResult<'fs.complete'>>('fs.complete', { machineId, prefix: '~/re' });
  assert.equal(done.base, '~/');
  assert.deepEqual(done.completions.map((e) => e.name), ['repo']);

  const suggested = await client.call<MethodResult<'fs.suggest'>>('fs.suggest', { machineId });
  assert.ok(suggested.entries.some((e) => e.suggest === 'repo' && e.path === join(home, 'src', 'app')));

  // With a single machine the hub routes without a machineId (as for every MachineTarget method).
  assert.equal((await client.call<MethodResult<'fs.browse'>>('fs.browse', {})).path, home);

  // Errors from the node come back as is; unknown machines are the hub's not_found.
  assert.equal((await client.request('fs.browse', { machineId, path: '~/missing' })).error?.code, 'not_found');
  assert.equal((await client.request('fs.browse', { machineId: 'm_nope' })).error?.code, 'not_found');

  await link.close();
  await waitFor(() => !hub.relay.listMachines().find((m) => m.id === machineId)?.online, 5000, 'offline');
  assert.equal((await client.request('fs.complete', { machineId, prefix: '~/' })).error?.code, 'machine_offline');
});
