import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNode, type BizziNode, type NodeExtension } from '@bizzi/core';
import { FakeAdapter } from '@bizzi/core/testing';
import { GLOBAL_CHANNEL, type AccountUsage, type ChannelEvent, type ThemeFile, type UserPrefs, type WidgetValue } from '@bizzi/protocol';
import { connectToHub, NtfyPusher, pairWithHub, type BizziHub, type HubCredential } from '../src/index.ts';
import { nullLogger } from '../src/util.ts';
import { makeHub, pairDevice, setupCode, sleep, tempDir, TestClient, tokenFor, waitFor } from './helpers.ts';

async function pairNode(hub: BizziHub, client: TestClient, node: BizziNode): Promise<HubCredential> {
  const { code } = await client.call<{ code: string }>('pairing.create', { kind: 'node', name: node.machine.name });
  const { credential } = await pairWithHub({ hubUrl: hub.url, code, kind: 'node', name: node.machine.name, machineId: node.machine.id });
  return credential;
}

function login(over: Partial<AccountUsage>): AccountUsage {
  return {
    agent: 'claude',
    accountId: 'mc@example.com',
    label: 'claude · max',
    billing: 'plan',
    machines: [],
    windows: [{ id: 'five_hour', label: '5h', usedPercent: 40 }],
    status: 'ok',
    observedAt: new Date().toISOString(),
    ...over,
  };
}

function widget(machineId: string, id: string, over: Partial<WidgetValue> = {}): WidgetValue {
  return { id, machineId, label: id, kind: 'text', placement: ['bar'], text: `${id} text`, observedAt: new Date().toISOString(), ...over };
}

test('hub merges usage per login across nodes, caches widgets, serves offline values', async (t) => {
  const hubDir = tempDir();
  const dirA = tempDir();
  const dirB = tempDir();
  const hub = await makeHub(hubDir.path, { requestTimeoutMs: 5000 });
  const owner = await pairDevice(hub, setupCode(hub), 'phone');
  const client = await TestClient.connect(hub.clientUrl, await tokenFor(hub, owner));
  await client.call('subscribe', { ch: GLOBAL_CHANNEL });

  // Node A serves widgets.list itself (what @bizzi/services does) so routed calls can be checked.
  let liveA: WidgetValue[] = [];
  const widgetsExt: NodeExtension = { methods: { 'widgets.list': () => ({ widgets: liveA }) } };
  const nodeA = await createNode({ dataDir: dirA.path, adapters: [new FakeAdapter()], version: '0', machineName: 'alpha', extensions: [widgetsExt] });
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
    hubDir.cleanup();
    dirA.cleanup();
    dirB.cleanup();
  });
  await Promise.all([linkA.waitConnected(5000), linkB.waitConnected(5000)]);
  const a = nodeA.machine.id;
  const b = nodeB.machine.id;

  // The same Claude login on both machines; B observed it later.
  const t0 = Date.now();
  nodeA.usage.report(login({ observedAt: new Date(t0 - 60_000).toISOString(), windows: [{ id: 'five_hour', label: '5h', usedPercent: 40 }] }));
  nodeB.usage.report(login({ observedAt: new Date(t0).toISOString(), windows: [{ id: 'five_hour', label: '5h', usedPercent: 62 }] }));
  // A Codex login only on A.
  nodeA.usage.report(login({ agent: 'codex', accountId: 'acct-x', label: 'codex · pro', status: 'warning' }));

  const merged = async () => (await client.call<{ accounts: AccountUsage[] }>('usage.list')).accounts;
  let accounts: AccountUsage[] = [];
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    accounts = await merged();
    if (accounts.length === 2 && accounts.find((x) => x.agent === 'claude')?.machines.length === 2) break;
    await sleep(10);
  }
  const claude = accounts.find((x) => x.agent === 'claude')!;
  assert.deepEqual(claude.machines, [a, b].sort());
  assert.equal(claude.windows?.[0]?.usedPercent, 62, 'newest observation wins');
  assert.deepEqual(accounts.map((x) => x.agent), ['codex', 'claude'], 'most constrained first');
  // Clients see the merged snapshot on the hub's global channel.
  await waitFor(
    () => client.on(GLOBAL_CHANNEL).find((e) => e.type === 'account.usage' && (e.data as { usage: AccountUsage }).usage.machines.length === 2),
    5000,
    'merged account.usage event',
  );

  // Widgets from both nodes' global channels.
  liveA = [widget(a, 'litellm', { kind: 'meter', value: 554, max: 2474 })];
  nodeA.bus.append(GLOBAL_CHANNEL, { type: 'widget.updated', data: { widget: liveA[0]! } });
  nodeB.bus.append(GLOBAL_CHANNEL, { type: 'widget.updated', data: { widget: widget(b, 'ci') } });
  nodeB.bus.append(GLOBAL_CHANNEL, { type: 'widget.updated', data: { widget: widget(b, 'gpu') } });
  nodeB.bus.append(GLOBAL_CHANNEL, { type: 'widget.removed', data: { machineId: b, widgetId: 'gpu' } });
  const ids = async (params = {}) => (await client.call<{ widgets: WidgetValue[] }>('widgets.list', params)).widgets.map((w) => `${w.machineId === a ? 'A' : 'B'}:${w.id}`).sort();
  await waitFor(() => client.on(GLOBAL_CHANNEL).some((e) => e.type === 'widget.removed'), 5000, 'widget.removed relayed');
  assert.deepEqual(await ids(), ['A:litellm', 'B:ci']);

  // With machineId: routed to an online node (and the cache refreshed from its answer).
  liveA = [...liveA, widget(a, 'deploy')];
  assert.deepEqual(await ids({ machineId: a }), ['A:deploy', 'A:litellm']);
  assert.deepEqual(await ids(), ['A:deploy', 'A:litellm', 'B:ci']);

  // B goes offline: its last usage and widget values still show.
  await linkB.close();
  await waitFor(
    () => client.on(GLOBAL_CHANNEL).some((e) => e.type === 'machine.updated' && e.data.machine.id === b && !e.data.machine.online),
    5000,
    'B offline',
  );
  assert.deepEqual(await ids({ machineId: b }), ['B:ci'], 'cached values for an offline machine');
  accounts = await merged();
  assert.deepEqual(accounts.find((x) => x.agent === 'claude')?.machines, [a, b].sort());
  assert.equal(accounts.find((x) => x.agent === 'claude')?.observedAt, new Date(t0).toISOString(), 'with its age');
});

