// Cross-machine work through the hub (spec §5.4, §12.4, topology.md §6), end to end in process: a real
// hub, two real nodes with fake agents and the bizzi-agents tools, node → hub requests, a helper started
// on the other machine, and forks of a git repository and of a plain directory onto it.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createNode, type BizziNode } from '@bizzi/core';
import { FakeAdapter } from '@bizzi/core/testing';
import { connectToHub, pairWithHub, requestToken, startHub, type BizziHub, type HubCredential, type HubLink } from '@bizzi/hub';
import { createOrchestrationExtension } from '@bizzi/orchestration';
import {
  BizziError,
  PROTOCOL_VERSION,
  sessionChannel,
  type ErrorObject,
  type ForkTransfer,
  type Logger,
  type SessionInfo,
  type WorkspaceInfo,
} from '@bizzi/protocol';
import WebSocket from 'ws';

const logger: Logger = { log() {}, child: () => logger };
const CODEX_MODES = ['read-only', 'untrusted', 'auto', 'full-access'];

function tempDir(prefix = 'bizzi-xm-'): string {
  return mkdtempSync(join(os.tmpdir(), prefix));
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

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

async function rejectsWith(p: Promise<unknown>, code: string, re?: RegExp): Promise<BizziError> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof BizziError, `expected a BizziError, got ${String(err)}`);
    assert.equal(err.code, code, err.message);
    if (re) assert.match(err.message, re);
    return err;
  }
  assert.fail(`expected ${code}`);
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
    if (msg.error) throw new BizziError(msg.error.code, msg.error.message, msg.error.data);
    return msg.result as T;
  }
  close(): void {
    this.#ws.close();
  }
}

interface Machine {
  name: string;
  dir: string;
  node: BizziNode;
  claude: FakeAdapter;
  codex: FakeAdapter;
  link?: HubLink;
  cred?: HubCredential;
}

interface World {
  hub: BizziHub;
  client: Client;
  a: Machine;
  b: Machine;
  dirs: string[];
  linkUp(m: Machine): Promise<void>;
}

