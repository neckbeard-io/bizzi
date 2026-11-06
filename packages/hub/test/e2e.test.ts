import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { createNode, type BizziNode } from '@bizzi/core';
import { FakeAdapter } from '@bizzi/core/testing';
import {
  GLOBAL_CHANNEL,
  sessionChannel,
  type ChannelEvent,
  type MachineInfo,
  type SessionInfo,
  type WorkspaceInfo,
} from '@bizzi/protocol';
import { connectToHub, pairWithHub, type BizziHub, type HubCredential, type HubLink } from '../src/index.ts';
import { contiguous, makeHub, pairDevice, setupCode, tempDir, TestClient, tokenFor, waitFor } from './helpers.ts';

async function startNode(dataDir: string, name: string): Promise<BizziNode> {
  return createNode({ dataDir, adapters: [new FakeAdapter()], version: '0.0.0-test', machineName: name, interruptGraceMs: 200 });
}

async function pairNode(hub: BizziHub, client: TestClient, node: BizziNode): Promise<HubCredential> {
  const { code } = await client.call<{ code: string }>('pairing.create', { kind: 'node', name: node.machine.name });
  const { credential } = await pairWithHub({ hubUrl: hub.url, code, kind: 'node', name: node.machine.name, machineId: node.machine.id });
  return credential;
}

function link(node: BizziNode, cred: HubCredential, url: string): HubLink {
  return connectToHub(node, { url, credentials: cred, minBackoffMs: 20, maxBackoffMs: 200 });
}

function nodeLog(node: BizziNode, ch: string): ChannelEvent[] {
  return node.bus.replay(ch, 0);
}

