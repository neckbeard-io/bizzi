import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { BizziError, GLOBAL_CHANNEL, NO_CAPABILITIES, sessionChannel } from '@bizzi/protocol';
import type { MachineInfo, SessionInfo } from '@bizzi/protocol';
import { BizziClient, BizziStore, createManualScheduler, selectAgentJob, selectMachineOnline, stringToBase64 } from '../src/index.ts';
import type { StoreSnapshot } from '../src/index.ts';
import { FakeServer, MACHINE, waitFor } from './fake-server.ts';

const HUB: MachineInfo = { ...MACHINE, id: 'm_hub', name: 'hub', roles: ['hub'] };
const LAPTOP: MachineInfo = { ...MACHINE, id: 'm_laptop', name: 'laptop' };
const SERVER: MachineInfo = { ...MACHINE, id: 'm_server', name: 'server', online: false, lastSeenAt: '2026-11-05T08:00:00Z' };

function session(id: string, machineId: string, extra: Partial<SessionInfo> = {}): SessionInfo {
  return { id, machineId, workspaceId: `w_${machineId}`, agent: 'claude', mode: 'structured', status: 'idle', createdAt: 'x', updatedAt: 'x', lastSeq: 0, ...extra };
}

function params(server: FakeServer, method: string): Record<string, unknown>[] {
  return server.requests.filter((r) => r.method === method).map((r) => r.params as Record<string, unknown>);
}

async function hubSetup(t: TestContext, opts: { cache?: StoreSnapshot; initialMachineId?: string } = {}) {
  const server = await FakeServer.start();
  server.helloMachine = HUB;
  server.helloRole = 'hub';
  const machines = new Map([LAPTOP, SERVER].map((m) => [m.id, { ...m }]));
  const offline = (mid: unknown): void => {
    const m = machines.get(String(mid));
    if (!m) throw new BizziError('not_found', 'no machine');
    if (!m.online) throw new BizziError('machine_offline', `${m.name} is offline`);
  };
  server.handlers.set('machines.list', () => ({ machines: [...machines.values()] }));
  server.handlers.set('agents.list', (p) => {
    offline(p.machineId);
    return { agents: [{ agent: 'claude', installed: true, auth: 'ok' }] };
  });
  server.handlers.set('workspaces.list', (p) => {
    offline(p.machineId);
    return { workspaces: [{ id: `w_${String(p.machineId)}`, machineId: p.machineId, name: 'ws', path: '/x', kind: 'git', createdAt: 'x' }] };
  });
  server.handlers.set('sessions.list', (p) => {
    offline(p.machineId);
    return { sessions: [session(`s_${String(p.machineId)}`, String(p.machineId))] };
  });
  server.handlers.set('devices.list', () => ({ devices: [{ id: 'd_1', name: 'phone', kind: 'device', createdAt: 'x' }] }));
  server.handlers.set('knowledge.inbox', (p) => {
    offline(p.machineId);
    return { cards: [] };
  });
  server.handlers.set('knowledge.settings.get', (p) => {
    offline(p.machineId);
    return { settings: { preset: 'balanced', defaultAgentScope: 'project' } };
  });
  const client = new BizziClient({ backoff: { baseMs: 10, maxMs: 20 }, requestTimeoutMs: 1000 });
  const scheduler = createManualScheduler();
  const store = new BizziStore(client, {
    scheduler,
    ...(opts.initialMachineId ? { initialMachineId: opts.initialMachineId } : {}),
    ...(opts.cache ? { cache: { load: () => opts.cache ?? null, save: () => {} } } : {}),
  });
  t.after(async () => {
    store.dispose();
    client.close();
    await server.stop();
  });
  const until = (cond: () => boolean): Promise<void> =>
    waitFor(() => {
      scheduler.flush();
      return cond();
    });
  return { server, client, store, machines, until };
}

test('hub: every node is loaded with its machineId; the hub host is not; offline machines record machine_offline', async (t) => {
  const { server, client, store, until } = await hubSetup(t);
  await client.connect(server.url, 'secret');
  await until(() => store.getState().sessionsLoaded && store.getState().devices !== null);
  const s = store.getState();
  assert.equal(s.role, 'hub');
  assert.equal(s.machine?.id, 'm_hub');
  assert.equal(s.selectedMachineId, 'm_laptop', 'the first online node is selected');

  for (const m of ['agents.list', 'workspaces.list', 'sessions.list']) {
    const ids = params(server, m).map((p) => p.machineId).sort();
    assert.deepEqual(ids, ['m_laptop', 'm_server'], `${m} goes to each node`);
  }
  assert.deepEqual(params(server, 'knowledge.inbox').map((p) => p.machineId), ['m_laptop']);
  assert.ok(s.agents.m_laptop);
  assert.equal(s.agents.m_server, undefined);
  assert.equal(s.machineErrors.m_server?.code, 'machine_offline');
  assert.equal(s.machineErrors.m_laptop, undefined);
  assert.ok(s.sessions.s_m_laptop);
  assert.equal(selectMachineOnline(s, 'm_laptop'), true);
  assert.equal(selectMachineOnline(s, 'm_server'), false);
  assert.ok(s.devices?.d_1);
});

