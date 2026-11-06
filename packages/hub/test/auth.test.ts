import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { test } from 'node:test';
import { GLOBAL_CHANNEL, PROTOCOL_VERSION, type DeviceInfo, type PairResponse } from '@bizzi/protocol';
import { generateKeyPair, loadCredential, pairWithHub, requestToken, saveCredential, signChallenge } from '../src/index.ts';
import { hubHttpBase, hubNodeUrl } from '../src/credentials.ts';
import { makeHub, pairDevice, postJson, setupCode, sleep, tempDir, TestClient, tokenFor, waitFor } from './helpers.ts';

test('setup code pairs the owner once, then pairing.create codes pair more devices', async (t) => {
  const dir = tempDir();
  t.after(dir.cleanup);
  const hub = await makeHub(dir.path);
  t.after(() => hub.close());

  // Setup code file exists with a formatted code.
  const code = setupCode(hub);
  assert.match(code, /^[2-9A-Z]{4}-[2-9A-Z]{4}$/);
  assert.equal(statSync(hub.setupCodeFile).mode & 0o777, 0o600);

  // Health endpoint.
  const health = (await (await fetch(`${hub.url}/healthz`)).json()) as { ok: boolean; role: string };
  assert.deepEqual([health.ok, health.role], [true, 'hub']);

  // Pair the owner; the code is case-insensitive and dashes/spaces are ignored.
  const kp = generateKeyPair();
  const loose = ` ${code.toLowerCase().replace('-', ' ')} `;
  const r = await postJson(`${hub.url}/api/pair`, { code: loose, kind: 'device', name: 'phone', publicKey: kp.publicKey });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const pair = r.body as unknown as PairResponse;
  assert.equal(pair.owner, true);
  assert.equal(pair.kind, 'device');
  assert.match(pair.deviceId, /^d_/);
  assert.match(pair.clientUrl, /^ws:\/\/127\.0\.0\.1:\d+\/ws$/);
  assert.match(pair.nodeUrl, /\/ws\/node$/);
  assert.equal(existsSync(hub.setupCodeFile), false, 'setup-code file removed once used');

  // Setup code is single use.
  const reuse = await postJson(`${hub.url}/api/pair`, { code, kind: 'device', name: 'again', publicKey: generateKeyPair().publicKey });
  assert.equal(reuse.status, 401);
  assert.equal(reuse.body.error?.code, 'unauthorized');

  // Token via challenge/response, then hello.
  const owner = { deviceId: pair.deviceId, privateKey: kp.privateKey };
  const tok = await requestToken({ hubUrl: hub.url, ...owner });
  assert.match(tok.token, /^bzt_/);
  assert.ok(Date.parse(tok.expiresAt) > Date.now() + 50 * 60_000);
  const client = await TestClient.connect(hub.clientUrl, tok.token);
  t.after(() => client.close());
  const hello = await client.call<{ role: string; machine: { roles: string[] } }>('hello', { protocol: PROTOCOL_VERSION, client: { name: 'x', version: '0' } });
  assert.equal(hello.role, 'hub');
  assert.deepEqual(hello.machine.roles, ['hub']);

  // pairing.create → a second (non-owner) device.
  const created = await client.call<{ code: string; expiresAt: string; pairUrl: string }>('pairing.create', { kind: 'device', name: 'laptop' });
  assert.match(created.code, /^[2-9A-Z]{4}-[2-9A-Z]{4}$/);
  assert.ok(created.pairUrl.endsWith(`/#/pair?code=${created.code}`));
  const second = await pairWithHub({ hubUrl: hub.clientUrl, code: created.code, kind: 'device', name: 'laptop' });
  assert.equal(second.response.owner, false);
  const reuse2 = await postJson(`${hub.url}/api/pair`, { code: created.code, kind: 'device', name: 'x', publicKey: generateKeyPair().publicKey });
  assert.equal(reuse2.status, 401);

  // A node code can't pair a device, and node pairing needs a machineId.
  const nodeCode = await client.call<{ code: string }>('pairing.create', { kind: 'node' });
  const wrongKind = await postJson(`${hub.url}/api/pair`, { code: nodeCode.code, kind: 'device', name: 'x', publicKey: generateKeyPair().publicKey });
  assert.equal(wrongKind.status, 401);
  const noMachine = await postJson(`${hub.url}/api/pair`, { code: nodeCode.code, kind: 'node', name: 'x', publicKey: generateKeyPair().publicKey });
  assert.equal(noMachine.status, 400);
  const badKey = await postJson(`${hub.url}/api/pair`, { code: nodeCode.code, kind: 'node', name: 'x', machineId: 'm_X', publicKey: { kty: 'OKP', crv: 'Ed25519', x: 'nope' } });
  assert.equal(badKey.status, 400);

  // devices.list and device.updated on the global channel.
  const { devices } = await client.call<{ devices: DeviceInfo[] }>('devices.list');
  assert.deepEqual(devices.map((d) => [d.name, Boolean(d.owner)]), [['phone', true], ['laptop', false]]);
  assert.ok(devices.every((d) => !('publicKey' in d)));
  await client.call('subscribe', { ch: GLOBAL_CHANNEL });
  await waitFor(() => client.on(GLOBAL_CHANNEL).filter((e) => e.type === 'device.updated').length === 2, 2000, 'device.updated x2');
});

