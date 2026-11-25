import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNode, type BizziNode, type NodeExtension } from '@bizzi/core';
import { FakeAdapter } from '@bizzi/core/testing';
import type { RouteSuggestion } from '@bizzi/protocol';
import { createRoutingExtension } from '@bizzi/routing';
import { connectToHub, pairWithHub, type BizziHub } from '../src/index.ts';
import { makeHub, pairDevice, setupCode, tempDir, TestClient, tokenFor, waitFor } from './helpers.ts';

async function linkNode(hub: BizziHub, client: TestClient, dataDir: string, name: string, extensions: NodeExtension[] = []) {
  const node: BizziNode = await createNode({ dataDir, adapters: [new FakeAdapter()], version: '0.0.0-test', machineName: name, extensions });
  const { code } = await client.call<{ code: string }>('pairing.create', { kind: 'node', name });
  const { credential } = await pairWithHub({ hubUrl: hub.url, code, kind: 'node', name, machineId: node.machine.id });
  const link = connectToHub(node, { url: hub.nodeUrl, credentials: credential, minBackoffMs: 20, maxBackoffMs: 200 });
  await link.waitConnected(5000);
  return { node, link };
}

/** A classifier that picks whichever option mentions the mac mini, recording each request. */
function macMiniPicker(requests: any[]) {
  return (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push(body);
    const lines: string[] = body.messages[0].content.split('\n').filter((l: string) => /^[A-T]\. /.test(l));
    const letter = lines.find((l) => l.includes('mac-mini'))!.slice(0, 1);
    const other = lines.find((l) => !l.includes('mac-mini'))!.slice(0, 1);
    const top = [{ token: letter, logprob: Math.log(0.9) }, { token: other, logprob: Math.log(0.1) }];
    return new Response(JSON.stringify({ choices: [{ logprobs: { content: [{ token: letter, top_logprobs: top }] } }] }));
  }) as unknown as typeof fetch;
}

test('the hub routes across every online machine with the logprob classifier', async (t) => {
  const dirs = [tempDir(), tempDir(), tempDir(), tempDir('bizzi-hub-ws-')];
  const requests: any[] = [];
  const fakeFetch = macMiniPicker(requests);
  const hub = await makeHub(dirs[0]!.path, { router: { backend: { url: 'http://llm.test/v1', model: 'fake-qwen', fetch: fakeFetch } } });
  const owner = await pairDevice(hub, setupCode(hub));
  const client = await TestClient.connect(hub.clientUrl, await tokenFor(hub, owner));
  const a = await linkNode(hub, client, dirs[1]!.path, 'laptop');
  const b = await linkNode(hub, client, dirs[2]!.path, 'mac-mini');
  t.after(async () => {
    client.close();
    await a.link.close();
    await b.link.close();
    await hub.close();
    await a.node.close();
    await b.node.close();
    for (const d of dirs) d.cleanup();
  });

  const ws = dirs[3]!.path;
  await client.call('workspace.create', { machineId: a.node.machine.id, path: `${ws}/a`, create: true, name: 'acme-shop' });
  const { workspace: onMini } = await client.call<{ workspace: { id: string } }>('workspace.create', {
    machineId: b.node.machine.id,
    path: `${ws}/b`,
    create: true,
    name: 'acme-shop',
  });
  await waitFor(() => hub.relay.store.listWorkspaces().length === 2, 5000, 'workspaces indexed');

  const { suggestion } = await client.call<{ suggestion: RouteSuggestion }>('route.suggest', { text: 'cart page broken on iPhone Safari' });
  assert.equal(suggestion.source, 'classifier');
  assert.deepEqual([suggestion.candidates[0]?.workspaceId, suggestion.candidates[0]?.label, suggestion.offered], [onMini.id, 'mac-mini · acme-shop', 2]);
  assert.equal(suggestion.classifier?.model, 'fake-qwen');
  assert.equal(requests.length, 1);

  // An offline machine's workspaces aren't offered.
  await b.link.close();
  await waitFor(() => !hub.relay.isOnline(b.node.machine.id), 5000, 'mac-mini offline');
  const { suggestion: one } = await client.call<{ suggestion: RouteSuggestion }>('route.suggest', { text: 'cart page broken' });
  assert.deepEqual([one.source, one.candidates[0]?.label], ['single', 'laptop · acme-shop']);
  assert.equal(requests.length, 1);
});

