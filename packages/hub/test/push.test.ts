import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { createNode } from '@bizzi/core';
import { FakeAdapter } from '@bizzi/core/testing';
import type { ChannelEvent, SessionInfo, WorkspaceInfo } from '@bizzi/protocol';
import { connectToHub, NtfyPusher, pairWithHub } from '../src/index.ts';
import { nullLogger } from '../src/util.ts';
import { makeHub, pairDevice, setupCode, sleep, tempDir, TestClient, tokenFor, waitFor } from './helpers.ts';

interface Captured {
  headers: IncomingHttpHeaders;
  body: string;
}

async function ntfyServer(): Promise<{ url: string; got: Captured[]; close: () => Promise<void> }> {
  const got: Captured[] = [];
  const srv = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8').on('data', (d: string) => (body += d));
    req.on('end', () => {
      got.push({ headers: req.headers, body });
      res.writeHead(200).end('{}');
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/bizzi-topic`, got, close: () => new Promise((r) => srv.close(() => r())) };
}

test('approval requests are pushed to ntfy with a click-through link; short turns are not', async (t) => {
  const ntfy = await ntfyServer();
  const hubDir = tempDir();
  const nodeDir = tempDir();
  const wsDir = tempDir('bizzi-hub-ws-');
  const hub = await makeHub(hubDir.path, {
    publicUrl: 'https://bizzi.example.com/',
    ntfy: { url: ntfy.url, token: 'tk_secret', debounceMs: 20 },
  });
  const owner = await pairDevice(hub, setupCode(hub));
  const client = await TestClient.connect(hub.clientUrl, await tokenFor(hub, owner));
  const node = await createNode({ dataDir: nodeDir.path, adapters: [new FakeAdapter()], version: '0', machineName: 'pusher' });
  const { code } = await client.call<{ code: string }>('pairing.create', { kind: 'node' });
  const { credential } = await pairWithHub({ hubUrl: hub.url, code, kind: 'node', name: 'pusher', machineId: node.machine.id });
  const link = connectToHub(node, { url: hub.nodeUrl, credentials: credential });
  t.after(async () => {
    await link.close();
    client.close();
    await hub.close();
    await node.close();
    await ntfy.close();
    hubDir.cleanup();
    nodeDir.cleanup();
    wsDir.cleanup();
  });
  await link.waitConnected(5000);

  const { workspace } = await client.call<{ workspace: WorkspaceInfo }>('workspace.create', {
    machineId: node.machine.id,
    path: join(wsDir.path, 'p'),
    create: true,
  });
  const { session } = await client.call<{ session: SessionInfo }>('session.create', { workspaceId: workspace.id, agent: 'claude', title: 'Fix tests' });
  const ch = `session:${session.id}`;
  await client.call('subscribe', { ch });
  await client.call('session.send', { sessionId: session.id, input: [{ type: 'text', text: '/approve rm -rf build' }] });
  const req = await waitFor(() => client.on(ch).find((e) => e.type === 'approval.requested'), 5000, 'approval.requested');
  await waitFor(() => ntfy.got.length === 1, 5000, 'ntfy push');
  const push = ntfy.got[0]!;
  assert.equal(push.headers.title, 'Approval needed: Fix tests');
  assert.equal(push.headers.click, `https://bizzi.example.com/#/s/${session.id}`);
  assert.equal(push.headers.authorization, 'Bearer tk_secret');
  assert.equal(push.headers.priority, 'high');
  assert.match(push.body, /Run rm -rf build\?/);
  assert.match(push.body, /on pusher/);

  // Approve; the (short) turn completes without another push.
  if (req.type !== 'approval.requested') throw new Error('unreachable');
  await client.call('approval.respond', { sessionId: session.id, approvalId: req.data.approvalId, decision: 'allow' });
  await waitFor(() => client.on(ch).some((e) => e.type === 'turn.completed'), 5000, 'turn.completed');
  await sleep(100);
  assert.equal(ntfy.got.length, 1);
});

test('NtfyPusher: long turns notify, bursts are debounced, stale events are ignored', async () => {
  const sent: { headers: Record<string, string>; body: string }[] = [];
  const fakeFetch = (async (_url: string, init: { headers: Record<string, string>; body: string }) => {
    sent.push({ headers: init.headers, body: init.body });
    return new Response('{}');
  }) as unknown as typeof fetch;
  const now = Date.parse('2026-11-06T12:00:00.000Z');
  const pusher = new NtfyPusher({
    url: 'http://ntfy/x',
    debounceMs: 20,
    logger: nullLogger,
    describe: () => ({ session: 'S' }),
    fetch: fakeFetch,
    now: () => now,
  });
  const ev = (type: string, data: unknown, ts: number, seq: number) =>
    ({ ch: 'session:s_1', seq, ts: new Date(ts).toISOString(), type, data }) as ChannelEvent;

  // A 30 s turn plus a question in the same burst → one notification.
  pusher.handle(ev('turn.started', { turnId: 't1', input: [] }, now - 30_000, 1));
  pusher.handle(ev('question.asked', { questionId: 'q1', text: 'Which DB?' }, now - 1000, 2));
  pusher.handle(ev('turn.completed', { turnId: 't1', stopReason: 'end_turn' }, now, 3));
  // A 2 s turn → nothing; an hour-old approval (outbox replay) → nothing.
  pusher.handle(ev('turn.started', { turnId: 't2', input: [] }, now - 2000, 4));
  pusher.handle(ev('turn.completed', { turnId: 't2', stopReason: 'end_turn' }, now, 5));
  pusher.handle(ev('approval.requested', { approvalId: 'a', title: 'old', kind: 'shell', editable: false, options: [] }, now - 3_600_000, 6));
  await sleep(60);
  await pusher.close();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.headers.Title, 'Question: S (+1 more)');
  assert.match(sent[0]!.body, /Question: S: Which DB\?/);
  assert.match(sent[0]!.body, /Turn finished: S: after 30s/);
});