test('pairing codes expire', async (t) => {
  const dir = tempDir();
  t.after(dir.cleanup);
  const hub = await makeHub(dir.path, { auth: { pairingTtlMs: 50 } });
  t.after(() => hub.close());
  const owner = await pairDevice(hub, setupCode(hub));
  const client = await TestClient.connect(hub.clientUrl, await tokenFor(hub, owner));
  t.after(() => client.close());
  const { code } = await client.call<{ code: string }>('pairing.create', { kind: 'device' });
  await sleep(80);
  const r = await postJson(`${hub.url}/api/pair`, { code, kind: 'device', name: 'late', publicKey: generateKeyPair().publicKey });
  assert.equal(r.status, 401);
  assert.match(r.body.error?.message ?? '', /expired/);
});

test('bad signatures, unknown devices and reused nonces are rejected', async (t) => {
  const dir = tempDir();
  t.after(dir.cleanup);
  const hub = await makeHub(dir.path);
  t.after(() => hub.close());
  const owner = await pairDevice(hub, setupCode(hub));

  // Signed with the wrong key.
  const ch1 = await postJson(`${hub.url}/api/auth/challenge`, { deviceId: owner.deviceId });
  assert.equal(ch1.status, 200);
  const nonce1 = ch1.body.nonce as string;
  const forged = signChallenge(generateKeyPair().privateKey, owner.deviceId, nonce1);
  const bad = await postJson(`${hub.url}/api/auth/token`, { deviceId: owner.deviceId, nonce: nonce1, signature: forged });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.error?.code, 'unauthorized');

  // The nonce was consumed by the failed attempt: a correct signature over it no longer works.
  const late = await postJson(`${hub.url}/api/auth/token`, {
    deviceId: owner.deviceId,
    nonce: nonce1,
    signature: signChallenge(owner.privateKey, owner.deviceId, nonce1),
  });
  assert.equal(late.status, 401);

  // Correct flow works once; the same nonce can't be replayed.
  const ch2 = await postJson(`${hub.url}/api/auth/challenge`, { deviceId: owner.deviceId });
  const nonce2 = ch2.body.nonce as string;
  const sig2 = signChallenge(owner.privateKey, owner.deviceId, nonce2);
  const ok = await postJson(`${hub.url}/api/auth/token`, { deviceId: owner.deviceId, nonce: nonce2, signature: sig2 });
  assert.equal(ok.status, 200);
  const replay = await postJson(`${hub.url}/api/auth/token`, { deviceId: owner.deviceId, nonce: nonce2, signature: sig2 });
  assert.equal(replay.status, 401);

  // Unknown device.
  const unknown = await postJson(`${hub.url}/api/auth/challenge`, { deviceId: 'd_NOPE' });
  assert.equal(unknown.status, 401);

  // A garbage token can't say hello.
  const c = new TestClient(hub.clientUrl);
  const r = await c.request('hello', { protocol: PROTOCOL_VERSION, client: { name: 'x', version: '0' }, token: 'bzt_garbage' });
  assert.equal(r.error?.code, 'unauthorized');
  assert.equal((await c.closed).code, 4401);
});

