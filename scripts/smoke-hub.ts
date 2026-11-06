// Hub end-to-end smoke test, the path a phone takes:
//   hub (bizzi hub serve) ← node dials out (bizzi serve --connect, paired with a code)
//   device pairs with the setup code → token → client protocol through the hub → session on the node.
// Then the node goes away: requests fail with machine_offline while history replay still works.
//
//   node scripts/smoke-hub.ts            # fake adapter, free
//   node scripts/smoke-hub.ts claude haiku   # real Claude session through the hub (a fraction of a cent)

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pairWithHub, requestToken } from '@bizzi/hub';

const agent = process.argv[2] ?? 'fake';
const model = process.argv[3];
const root = mkdtempSync(join(tmpdir(), 'bizzi-hubsmoke-'));
const procs: ChildProcess[] = [];

function start(args: string[], env: Record<string, string> = {}): Promise<{ proc: ChildProcess; ready: any }> {
  const proc = spawn(process.execPath, ['apps/cli/src/main.ts', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, BIZZI_LOG_LEVEL: 'warn', ...env },
  });
  procs.push(proc);
  proc.stderr!.on('data', (d) => {
    const s = String(d);
    if (/"level":"(error|warn)"/.test(s)) process.stderr.write(`  [${args[0]}] ${s}`);
  });
  return new Promise((resolve, reject) => {
    createInterface({ input: proc.stdout! }).once('line', (l) => resolve({ proc, ready: JSON.parse(l) }));
    proc.once('exit', (c) => reject(new Error(`${args.join(' ')} exited ${c}`)));
  });
}

class Client {
  #ws: WebSocket;
  #id = 0;
  #pending = new Map<string, (m: any) => void>();
  listeners: ((e: any) => void)[] = [];
  constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data));
      if (msg.id && this.#pending.has(msg.id)) {
        this.#pending.get(msg.id)!(msg);
        this.#pending.delete(msg.id);
      } else if (msg.ch) for (const l of this.listeners) l(msg);
    };
  }
  static async open(url: string): Promise<Client> {
    const ws = new WebSocket(url);
    await new Promise((r, j) => {
      ws.onopen = r;
      ws.onerror = j;
    });
    return new Client(ws);
  }
  call(method: string, params: unknown): Promise<any> {
    const id = `r_${++this.#id}`;
    this.#ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) =>
      this.#pending.set(id, (m) => (m.error ? reject(Object.assign(new Error(`${method}: ${m.error.message}`), { code: m.error.code })) : resolve(m.result))),
    );
  }
  close() {
    this.#ws.close();
  }
}

const step = (s: string) => console.log(`• ${s}`);
let ok = false;
try {
  const hub = await start(['hub', 'serve', '--host', '127.0.0.1', '--port', '0', '--data-dir', join(root, 'hub')]);
  const hubUrl: string = hub.ready.url;
  step(`hub up at ${hubUrl}`);

  // Device: pair with the setup code, get a token, connect.
  const setupCode = readFileSync(join(root, 'hub', 'setup-code'), 'utf8').trim();
  const device = await pairWithHub({ hubUrl, code: setupCode, kind: 'device', name: 'smoke-phone' });
  step(`device paired (owner=${device.response.owner})`);
  const deviceToken = async () =>
    (await requestToken({ hubUrl, deviceId: device.credential.deviceId, privateKey: device.credential.privateKey })).token;
  const client = await Client.open(device.response.clientUrl);
  const hello = await client.call('hello', { protocol: 'bizzi/1', client: { name: 'smoke', version: '0' }, token: await deviceToken() });
  step(`hello role=${hello.role}`);

  // Node: pairing code from the device, then `bizzi serve --connect` pairs itself on first start.
  const { code } = await client.call('pairing.create', { kind: 'node', name: 'smoke-node' });
  const nodeArgs = ['serve', '--port', '0', '--data-dir', join(root, 'node'), '--name', 'smoke-node', '--connect', device.response.nodeUrl];
  if (agent === 'fake') nodeArgs.push('--fake');
  const node = await start(nodeArgs, { BIZZI_PAIR_CODE: code });
  const machineId: string = node.ready.machineId;
  for (let i = 0; i < 50; i++) {
    const { machines } = await client.call('machines.list', {});
    if (machines.some((m: any) => m.id === machineId && m.online)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  step(`node ${machineId} online through the hub`);

  // Session on the node, driven through the hub.
  const { workspace } = await client.call('workspace.create', { machineId, path: join(root, 'ws'), create: true, name: 'smoke' });
  const { session } = await client.call('session.create', { workspaceId: workspace.id, agent: agent === 'fake' ? 'claude' : agent, ...(model ? { model } : {}) });
  const ch = `session:${session.id}`;
  const done = new Promise<any>((resolve) =>
    client.listeners.push((e) => {
      if (e.ch !== ch) return;
      if (e.type === 'approval.requested') void client.call('approval.respond', { sessionId: session.id, approvalId: e.data.approvalId, decision: 'allow' });
      if (e.type === 'message.completed') console.log(`  assistant: ${String(e.data.text).slice(0, 120)}`);
      if (e.type === 'turn.completed') resolve(e.data);
    }),
  );
  await client.call('subscribe', { ch, since: 0 });
  await client.call('session.send', { sessionId: session.id, input: [{ type: 'text', text: 'Reply with the single word pong.' }] });
  const turn = await Promise.race([done, new Promise((_, j) => setTimeout(() => j(new Error('turn timed out')), 180_000))]);
  step(`turn completed through the hub: ${(turn as any).stopReason}`);

  // Node goes away.
  node.proc.kill('SIGTERM');
  await new Promise((r) => node.proc.once('exit', r));
  await new Promise((r) => setTimeout(r, 500));
  let offlineCode = '';
  try {
    await client.call('session.send', { sessionId: session.id, input: [{ type: 'text', text: 'again' }] });
  } catch (err) {
    offlineCode = (err as any).code;
  }
  step(`request to offline node → ${offlineCode || 'no error!'}`);

  // A fresh device connection can still replay the history from the hub.
  const late = await Client.open(device.response.clientUrl);
  await late.call('hello', { protocol: 'bizzi/1', client: { name: 'smoke-late', version: '0' }, token: await deviceToken() });
  const replayed: string[] = [];
  late.listeners.push((e) => e.ch === ch && replayed.push(e.type));
  await late.call('subscribe', { ch, since: 0 });
  await new Promise((r) => setTimeout(r, 500));
  step(`replayed ${replayed.length} events from the hub while the node is offline (turn.completed: ${replayed.includes('turn.completed')})`);
  late.close();
  client.close();

  ok = (turn as any).stopReason === 'end_turn' && offlineCode === 'machine_offline' && replayed.includes('turn.completed');
} catch (err) {
  console.error(err);
} finally {
  for (const p of procs) if (p.exitCode === null) p.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 500));
  rmSync(root, { recursive: true, force: true });
}
console.log(ok ? 'HUB SMOKE OK' : 'HUB SMOKE FAILED');
process.exit(ok ? 0 : 1);
