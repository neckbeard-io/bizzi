import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { BizziError, sessionChannel } from '@bizzi/protocol';
import type { ChannelEvent } from '@bizzi/protocol';
import { BizziClient, backoffDelay } from '../src/index.ts';
import type { ConnectionState, GapInfo } from '../src/index.ts';
import { FakeServer, MACHINE, waitFor } from './fake-server.ts';

const fastBackoff = { baseMs: 10, maxMs: 50, factor: 2, jitter: 0.5 };

async function setup(t: TestContext): Promise<{ server: FakeServer; client: BizziClient }> {
  const server = await FakeServer.start();
  const client = new BizziClient({ backoff: fastBackoff, requestTimeoutMs: 1000, gapTimeoutMs: 200 });
  t.after(async () => {
    client.close();
    await server.stop();
  });
  return { server, client };
}

test('backoff grows exponentially, is capped and jittered', () => {
  const opts = { baseMs: 100, maxMs: 1000, factor: 2, jitter: 0.5 };
  assert.equal(backoffDelay(0, opts, () => 1), 100);
  assert.equal(backoffDelay(0, opts, () => 0), 50);
  assert.equal(backoffDelay(3, opts, () => 1), 800);
  assert.equal(backoffDelay(10, opts, () => 1), 1000);
  assert.equal(backoffDelay(10, opts, () => 0), 500);
});

test('handshake: hello with token, connection state and machine', async (t) => {
  const ctx = await setup(t);
  const states: ConnectionState[] = [];
  ctx.client.onConnection((c) => states.push(c.state));
  const hello = await ctx.client.connect(ctx.server.url, 'secret');
  assert.equal(hello.machine.id, MACHINE.id);
  assert.equal(ctx.client.getConnection().state, 'open');
  assert.equal(ctx.client.getConnection().machine?.id, MACHINE.id);
  assert.deepEqual(states, ['connecting', 'open']);
  const helloReq = ctx.server.requests.find((r) => r.method === 'hello');
  assert.equal((helloReq?.params as { protocol: string }).protocol, 'bizzi/1');
});

test('handshake: a bad token is fatal (no reconnect loop)', async (t) => {
  const ctx = await setup(t);
  await assert.rejects(ctx.client.connect(ctx.server.url, 'wrong'), (e: unknown) => e instanceof BizziError && e.code === 'unauthorized');
  assert.equal(ctx.client.getConnection().state, 'closed');
  assert.equal(ctx.client.getConnection().lastError?.code, 'unauthorized');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(ctx.server.requests.filter((r) => r.method === 'hello').length, 1);
});

test('request/response, error responses and timeouts', async (t) => {
  const ctx = await setup(t);
  ctx.server.handlers.set('workspaces.list', () => ({
    workspaces: [{ id: 'w_1', machineId: 'm_1', name: 'acme', path: '/src/acme', kind: 'git', createdAt: 'x' }],
  }));
  await ctx.client.connect(ctx.server.url, 'secret');
  const res = await ctx.client.request('workspaces.list', {});
  assert.equal(res.workspaces[0]?.name, 'acme');

  await assert.rejects(
    ctx.client.request('git.diff', { workspaceId: 'w_1' }),
    (e: unknown) => e instanceof BizziError && e.code === 'unsupported',
  );

  ctx.server.blackhole.add('session.stop');
  await assert.rejects(
    ctx.client.request('session.stop', { sessionId: 's_1' }, { timeoutMs: 50 }),
    (e: unknown) => e instanceof BizziError && /timed out/.test(e.message),
  );
});

test('requests made while reconnecting are sent after the handshake', async (t) => {
  const ctx = await setup(t);
  await ctx.client.connect(ctx.server.url, 'secret');
  ctx.server.dropAll();
  await waitFor(() => ctx.client.getConnection().state === 'reconnecting');
  const res = await ctx.client.request('machines.list', {});
  assert.equal(res.machines.length, 1);
  assert.equal(ctx.server.helloCount, 2);
});

