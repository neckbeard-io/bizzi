import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { BizziError, authMessage, normalizePairingCode } from '@bizzi/protocol';
import type { Ed25519PublicJwk } from '@bizzi/protocol';
import {
  BizziClient,
  HubTokenProvider,
  base64UrlToBytes,
  hubHttpBase,
  hubTokenProvider,
  loadOrCreateIdentity,
  memoryIdentityStore,
  nativeIdentityStore,
  pairWithHub,
  parsePairLink,
  requestToken,
  verifySignature,
} from '../src/index.ts';
import type { BizziNative } from '../src/index.ts';
import { FakeServer } from './fake-server.ts';

/** A minimal hub HTTP API (protocol hub.ts) that really verifies Ed25519 signatures. */
class FakeHub {
  readonly server: Server;
  readonly codes = new Set<string>(['SETUP123']);
  readonly devices = new Map<string, { publicKey: Ed25519PublicJwk; name: string; revoked: boolean }>();
  readonly nonces = new Map<string, string>();
  readonly issued: string[] = [];
  /** Lifetime of issued tokens. */
  tokenTtlMs = 60_000;
  tokenRequests = 0;
  /** Called with every issued token (e.g. to authorize it on the ws fake). */
  onToken: (token: string) => void = () => {};
  private n = 0;

  private constructor(server: Server) {
    this.server = server;
  }