test('themes live on the hub: CRUD, persisted, not relayed to nodes', async (t) => {
  const hubDir = tempDir();
  let hub = await makeHub(hubDir.path);
  const owner = await pairDevice(hub, setupCode(hub), 'desktop');
  let client = await TestClient.connect(hub.clientUrl, await tokenFor(hub, owner));
  t.after(async () => {
    client.close();
    await hub.close();
    hubDir.cleanup();
  });

  const { theme } = await client.call<{ theme: ThemeFile }>('theme.save', { name: 'Nord warm', data: { base: 'nord', tones: 5 } });
  assert.match(theme.id, /^th_/);
  await client.call('theme.save', { id: theme.id, name: 'Nord warmer', data: { base: 'nord', tones: 6 } });
  const second = await client.call<{ theme: ThemeFile }>('theme.save', { name: 'Paper', data: {} });
  assert.equal((await client.request('theme.save', { name: '   ', data: {} })).error?.code, 'bad_request');
  assert.equal((await client.request('theme.save', { name: 'huge', data: { x: 'y'.repeat(257 * 1024) } })).error?.code, 'bad_request');
  assert.equal((await client.request('theme.delete', { id: 'th_missing' })).error?.code, 'not_found');
  await client.call('theme.delete', { id: second.theme.id });

  client.close();
  await hub.close();
  hub = await makeHub(hubDir.path);
  client = await TestClient.connect(hub.clientUrl, await tokenFor(hub, owner));
  const { themes } = await client.call<{ themes: ThemeFile[] }>('themes.list');
  assert.deepEqual(themes.map((x) => [x.id, x.name, x.data]), [[theme.id, 'Nord warmer', { base: 'nord', tones: 6 }]]);
});