test('reconnect re-hellos and re-subscribes with since = last seq; replay has no duplicates', async (t) => {
  const ctx = await setup(t);
  const ch = sessionChannel('s_1');
  const got: ChannelEvent[] = [];
  ctx.client.onEvent((ev) => got.push(ev));
  await ctx.client.connect(ctx.server.url, 'secret');
  await ctx.client.subscribe(ch);
  for (let i = 0; i < 3; i++) ctx.server.push(ch, { type: 'message.delta', data: { messageId: 'msg_1', role: 'assistant', text: `${i}` } });
  await waitFor(() => got.length === 3);

  ctx.server.dropAll();
  // Events produced while the client is away.
  ctx.server.push(ch, { type: 'message.delta', data: { messageId: 'msg_1', role: 'assistant', text: '3' } });
  ctx.server.push(ch, { type: 'message.completed', data: { messageId: 'msg_1', role: 'assistant', text: '0123' } });
  // A sloppy server replays a little before the cursor; the client must drop those.
  ctx.server.replayOverlap = 2;

  await waitFor(() => got.length === 5);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(got.map((e) => e.seq), [1, 2, 3, 4, 5]);
  assert.equal(ctx.server.helloCount, 2);
  const resub = ctx.server.requests.filter((r) => r.method === 'subscribe' && (r.params as { ch: string }).ch === ch);
  assert.deepEqual(resub.map((r) => (r.params as { since: number }).since), [0, 3]);
  assert.ok(ctx.client.stats.duplicates >= 2);
  assert.equal(ctx.client.getConnection().sessions, 2);
});

test('gap detection: holds out-of-order events, re-subscribes, and delivers in order', async (t) => {
  const ctx = await setup(t);
  const ch = sessionChannel('s_2');
  const got: number[] = [];
  const gaps: GapInfo[] = [];
  ctx.client.onEvent((ev) => got.push(ev.seq));
  ctx.client.onGap((g) => gaps.push(g));
  await ctx.client.connect(ctx.server.url, 'secret');
  await ctx.client.subscribe(ch);
  ctx.server.push(ch, { type: 'usage.updated', data: { inputTokens: 1 } });
  await waitFor(() => got.length === 1);
  // seq 2 exists in the log but is not sent live; seq 3 is.
  ctx.server.push(ch, { type: 'usage.updated', data: { inputTokens: 2 } }, { send: false });
  ctx.server.push(ch, { type: 'usage.updated', data: { inputTokens: 3 } });
  await waitFor(() => got.length === 3);
  assert.deepEqual(got, [1, 2, 3]);
  assert.equal(gaps.length, 1);
  assert.deepEqual({ from: gaps[0]?.from, to: gaps[0]?.to, state: gaps[0]?.state }, { from: 2, to: 2, state: 'detected' });
});

test('gap that never fills is skipped after gapTimeoutMs', async (t) => {
  const ctx = await setup(t);
  const ch = sessionChannel('s_3');
  const got: number[] = [];
  const gaps: GapInfo[] = [];
  ctx.client.onEvent((ev) => got.push(ev.seq));
  ctx.client.onGap((g) => gaps.push(g));
  await ctx.client.connect(ctx.server.url, 'secret');
  await ctx.client.subscribe(ch);
  ctx.server.push(ch, { type: 'usage.updated', data: {} });
  ctx.server.push(ch, { type: 'usage.updated', data: {} }, { seq: 5 });
  await waitFor(() => got.length === 2, 2000);
  assert.deepEqual(got, [1, 5]);
  assert.deepEqual(gaps.map((g) => g.state), ['detected', 'skipped']);
});

test('close() stops reconnecting and rejects pending requests', async (t) => {
  const ctx = await setup(t);
  await ctx.client.connect(ctx.server.url, 'secret');
  ctx.server.blackhole.add('agents.list');
  const p = ctx.client.request('agents.list', {});
  ctx.client.close();
  await assert.rejects(p, (e: unknown) => e instanceof BizziError);
  assert.equal(ctx.client.getConnection().state, 'closed');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(ctx.server.helloCount, 1);
});