test('hub: machine-targeted actions carry the selected machine (or an explicit one)', async (t) => {
  const { server, client, store, until } = await hubSetup(t);
  server.handlers.set('agent.plan', (p) => ({ plan: { target: p.agent, action: p.action, method: 'x', steps: [] } }));
  server.handlers.set('agent.install', (p) => ({ jobId: 'job_1', plan: { target: p.agent, action: p.action, method: 'x', steps: [] } }));
  server.handlers.set('agent.secrets', () => ({ secrets: [] }));
  server.handlers.set('knowledge.list', () => ({ items: [] }));
  server.handlers.set('workspace.create', (p) => ({ workspace: { id: 'w_new', machineId: p.machineId, name: 'n', path: String(p.path), kind: 'dir', createdAt: 'x' } }));
  await client.connect(server.url, 'secret');
  await until(() => store.getState().sessionsLoaded);

  await store.planAgent({ agent: 'codex', action: 'install' });
  await store.listSecrets();
  await store.listKnowledge({ type: 'rule' });
  await store.createWorkspace({ path: '/tmp/x' });
  const job = await store.installAgent({ machineId: 'm_laptop', agent: 'agy', action: 'install' });
  assert.equal(params(server, 'agent.plan')[0]?.machineId, 'm_laptop');
  assert.equal(params(server, 'agent.secrets')[0]?.machineId, 'm_laptop');
  assert.deepEqual(params(server, 'knowledge.list')[0], { machineId: 'm_laptop', type: 'rule' });
  assert.equal(params(server, 'workspace.create')[0]?.machineId, 'm_laptop');
  assert.equal(job.machineId, 'm_laptop');

  // Selecting another machine re-targets subsequent calls.
  store.selectMachine('m_server');
  await store.planAgent({ agent: 'codex', action: 'install' });
  assert.equal(params(server, 'agent.plan')[1]?.machineId, 'm_server');

  // Progress events by jobId land in the job; done triggers an agents reload for that machine.
  const before = params(server, 'agents.list').length;
  server.push(GLOBAL_CHANNEL, { type: 'install.progress', data: { agent: 'agy', jobId: 'job_1', stage: 'download', step: 1, total: 3, message: 'fetching' } });
  await until(() => store.getState().jobs.job_1?.stage === 'download');
  assert.equal(store.getState().jobs.job_1?.total, 3);
  server.push(GLOBAL_CHANNEL, { type: 'install.progress', data: { agent: 'agy', jobId: 'job_1', stage: 'done', step: 3, total: 3, done: true, ok: true } });
  await until(() => store.getState().jobs.job_1?.done === true);
  assert.equal(selectAgentJob(store.getState(), 'm_laptop', 'agy')?.ok, true);
  assert.equal(store.getState().jobs.job_1?.log.length, 2);
  await until(() => params(server, 'agents.list').length === before + 1);
  assert.deepEqual(params(server, 'agents.list').at(-1), { machineId: 'm_laptop', refresh: true });
});

test('hub: a machine coming online (machine.updated) is loaded live', async (t) => {
  const { server, client, store, machines, until } = await hubSetup(t);
  await client.connect(server.url, 'secret');
  await until(() => store.getState().sessionsLoaded);
  assert.equal(store.getState().sessions.s_m_server, undefined);

  const back = { ...SERVER, online: true };
  machines.set(back.id, back);
  server.push(GLOBAL_CHANNEL, { type: 'machine.updated', data: { machine: back } });
  await until(() => store.getState().sessions.s_m_server !== undefined && store.getState().agents.m_server !== undefined);
  assert.equal(store.getState().machines.m_server?.online, true);
  assert.equal(store.getState().machineErrors.m_server, undefined);

  const gone = { ...back, online: false, lastSeenAt: new Date().toISOString() };
  server.push(GLOBAL_CHANNEL, { type: 'machine.updated', data: { machine: gone } });
  await until(() => store.getState().machines.m_server?.online === false);
  // Cached data of the now-offline machine stays visible.
  assert.ok(store.getState().sessions.s_m_server);
});