async function world(t: TestContext): Promise<World> {
  const dirs: string[] = [];
  const mk = (p?: string) => {
    const d = tempDir(p);
    dirs.push(d);
    return d;
  };
  const hubDir = mk();
  const hub = await startHub({ dataDir: hubDir, port: 0, version: '0.0.0-test', logger, onSetupCode: () => {}, requestTimeoutMs: 10_000 });
  const setup = readFileSync(hub.setupCodeFile, 'utf8').trim();
  const { credential: owner } = await pairWithHub({ hubUrl: hub.url, code: setup, kind: 'device', name: 'phone' });
  const client = new Client(hub.clientUrl);
  await client.open();
  const { token } = await requestToken({ hubUrl: hub.url, deviceId: owner.deviceId, privateKey: owner.privateKey });
  await client.call('hello', { protocol: PROTOCOL_VERSION, client: { name: 'test', version: '0' }, token });

  const machine = async (name: string): Promise<Machine> => {
    const dir = mk();
    const claude = new FakeAdapter();
    const codex = new FakeAdapter({ agent: 'codex', capabilities: { permissionModes: CODEX_MODES } });
    const node = await createNode({
      dataDir: dir,
      adapters: [claude, codex],
      version: '0.0.0-test',
      machineName: name,
      logger,
      interruptGraceMs: 200,
      extensions: [createOrchestrationExtension()],
    });
    return { name, dir, node, claude, codex };
  };
  const a = await machine('laptop');
  const b = await machine('mini');
  const linkUp = async (m: Machine) => {
    if (!m.cred) {
      const { code } = await client.call<{ code: string }>('pairing.create', { kind: 'node', name: m.name });
      m.cred = (await pairWithHub({ hubUrl: hub.url, code, kind: 'node', name: m.name, machineId: m.node.machine.id })).credential;
    }
    m.link = connectToHub(m.node, { url: hub.nodeUrl, credentials: m.cred, minBackoffMs: 20, maxBackoffMs: 200, logger });
    await m.link.waitConnected(5000);
    await waitFor(() => m.node.hub.connected, `${m.name} hub port`);
  };
  t.after(async () => {
    client.close();
    for (const m of [a, b]) {
      await m.link?.close();
      await m.node.close();
    }
    await hub.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  await linkUp(a);
  await linkUp(b);
  return { hub, client, a, b, dirs, linkUp };
}

/** A repository on A and a clone of it on B, both with the same origin URL (linked workspaces). */
async function linkedRepos(w: World): Promise<{ wsA: WorkspaceInfo; wsB: WorkspaceInfo; pathA: string; pathB: string }> {
  const root = tempDir('bizzi-xm-repos-');
  w.dirs.push(root);
  const pathA = join(root, 'laptop', 'app');
  const pathB = join(root, 'mini', 'app');
  mkdirSync(pathA, { recursive: true });
  git(pathA, 'init', '-q');
  writeFileSync(join(pathA, 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(pathA, '.gitignore'), 'node_modules/\n');
  git(pathA, 'add', '-A');
  git(pathA, 'commit', '-q', '-m', 'initial');
  git(pathA, 'remote', 'add', 'origin', 'git@github.com:Acme/App.git');
  mkdirSync(join(root, 'mini'), { recursive: true });
  git(join(root, 'mini'), 'clone', '-q', pathA, 'app');
  git(pathB, 'remote', 'set-url', 'origin', 'https://github.com/acme/app');
  const { workspace: wsA } = await w.client.call<{ workspace: WorkspaceInfo }>('workspace.create', { machineId: w.a.node.machine.id, path: pathA });
  const { workspace: wsB } = await w.client.call<{ workspace: WorkspaceInfo }>('workspace.create', { machineId: w.b.node.machine.id, path: pathB });
  return { wsA, wsB, pathA, pathB };
}

async function idle(node: BizziNode, id: string): Promise<void> {
  await waitFor(() => node.sessions.get(id).session.status === 'idle' && !node.sessions.isBusy(id), `session ${id} idle`);
}

test('node → hub requests: index reads as the node, allowlist, offline targets fail fast, unlinked nodes too', async (t) => {
  const w = await world(t);
  const { a, b } = w;
  assert.equal(a.node.hub.state, 'connected');
  const { machines } = await a.node.hub.request<{ machines: { id: string; online: boolean }[] }>('machines.list', {});
  assert.ok(machines.some((m) => m.id === b.node.machine.id && m.online));
  // Only the allowlisted methods; devices-only and arbitrary client methods are refused.
  await rejectsWith(a.node.hub.request('pairing.create', { kind: 'device' }), 'unauthorized');
  await rejectsWith(a.node.hub.request('session.create', { workspaceId: 'w_x', agent: 'claude' }), 'unauthorized');
  // Node-to-node methods need a known target.
  await rejectsWith(a.node.hub.request('helper.wait', { machineId: 'm_nope', sessionId: 's', parentId: 'p' }), 'not_found');
  // A device can't impersonate a node.
  await rejectsWith(w.client.call('helper.start', { machineId: b.node.machine.id }), 'unauthorized');

  // B goes offline: A's request to it fails fast with machine_offline (and lastSeenAt).
  await b.link!.close();
  await waitFor(() => !w.hub.relay.isOnline(b.node.machine.id), 'B offline on the hub');
  const t0 = Date.now();
  const err = await rejectsWith(a.node.hub.request('helper.wait', { machineId: b.node.machine.id, sessionId: 's', parentId: 'p' }), 'machine_offline');
  assert.ok(Date.now() - t0 < 1000);
  assert.equal((err.data as { machineId?: string }).machineId, b.node.machine.id);
  // B itself, unlinked, gets machine_offline without sending anything.
  await waitFor(() => !b.node.hub.connected, 'B hub port down');
  await rejectsWith(b.node.hub.request('machines.list', {}), 'machine_offline', /not connected to a hub/);
});

test('cross-machine helper: start on B, wait, read, send; guardrails, budget, ownership, cascade, offline', async (t) => {
  const w = await world(t);
  const { a, b, client } = w;
  const { wsA, wsB } = await linkedRepos(w);
  const { session: parent } = await client.call<{ session: SessionInfo }>('session.create', {
    workspaceId: wsA.id,
    agent: 'claude',
    permissionMode: 'acceptEdits',
    budget: { turns: 10 },
  });
  await client.call('session.send', { sessionId: parent.id, input: [{ type: 'text', text: 'plan the work' }] });
  await idle(a.node, parent.id);

  // Start a Codex helper on the mini by name. Its workspace defaults to the one linked to the parent's
  // (same origin, cloned differently), its mode is clamped to the parent's level, its budget to what's left.
  const orch = a.node.orchestration;
  const r = await orch.startHelper(parent.id, { machine: 'MINI', agent: 'codex', prompt: 'review a.ts', permissionMode: 'full-access' });
  const helper = r.session;
  assert.equal(helper.machineId, b.node.machine.id);
  assert.equal(helper.spawnedBy, parent.id);
  assert.equal(helper.spawnedByMachineId, a.node.machine.id);
  assert.equal(helper.depth, 1);
  assert.equal(helper.workspaceId, wsB.id);
  assert.equal(helper.permissionMode, 'auto');
  assert.deepEqual(helper.budget, { turns: 9 });
  assert.match(r.notes.join('\n'), /runs on mini/);
  assert.match(r.notes.join('\n'), /looser than the parent's/);

  // It is a first-class session on B and in the hub index (nested under its parent by spawnedBy).
  assert.equal(b.node.sessions.get(helper.id).session.spawnedBy, parent.id);
  await waitFor(() => w.hub.relay.store.getSession(helper.id), 'the helper in the hub index');
  const listed = await client.call<{ sessions: SessionInfo[] }>('sessions.list', { spawnedBy: parent.id });
  assert.ok(listed.sessions.some((s) => s.id === helper.id));

  const done = await orch.wait(parent.id, helper.id, 'done', 10_000);
  assert.equal(done.reached, true, done.reason);
  assert.equal(done.state, 'idle');
  const read = await orch.read(parent.id, helper.id);
  assert.equal(read.finalMessage, 'echo: review a.ts');
  assert.equal(read.turns, 1);
  // The helper's turn counts in the parent's tree on A.
  assert.equal(a.node.sessions.spent(parent.id).tree.turns, 2);

  const { turnId } = await orch.send(parent.id, helper.id, [{ type: 'text', text: 'and b.ts' }]);
  assert.ok(turnId);
  await orch.wait(parent.id, helper.id, 'done', 10_000);
  const more = await orch.read(parent.id, helper.id, { since: read.cursor });
  assert.equal(more.finalMessage, 'echo: and b.ts');
  assert.equal(a.node.sessions.spent(parent.id).tree.turns, 3);

  const helpers = await orch.listHelpers(parent.id);
  assert.deepEqual(helpers.map((h) => h.id), [helper.id]);

  // Ownership: another session on A, or a caller claiming another machine on B, can't drive it.
  const { session: other } = await client.call<{ session: SessionInfo }>('session.create', { workspaceId: wsA.id, agent: 'claude' });
  await rejectsWith(orch.wait(other.id, helper.id, 'done', 100), 'not_found');
  await rejectsWith(b.node.dispatch('helper.read', { caller: { machineId: 'm_elsewhere' }, sessionId: helper.id, parentId: parent.id }), 'not_found');
  await rejectsWith(b.node.dispatch('helper.read', { sessionId: helper.id, parentId: parent.id }), 'bad_request', /caller/);
  // The permission cap holds on B even though the parent lives on A.
  await rejectsWith(b.node.call('session.set', { sessionId: helper.id, permissionMode: 'full-access' }), 'conflict');

  // Depth: B applies its own limit too.
  await b.node.call('orchestration.settings.set', { settings: { maxDepth: 1 } });
  const { session: deep } = await client.call<{ session: SessionInfo }>('session.create', { workspaceId: wsA.id, agent: 'claude' });
  await a.node.call('orchestration.settings.set', { settings: { maxDepth: 3 } });
  const child = await orch.startHelper(deep.id, { machine: 'laptop', agent: 'claude', prompt: 'local helper' });
  assert.equal(child.session.machineId, a.node.machine.id);
  await rejectsWith(orch.startHelper(child.session.id, { machine: 'mini', agent: 'codex', prompt: 'too deep' }), 'conflict', /depth limit reached on mini/);

  // Through the MCP tools, as the agent would: machines_list and session_start with a machine.
  await client.call('session.send', { sessionId: parent.id, input: [{ type: 'text', text: '/mcp bizzi-agents machines_list' }] });
  await idle(a.node, parent.id);
  await client.call('session.send', {
    sessionId: parent.id,
    input: [{ type: 'text', text: `/mcp bizzi-agents session_start ${JSON.stringify({ agent: 'claude', prompt: 'via mcp', machine: 'mini', scope: 'detached' })}` }],
  });
  await idle(a.node, parent.id);
  const outputs = a.node.bus
    .replay(sessionChannel(parent.id), 0)
    .filter((e) => e.type === 'tool.completed')
    .map((e) => String((e.data as { output?: unknown }).output ?? ''));
  assert.match(outputs.at(-2)!, /mini \[.*online/);
  assert.match(outputs.at(-1)!, /Started helper .* runs on mini/);
  const viaMcp = (await orch.listHelpers(parent.id)).find((h) => h.title === 'via mcp')!;
  assert.equal(viaMcp.machineId, b.node.machine.id);
  assert.equal(viaMcp.scope, 'detached');

  // Cascade: stopping the parent on A stops its child helper on B; the detached one carries on.
  await client.call('session.stop', { sessionId: parent.id });
  await waitFor(() => b.node.sessions.get(helper.id).session.status === 'ended', 'remote child stopped with its parent');
  assert.notEqual(b.node.sessions.get(viaMcp.id).session.status, 'ended');

  // Offline: a helper on a machine that's gone fails fast with machine_offline.
  await b.link!.close();
  await waitFor(() => !w.hub.relay.isOnline(b.node.machine.id), 'B offline');
  const t0 = Date.now();
  await rejectsWith(orch.startHelper(other.id, { machine: 'mini', agent: 'codex', prompt: 'x' }), 'machine_offline', /mini is offline/);
  assert.ok(Date.now() - t0 < 1000);
  await rejectsWith(orch.startHelper(other.id, { machine: 'nowhere', agent: 'codex', prompt: 'x' }), 'not_found');
});

test('fork to machine: a git workspace with local commits and uncommitted changes, and a plain directory', async (t) => {
  const w = await world(t);
  const { a, b, client } = w;
  const { wsA, wsB, pathA, pathB } = await linkedRepos(w);
  // A has a commit B doesn't, a modified tracked file, an untracked file and an ignored one.
  writeFileSync(join(pathA, 'b.ts'), 'export const b = 2;\n');
  git(pathA, 'add', 'b.ts');
  git(pathA, 'commit', '-q', '-m', 'add b');
  const headA = git(pathA, 'rev-parse', 'HEAD');
  writeFileSync(join(pathA, 'a.ts'), 'export const a = 42;\n');
  writeFileSync(join(pathA, 'notes.md'), 'todo: wire it up\n');
  mkdirSync(join(pathA, 'node_modules'));
  writeFileSync(join(pathA, 'node_modules', 'x.js'), '//\n');
  const statusBefore = git(pathA, 'status', '--porcelain');

  const { session: src } = await client.call<{ session: SessionInfo }>('session.create', { workspaceId: wsA.id, agent: 'claude', title: 'Wire up b' });
  await client.call('session.send', { sessionId: src.id, input: [{ type: 'text', text: 'make a.ts use b' }] });
  await idle(a.node, src.id);

  const res = await client.call<{ session: SessionInfo; workspace: WorkspaceInfo; transfer: ForkTransfer }>('session.forkTo', {
    sessionId: src.id,
    toMachineId: b.node.machine.id,
    prompt: 'Finish the wiring and run the tests.',
  });
  assert.equal(res.session.machineId, b.node.machine.id);
  assert.equal(res.session.forkedFrom, src.id);
  assert.equal(res.session.forkedFromMachineId, a.node.machine.id);
  assert.equal(res.workspace.kind, 'worktree');
  assert.equal(res.workspace.parentWorkspaceId, wsB.id);
  assert.equal(res.transfer.kind, 'git');
  assert.equal(res.transfer.uncommitted, true);
  assert.equal(res.transfer.sourceBranch, 'main');
  assert.match(res.transfer.branch!, /^fork\/main-/);
  assert.ok(res.transfer.bytes > 0);

  // B's worktree has A's local commit plus the work-tree state; ignored files stay behind.
  const wt = res.workspace.path;
  assert.equal(readFileSync(join(wt, 'a.ts'), 'utf8'), 'export const a = 42;\n');
  assert.equal(readFileSync(join(wt, 'b.ts'), 'utf8'), 'export const b = 2;\n');
  assert.equal(readFileSync(join(wt, 'notes.md'), 'utf8'), 'todo: wire it up\n');
  assert.equal(existsSync(join(wt, 'node_modules')), false);
  assert.equal(git(wt, 'rev-parse', 'HEAD^'), headA);
  assert.equal(git(wt, 'rev-parse', 'HEAD'), res.transfer.commit);
  // B's own checkout is untouched.
  assert.equal(readFileSync(join(pathB, 'a.ts'), 'utf8'), 'export const a = 1;\n');
  // A is untouched: same HEAD, same status, no leftover refs.
  assert.equal(git(pathA, 'rev-parse', 'HEAD'), headA);
  assert.equal(git(pathA, 'status', '--porcelain'), statusBefore);
  assert.equal(git(pathA, 'for-each-ref', 'refs/bizzi'), '');

  // The new session started with the brief.
  await idle(b.node, res.session.id);
  const first = b.node.bus.replay(sessionChannel(res.session.id), 0).find((e) => e.type === 'turn.started')!;
  const brief = (first.data as { input: { text: string }[] }).input[0]!.text;
  assert.match(brief, /# Continuing work from laptop/);
  assert.match(brief, /## Goal\n\nmake a\.ts use b/);
  assert.match(brief, /## Where it left off\n\necho: make a\.ts use b/);
  assert.match(brief, /branch `fork\/main-/);
  assert.match(brief, /## Next\n\nFinish the wiring and run the tests\./);
  // The original's timeline notes the fork.
  const note = a.node.bus.replay(sessionChannel(src.id), 0).find((e) => e.type === 'agent.raw' && (e.data as { payload: { type?: string } }).payload.type === 'bizzi.forkTo');
  assert.ok(note);

  // Same branch again: refused on B, nothing half-done.
  await rejectsWith(
    client.call('session.forkTo', { sessionId: src.id, toMachineId: b.node.machine.id, branch: res.transfer.branch }),
    'conflict',
    /already exists/,
  );

  // Clean work tree and B already has every commit: nothing to send.
  git(pathA, 'checkout', '-q', '--', 'a.ts');
  rmSync(join(pathA, 'notes.md'));
  git(pathB, 'fetch', '-q', pathA, 'main:refs/remotes/laptop/main');
  const clean = await client.call<{ transfer: ForkTransfer }>('session.forkTo', { sessionId: src.id, toMachineId: 'mini', branch: 'fork/clean' });
  assert.equal(clean.transfer.uncommitted, false);
  assert.equal(clean.transfer.commit, headA);
  assert.equal(clean.transfer.bytes, 0);

  // A fresh clone into a new directory on B, with the origin carried over.
  const fresh = join(tempDir('bizzi-xm-fresh-'), 'app');
  w.dirs.push(fresh);
  const cloned = await client.call<{ workspace: WorkspaceInfo }>('session.forkTo', { sessionId: src.id, toMachineId: 'mini', toPath: fresh });
  assert.equal(cloned.workspace.kind, 'git');
  assert.equal(git(fresh, 'rev-parse', 'HEAD'), headA);
  assert.equal(git(fresh, 'remote', 'get-url', 'origin'), 'git@github.com:Acme/App.git');

  // A plain directory: a shadow-git snapshot, materialized into a new directory on B.
  const plain = tempDir('bizzi-xm-plain-');
  w.dirs.push(plain);
  writeFileSync(join(plain, 'notes.txt'), 'hello\n');
  mkdirSync(join(plain, 'sub'));
  writeFileSync(join(plain, 'sub', 'x.txt'), 'x\n');
  const { workspace: dirWs } = await client.call<{ workspace: WorkspaceInfo }>('workspace.create', { machineId: a.node.machine.id, path: plain });
  assert.equal(dirWs.kind, 'dir');
  const { session: dirSession } = await client.call<{ session: SessionInfo }>('session.create', { workspaceId: dirWs.id, agent: 'claude' });
  await rejectsWith(client.call('session.forkTo', { sessionId: dirSession.id, toMachineId: 'mini' }), 'bad_request', /toPath/);
  const target = join(tempDir('bizzi-xm-plain-to-'), 'notes');
  w.dirs.push(target);
  const forkedDir = await client.call<{ workspace: WorkspaceInfo; transfer: ForkTransfer }>('session.forkTo', {
    sessionId: dirSession.id,
    toMachineId: 'mini',
    toPath: target,
    agent: 'codex',
  });
  assert.equal(forkedDir.transfer.kind, 'snapshot');
  assert.equal(forkedDir.workspace.kind, 'dir');
  assert.equal(readFileSync(join(target, 'notes.txt'), 'utf8'), 'hello\n');
  assert.equal(readFileSync(join(target, 'sub', 'x.txt'), 'utf8'), 'x\n');
  assert.equal(existsSync(join(target, '.git')), false);
  assert.equal(existsSync(join(plain, '.git')), false);
  // A non-empty target is refused.
  await rejectsWith(client.call('session.forkTo', { sessionId: dirSession.id, toMachineId: 'mini', toPath: target }), 'conflict', /not empty/);

  // Fork to an offline machine fails fast.
  await b.link!.close();
  await waitFor(() => !w.hub.relay.isOnline(b.node.machine.id), 'B offline');
  await rejectsWith(client.call('session.forkTo', { sessionId: src.id, toMachineId: b.node.machine.id }), 'machine_offline');
});
