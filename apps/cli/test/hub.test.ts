import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pairWithHub, requestToken } from '@bizzi/hub';
import { PROTOCOL_VERSION, type MachineInfo } from '@bizzi/protocol';
import WebSocket from 'ws';

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));

function tempDir() {
  const path = mkdtempSync(join(os.tmpdir(), 'bizzi-cli-hub-'));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

interface Proc {
  child: ChildProcess;
  first: Record<string, unknown>;
  stderr: () => string;
  stop: () => Promise<void>;
}

/** Spawn the CLI and wait for its first stdout JSON line. */
async function spawnCli(args: string[], env: Record<string, string> = {}): Promise<Proc> {
  const child = spawn(process.execPath, [MAIN, ...args], {
    env: {
      ...process.env,
      BIZZI_HUB_URL: '',
      BIZZI_PAIR_CODE: '',
      BIZZI_PUBLIC_URL: '',
      BIZZI_NTFY_URL: '',
      // Keep widget files out of the real ~/.config.
      BIZZI_WIDGETS_DIR: join(args[args.indexOf('--data-dir') + 1] ?? os.tmpdir(), 'widgets'),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout!.setEncoding('utf8').on('data', (d: string) => (out += d));
  child.stderr!.setEncoding('utf8').on('data', (d: string) => (err += d));
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const line = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no ready line; stderr:\n${err}`)), 15_000);
    const check = () => {
      const nl = out.indexOf('\n');
      if (nl >= 0) {
        clearTimeout(t);
        resolve(out.slice(0, nl));
      }
    };
    child.stdout!.on('data', check);
    child.once('exit', () => reject(new Error(`exited early; stderr:\n${err}`)));
  });
  return {
    child,
    first: JSON.parse(line) as Record<string, unknown>,
    stderr: () => err,
    stop: async () => {
      if (child.exitCode === null) child.kill('SIGTERM');
      await exited;
    },
  };
}

function run(args: string[], env: Record<string, string> = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) =>
    execFile(process.execPath, [MAIN, ...args], { env: { ...process.env, ...env } }, (err, stdout, stderr) =>
      err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve({ stdout, stderr }),
    ),
  );
}

async function hubCall<T>(clientUrl: string, token: string, method: string, params: unknown = {}): Promise<T> {
  const ws = new WebSocket(clientUrl);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const call = (id: string, m: string, p: unknown) =>
    new Promise<{ result?: unknown; error?: { message: string } }>((resolve) => {
      const onMsg = (raw: WebSocket.RawData) => {
        const msg = JSON.parse(raw.toString());
        if (msg.id === id) {
          ws.off('message', onMsg);
          resolve(msg);
        }
      };
      ws.on('message', onMsg);
      ws.send(JSON.stringify({ id, method: m, params: p }));
    });
  try {
    const hello = await call('1', 'hello', { protocol: PROTOCOL_VERSION, client: { name: 't', version: '0' }, token });
    if (hello.error) throw new Error(hello.error.message);
    const res = await call('2', method, params);
    if (res.error) throw new Error(res.error.message);
    return res.result as T;
  } finally {
    ws.close();
  }
}

async function waitFor<T>(fn: () => Promise<T | undefined | false>, timeoutMs = 15_000, what = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('hub serve, hub code, pair, serve --connect, and env auto-pairing', async (t) => {
  const hubDir = tempDir();
  const nodeDir1 = tempDir();
  const nodeDir2 = tempDir();
  const procs: Proc[] = [];
  t.after(async () => {
    for (const p of procs) await p.stop();
    hubDir.cleanup();
    nodeDir1.cleanup();
    nodeDir2.cleanup();
  });

  // Hub with a setup code.
  const hub = await spawnCli(['hub', 'serve', '--host', '127.0.0.1', '--port', '0', '--data-dir', hubDir.path]);
  procs.push(hub);
  assert.equal(hub.first.event, 'hub-ready');
  const hubUrl = hub.first.url as string;
  const clientUrl = hub.first.clientUrl as string;
  const nodeUrl = hub.first.nodeUrl as string;
  assert.match(nodeUrl, /^ws:\/\/127\.0\.0\.1:\d+\/ws\/node$/);
  const setup = readFileSync(join(hubDir.path, 'setup-code'), 'utf8').trim();
  await waitFor(async () => hub.stderr().includes(`Setup code: ${setup}`), 5000, 'setup code banner');

  // Owner device.
  const { credential: owner } = await pairWithHub({ hubUrl, code: setup, kind: 'device', name: 'phone' });
  const ownerToken = async () => (await requestToken({ hubUrl, deviceId: owner.deviceId, privateKey: owner.privateKey })).token;

  // `bizzi hub code` mints a node code locally; `bizzi pair` uses it.
  const minted = JSON.parse((await run(['hub', 'code', '--kind', 'node', '--data-dir', hubDir.path, '--json'])).stdout) as { code: string };
  const paired = await run(['pair', hubUrl, minted.code, '--data-dir', nodeDir1.path, '--name', 'node-one']);
  assert.match(paired.stdout, /credential saved to/);
  const credFile = join(nodeDir1.path, 'hub-credential.json');
  assert.equal(statSync(credFile).mode & 0o777, 0o600);
  const cred1 = JSON.parse(readFileSync(credFile, 'utf8')) as { machineId: string; hubUrl: string };
  assert.equal(cred1.hubUrl, nodeUrl);
  // Pairing again without --force is refused.
  await assert.rejects(run(['pair', hubUrl, 'XXXX-XXXX', '--data-dir', nodeDir1.path]), /already paired/);

  // serve --connect: same machine id as the pairing, and the hub sees it online.
  const node1 = await spawnCli(['serve', '--fake', '--port', '0', '--data-dir', nodeDir1.path, '--name', 'node-one', '--connect', nodeUrl], {
    BIZZI_TOKEN: 'tok-1',
  });
  procs.push(node1);
  assert.equal(node1.first.machineId, cred1.machineId);
  await waitFor(
    async () => {
      const { machines } = await hubCall<{ machines: MachineInfo[] }>(clientUrl, await ownerToken(), 'machines.list');
      return machines.some((m) => m.id === cred1.machineId && m.online);
    },
    15_000,
    'node-one online',
  );

  // Auto-pairing from env on first start (no credential yet).
  const { code } = await hubCall<{ code: string }>(clientUrl, await ownerToken(), 'pairing.create', { kind: 'node' });
  const node2 = await spawnCli(['serve', '--fake', '--port', '0', '--data-dir', nodeDir2.path, '--name', 'node-two'], {
    BIZZI_TOKEN: 'tok-2',
    BIZZI_HUB_URL: hubUrl,
    BIZZI_PAIR_CODE: code,
  });
  procs.push(node2);
  await waitFor(
    async () => {
      const { machines } = await hubCall<{ machines: MachineInfo[] }>(clientUrl, await ownerToken(), 'machines.list');
      return machines.some((m) => m.id === node2.first.machineId && m.online && m.name === 'node-two');
    },
    15_000,
    'node-two online',
  );
  assert.ok(existsSync(join(nodeDir2.path, 'hub-credential.json')));

  // Node shutdown marks the machine offline.
  await node2.stop();
  await waitFor(
    async () => {
      const { machines } = await hubCall<{ machines: MachineInfo[] }>(clientUrl, await ownerToken(), 'machines.list');
      return machines.some((m) => m.id === node2.first.machineId && !m.online);
    },
    15_000,
    'node-two offline',
  );
});