test('cached snapshot: offline machines keep their last known data across a reload', async (t) => {
  const cache: StoreSnapshot = {
    v: 1,
    machines: { m_server: { ...SERVER, online: true } },
    agents: { m_server: [{ agent: 'codex', installed: true, auth: 'ok' }] },
    workspaces: { w_m_server: { id: 'w_m_server', machineId: 'm_server', name: 'infra', path: '/srv', kind: 'git', createdAt: 'x' } },
    sessions: { s_old: session('s_old', 'm_server') },
    selectedMachineId: 'm_server',
  };
  const { server, client, store, until } = await hubSetup(t, { cache });
  assert.equal(store.getState().machines.m_server?.online, false, 'cached machines start offline');
  await client.connect(server.url, 'secret');
  await until(() => store.getState().sessionsLoaded);
  const s = store.getState();
  assert.equal(s.selectedMachineId, 'm_server', 'the remembered machine stays selected');
  assert.equal(s.agents.m_server?.[0]?.agent, 'codex');
  assert.ok(s.sessions.s_old);
  assert.ok(s.workspaces?.w_m_server);
  assert.ok(s.sessions.s_m_laptop, 'online machines load normally');
});

test('node mode: calls name the node itself; other known machines are not loaded', async (t) => {
  const server = await FakeServer.start();
  server.handlers.set('machines.list', () => ({ machines: [MACHINE, { ...LAPTOP, id: 'm_other' }] }));
  server.handlers.set('knowledge.inbox', () => ({ cards: [] }));
  server.handlers.set('knowledge.settings.get', () => ({ settings: { preset: 'strict', defaultAgentScope: 'workspace' } }));
  const client = new BizziClient({ backoff: { baseMs: 10, maxMs: 20 } });
  const scheduler = createManualScheduler();
  const store = new BizziStore(client, { scheduler });
  t.after(async () => {
    store.dispose();
    client.close();
    await server.stop();
  });
  await client.connect(server.url, 'secret');
  await waitFor(() => {
    scheduler.flush();
    return store.getState().sessionsLoaded && store.getState().knowledgeSettings !== null;
  });
  assert.equal(store.getState().role, 'node');
  assert.equal(store.getState().selectedMachineId, 'm_1');
  for (const m of ['agents.list', 'workspaces.list', 'sessions.list']) assert.deepEqual(params(server, m).map((p) => p.machineId), ['m_1']);
  assert.equal(params(server, 'devices.list').length, 0);
  assert.equal(store.getState().knowledgeSettings?.preset, 'strict');
});

test('terminal late-join: snapshot first, then subscribe from its seq', async (t) => {
  const server = await FakeServer.start();
  const term = session('s_t', 'm_1', { mode: 'terminal', agent: 'shell', status: 'running' });
  server.handlers.set('sessions.list', () => ({ sessions: [term] }));
  server.handlers.set('session.get', () => ({ session: term, capabilities: NO_CAPABILITIES }));
  const ch = sessionChannel('s_t');
  for (let i = 0; i < 50; i++) server.push(ch, { type: 'term.output', data: { dataBase64: stringToBase64(`old line ${i}\r\n`) } });
  server.handlers.set('term.snapshot', () => ({ dataBase64: stringToBase64('$ screen as of seq 50\r\n'), seq: 50 }));
  const client = new BizziClient({ backoff: { baseMs: 10, maxMs: 20 } });
  const scheduler = createManualScheduler();
  const store = new BizziStore(client, { scheduler, watchAttention: false });
  t.after(async () => {
    store.dispose();
    client.close();
    await server.stop();
  });
  await client.connect(server.url, 'secret');
  await waitFor(() => {
    scheduler.flush();
    return store.getState().sessionsLoaded;
  });
  await store.openSession('s_t');
  const sub = params(server, 'subscribe').find((p) => p.ch === ch);
  assert.equal(sub?.since, 50);
  server.push(ch, { type: 'term.output', data: { dataBase64: stringToBase64('new\r\n') } });
  await waitFor(() => store.terminal.backlog('s_t').length === 2);
  const text = store.terminal
    .backlog('s_t')
    .map((c) => new TextDecoder().decode(c))
    .join('');
  assert.equal(text, '$ screen as of seq 50\r\nnew\r\n');
  assert.equal(store.getState().timelines.s_t?.lastSeq, 50);
});

