// Identity colour and icon through the hub (spec §11.1): machine.set { color } and workspace.set reach
// the owning node, the hub's replica keeps them (offline too), and clients get the events.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { createNode, type BizziNode } from '@bizzi/core';
import { FakeAdapter } from '@bizzi/core/testing';
import { GLOBAL_CHANNEL, type MachineInfo, type WorkspaceInfo } from '@bizzi/protocol';
import { connectToHub, pairWithHub, type BizziHub, type HubCredential } from '../src/index.ts';
import { makeHub, pairDevice, setupCode, tempDir, TestClient, tokenFor, waitFor } from './helpers.ts';

async function pairNode(hub: BizziHub, client: TestClient, node: BizziNode): Promise<HubCredential> {
  const { code } = await client.call<{ code: string }>('pairing.create', { kind: 'node', name: node.machine.name });
  const { credential } = await pairWithHub({ hubUrl: hub.url, code, kind: 'node', name: node.machine.name, machineId: node.machine.id });
  return credential;
}

test('hub: machine colour and workspace colour, icon and name replicate, and stay in the replica while offline', async (t) => {
  const hubDir = tempDir();
  const nodeDir = tempDir();
  const wsDir = tempDir('bizzi-hub-ws-');
  t.after(() => {
    hubDir.cleanup();
    nodeDir.cleanup();
    wsDir.cleanup();
  });
  const hub = await makeHub(hubDir.path, { requestTimeoutMs: 5000 });
  const owner = await pairDevice(hub, setupCode(hub), 'phone');
  const client = await TestClient.connect(hub.clientUrl, await tokenFor(hub, owner));
  await client.call('subscribe', { ch: GLOBAL_CHANNEL });
  const node = await createNode({ dataDir: nodeDir.path, adapters: [new FakeAdapter()], version: '0.0.0-test', machineName: 'mini', interruptGraceMs: 200 });
  const link = connectToHub(node, { url: hub.nodeUrl, credentials: await pairNode(hub, client, node), minBackoffMs: 20, maxBackoffMs: 200 });
  t.after(async () => {
    await link.close();
    client.close();
    await hub.close();
    await node.close();
  });
  await link.waitConnected(5000);
  const machineId = node.machine.id;

  const { machine } = await client.call<{ machine: MachineInfo }>('machine.set', { machineId, color: 'purple' });
  assert.equal(machine.color, 'purple');
  assert.equal(node.machine.color, 'purple');
  await waitFor(() => client.on(GLOBAL_CHANNEL).some((e) => e.type === 'machine.updated' && e.data.machine.color === 'purple'), 5000, 'machine.updated with colour');

  const { workspace } = await client.call<{ workspace: WorkspaceInfo }>('workspace.create', { machineId, path: join(wsDir.path, 'site'), create: true });
  const set = await client.call<{ workspace: WorkspaceInfo }>('workspace.set', { workspaceId: workspace.id, name: 'Website', color: 'green', icon: 'W' });
  assert.equal(set.workspace.color, 'green');
  assert.equal(node.workspaces.get(workspace.id).icon, 'W');
  await waitFor(() => client.on(GLOBAL_CHANNEL).some((e) => e.type === 'workspace.updated' && e.data.workspace.id === workspace.id), 5000, 'workspace.updated');
  // The hub's index answers lists, so it must have the new fields.
  const listed = await waitFor(
    () => hub.relay.store.listWorkspaces(machineId).find((w) => w.id === workspace.id && w.color === 'green'),
    5000,
    'hub replica updated',
  );
  assert.equal(listed.name, 'Website');
  assert.equal(listed.icon, 'W');

  // Validation happens on the node and comes back through the hub.
  assert.equal((await client.request('workspace.set', { workspaceId: workspace.id, color: 'brown' })).error?.code, 'bad_request');
  assert.equal((await client.request('workspace.set', { workspaceId: 'w_nope', color: 'red' })).error?.code, 'not_found');

  // Offline: lists still carry the colours; changes wait for the machine.
  await link.close();
  await waitFor(() => client.on(GLOBAL_CHANNEL).some((e) => e.type === 'machine.updated' && e.data.machine.id === machineId && !e.data.machine.online), 5000, 'offline');
  const machines = await client.call<{ machines: MachineInfo[] }>('machines.list');
  assert.equal(machines.machines.find((m) => m.id === machineId)?.color, 'purple');
  const { workspaces } = await client.call<{ workspaces: WorkspaceInfo[] }>('workspaces.list', { machineId });
  assert.equal(workspaces.find((w) => w.id === workspace.id)?.color, 'green');
  assert.ok((await client.request('workspace.set', { workspaceId: workspace.id, color: 'red' })).error);
});