test('hub relays two linked nodes: routing, offline replay, reconnect without gaps, merged global', async (t) => {
  const hubDir = tempDir();
  const dirA = tempDir();
  const dirB = tempDir();
  const wsDir = tempDir('bizzi-hub-ws-');
  t.after(() => {
    hubDir.cleanup();
    dirA.cleanup();
    dirB.cleanup();
    wsDir.cleanup();
  });

  let hub = await makeHub(hubDir.path, { requestTimeoutMs: 5000 });
  const port = hub.port;
  const owner = await pairDevice(hub, setupCode(hub), 'phone');
  let client = await TestClient.connect(hub.clientUrl, await tokenFor(hub, owner));
  await client.call('subscribe', { ch: GLOBAL_CHANNEL });

  const nodeA = await startNode(dirA.path, 'alpha');
  const nodeB = await startNode(dirB.path, 'beta');
  const credA = await pairNode(hub, client, nodeA);
  const credB = await pairNode(hub, client, nodeB);
  assert.equal(credB.hubUrl, hub.nodeUrl);
  const linkA = link(nodeA, credA, hub.nodeUrl);
  let linkB = link(nodeB, credB, hub.nodeUrl);
  t.after(async () => {
    await linkA.close();
    await linkB.close();
    client.close();
    await hub.close();
    await nodeA.close();
    await nodeB.close();
  });
  await Promise.all([linkA.waitConnected(5000), linkB.waitConnected(5000)]);

  // machines.list shows both, online.
  const list = await client.call<{ machines: MachineInfo[] }>('machines.list');
  assert.deepEqual(list.machines.map((m) => [m.id, m.name, m.online]).sort(), [
    [nodeA.machine.id, 'alpha', true],
    [nodeB.machine.id, 'beta', true],
  ].sort());

  // Unknown machine → not_found; no machineId with two machines → bad_request.
  assert.equal((await client.request('agents.list', { machineId: 'm_NOPE' })).error?.code, 'not_found');
  assert.equal((await client.request('agents.list', {})).error?.code, 'bad_request');
  const agents = await client.call<{ agents: { agent: string }[] }>('agents.list', { machineId: nodeB.machine.id });
  assert.deepEqual(agents.agents.map((a) => a.agent), ['claude']);

  // Workspace + session on node B through the hub.
  const { workspace } = await client.call<{ workspace: WorkspaceInfo }>('workspace.create', {
    machineId: nodeB.machine.id,
    path: join(wsDir.path, 'proj-b'),
    create: true,
  });
  assert.equal(workspace.machineId, nodeB.machine.id);
  assert.equal(nodeB.workspaces.list().length, 1);
  assert.equal(nodeA.workspaces.list().length, 0);
  const { workspace: wsA } = await client.call<{ workspace: WorkspaceInfo }>('workspace.create', {
    machineId: nodeA.machine.id,
    path: join(wsDir.path, 'proj-a'),
    create: true,
  });

  const { session } = await client.call<{ session: SessionInfo }>('session.create', { workspaceId: workspace.id, agent: 'claude' });
  assert.equal(session.machineId, nodeB.machine.id);
  const ch = sessionChannel(session.id);
  await client.call('subscribe', { ch });
  await client.call('session.send', { sessionId: session.id, input: [{ type: 'text', text: 'hello hub' }] });
  await waitFor(() => client.on(ch).some((e) => e.type === 'turn.completed'), 5000, 'turn.completed via hub');
  assert.ok(client.on(ch).some((e) => e.type === 'message.completed' && e.data.text === 'echo: hello hub'));
  assert.ok(contiguous(client.on(ch)));

  // Lists come from the hub index (aggregated across machines).
  const all = await client.call<{ workspaces: WorkspaceInfo[] }>('workspaces.list');
  assert.deepEqual(all.workspaces.map((w) => w.id).sort(), [workspace.id, wsA.id].sort());
  const onlyB = await client.call<{ workspaces: WorkspaceInfo[] }>('workspaces.list', { machineId: nodeB.machine.id });
  assert.deepEqual(onlyB.workspaces.map((w) => w.id), [workspace.id]);
  const get = await client.call<{ session: SessionInfo; capabilities: { streaming: string } }>('session.get', { sessionId: session.id });
  assert.equal(get.capabilities.streaming, 'token');

  // ---- B's link drops.
  await linkB.close();
  await waitFor(
    () => client.on(GLOBAL_CHANNEL).some((e) => e.type === 'machine.updated' && e.data.machine.id === nodeB.machine.id && !e.data.machine.online),
    5000,
    'machine.updated offline',
  );
  const offline = (await client.call<{ machines: MachineInfo[] }>('machines.list')).machines.find((m) => m.id === nodeB.machine.id);
  assert.equal(offline?.online, false);
  assert.ok(offline?.lastSeenAt);

  const send = await client.request('session.send', { sessionId: session.id, input: [{ type: 'text', text: 'are you there' }] });
  assert.equal(send.error?.code, 'machine_offline');
  const ws = await client.request('workspace.create', { machineId: nodeB.machine.id, path: join(wsDir.path, 'x'), create: true });
  assert.equal(ws.error?.code, 'machine_offline');
  // Machine A is unaffected.
  await client.call('agents.list', { machineId: nodeA.machine.id });

  // A second client can still read B's history from the replica, plus cached session state.
  const stored = client.on(ch).length;
  const reader = await TestClient.connect(hub.clientUrl, await tokenFor(hub, owner));
  const sub = await reader.call<{ lastSeq: number }>('subscribe', { ch });
  assert.equal(sub.lastSeq, stored);
  await waitFor(() => reader.on(ch).length === stored, 5000, 'offline replay');
  assert.deepEqual(reader.on(ch), client.on(ch));
  const cached = await reader.call<{ session: SessionInfo; capabilities: { streaming: string } }>('session.get', { sessionId: session.id });
  assert.equal(cached.session.id, session.id);
  assert.equal(cached.capabilities.streaming, 'token');
  const sessions = await reader.call<{ sessions: SessionInfo[] }>('sessions.list', { machineId: nodeB.machine.id });
  assert.deepEqual(sessions.sessions.map((s) => s.id), [session.id]);
  reader.close();

  // Work continues on B while it's disconnected (the node's log is the outbox).
  await nodeB.call('session.send', { sessionId: session.id, input: [{ type: 'text', text: 'offline turn' }] });
  await waitFor(() => nodeLog(nodeB, ch).filter((e) => e.type === 'turn.completed').length === 2, 5000, 'offline turn on B');

  // ---- B reconnects: the hub catches up from its stored seq, then live relay resumes.
  linkB = link(nodeB, credB, hub.nodeUrl);
  await linkB.waitConnected(5000);
  await waitFor(() => client.on(ch).length === nodeLog(nodeB, ch).length, 5000, 'catch-up after reconnect');
  await client.call('session.send', { sessionId: session.id, input: [{ type: 'text', text: 'back online' }] });
  await waitFor(() => client.on(ch).filter((e) => e.type === 'turn.completed').length === 3, 5000, 'third turn');
  await waitFor(() => client.on(ch).length === nodeLog(nodeB, ch).length, 5000, 'in sync');
  assert.ok(contiguous(client.on(ch)), 'no gaps or duplicates across the reconnect');
  assert.deepEqual(client.on(ch), nodeLog(nodeB, ch));

  // A session created on B while online gets replicated without an explicit client subscribe.
  const { session: s2 } = await client.call<{ session: SessionInfo }>('session.create', { workspaceId: workspace.id, agent: 'claude' });
  await client.call('session.send', { sessionId: s2.id, input: [{ type: 'text', text: 'second session' }] });
  await waitFor(() => nodeLog(nodeB, sessionChannel(s2.id)).some((e) => e.type === 'turn.completed'), 5000, 's2 turn');
  await waitFor(() => hub.relay.bus.lastSeq(sessionChannel(s2.id)) === nodeB.bus.lastSeq(sessionChannel(s2.id)), 5000, 's2 replicated');

  // ---- Hub restarts while B keeps working: cursors persist, nothing duplicates.
  client.close();
  await hub.close();
  await nodeB.call('session.send', { sessionId: session.id, input: [{ type: 'text', text: 'while hub is down' }] });
  await waitFor(() => nodeLog(nodeB, ch).filter((e) => e.type === 'turn.completed').length === 4, 5000, 'turn while hub down');
  hub = await makeHub(hubDir.path, { port, requestTimeoutMs: 5000 });
  await Promise.all([linkA.waitConnected(5000), linkB.waitConnected(5000)]);
  await waitFor(() => hub.relay.bus.lastSeq(ch) === nodeB.bus.lastSeq(ch), 5000, 'catch-up after hub restart');
  client = await TestClient.connect(hub.clientUrl, await tokenFor(hub, owner));
  await client.call('subscribe', { ch });
  await client.call('subscribe', { ch: GLOBAL_CHANNEL });
  await waitFor(() => client.on(ch).length === nodeLog(nodeB, ch).length, 5000, 'full replay after restart');
  assert.deepEqual(client.on(ch), nodeLog(nodeB, ch));

  // ---- The hub's global log merges both nodes, re-sequenced, without duplicates.
  const lastGlobal = hub.relay.bus.lastSeq(GLOBAL_CHANNEL);
  await waitFor(() => client.on(GLOBAL_CHANNEL).length === lastGlobal, 5000, 'global replay');
  const global = client.on(GLOBAL_CHANNEL);
  assert.ok(contiguous(global), 'global seqs are contiguous');
  const created = global.filter((e) => e.type === 'workspace.created').map((e) => e.data.workspace.id);
  assert.deepEqual(created.sort(), [workspace.id, wsA.id].sort(), 'each workspace.created exactly once');
  const sessionsCreated = global.filter((e) => e.type === 'session.created').map((e) => e.data.session.id);
  assert.deepEqual(sessionsCreated.sort(), [session.id, s2.id].sort());
  const machineEvents = global.filter((e) => e.type === 'machine.updated').map((e) => e.data.machine.id);
  assert.ok(machineEvents.includes(nodeA.machine.id) && machineEvents.includes(nodeB.machine.id));
  assert.ok(global.some((e) => e.type === 'device.updated'));
  // Every node global event made it exactly once: B's own global log vs the hub's copies from B.
  const bSessionUpdates = nodeLog(nodeB, GLOBAL_CHANNEL).filter((e) => e.type === 'session.updated').length;
  const hubSessionUpdates = global.filter((e) => e.type === 'session.updated' && e.data.session.machineId === nodeB.machine.id).length;
  assert.equal(hubSessionUpdates, bSessionUpdates);
});