test('terminal late-join falls back to a full replay when term.snapshot is unsupported', async (t) => {
  const server = await FakeServer.start();
  const term = session('s_t', 'm_1', { mode: 'terminal', agent: 'shell', status: 'running' });
  server.handlers.set('sessions.list', () => ({ sessions: [term] }));
  server.handlers.set('session.get', () => ({ session: term, capabilities: NO_CAPABILITIES }));
  server.push(sessionChannel('s_t'), { type: 'term.output', data: { dataBase64: stringToBase64('hi') } });
  const client = new BizziClient({ backoff: { baseMs: 10, maxMs: 20 } });
  const store = new BizziStore(client, { scheduler: createManualScheduler(), watchAttention: false, autoLoad: false });
  t.after(async () => {
    store.dispose();
    client.close();
    await server.stop();
  });
  await client.connect(server.url, 'secret');
  await store.loadSessions();
  await store.openSession('s_t');
  assert.equal(params(server, 'subscribe').find((p) => p.ch === sessionChannel('s_t'))?.since, 0);
  await waitFor(() => store.terminal.backlog('s_t').length === 1);
});

test('fork adds the new session; delete and session.removed drop a session everywhere', async (t) => {
  const server = await FakeServer.start();
  const a = session('s_a', 'm_1');
  const b = session('s_b', 'm_1');
  server.handlers.set('sessions.list', () => ({ sessions: [a, b] }));
  server.handlers.set('session.get', (p) => ({ session: p.sessionId === 's_a' ? a : b, capabilities: { ...NO_CAPABILITIES, fork: true } }));
  server.handlers.set('session.fork', () => ({ session: session('s_fork', 'm_1', { forkedFrom: 's_a', title: 'fork' }) }));
  server.handlers.set('session.delete', () => ({}));
  const client = new BizziClient({ backoff: { baseMs: 10, maxMs: 20 } });
  const scheduler = createManualScheduler();
  const store = new BizziStore(client, { scheduler, autoLoad: false });
  t.after(async () => {
    store.dispose();
    client.close();
    await server.stop();
  });
  await client.connect(server.url, 'secret');
  await store.loadSessions();
  await store.openSession('s_a');
  const fork = await store.forkSession('s_a');
  scheduler.flush();
  assert.equal(store.getState().sessions[fork.id]?.forkedFrom, 's_a');

  await store.deleteSession('s_a');
  scheduler.flush();
  assert.equal(store.getState().sessions.s_a, undefined);
  assert.equal(store.getState().timelines.s_a, undefined);
  assert.equal(store.getState().capabilities.s_a, undefined);
  assert.equal(store.isOpen('s_a'), false);
  assert.equal(client.isSubscribed(sessionChannel('s_a')), false);

  server.push(GLOBAL_CHANNEL, { type: 'session.removed', data: { sessionId: 's_b', workspaceId: 'w_m_1' } });
  await waitFor(() => {
    scheduler.flush();
    return store.getState().sessions.s_b === undefined;
  });
});

test('question.respond, with a text fallback for agents without it', async (t) => {
  const server = await FakeServer.start();
  const s = session('s_q', 'm_1');
  server.handlers.set('question.respond', () => ({}));
  server.handlers.set('session.send', () => ({ turnId: 't_2' }));
  const client = new BizziClient({ backoff: { baseMs: 10, maxMs: 20 } });
  const store = new BizziStore(client, { scheduler: createManualScheduler(), autoLoad: false });
  t.after(async () => {
    store.dispose();
    client.close();
    await server.stop();
  });
  server.handlers.set('sessions.list', () => ({ sessions: [s] }));
  await client.connect(server.url, 'secret');
  await store.respondQuestion('s_q', 'q_1', { answers: { provider: 'Auth0', flows: ['Web', 'API'] } });
  await store.respondQuestion('s_q', 'q_1', { cancel: true });
  assert.deepEqual(params(server, 'question.respond'), [
    { sessionId: 's_q', questionId: 'q_1', answers: { provider: 'Auth0', flows: ['Web', 'API'] } },
    { sessionId: 's_q', questionId: 'q_1', cancel: true },
  ]);

  server.handlers.delete('question.respond');
  await store.respondQuestion('s_q', 'q_2', { answers: { a: 'yes', b: ['x', 'y'] } });
  assert.deepEqual(params(server, 'session.send').at(-1), { sessionId: 's_q', input: [{ type: 'text', text: 'yes\nx, y' }] });
  await assert.rejects(store.respondQuestion('s_q', 'q_2', { cancel: true }), (e: unknown) => e instanceof BizziError && e.code === 'unsupported');
});