  static async start(): Promise<FakeHub> {
    let hub: FakeHub | null = null;
    const server = createServer((req, res) => void hub?.route(req, res));
    hub = new FakeHub(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    return hub;
  }

  get url(): string {
    const a = this.server.address();
    if (!a || typeof a === 'string') throw new Error('no address');
    return `http://127.0.0.1:${a.port}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const send = (status: number, json: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    };
    const deny = (message: string): void => send(401, { error: { code: 'unauthorized', message } });
    if (req.method !== 'POST') return send(405, { error: { code: 'bad_request', message: 'POST only' } });
    if (req.url === '/api/pair') {
      const code = normalizePairingCode(String(body.code ?? ''));
      if (!this.codes.delete(code)) return deny('unknown or used pairing code');
      const deviceId = `d_${++this.n}`;
      this.devices.set(deviceId, { publicKey: body.publicKey as Ed25519PublicJwk, name: String(body.name), revoked: false });
      return send(200, { deviceId, kind: body.kind, owner: this.n === 1, clientUrl: 'ws://hub.test/ws', nodeUrl: 'ws://hub.test/ws/node' });
    }
    if (req.url === '/api/auth/challenge') {
      const id = String(body.deviceId);
      const d = this.devices.get(id);
      if (!d || d.revoked) return deny('unknown or revoked device');
      const nonce = `n${++this.n}`;
      this.nonces.set(id, nonce);
      return send(200, { nonce, expiresAt: new Date(Date.now() + 30_000).toISOString() });
    }
    if (req.url === '/api/auth/token') {
      this.tokenRequests++;
      const id = String(body.deviceId);
      const d = this.devices.get(id);
      const nonce = this.nonces.get(id);
      if (!d || d.revoked || !nonce || nonce !== body.nonce) return deny('bad challenge');
      this.nonces.delete(id);
      const ok = await verifySignature(d.publicKey, authMessage(id, nonce), base64UrlToBytes(String(body.signature)) as Uint8Array<ArrayBuffer>);
      if (!ok) return deny('bad signature');
      const token = `tok_${++this.n}`;
      this.issued.push(token);
      this.onToken(token);
      return send(200, { token, expiresAt: new Date(Date.now() + this.tokenTtlMs).toISOString() });
    }
    send(404, { error: { code: 'not_found', message: 'no route' } });
  }
}

async function setup(t: TestContext): Promise<FakeHub> {
  const hub = await FakeHub.start();
  t.after(() => hub.stop());
  return hub;
}

test('hub URLs and pairing links are normalized', () => {
  assert.equal(hubHttpBase('hub.example.com'), 'https://hub.example.com');
  assert.equal(hubHttpBase('wss://hub.example.com/ws'), 'https://hub.example.com');
  assert.equal(hubHttpBase('ws://192.168.1.5:7777/ws'), 'http://192.168.1.5:7777');
  assert.equal(hubHttpBase('192.168.1.5:7777'), 'http://192.168.1.5:7777');
  assert.equal(hubHttpBase('nas.local:7777/'), 'http://nas.local:7777');
  assert.equal(hubHttpBase('https://example.com/bizzi/'), 'https://example.com/bizzi');

  assert.deepEqual(parsePairLink('https://hub.example.com/#/pair?code=ab12-cd34'), { code: 'AB12CD34', hubUrl: 'https://hub.example.com' });
  assert.deepEqual(parsePairLink('https://example.com/bizzi/pair?code=K7Q2M9XD'), { code: 'K7Q2M9XD', hubUrl: 'https://example.com/bizzi' });
  assert.deepEqual(parsePairLink('https://hub.example.com/pair/K7Q2M9XD'), { code: 'K7Q2M9XD', hubUrl: 'https://hub.example.com' });
  assert.deepEqual(parsePairLink('bizzi://pair?hub=https%3A%2F%2Fhub.example.com&code=xy99zz11'), { code: 'XY99ZZ11', hubUrl: 'https://hub.example.com' });
  assert.deepEqual(parsePairLink(' k7q2-m9xd '), { code: 'K7Q2M9XD' });
  assert.equal(parsePairLink('https://hub.example.com/'), null);
  assert.equal(parsePairLink('hello world!'), null);
});

test('pairing registers the public key; tokens come from a signed challenge', async (t) => {
  const hub = await setup(t);
  const store = memoryIdentityStore();
  const creds = await pairWithHub({ hubUrl: hub.url, code: 'setup-123', name: 'Test phone', store });
  assert.equal(creds.deviceId, 'd_1');
  assert.equal(creds.owner, true);
  assert.equal(creds.clientUrl, 'ws://hub.test/ws');
  assert.equal(creds.hubUrl, hub.url);
  assert.ok(creds.keyId.startsWith(`${hub.url}#`));
  assert.equal(hub.devices.get('d_1')?.name, 'Test phone');

  const identity = await loadOrCreateIdentity(creds.keyId, store);
  assert.deepEqual(identity.publicKey, hub.devices.get('d_1')?.publicKey);
  const tok = await requestToken({ hubUrl: hub.url, deviceId: creds.deviceId, identity });
  assert.equal(tok.token, hub.issued[0]);

  // The private key never left the store as bytes: it is a non-extractable CryptoKey.
  const pair = await store.load(creds.keyId);
  assert.equal(pair?.privateKey.extractable, false);
});

test('pairing errors surface as BizziError with the hub error code; the unused key is discarded', async (t) => {
  const hub = await setup(t);
  const store = memoryIdentityStore();
  await assert.rejects(pairWithHub({ hubUrl: hub.url, code: 'WRONG', name: 'x', store }), (e: unknown) => e instanceof BizziError && e.code === 'unauthorized' && /pairing code/.test(e.message));
  await assert.rejects(pairWithHub({ hubUrl: 'http://127.0.0.1:1', code: 'SETUP123', name: 'x', store }), (e: unknown) => e instanceof BizziError && e.code === 'machine_offline');
});

test('another device key cannot get a token for a paired device', async (t) => {
  const hub = await setup(t);
  const store = memoryIdentityStore();
  const creds = await pairWithHub({ hubUrl: hub.url, code: 'SETUP123', name: 'phone', store });
  const intruder = await loadOrCreateIdentity('someone-else', store);
  await assert.rejects(requestToken({ hubUrl: hub.url, deviceId: creds.deviceId, identity: intruder }), (e: unknown) => e instanceof BizziError && e.code === 'unauthorized' && /signature/.test(e.message));
});

test('token provider caches, refreshes before expiry, shares concurrent fetches and honors forceRefresh', async (t) => {
  const hub = await setup(t);
  hub.tokenTtlMs = 10 * 60_000;
  const store = memoryIdentityStore();
  const creds = await pairWithHub({ hubUrl: hub.url, code: 'SETUP123', name: 'phone', store });
  const identity = await loadOrCreateIdentity(creds.keyId, store);
  let now = Date.now();
  const provider = new HubTokenProvider({ hubUrl: hub.url, deviceId: creds.deviceId, identity, refreshMarginMs: 60_000, now: () => now });

  const [a, b] = await Promise.all([provider.getToken(), provider.getToken()]);
  assert.equal(a, b);
  assert.equal(provider.fetches, 1);
  assert.equal(await provider.getToken(), a);
  assert.equal(provider.fetches, 1);

  // 8 minutes later: still more than the margin left.
  now += 8 * 60_000;
  assert.equal(await provider.getToken(), a);
  // 9.5 minutes in: inside the 60 s margin, so a new token is fetched before the old one expires.
  now += 90_000;
  const c = await provider.getToken();
  assert.notEqual(c, a);
  assert.equal(provider.fetches, 2);

  const d = await provider.getToken({ forceRefresh: true });
  assert.notEqual(d, c);
  assert.equal(provider.fetches, 3);
});

test('short-lived tokens refresh at half their lifetime', async (t) => {
  const hub = await setup(t);
  hub.tokenTtlMs = 20_000;
  const store = memoryIdentityStore();
  const creds = await pairWithHub({ hubUrl: hub.url, code: 'SETUP123', name: 'phone', store });
  let now = Date.now();
  const provider = new HubTokenProvider({ hubUrl: hub.url, deviceId: creds.deviceId, identity: await loadOrCreateIdentity(creds.keyId, store), now: () => now });
  const a = await provider.getToken();
  now += 9_000;
  assert.equal(await provider.getToken(), a);
  now += 2_000;
  assert.notEqual(await provider.getToken(), a);
});

test('client connects with a token provider and re-authenticates once when the hub rejects a stale token', async (t) => {
  const hub = await setup(t);
  const ws = await FakeServer.start();
  ws.helloRole = 'hub';
  hub.onToken = (tok) => ws.tokens.add(tok);
  const store = memoryIdentityStore();
  const creds = await pairWithHub({ hubUrl: hub.url, code: 'SETUP123', name: 'phone', store });
  const provider = await hubTokenProvider(creds, { store });
  const client = new BizziClient({ backoff: { baseMs: 10, maxMs: 20 }, requestTimeoutMs: 1000 });
  t.after(async () => {
    client.close();
    await ws.stop();
  });

  const hello = await client.connect(ws.url, provider);
  assert.equal(hello.role, 'hub');
  assert.equal(client.getConnection().role, 'hub');
  const first = ws.requests.find((r) => r.method === 'hello');
  assert.equal((first?.params as { token?: string }).token, hub.issued[0]);

  // The hub forgets the token (e.g. it restarted); the next reconnect gets `unauthorized`, refreshes, succeeds.
  ws.tokens.clear();
  ws.dropAll();
  await new Promise<void>((resolve, reject) => {
    const t0 = Date.now();
    const tick = (): void => {
      if (ws.helloCount === 2) return resolve();
      if (Date.now() - t0 > 3000) return reject(new Error('no re-auth'));
      setTimeout(tick, 5);
    };
    tick();
  });
  assert.equal(hub.issued.length, 2);
  assert.equal(client.getConnection().state, 'open');
  const hellos = ws.requests.filter((r) => r.method === 'hello').map((r) => (r.params as { token?: string }).token);
  assert.deepEqual(hellos, [hub.issued[0], hub.issued[0], hub.issued[1]]);
});

test('a revoked device fails fatally instead of retrying forever', async (t) => {
  const hub = await setup(t);
  const ws = await FakeServer.start();
  const store = memoryIdentityStore();
  const creds = await pairWithHub({ hubUrl: hub.url, code: 'SETUP123', name: 'phone', store });
  const dev = hub.devices.get(creds.deviceId);
  if (dev) dev.revoked = true;
  const client = new BizziClient({ backoff: { baseMs: 10, maxMs: 20 } });
  t.after(async () => {
    client.close();
    await ws.stop();
  });
  await assert.rejects(client.connect(ws.url, await hubTokenProvider(creds, { store })), (e: unknown) => e instanceof BizziError && e.code === 'unauthorized');
  assert.equal(client.getConnection().state, 'closed');
  assert.equal(ws.helloCount, 0);
});

test('native bridge store: PKCS8 in the secure store, a non-extractable key in memory, same identity after reload', async () => {
  const secure = new Map<string, string>();
  const native: BizziNative = {
    platform: 'ios',
    secureGet: async (k) => secure.get(k) ?? null,
    secureSet: async (k, v) => void secure.set(k, v),
    secureDelete: async (k) => void secure.delete(k),
    scanQr: async () => null,
  };
  const a = await loadOrCreateIdentity('hub#1', nativeIdentityStore(native));
  const stored = JSON.parse(secure.get('bizzi.deviceKey.hub#1') ?? '{}') as { pkcs8?: string; publicKey?: Ed25519PublicJwk };
  assert.ok(stored.pkcs8 && stored.pkcs8.length > 40);
  assert.deepEqual(stored.publicKey, a.publicKey);

  // A fresh store (app restart) loads the same key and signs verifiably.
  const fresh = nativeIdentityStore(native);
  const pair = await fresh.load('hub#1');
  assert.equal(pair?.privateKey.extractable, false);
  const b = await loadOrCreateIdentity('hub#1', fresh);
  const sig = await b.sign('hello');
  assert.equal(await verifySignature(a.publicKey, 'hello', base64UrlToBytes(sig) as Uint8Array<ArrayBuffer>), true);

  await fresh.delete('hub#1');
  assert.equal(secure.size, 0);
});
