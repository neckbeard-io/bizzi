import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify, type ECDH } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { createNode } from '@bizzi/core';
import { FakeAdapter } from '@bizzi/core/testing';
import type { SessionInfo, WebPushPayload, WorkspaceInfo } from '@bizzi/protocol';
import {
  VAPID_FILE,
  connectToHub,
  encryptWebPush,
  generateVapidKeys,
  pairWithHub,
  vapidAuthorization,
  vapidJwt,
  vapidKeyObject,
} from '../src/index.ts';
import { fromB64url } from '../src/webpush.ts';
import { makeHub, pairDevice, postJson, setupCode, sleep, tempDir, TestClient, tokenFor, waitFor } from './helpers.ts';

// RFC 8291 §5 / Appendix A.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
    'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
    'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

/** The user agent's side of RFC 8291: decrypt one aes128gcm record. */
function decrypt(body: Buffer, ua: ECDH, auth: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const idlen = body[20]!;
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const uaPublic = ua.getPublicKey();
  const secret = ua.computeSecret(asPublic);
  const ikm = Buffer.from(hkdfSync('sha256', secret, auth, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  assert.equal(plain[end], 2, 'last-record delimiter');
  return plain.subarray(0, end);
}

function userAgent(): { ecdh: ECDH; auth: Buffer; keys: { p256dh: string; auth: string } } {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return { ecdh, auth, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
}

test('encryptWebPush reproduces the RFC 8291 example', () => {
  const body = encryptWebPush(Buffer.from(RFC.plaintext), { p256dh: RFC.uaPublic, auth: RFC.auth }, { asPrivateKey: fromB64url(RFC.asPrivate), salt: fromB64url(RFC.salt) });
  assert.equal(body.toString('base64url'), RFC.body);
  assert.equal(body.length, 144);
  // And the receiver's side of the same vector.
  const ua = createECDH('prime256v1');
  ua.setPrivateKey(fromB64url(RFC.uaPrivate));
  assert.equal(decrypt(body, ua, fromB64url(RFC.auth)).toString(), RFC.plaintext);
});

test('encryptWebPush: fresh keys and salt per message round-trip', () => {
  const ua = userAgent();
  const a = encryptWebPush(Buffer.from('hello'), ua.keys);
  const b = encryptWebPush(Buffer.from('hello'), ua.keys);
  assert.notDeepEqual(a.subarray(0, 16), b.subarray(0, 16));
  assert.equal(a.readUInt32BE(16), 4096);
  assert.equal(decrypt(a, ua.ecdh, ua.auth).toString(), 'hello');
  assert.throws(() => encryptWebPush(Buffer.from('x'), { p256dh: ua.keys.p256dh, auth: 'AAAA' }), /16 bytes/);
});

test('VAPID: ES256 JWT with aud/exp/sub and a vapid Authorization header', () => {
  const keys = generateVapidKeys();
  assert.equal(fromB64url(keys.publicKey).length, 65);
  assert.equal(fromB64url(keys.privateKey).length, 32);
  const jwt = vapidJwt({ audience: 'https://push.example.net', subject: 'mailto:me@example.com', expiresAt: 1_900_000_000, key: vapidKeyObject(keys) });
  const [h, c, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h!, 'base64url').toString()), { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(JSON.parse(Buffer.from(c!, 'base64url').toString()), { aud: 'https://push.example.net', exp: 1_900_000_000, sub: 'mailto:me@example.com' });
  const sig = Buffer.from(s!, 'base64url');
  assert.equal(sig.length, 64, 'raw r||s, not DER');
  const pub = fromB64url(keys.publicKey);
  const verifyKey = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') } });
  assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), { key: verifyKey, dsaEncoding: 'ieee-p1363' }, sig));
  assert.equal(vapidAuthorization(jwt, keys.publicKey), `vapid t=${jwt}, k=${keys.publicKey}`);
});

