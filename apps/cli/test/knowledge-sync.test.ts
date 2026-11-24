// Knowledge replication end to end (knowledge.md §9.4, spec §13 M3 exit criterion): a rule written on
// one machine reaches a Codex session on another through the hub, and edits made while a machine was
// offline replicate when it reconnects. In process: a real hub, two real nodes with the knowledge
// extension and the session-start injection the CLI wires, fake agents.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createNode, type BizziNode } from '@bizzi/core';
import { FakeAdapter } from '@bizzi/core/testing';
import { connectToHub, pairWithHub, requestToken, startHub, type HubCredential, type HubLink } from '@bizzi/hub';
import { PROTOCOL_VERSION, type ErrorObject, type Logger } from '@bizzi/protocol';
import { createKnowledgeExtension } from '@bizzi/services';
import WebSocket from 'ws';
import { createKnowledgeRuntime, type KnowledgeRuntime } from '../src/knowledge.ts';

const logger: Logger = { log() {}, child: () => logger };

function tempDir(): string {
  return mkdtempSync(join(os.tmpdir(), 'bizzi-ksync-'));
}

async function waitFor<T>(fn: () => T | undefined | false, what: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Minimal client-protocol connection to the hub. */
class Client {
  readonly #ws: WebSocket;
  readonly #pending = new Map<string, (m: { result?: unknown; error?: ErrorObject }) => void>();
  #n = 0;
  constructor(url: string) {
    this.#ws = new WebSocket(url);
    this.#ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (typeof msg.id === 'string') this.#pending.get(msg.id)?.(msg);
    });
  }
  async open(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#ws.once('open', () => resolve());
      this.#ws.once('error', reject);
    });
  }
  async call<T = any>(method: string, params: unknown = {}): Promise<T> {
    const id = String(++this.#n);
    const msg = await new Promise<{ result?: unknown; error?: ErrorObject }>((resolve) => {
      this.#pending.set(id, resolve);
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
    if (msg.error) throw new Error(`${method}: ${msg.error.message}`);
    return msg.result as T;
  }
  close(): void {
    this.#ws.close();
  }
}

interface Machine {
  node: BizziNode;
  runtime: KnowledgeRuntime;
  codex: FakeAdapter;
  link?: HubLink;
}

async function startMachine(dataDir: string, name: string): Promise<Machine> {
  const runtime = (await createKnowledgeRuntime(dataDir, logger))!;
  const codex = new FakeAdapter({ agent: 'codex' });
  const node = await createNode({
    dataDir,
    adapters: [new FakeAdapter(), codex],
    version: '0.0.0-test',
    machineName: name,
    logger,
    prepareStart: runtime.prepareStart,
    extensions: [createKnowledgeExtension({ store: (id) => runtime.store(id), harvest: false, pollMs: 0 })],
  });
  runtime.bindMachine(() => node.machine);
  return { node, runtime, codex };
}

test('a rule written on one machine reaches a Codex session on another; offline edits catch up', async (t) => {
  const dirs = { hub: tempDir(), a: tempDir(), b: tempDir(), ws: tempDir() };
  const hub = await startHub({ dataDir: dirs.hub, port: 0, version: '0.0.0-test', logger, onSetupCode: () => {} });
  const setup = readFileSync(hub.setupCodeFile, 'utf8').trim();
  const { credential: owner } = await pairWithHub({ hubUrl: hub.url, code: setup, kind: 'device', name: 'phone' });
  const client = new Client(hub.clientUrl);
  await client.open();
  const { token } = await requestToken({ hubUrl: hub.url, deviceId: owner.deviceId, privateKey: owner.privateKey });
  await client.call('hello', { protocol: PROTOCOL_VERSION, client: { name: 'test', version: '0' }, token });

  const a = await startMachine(dirs.a, 'laptop');
  const b = await startMachine(dirs.b, 'mini');
  const creds = new Map<Machine, HubCredential>();
  const linkUp = async (m: Machine) => {
    let cred = creds.get(m);
    if (!cred) {
      const { code } = await client.call<{ code: string }>('pairing.create', { kind: 'node', name: m.node.machine.name });
      cred = (await pairWithHub({ hubUrl: hub.url, code, kind: 'node', name: m.node.machine.name, machineId: m.node.machine.id })).credential;
      creds.set(m, cred);
    }
    m.link = connectToHub(m.node, { url: hub.nodeUrl, credentials: cred, minBackoffMs: 20, maxBackoffMs: 200, logger });
    await m.link.waitConnected(5000);
  };
  t.after(async () => {
    client.close();
    for (const m of [a, b]) {
      await m.link?.close();
      await m.node.close();
      m.runtime.close();
    }
    await hub.close();
    for (const d of Object.values(dirs)) rmSync(d, { recursive: true, force: true });
  });

  // A has a rule before either machine ever linked; B has a memory.
  const storeA = a.runtime.store(a.node.machine.id);
  const storeB = b.runtime.store(b.node.machine.id);
  await a.node.call('knowledge.add', { type: 'rule', title: 'No AI attribution', body: 'Never add AI attribution to commits.', scope: { level: 'global' } });
  await b.node.call('knowledge.add', { type: 'memory', title: 'Mini has Xcode', body: 'Xcode 27 lives on the mac mini.', scope: { level: 'global' } });
  await linkUp(a);
  await linkUp(b);
  await waitFor(() => storeB.list({ type: 'rule' }).length === 1, 'the rule on B');
  await waitFor(() => storeA.list({ type: 'memory' }).length === 1, 'the memory on A');

  // A rule added through the hub on A shows up in a Codex session started on B.
  await client.call('knowledge.add', {
    machineId: a.node.machine.id,
    type: 'rule',
    title: 'Use pnpm',
    body: 'Always use pnpm here, never npm.',
    scope: { level: 'global' },
  });
  await waitFor(() => storeB.list({ type: 'rule' }).length === 2, 'the second rule on B');
  const { workspace } = await client.call('workspace.create', { machineId: b.node.machine.id, path: dirs.ws, name: 'ws' });
  await client.call('session.create', { workspaceId: workspace.id, agent: 'codex' });
  const start = await waitFor(() => b.codex.starts[0], 'codex start on B');
  assert.match(start.systemPromptAppend ?? '', /Always use pnpm here, never npm\./);
  assert.match(start.systemPromptAppend ?? '', /Never add AI attribution to commits\./);

  // B goes offline. A forgets one rule; B edits the other locally. Both converge on reconnect.
  await b.link!.close();
  const pnpm = storeA.list({ type: 'rule' }).find((i) => i.title === 'Use pnpm')!;
  const attribution = storeB.list({ type: 'rule' }).find((i) => i.title === 'No AI attribution')!;
  await client.call('knowledge.forget', { machineId: a.node.machine.id, id: pnpm.id });
  await b.node.call('knowledge.update', { id: attribution.id, body: 'Never add AI attribution to commits or PRs.' });
  await linkUp(b);
  await waitFor(() => storeB.get(pnpm.id)?.status === 'deleted', 'the forget on B');
  // An edit supersedes: the new version and the superseded old one both replicate.
  const edited = await waitFor(
    () => storeA.list({ type: 'rule', status: 'active' }).find((i) => i.body === 'Never add AI attribution to commits or PRs.'),
    'the offline edit on A',
  );
  assert.deepEqual(edited.supersedes, [attribution.id]);
  await waitFor(() => storeA.get(attribution.id)?.status === 'superseded', 'the old version superseded on A');
  assert.equal(hub.relay.store.countKnowledge(), 4);
});
