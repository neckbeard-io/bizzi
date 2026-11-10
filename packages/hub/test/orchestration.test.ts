import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { createNode, type BizziNode } from '@bizzi/core';
import { FakeAdapter } from '@bizzi/core/testing';
import { GLOBAL_CHANNEL, type SessionInfo, type WorkspaceInfo } from '@bizzi/protocol';
import { connectToHub, pairWithHub } from '../src/index.ts';
import { makeHub, pairDevice, setupCode, tempDir, TestClient, tokenFor, waitFor } from './helpers.ts';

async function poll<T>(fn: () => Promise<T | undefined>, what: string, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function startNode(dataDir: string): Promise<BizziNode> {
  return createNode({ dataDir, adapters: [new FakeAdapter()], version: '0.0.0-test', machineName: 'n1', interruptGraceMs: 200 });
}

test('hub: markSeen routes to the node and seenThrough reaches every device; sessions.list spawnedBy', async (t) => {
  const hubDir = tempDir();
  const nodeDir = tempDir();
  const wsDir = tempDir('bizzi-hub-ws-');
  const hub = await makeHub(hubDir.path, { requestTimeoutMs: 5000 });
  const phone = await pairDevice(hub, setupCode(hub), 'phone');
  const a = await TestClient.connect(hub.clientUrl, await tokenFor(hub, phone));
  const { code: laptopCode } = await a.call<{ code: string }>('pairing.create', { kind: 'device', name: 'laptop' });
  const laptop = await pairDevice(hub, laptopCode, 'laptop');
  const b = await TestClient.connect(hub.clientUrl, await tokenFor(hub, laptop));
  await a.call('subscribe', { ch: GLOBAL_CHANNEL });
  await b.call('subscribe', { ch: GLOBAL_CHANNEL });

  const node = await startNode(nodeDir.path);
  const { code } = await a.call<{ code: string }>('pairing.create', { kind: 'node', name: 'n1' });
  const { credential } = await pairWithHub({ hubUrl: hub.url, code, kind: 'node', name: 'n1', machineId: node.machine.id });
  const link = connectToHub(node, { url: hub.nodeUrl, credentials: credential, minBackoffMs: 20, maxBackoffMs: 200 });
  t.after(async () => {
    await link.close();
    a.close();
    b.close();
    await hub.close();
    await node.close();
    hubDir.cleanup();
    nodeDir.cleanup();
    wsDir.cleanup();
  });
  await link.waitConnected(5000);

  const { workspace } = await a.call<{ workspace: WorkspaceInfo }>('workspace.create', { path: join(wsDir.path, 'p'), create: true });
  const { session } = await a.call<{ session: SessionInfo }>('session.create', { workspaceId: workspace.id, agent: 'claude' });
  await a.call('session.send', { sessionId: session.id, input: [{ type: 'text', text: 'hi' }] });
  await waitFor(() => node.sessions.get(session.id).session.status === 'idle' && !node.sessions.isBusy(session.id), 5000, 'idle');
  const lastSeq = node.sessions.get(session.id).session.lastSeq;

  // Phone marks it seen through the hub; the laptop gets the session.updated, and the hub index agrees.
  assert.deepEqual(await a.call('session.markSeen', { sessionId: session.id, seq: lastSeq }), { seenThrough: lastSeq });
  assert.equal(node.sessions.get(session.id).session.seenThrough, lastSeq);
  await waitFor(
    () => b.on(GLOBAL_CHANNEL).some((e) => e.type === 'session.updated' && e.data.session.id === session.id && e.data.session.seenThrough === lastSeq),
    5000,
    'laptop sees seenThrough',
  );
  const listed = await b.call<{ sessions: SessionInfo[] }>('sessions.list', {});
  assert.equal(listed.sessions.find((s) => s.id === session.id)?.seenThrough, lastSeq);
  // Monotonic through the hub too.
  assert.deepEqual(await b.call('session.markSeen', { sessionId: session.id, seq: 1 }), { seenThrough: lastSeq });
  assert.equal((await b.request('session.markSeen', { sessionId: 's_unknown', seq: 1 })).error?.code, 'not_found');

  // Helpers: the hub's index filters by spawnedBy.
  const helper = await node.orchestration.startHelper(session.id, { agent: 'claude', prompt: 'help' });
  const helpers = await poll(async () => {
    const r = await a.call<{ sessions: SessionInfo[] }>('sessions.list', { spawnedBy: session.id });
    return r.sessions.length === 1 ? r.sessions : undefined;
  }, 'helper indexed');
  assert.equal(helpers[0]!.id, helper.session.id);
  assert.equal(helpers[0]!.depth, 1);
  const none = await a.call<{ sessions: SessionInfo[] }>('sessions.list', { spawnedBy: helper.session.id });
  assert.deepEqual(none.sessions, []);
  assert.equal((await a.request('sessions.list', { spawnedBy: 5 })).error?.code, 'bad_request');

  // Orchestration settings route by machine / workspace.
  const got = await a.call<{ settings: { maxDepth: number } }>('orchestration.settings.get', { workspaceId: workspace.id });
  assert.equal(got.settings.maxDepth, 2);
});