interface Got {
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/** A fake push service: 201 for /push/ok*, 410 for /push/gone*. */
async function pushService(): Promise<{ origin: string; got: Got[]; close: () => Promise<void> }> {
  const got: Got[] = [];
  const srv = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (d: Buffer) => chunks.push(d));
    req.on('end', () => {
      got.push({ path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(req.url?.startsWith('/push/gone') ? 410 : 201).end();
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  return { origin, got, close: () => new Promise((r) => { srv.close(() => r()); srv.closeAllConnections(); }) };
}

test('hub: Web Push to subscribed devices, expired subscriptions dropped, Approve from the notification', async (t) => {
  const ps = await pushService();
  const hubDir = tempDir();
  const nodeDir = tempDir();
  const wsDir = tempDir('bizzi-hub-ws-');
  const hub = await makeHub(hubDir.path, {
    publicUrl: 'https://bizzi.example.com/',
    webPush: { debounceMs: 20, allowInsecureEndpoints: true, subject: 'mailto:ops@example.com' },
  });
  const owner = await pairDevice(hub, setupCode(hub), 'phone');
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
    await ps.close();
    hubDir.cleanup();
    nodeDir.cleanup();
    wsDir.cleanup();
  });
  await link.waitConnected(5000);

  // The VAPID key is generated into the data dir and served by push.config.
  const vapid = JSON.parse(readFileSync(join(hubDir.path, VAPID_FILE), 'utf8')) as { publicKey: string };
  const { webPush } = await client.call<{ webPush: { publicKey: string } }>('push.config');
  assert.equal(webPush.publicKey, vapid.publicKey);

  // Validation: https only (unless allowed), well-formed keys.
  const ua = userAgent();
  const bad = await client.request('push.register', { subscription: { endpoint: `${ps.origin}/push/ok`, keys: { p256dh: 'AAAA', auth: ua.keys.auth } } });
  assert.equal(bad.error?.code, 'bad_request');

  const gone = userAgent();
  await client.call('push.register', { subscription: { endpoint: `${ps.origin}/push/ok-1`, keys: ua.keys }, name: 'Chrome' });
  await client.call('push.register', { subscription: { endpoint: `${ps.origin}/push/gone-1`, keys: gone.keys } });

  // A node can't touch push.*.
  const nodeClient = await TestClient.connect(hub.clientUrl, await tokenFor(hub, credential));
  assert.equal((await nodeClient.request('push.config')).error?.code, 'unauthorized');
  nodeClient.close();

  const { workspace } = await client.call<{ workspace: WorkspaceInfo }>('workspace.create', { machineId: node.machine.id, path: join(wsDir.path, 'p'), create: true });
  const { session } = await client.call<{ session: SessionInfo }>('session.create', { workspaceId: workspace.id, agent: 'claude', title: 'Fix tests' });
  const ch = `session:${session.id}`;
  await client.call('subscribe', { ch });
  await client.call('session.send', { sessionId: session.id, input: [{ type: 'text', text: '/approve rm -rf build' }] });
  await waitFor(() => client.on(ch).find((e) => e.type === 'approval.requested'), 5000, 'approval.requested');
  await waitFor(() => ps.got.length === 2, 5000, 'two push deliveries');

  const ok = ps.got.find((g) => g.path === '/push/ok-1')!;
  assert.equal(ok.headers['content-encoding'], 'aes128gcm');
  assert.equal(ok.headers['content-type'], 'application/octet-stream');
  assert.equal(ok.headers.ttl, '86400');
  assert.equal(ok.headers.urgency, 'high');
  const auth = /^vapid t=([^,]+), k=(.+)$/.exec(ok.headers.authorization ?? '');
  assert.ok(auth, 'vapid Authorization header');
  assert.equal(auth[2], vapid.publicKey);
  const claims = JSON.parse(Buffer.from(auth[1]!.split('.')[1]!, 'base64url').toString()) as { aud: string; sub: string; exp: number };
  assert.equal(claims.aud, ps.origin);
  assert.equal(claims.sub, 'mailto:ops@example.com');
  assert.ok(claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 24 * 3600);

  const payload = JSON.parse(decrypt(ok.body, ua.ecdh, ua.auth).toString()) as WebPushPayload;
  assert.equal(payload.title, 'Approval needed: Fix tests');
  assert.match(payload.body, /Run rm -rf build\?/);
  assert.match(payload.body, /on pusher/);
  assert.equal(payload.url, `https://bizzi.example.com/#/s/${session.id}`);
  assert.equal(payload.sessionId, session.id);
  assert.equal(payload.tag, `session:${session.id}`);
  assert.ok(payload.approval);
  assert.equal(payload.approval.actionUrl, 'https://bizzi.example.com/api/push/action');
  assert.ok(payload.approval.options.includes('allow'));

  // The 410 subscription is gone: a test push reaches only the live one.
  await waitFor(() => hub.relay.store.webPush.list().length === 1, 5000, 'expired subscription dropped');
  assert.equal(hub.relay.store.webPush.list()[0]!.endpoint, `${ps.origin}/push/ok-1`);
  const res = await client.call<{ sent: number; failed: number }>('push.test');
  assert.deepEqual(res, { sent: 1, failed: 0 });

  // Approve from the notification: the service worker POSTs the token (here straight to the hub).
  const wrong = await postJson(`${hub.url}/api/push/action`, { token: 'nope', decision: 'allow' });
  assert.equal(wrong.status, 401);
  const approved = await postJson(`${hub.url}/api/push/action`, { token: payload.approval.token, decision: 'allow' });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const resolved = await waitFor(() => client.on(ch).find((e) => e.type === 'approval.resolved'), 5000, 'approval.resolved');
  assert.equal((resolved.data as { decision: string }).decision, 'allow');
  await waitFor(() => client.on(ch).some((e) => e.type === 'turn.completed'), 5000, 'turn.completed');
  // Single use.
  const again = await postJson(`${hub.url}/api/push/action`, { token: payload.approval.token, decision: 'deny' });
  assert.equal(again.status, 401);

  // Unregister: no more deliveries.
  await client.call('push.unregister', { endpoint: `${ps.origin}/push/ok-1` });
  assert.deepEqual(await client.call('push.test'), { sent: 0, failed: 0 });
});

test('hub: the VAPID key survives restarts; Web Push can be turned off', async (t) => {
  const ps = await pushService();
  const hubDir = tempDir();
  let hub = await makeHub(hubDir.path, { webPush: { allowInsecureEndpoints: true } });
  let client: TestClient | undefined;
  t.after(async () => {
    client?.close();
    await hub.close();
    await ps.close();
    hubDir.cleanup();
  });
  const firstUrl = hub.url;
  const owner = await pairDevice(hub, setupCode(hub));
  client = await TestClient.connect(hub.clientUrl, await tokenFor(hub, owner));
  const first = (await client.call<{ webPush: { publicKey: string } }>('push.config')).webPush.publicKey;
  const ua = userAgent();
  await client.call('push.register', { subscription: { endpoint: `${ps.origin}/push/ok-2`, keys: ua.keys } });
  client.close();
  await hub.close();

  hub = await makeHub(hubDir.path, { webPush: { allowInsecureEndpoints: true } });
  client = await TestClient.connect(hub.clientUrl, await tokenFor(hub, owner));
  assert.equal((await client.call<{ webPush: { publicKey: string } }>('push.config')).webPush.publicKey, first);
  assert.deepEqual(await client.call('push.test'), { sent: 1, failed: 0 });
  // Without a publicUrl the click-through uses the URL the device registered through (the UI re-registers on load).
  const payload = JSON.parse(decrypt(ps.got.at(-1)!.body, ua.ecdh, ua.auth).toString()) as WebPushPayload;
  assert.equal(payload.url, `${firstUrl}/#/`);
  client.close();
  await hub.close();

  // Web Push off: push.* answers unsupported.
  hub = await makeHub(hubDir.path, { webPush: false });
  client = await TestClient.connect(hub.clientUrl, await tokenFor(hub, owner));
  assert.equal((await client.request('push.config')).error?.code, 'unsupported');
  client.close();
  await hub.close();
});

test('Pusher drops a queued approval once it is resolved', async () => {
  const { Pusher } = await import('../src/push.ts');
  const { nullLogger } = await import('../src/util.ts');
  const sent: string[] = [];
  const now = Date.now();
  const pusher = new Pusher({
    sinks: [{ send: async (n) => void sent.push(n.title) }],
    debounceMs: 30,
    logger: nullLogger,
    describe: () => ({ session: 'S' }),
  });
  const ev = (type: string, data: unknown, seq: number) => ({ ch: 'session:s1', seq, ts: new Date(now).toISOString(), type, data }) as never;
  pusher.handle(ev('approval.requested', { approvalId: 'a1', title: 'Run ls', kind: 'shell', editable: false, options: ['allow', 'deny'] }, 1));
  pusher.handle(ev('approval.resolved', { approvalId: 'a1', decision: 'allow' }, 2));
  await sleep(60);
  await pusher.close();
  assert.deepEqual(sent, []);
});