test('prefs live on the hub: shared by devices, prefs.updated pushed, persisted', async (t) => {
  const hubDir = tempDir();
  let hub = await makeHub(hubDir.path);
  const desktop = await pairDevice(hub, setupCode(hub), 'desktop');
  let a = await TestClient.connect(hub.clientUrl, await tokenFor(hub, desktop));
  const { code } = await a.call<{ code: string }>('pairing.create', { kind: 'device', name: 'phone' });
  const phone = await pairDevice(hub, code, 'phone');
  const b = await TestClient.connect(hub.clientUrl, await tokenFor(hub, phone));
  t.after(async () => {
    a.close();
    b.close();
    await hub.close();
    hubDir.cleanup();
  });
  await b.call('subscribe', { ch: GLOBAL_CHANNEL });
  assert.deepEqual((await a.call<{ prefs: UserPrefs }>('prefs.get')).prefs, {});
  const { prefs } = await a.call<{ prefs: UserPrefs }>('prefs.set', { prefs: { themeId: 'harbour', density: 'compact' } });
  assert.deepEqual(prefs, { themeId: 'harbour', density: 'compact' });
  await waitFor(() => b.events.find((e) => e.type === 'prefs.updated'));
  assert.deepEqual(b.events.find((e) => e.type === 'prefs.updated')?.data, { prefs: { themeId: 'harbour', density: 'compact' } });
  assert.deepEqual((await b.call<{ prefs: UserPrefs }>('prefs.set', { prefs: { themeId: 'nord' } })).prefs, { themeId: 'nord', density: 'compact' });
  assert.equal((await a.request('prefs.set', { prefs: { density: 7 } })).error?.code, 'bad_request');

  a.close();
  b.close();
  await hub.close();
  hub = await makeHub(hubDir.path);
  a = await TestClient.connect(hub.clientUrl, await tokenFor(hub, desktop));
  assert.deepEqual((await a.call<{ prefs: UserPrefs }>('prefs.get')).prefs, { themeId: 'nord', density: 'compact' });
});

test('NtfyPusher: plan windows at 80% and 95% and limited logins, once per window reset', async () => {
  const sent: { headers: Record<string, string>; body: string }[] = [];
  const fakeFetch = (async (_url: string, init: { headers: Record<string, string>; body: string }) => {
    sent.push({ headers: init.headers, body: init.body });
    return new Response('{}');
  }) as unknown as typeof fetch;
  let now = Date.parse('2026-11-10T12:00:00.000Z');
  let saved: string | undefined;
  const make = () =>
    new NtfyPusher({
      url: 'http://ntfy/x',
      publicUrl: 'https://bizzi.example.com',
      debounceMs: 5,
      logger: nullLogger,
      describe: () => ({ session: 'S' }),
      fetch: fakeFetch,
      now: () => now,
      state: { load: () => saved, save: (j) => (saved = j) },
    });
  let pusher = make();
  let seq = 0;
  const reset1 = '2026-11-10T14:00:00.000Z';
  const reset2 = '2026-11-10T19:00:00.000Z';
  const push = async (usedPercent: number, resetsAt: string, status: AccountUsage['status'] = 'ok', observedAt = new Date(now).toISOString()) => {
    const usage = login({ label: 'claude max', status, observedAt, windows: [{ id: 'five_hour', label: '5h', usedPercent, resetsAt }] });
    pusher.handle({ ch: GLOBAL_CHANNEL, seq: ++seq, ts: observedAt, type: 'account.usage', data: { usage } } as ChannelEvent);
    await sleep(20);
  };

  await push(50, reset1);
  assert.equal(sent.length, 0);
  await push(81, reset1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.headers.Title, 'claude max: 5h at 81%');
  assert.equal(sent[0]!.body, 'resets in 2h00');
  assert.equal(sent[0]!.headers.Click, 'https://bizzi.example.com/');
  await push(79, reset1);
  await push(84, reset1);
  assert.equal(sent.length, 1, '80% is announced once per reset');
  await push(96, reset1);
  assert.equal(sent.length, 2);
  assert.equal(sent[1]!.headers.Title, 'claude max: 5h at 96%');
  await push(100, reset1, 'limited');
  assert.equal(sent.length, 3);
  assert.equal(sent[2]!.headers.Title, 'claude max is rate limited');
  await push(100, reset1, 'limited');
  assert.equal(sent.length, 3, 'limited once per reset');

  // A restart keeps the marks; an old replayed snapshot never notifies.
  await pusher.close();
  pusher = make();
  await push(100, reset1, 'limited');
  assert.equal(sent.length, 3);

  // A new window: crossing again notifies again; a stale snapshot only updates the marks.
  now += 3 * 3_600_000;
  await push(10, reset2);
  await push(97, reset2, 'ok', new Date(now - 3_600_000).toISOString());
  assert.equal(sent.length, 3, 'stale snapshot');
  await push(98, reset2);
  assert.equal(sent.length, 3, 'already marked by the stale snapshot');
  await push(100, reset2, 'limited');
  assert.equal(sent.length, 4);
  await pusher.close();
});
