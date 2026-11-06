import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROTOCOL_VERSION, sessionChannel, type ChannelEvent, type ResponseMsg } from '@bizzi/protocol';
import WebSocket from 'ws';
import { startServer, type BizziNode, type BizziServer } from '../src/index.ts';
import { makeNode, tempDir, waitFor } from './helpers.ts';

const TOKEN = 'test-token-123';

async function setup(t: { after: (fn: () => unknown) => void }, serverOpts: { maxBufferedBytes?: number } = {}) {
  const dir = tempDir();
  const node = await makeNode(dir.path);
  const server = await startServer(node, { host: '127.0.0.1', port: 0, token: TOKEN, ...serverOpts });
  t.after(async () => {
    await server.close();
    await node.close();
    dir.cleanup();
  });
  return { node, server, dir };
}

/** Minimal test client. */
class Client {
  readonly ws: WebSocket;
  readonly events: ChannelEvent[] = [];
  readonly #pending = new Map<string, (m: ResponseMsg) => void>();
  #n = 0;
  closeCode?: number;
  readonly closed: Promise<number>;
  readonly opened: Promise<void>;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
    this.closed = new Promise((resolve) => this.ws.once('close', (code) => resolve((this.closeCode = code))));
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if ('ch' in msg) this.events.push(msg);
      else this.#pending.get(msg.id)?.(msg), this.#pending.delete(msg.id);
    });
  }

  async request(method: string, params: unknown = {}): Promise<ResponseMsg> {
    await this.opened;
    const id = `r_${++this.#n}`;
    return new Promise((resolve) => {
      this.#pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async call<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    const res = await this.request(method, params);
    if ('error' in res) throw Object.assign(new Error(res.error.message), { code: res.error.code });
    return res.result as T;
  }

  hello(token = TOKEN) {
    return this.request('hello', { protocol: PROTOCOL_VERSION, client: { name: 'test', version: '0' }, token });
  }

  close() {
    this.ws.close();
  }
}

async function connect(server: BizziServer): Promise<Client> {
  const c = new Client(server.url);
  const res = await c.hello();
  assert.ok('result' in res, JSON.stringify(res));
  return c;
}

test('healthz and unknown paths', async (t) => {
  const { server } = await setup(t);
  const base = server.url.replace('ws://', 'http://').replace('/ws', '');
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; protocol: string };
  assert.equal(body.ok, true);
  assert.equal(body.protocol, PROTOCOL_VERSION);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  const bad = new WebSocket(server.url.replace('/ws', '/other'));
  await new Promise<void>((resolve) => bad.once('error', () => resolve()));
});

test('auth: wrong token, wrong protocol and non-hello first messages are rejected with 4401', async (t) => {
  const { server } = await setup(t);

  const c1 = new Client(server.url);
  const r1 = await c1.hello('wrong');
  assert.ok('error' in r1 && r1.error.code === 'unauthorized');
  assert.equal(await c1.closed, 4401);

  const c2 = new Client(server.url);
  const r2 = await c2.request('hello', { protocol: 'bizzi/0', client: { name: 't', version: '0' }, token: TOKEN });
  assert.ok('error' in r2 && r2.error.code === 'unauthorized');
  assert.equal(await c2.closed, 4401);

  const c3 = new Client(server.url);
  const r3 = await c3.request('machines.list');
  assert.ok('error' in r3 && r3.error.code === 'unauthorized');
  assert.equal(await c3.closed, 4401);

  const c4 = new Client(server.url);
  await c4.opened;
  c4.ws.send('garbage');
  assert.equal(await c4.closed, 4401);

  const c5 = new Client(server.url);
  const r5 = await c5.request('hello', { protocol: PROTOCOL_VERSION, client: { name: 't', version: '0' } });
  assert.ok('error' in r5 && r5.error.code === 'unauthorized');
  assert.equal(await c5.closed, 4401);
});

test('hello, requests and error mapping', async (t) => {
  const { server, node, dir } = await setup(t);
  const c = new Client(server.url);
  t.after(() => c.close());
  const hello = await c.hello();
  assert.ok('result' in hello);
  const result = hello.result as { protocol: string; machine: { id: string }; role?: string };
  assert.equal(result.protocol, PROTOCOL_VERSION);
  assert.equal(result.role, 'node');
  assert.equal(result.machine.id, node.machine.id);

  const { workspace } = await c.call<{ workspace: { id: string } }>('workspace.create', { path: dir.path + '/w', create: true });
  const { workspaces } = await c.call<{ workspaces: unknown[] }>('workspaces.list');
  assert.equal(workspaces.length, 1);
  assert.ok(workspace.id);

  const notFound = await c.request('session.get', { sessionId: 's_x' });
  assert.ok('error' in notFound && notFound.error.code === 'not_found');
  const unknown = await c.request('does.not.exist');
  assert.ok('error' in unknown && unknown.error.code === 'unsupported');
  const badSub = await c.request('subscribe', { ch: 'nope' });
  assert.ok('error' in badSub && badSub.error.code === 'bad_request');
  c.ws.send('{"not":"a request"}');
  await c.call('machines.list'); // connection still usable
});