test('failed attempts are rate limited', async (t) => {
  const dir = tempDir();
  t.after(dir.cleanup);
  const hub = await makeHub(dir.path, { auth: { maxFailures: 3 } });
  t.after(() => hub.close());
  const pk = generateKeyPair().publicKey;
  for (let i = 0; i < 3; i++) {
    const r = await postJson(`${hub.url}/api/pair`, { code: 'AAAA-AAAA', kind: 'device', name: 'x', publicKey: pk });
    assert.equal(r.status, 401);
  }
  const limited = await fetch(`${hub.url}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: setupCode(hub), kind: 'device', name: 'x', publicKey: pk }),
  });
  assert.equal(limited.status, 429, 'even the right code is refused while limited');
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
});

test('tokens expire', async (t) => {
  const dir = tempDir();
  t.after(dir.cleanup);
  const hub = await makeHub(dir.path, { auth: { tokenTtlMs: 60 } });
  t.after(() => hub.close());
  const owner = await pairDevice(hub, setupCode(hub));
  const token = await tokenFor(hub, owner);
  await sleep(100);
  const c = new TestClient(hub.clientUrl);
  const r = await c.request('hello', { protocol: PROTOCOL_VERSION, client: { name: 'x', version: '0' }, token });
  assert.equal(r.error?.code, 'unauthorized');
  assert.match(r.error?.message ?? '', /expired/);
  assert.equal((await c.closed).code, 4401);
});

test('revoking a device closes its sockets and blocks new tokens; only devices may manage devices', async (t) => {
  const dir = tempDir();
  t.after(dir.cleanup);
  const hub = await makeHub(dir.path);
  t.after(() => hub.close());
  const owner = await pairDevice(hub, setupCode(hub), 'owner');
  const a = await TestClient.connect(hub.clientUrl, await tokenFor(hub, owner));
  t.after(() => a.close());
  const { code } = await a.call<{ code: string }>('pairing.create', { kind: 'device' });
  const victim = await pairDevice(hub, code, 'victim');
  const victimToken = await tokenFor(hub, victim);
  const b = await TestClient.connect(hub.clientUrl, victimToken);

  await a.call('subscribe', { ch: GLOBAL_CHANNEL });
  await a.call('device.revoke', { deviceId: victim.deviceId });
  const closed = await b.closed;
  assert.equal(closed.code, 4403);

  // Existing token and new challenges are refused.
  const c = new TestClient(hub.clientUrl);
  const r = await c.request('hello', { protocol: PROTOCOL_VERSION, client: { name: 'x', version: '0' }, token: victimToken });
  assert.equal(r.error?.code, 'unauthorized');
  await assert.rejects(tokenFor(hub, victim), (err: { code?: string }) => err.code === 'unauthorized');

  const { devices } = await a.call<{ devices: DeviceInfo[] }>('devices.list');
  assert.equal(devices.find((d) => d.id === victim.deviceId)?.revoked, true);
  await waitFor(
    () => a.on(GLOBAL_CHANNEL).some((e) => e.type === 'device.updated' && e.data.device.id === victim.deviceId && e.data.device.revoked),
    2000,
    'device.updated revoked',
  );
  const missing = await a.request('device.revoke', { deviceId: 'd_NOPE' });
  assert.equal(missing.error?.code, 'not_found');

  // A node-kind credential may connect to /ws but not manage devices.
  const { code: nodeCode } = await a.call<{ code: string }>('pairing.create', { kind: 'node' });
  const node = await pairWithHub({ hubUrl: hub.url, code: nodeCode, kind: 'node', name: 'n', machineId: 'm_TESTMACHINE' });
  const n = await TestClient.connect(hub.clientUrl, await tokenFor(hub, node.credential));
  t.after(() => n.close());
  const denied = await n.request('pairing.create', { kind: 'device' });
  assert.equal(denied.error?.code, 'unauthorized');
});

test('credential file helpers', (t) => {
  const dir = tempDir();
  t.after(dir.cleanup);
  assert.equal(loadCredential(dir.path), undefined);
  const kp = generateKeyPair();
  const file = saveCredential(dir.path, {
    version: 1,
    hubUrl: 'wss://h.example/ws/node',
    deviceId: 'd_1',
    kind: 'node',
    machineId: 'm_1',
    publicKey: kp.publicKey,
    privateKey: kp.privateKey,
    pairedAt: new Date().toISOString(),
  });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(loadCredential(dir.path)?.deviceId, 'd_1');

  assert.equal(hubHttpBase('wss://h.example/ws/node'), 'https://h.example');
  assert.equal(hubHttpBase('ws://hub:7777/ws'), 'http://hub:7777');
  assert.equal(hubHttpBase('https://h.example/bizzi/'), 'https://h.example/bizzi');
  assert.equal(hubHttpBase('hub:7777'), 'http://hub:7777');
  assert.equal(hubNodeUrl('https://h.example'), 'wss://h.example/ws/node');
  assert.equal(hubNodeUrl('ws://hub:7777/ws/node'), 'ws://hub:7777/ws/node');
});
