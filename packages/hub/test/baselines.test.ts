import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNode, type BizziNode } from '@bizzi/core';
import { FakeAdapter } from '@bizzi/core/testing';
import type { ContextBaseline, SessionInfo, WorkspaceInfo } from '@bizzi/protocol';
import { connectToHub, pairWithHub, type BizziHub, type HubCredential } from '../src/index.ts';
import { makeHub, pairDevice, setupCode, sleep, tempDir, TestClient, tokenFor, waitFor } from './helpers.ts';

async function pairNode(hub: BizziHub, client: TestClient, node: BizziNode): Promise<HubCredential> {
  const { code } = await client.call<{ code: string }>('pairing.create', { kind: 'node', name: node.machine.name });
  const { credential } = await pairWithHub({ hubUrl: hub.url, code, kind: 'node', name: node.machine.name, machineId: node.machine.id });
  return credential;
}

function fakeSession(node: BizziNode, over: Partial<SessionInfo>): SessionInfo {
  const now = new Date().toISOString();
  return { id: `s_${Math.random().toString(36).slice(2)}`, machineId: node.machine.id, workspaceId: 'w_x', agent: 'claude', mode: 'structured', status: 'idle', createdAt: now, updatedAt: now, lastSeq: 0, ...over };
}

test('hub routes baselines.list: all online machines, by machineId, by workspaceId; offline machines', async (t) => {
  const hubDir = tempDir();
  const dirA = tempDir();
  const dirB = tempDir();
  const wsDir = tempDir('bizzi-hub-ws-');
  const hub = await makeHub(hubDir.path, { requestTimeoutMs: 5000 });
  const owner = await pairDevice(hub, setupCode(hub), 'phone');
  const client = await TestClient.connect(hub.clientUrl, await tokenFor(hub, owner));
  const nodeA = await createNode({ dataDir: dirA.path, adapters: [new FakeAdapter()], version: '0', machineName: 'alpha' });
  const nodeB = await createNode({ dataDir: dirB.path, adapters: [new FakeAdapter()], version: '0', machineName: 'beta' });
  const linkA = connectToHub(nodeA, { url: hub.nodeUrl, credentials: await pairNode(hub, client, nodeA), minBackoffMs: 20 });
  const linkB = connectToHub(nodeB, { url: hub.nodeUrl, credentials: await pairNode(hub, client, nodeB), minBackoffMs: 20 });
  t.after(async () => {
    await linkA.close();
    await linkB.close();
    client.close();
    await hub.close();
    await nodeA.close();
    await nodeB.close();
    for (const d of [hubDir, dirA, dirB, wsDir]) d.cleanup();
  });
  await Promise.all([linkA.waitConnected(5000), linkB.waitConnected(5000)]);
  const a = nodeA.machine.id;
  const b = nodeB.machine.id;

  const { workspace } = await nodeA.call('workspace.create', { path: wsDir.path });
  assert.ok(nodeA.baselines.observe(fakeSession(nodeA, { workspaceId: workspace.id, model: 'opus' }), 14_000));
  assert.ok(nodeB.baselines.observe(fakeSession(nodeB, { agent: 'codex', model: 'gpt-5.5-codex', workspaceId: 'w_b' }), 9_000));

  type R = { baselines: ContextBaseline[] };
  // No target: every online machine, each entry tagged with its machine.
  const all = (await client.call<R>('baselines.list')).baselines;
  assert.deepEqual(all.map((x) => [x.machineId, x.agent, x.tokens]).sort(), [
    [a, 'claude', 14_000],
    [b, 'codex', 9_000],
  ].sort());

  // By machine.
  const onB = (await client.call<R>('baselines.list', { machineId: b })).baselines;
  assert.deepEqual(onB.map((x) => x.agent), ['codex']);

  // By workspace: routed to the workspace's machine once the hub has indexed it.
  for (let i = 0; i < 200; i++) {
    const ws = (await client.call<{ workspaces: WorkspaceInfo[] }>('workspaces.list', { machineId: a })).workspaces;
    if (ws.some((w) => w.id === workspace.id)) break;
    await sleep(10);
  }
  const inWs = (await client.call<R>('baselines.list', { workspaceId: workspace.id })).baselines;
  assert.deepEqual(inWs.map((x) => [x.machineId, x.workspaceId, x.tokens]), [[a, workspace.id, 14_000]]);

  // Unknown machine → not_found.
  const unknown = await client.request('baselines.list', { machineId: 'm_nope' });
  assert.equal(unknown.error?.code, 'not_found');

  // B goes offline: the fan-out skips it, a targeted call says machine_offline.
  await linkB.close();
  await waitFor(() => !hub.relay.listMachines().find((m) => m.id === b)?.online, 5000, 'b offline');
  const after = (await client.call<R>('baselines.list')).baselines;
  assert.deepEqual(after.map((x) => x.machineId), [a]);
  const offline = await client.request('baselines.list', { machineId: b });
  assert.equal(offline.error?.code, 'machine_offline');
});