test('subscribe replays history while live events flow, with no gaps or duplicates', async (t) => {
  const { server, node, dir } = await setup(t);
  const c0 = await connect(server);
  t.after(() => c0.close());
  const { workspace } = await c0.call<{ workspace: { id: string } }>('workspace.create', { path: dir.path + '/w', create: true });
  const { session } = await c0.call<{ session: { id: string } }>('session.create', { workspaceId: workspace.id, agent: 'claude' });
  const ch = sessionChannel(session.id);
  await waitFor(() => node.sessions.get(session.id).session.status === 'idle');

  // Producer: append synthetic events continuously from timers (interleaving with socket I/O).
  const TOTAL = 3000;
  let produced = 0;
  const producing = new Promise<void>((resolve) => {
    const tick = () => {
      for (let i = 0; i < 25 && produced < TOTAL; i++, produced++) {
        node.bus.append(ch, { type: 'agent.raw', data: { agent: 'claude', payload: { n: produced } } });
      }
      if (produced < TOTAL) setImmediate(tick);
      else resolve();
    };
    tick();
  });

  // Subscribers join at different points in the stream, with different cursors.
  const clients: { c: Client; since: number }[] = [];
  for (const since of [0, 5, 0]) {
    await waitFor(() => produced > clients.length * 700 + 300);
    const c = await connect(server);
    t.after(() => c.close());
    const res = await c.call<{ ch: string; lastSeq: number }>('subscribe', { ch, since });
    assert.equal(res.ch, ch);
    assert.ok(res.lastSeq >= since);
    clients.push({ c, since });
  }
  await producing;
  const last = node.bus.lastSeq(ch);
  for (const { c, since } of clients) {
    await waitFor(() => c.events.at(-1)?.seq === last, 10_000, `client since=${since} to reach ${last}`);
    const seqs = c.events.map((e) => e.seq);
    assert.deepEqual(seqs, Array.from({ length: last - since }, (_, i) => since + i + 1));
    assert.ok(c.events.every((e) => e.ch === ch && typeof e.ts === 'string'));
  }

  // unsubscribe stops delivery
  const { c } = clients[0]!;
  await c.call('unsubscribe', { ch });
  const count = c.events.length;
  node.bus.append(ch, { type: 'agent.raw', data: { agent: 'claude', payload: 'after' } });
  await c.call('machines.list');
  assert.equal(c.events.length, count);
});

test('global channel and session events over the wire, including an approval round-trip', async (t) => {
  const { server, dir } = await setup(t);
  const c = await connect(server);
  t.after(() => c.close());
  await c.call('subscribe', { ch: 'global' });
  const { workspace } = await c.call<{ workspace: { id: string } }>('workspace.create', { path: dir.path + '/w', create: true });
  const { session } = await c.call<{ session: { id: string } }>('session.create', { workspaceId: workspace.id, agent: 'claude' });
  await waitFor(() => c.events.some((e) => e.type === 'session.updated' && e.data.session.status === 'idle'));
  await c.call('subscribe', { ch: sessionChannel(session.id) });
  await c.call('session.send', { sessionId: session.id, input: [{ type: 'text', text: '/approve ls' }] });
  const req = await waitFor(() => c.events.find((e) => e.type === 'approval.requested'));
  assert.equal(req.type, 'approval.requested');
  if (req.type !== 'approval.requested') return;
  await c.call('approval.respond', { sessionId: session.id, approvalId: req.data.approvalId, decision: 'allow' });
  await waitFor(() => c.events.find((e) => e.type === 'turn.completed'));
  assert.ok(c.events.some((e) => e.type === 'workspace.created'));
  assert.ok(c.events.some((e) => e.type === 'session.created'));
});

test('slow consumers exceeding the buffer limit are disconnected', async (t) => {
  const { server, node } = await setup(t, { maxBufferedBytes: 64 * 1024 });
  const c = await connect(server);
  // Stop reading from the socket so the server-side buffer grows.
  await c.call('subscribe', { ch: 'global' });
  const sock = (c.ws as unknown as { _socket: { pause(): void } })._socket;
  sock.pause();
  const big = 'x'.repeat(64 * 1024);
  for (let i = 0; i < 200 && server.connections > 0; i++) {
    node.bus.append('global', { type: 'install.progress', data: { agent: 'claude', stage: big } });
    await new Promise((r) => setImmediate(r));
  }
  await waitFor(() => server.connections === 0, 5000, 'slow connection to be closed');
});