test('a hub without a classifier borrows a machine\'s (preferred first, the next when it fails)', async (t) => {
  const dirs = [tempDir(), tempDir(), tempDir(), tempDir(), tempDir('bizzi-hub-ws-')];
  const good: any[] = [];
  const failing: string[] = [];
  const brokenFetch = (async (url: string) => {
    failing.push(url);
    return new Response('upstream down', { status: 502 });
  }) as unknown as typeof fetch;
  const hub = await makeHub(dirs[0]!.path, { router: { via: 'laptop' } });
  const owner = await pairDevice(hub, setupCode(hub));
  const client = await TestClient.connect(hub.clientUrl, await tokenFor(hub, owner));
  // The laptop can reach a model, but it's down; the mac mini's works; the vps has none.
  const laptop = await linkNode(hub, client, dirs[1]!.path, 'laptop', [
    createRoutingExtension({ backend: { url: 'http://vpn-only.test/v1', model: 'lab-qwen', fetch: brokenFetch } }),
  ]);
  const mini = await linkNode(hub, client, dirs[2]!.path, 'mac-mini', [
    createRoutingExtension({ backend: { url: 'http://localhost:8000/v1', model: 'local-qwen', maxOptions: 8, fetch: macMiniPicker(good) } }),
  ]);
  const vps = await linkNode(hub, client, dirs[3]!.path, 'vps');
  t.after(async () => {
    client.close();
    for (const n of [laptop, mini, vps]) await n.link.close();
    await hub.close();
    for (const n of [laptop, mini, vps]) await n.node.close();
    for (const d of dirs) d.cleanup();
  });

  const routing = (name: string) => hub.relay.listMachines().find((m) => m.name === name)?.routing;
  assert.deepEqual(
    [routing('laptop'), routing('mac-mini'), routing('vps')],
    [{ model: 'lab-qwen', maxOptions: 20 }, { model: 'local-qwen', maxOptions: 8 }, undefined],
  );

  const ws = dirs[4]!.path;
  for (const [n, name] of [
    [laptop, 'acme-shop'],
    [mini, 'acme-shop'],
    [vps, 'infra'],
  ] as const) {
    await client.call('workspace.create', { machineId: n.node.machine.id, path: `${ws}/${n.node.machine.name}`, create: true, name });
  }
  await waitFor(() => hub.relay.store.listWorkspaces().length === 3, 5000, 'workspaces indexed');

  const { suggestion } = await client.call<{ suggestion: RouteSuggestion }>('route.suggest', { text: 'cart page broken on iPhone Safari' });
  assert.equal(failing.length, 1, 'the preferred laptop was tried first');
  assert.equal(good.length, 1);
  assert.deepEqual(
    [suggestion.source, suggestion.candidates[0]?.label, suggestion.classifier?.model, suggestion.classifier?.via, suggestion.offered],
    ['classifier', 'mac-mini · acme-shop', 'local-qwen', mini.node.machine.id, 3],
  );

  // Only the broken one left: the suggestion says why, and the user is asked.
  await mini.link.close();
  await waitFor(() => !hub.relay.isOnline(mini.node.machine.id), 5000, 'mac-mini offline');
  const { suggestion: down } = await client.call<{ suggestion: RouteSuggestion }>('route.suggest', { text: 'cart page broken' });
  assert.equal(down.source, 'none');
  assert.match(down.note ?? '', /^laptop: routing classifier answered 502/);

  // No machine with a classifier online: explicit tokens still work, the rest is asked.
  await laptop.link.close();
  await waitFor(() => !hub.relay.isOnline(laptop.node.machine.id), 5000, 'laptop offline');
  const { suggestion: none } = await client.call<{ suggestion: RouteSuggestion }>('route.suggest', { text: '#infra bump the chart' });
  assert.deepEqual([none.source, none.candidates[0]?.label], ['explicit', 'vps · infra']);
});

test('the hub keeps routing rules and recorded decisions itself and routes with the rules', async (t) => {
  const dirs = [tempDir(), tempDir(), tempDir(), tempDir('bizzi-hub-ws-')];
  const hub = await makeHub(dirs[0]!.path);
  const owner = await pairDevice(hub, setupCode(hub));
  const client = await TestClient.connect(hub.clientUrl, await tokenFor(hub, owner));
  const a = await linkNode(hub, client, dirs[1]!.path, 'laptop');
  const b = await linkNode(hub, client, dirs[2]!.path, 'mac-mini');
  t.after(async () => {
    client.close();
    await a.link.close();
    await b.link.close();
    await hub.close();
    await a.node.close();
    await b.node.close();
    for (const d of dirs) d.cleanup();
  });
  const ws = dirs[3]!.path;
  await client.call('workspace.create', { machineId: a.node.machine.id, path: `${ws}/a`, create: true, name: 'acme-shop' });
  const { workspace: site } = await client.call<{ workspace: { id: string } }>('workspace.create', { machineId: b.node.machine.id, path: `${ws}/b`, create: true, name: 'site' });
  await waitFor(() => hub.relay.store.listWorkspaces().length === 2, 5000, 'workspaces indexed');

  const { rules } = await client.call<{ rules: { id: string }[] }>('route.rules.set', { rules: [{ match: ['screenshot*'], workspaceId: site.id }] });
  assert.equal(rules.length, 1);
  const { suggestion } = await client.call<{ suggestion: RouteSuggestion }>('route.suggest', { text: 'take screenshots of the header' });
  assert.deepEqual([suggestion.source, suggestion.candidates[0]?.label, suggestion.rule?.id], ['rule', 'mac-mini · site', rules[0]!.id]);
  await assert.rejects(client.call('route.rules.set', { rules: [{ match: ['x'] }] }), /exactly one of tag/);

  const chosen = { machineId: b.node.machine.id, workspaceId: site.id, label: 'mac-mini · site' };
  await client.call('route.record', { decision: { text: 'header looks off', source: 'none', candidates: [], confidence: 0, chosen, via: 'other', overridden: false } });
  const { decisions, total } = await client.call<{ decisions: { chosen: unknown }[]; total: number }>('route.decisions', {});
  assert.deepEqual([total, decisions[0]?.chosen], [1, chosen]);
  assert.equal(hub.relay.store.routes.list({}).total, 1);
});
