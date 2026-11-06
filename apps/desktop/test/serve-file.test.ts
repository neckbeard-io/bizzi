import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { checkHealth, decideAttach, healthzUrl, isPidAlive, readServeFile } from '../src/core/serve-file.ts';

async function tempDir(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bizzi-desktop-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function healthServer(status: number): Promise<{ server: Server; port: number; auth: string[] }> {
  const auth: string[] = [];
  const server = createServer((req, res) => {
    auth.push(String(req.headers.authorization));
    res.writeHead(req.url === '/healthz' ? status : 404).end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: (server.address() as AddressInfo).port, auth };
}

const ready = (port: number, pid = process.pid) => ({ event: 'ready', url: `ws://127.0.0.1:${port}/ws`, token: 'secret', machineId: 'm', pid });

test('healthzUrl maps ws/wss to http/https /healthz', () => {
  assert.equal(healthzUrl('ws://127.0.0.1:7777/ws'), 'http://127.0.0.1:7777/healthz');
  assert.equal(healthzUrl('wss://bizzi.example.com/ws/node?x=1'), 'https://bizzi.example.com/healthz');
});

test('isPidAlive', () => {
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(2 ** 22 + 12345), false);
});

test('missing serve.json -> spawn', async (t) => {
  const dir = await tempDir(t);
  assert.deepEqual(await decideAttach(dir), { attach: false, reason: 'missing' });
});

test('malformed serve.json -> spawn', async (t) => {
  const dir = await tempDir(t);
  await writeFile(join(dir, 'serve.json'), '{"event":"ready"');
  assert.equal((await decideAttach(dir)).attach, false);
  assert.equal(((await decideAttach(dir)) as { reason: string }).reason, 'invalid');
  await writeFile(join(dir, 'serve.json'), JSON.stringify({ event: 'ready', url: 'ws://x/ws' }));
  assert.equal((await readServeFile(dir)).kind, 'invalid');
});

test('stale serve.json (dead pid) -> spawn, without probing health', async (t) => {
  const dir = await tempDir(t);
  await writeFile(join(dir, 'serve.json'), JSON.stringify(ready(1, 999_999)));
  let probed = false;
  const d = await decideAttach(dir, { isAlive: () => false, health: async () => ((probed = true), true) });
  assert.deepEqual(d, { attach: false, reason: 'dead-pid', detail: 'pid 999999' });
  assert.equal(probed, false);
});

test('live pid but /healthz failing -> spawn', async (t) => {
  const dir = await tempDir(t);
  const { server, port } = await healthServer(503);
  t.after(() => server.close());
  await writeFile(join(dir, 'serve.json'), JSON.stringify(ready(port)));
  const d = await decideAttach(dir);
  assert.equal(d.attach, false);
  assert.equal((d as { reason: string }).reason, 'unhealthy');
});

test('live pid but nothing listening -> spawn', async (t) => {
  const dir = await tempDir(t);
  const { server, port } = await healthServer(200);
  await new Promise((r) => server.close(r));
  await writeFile(join(dir, 'serve.json'), JSON.stringify(ready(port)));
  assert.equal((await decideAttach(dir, { timeoutMs: 500 })).attach, false);
});

test('live pid and healthy -> attach, sending the bearer token', async (t) => {
  const dir = await tempDir(t);
  const { server, port, auth } = await healthServer(200);
  t.after(() => server.close());
  await writeFile(join(dir, 'serve.json'), JSON.stringify(ready(port)));
  const d = await decideAttach(dir);
  assert.deepEqual(d, { attach: true, ready: ready(port) });
  assert.deepEqual(auth, ['Bearer secret']);
});

test('checkHealth times out on a server that never answers', async (t) => {
  const server = createServer(() => {});
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const port = (server.address() as AddressInfo).port;
  const started = Date.now();
  assert.equal(await checkHealth(ready(port) as never, 100), false);
  assert.ok(Date.now() - started < 2000);
});
