import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { BizziError } from '@bizzi/protocol';
import { BizziClient, BizziStore, createManualScheduler, hubTokenProvider, memoryIdentityStore, pairWithHub, selectInbox, timelineItems } from '@bizzi/client';
import { MockCore, createMockHubFetch, createMockSocketFactory } from '../src/mock/mockServer.ts';
import type { MockOptions } from '../src/mock/mockServer.ts';

function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (cond()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timed out'));
      setTimeout(tick, 2);
    };
    tick();
  });
}

async function connectMock(t: TestContext, opts: MockOptions = {}) {
  const core = new MockCore({ speed: 0, autoplay: false, ...opts });
  const client = new BizziClient({ createSocket: createMockSocketFactory(core) });
  const scheduler = createManualScheduler();
  const store = new BizziStore(client, { scheduler });
  t.after(() => {
    store.dispose();
    client.close();
  });
  await client.connect('mock://local', 'demo');
  const until = (cond: () => boolean): Promise<void> =>
    waitFor(() => {
      scheduler.flush();
      return cond();
    });
  await until(() => store.getState().sessionsLoaded && store.getState().agents.m_laptop !== undefined);
  return { core, client, store, until };
}

test('mock hub drives a full scripted session through the real client', async (t) => {
  const { store, until } = await connectMock(t);
  assert.equal(store.getState().role, 'hub');
  assert.equal(store.getState().selectedMachineId, 'm_laptop');
  // s_review waits for approval and s_plan for answers, so the store watches both and the inbox shows them.
  await until(() => selectInbox(store.getState()).length === 2);
  assert.deepEqual(selectInbox(store.getState()).map((e) => e.item.kind).sort(), ['approval', 'question']);

  await store.openSession('s_demo');
  await until(() => (store.getState().timelines['s_demo']?.lastSeq ?? 0) > 5);
  const { turnId } = await store.send('s_demo', 'fix it');
  assert.ok(turnId);

  // The scripted turn stops at an editable approval; steering meanwhile shows up as a steer item.
  await until(() => (store.getState().timelines['s_demo']?.pendingApprovals.length ?? 0) === 1);
  await store.steer('s_demo', 'keep the diff small');
  await until(() => timelineItems(store.getState().timelines['s_demo'] ?? { order: [], items: {} } as never).some((i) => i.kind === 'steer' && i.turnId === turnId));
  const tl = store.getState().timelines['s_demo'];
  const approvalId = tl?.pendingApprovals[0];
  assert.ok(approvalId);
  const ap = tl.items[`ap:${approvalId}`];
  assert.ok(ap?.kind === 'approval' && ap.request.editable);

  await store.respondApproval('s_demo', approvalId, { decision: 'allow' });
  await until(() => store.getState().timelines['s_demo']?.activeTurnId === null);

  const done = store.getState().timelines['s_demo'];
  assert.ok(done);
  const kinds = timelineItems(done).map((i) => i.kind);
  for (const k of ['turn', 'steer', 'reasoning', 'tool', 'approval', 'file', 'message', 'turn-end']) assert.ok(kinds.includes(k as never), `has ${k}`);
  assert.equal(done.plan?.every((p) => p.status === 'completed'), true);
  assert.ok(done.usage?.costUsd);
  const last = timelineItems(done).filter((i) => i.kind === 'message').at(-1);
  assert.ok(last?.kind === 'message' && !last.streaming && last.text.includes('| Run |'));
  assert.equal(store.getState().sessions['s_demo']?.status, 'idle');
});

test('mock: structured questions are answered with question.respond', async (t) => {
  const { store, until } = await connectMock(t);
  await until(() => store.getState().timelines['s_plan']?.pendingQuestions.length === 1);
  const tl = store.getState().timelines['s_plan'];
  assert.equal(tl?.prompt, 'input');
  const q = tl?.items['q:q_plan1'];
  assert.ok(q?.kind === 'question');
  assert.equal(q.questions?.length, 3);
  assert.equal(q.questions?.[1]?.multiSelect, true);

  await store.respondQuestion('s_plan', 'q_plan1', { answers: { provider: 'Keycloak', flows: ['Web login', 'API tokens'], sessions: 'log everyone out' } });
  await until(() => store.getState().timelines['s_plan']?.status === 'idle');
  const after = store.getState().timelines['s_plan'];
  const answered = after?.items['q:q_plan1'];
  assert.ok(answered?.kind === 'question' && answered.status === 'answered');
  assert.deepEqual(answered.answers?.flows, ['Web login', 'API tokens']);
  const reply = timelineItems(after ?? ({ order: [], items: {} } as never)).filter((i) => i.kind === 'message').at(-1);
  assert.ok(reply?.kind === 'message' && reply.text.includes('Keycloak'));
  assert.equal(selectInbox(store.getState()).some((e) => e.sessionId === 's_plan'), false);
});

test('mock: cancelled approvals in history, fork and delete', async (t) => {
  const { store, until } = await connectMock(t);
  await store.openSession('s_notes');
  await until(() => store.getState().timelines['s_notes']?.items['ap:ap_n2'] !== undefined);
  const ap = store.getState().timelines['s_notes']?.items['ap:ap_n2'];
  assert.ok(ap?.kind === 'approval' && ap.decision === 'cancelled');

  await store.openSession('s_demo');
  const fork = await store.forkSession('s_demo');
  assert.equal(fork.forkedFrom, 's_demo');
  await store.openSession(fork.id);
  await until(() => (store.getState().timelines[fork.id]?.order.length ?? 0) > 3);

  await store.deleteSession(fork.id);
  await until(() => store.getState().sessions[fork.id] === undefined);
  await assert.rejects(store.client.request('session.get', { sessionId: fork.id }), (e: unknown) => e instanceof BizziError && e.code === 'not_found');
});

test('mock: the offline machine serves cached lists from the hub but rejects work with machine_offline', async (t) => {
  const { core, store, until } = await connectMock(t);
  const s = store.getState();
  assert.equal(s.machines.m_server?.online, false);
  assert.ok(s.machines.m_server?.lastSeenAt);
  assert.ok(s.sessions.s_infra, 'sessions of the offline machine come from the replica');
  assert.equal(s.machineErrors.m_server?.code, 'machine_offline');

  await assert.rejects(store.send('s_infra', 'hello'), (e: unknown) => e instanceof BizziError && e.code === 'machine_offline');
  await assert.rejects(store.planAgent({ machineId: 'm_server', agent: 'codex', action: 'install' }), (e: unknown) => e instanceof BizziError && e.code === 'machine_offline');
  await store.openSession('s_infra');
  await until(() => (store.getState().timelines.s_infra?.order.length ?? 0) > 3);

  // It comes back: machine.updated reaches the store and its data loads.
  core.setMachineOnline('m_server', true);
  await until(() => store.getState().agents.m_server !== undefined && store.getState().machineErrors.m_server === undefined);
});

test('mock terminal: late join from term.snapshot, then live echo', async (t) => {
  const { core, store } = await connectMock(t, { role: 'node' });
  assert.equal(store.getState().role, 'node');
  void core;
  await store.openSession('s_term');
  let out = '';
  store.terminal.subscribe('s_term', (c) => (out += new TextDecoder().decode(c)));
  assert.ok(out.includes('Initial commit'), 'the snapshot carries the scrollback');
  await store.termInput('s_term', 'pwd\r');
  await waitFor(() => out.includes('/Users/dev/src/acme-shop\r\n'));
});

test('mock hub: pair with the setup code, connect with a signed token, revoke', async (t) => {
  const core = new MockCore({ speed: 0, autoplay: false });
  const fetch = createMockHubFetch(core);
  const keys = memoryIdentityStore();
  const creds = await pairWithHub({ hubUrl: 'mock://hub', code: 'demo-1234', name: 'Test phone', store: keys, fetch });
  assert.equal(creds.clientUrl, 'mock://hub/ws');
  const provider = await hubTokenProvider(creds, { store: keys, fetch });
  const client = new BizziClient({ createSocket: createMockSocketFactory(core), backoff: { baseMs: 5, maxMs: 10 } });
  const scheduler = createManualScheduler();
  const store = new BizziStore(client, { scheduler });
  t.after(() => {
    store.dispose();
    client.close();
  });
  await client.connect(creds.clientUrl, provider);
  await waitFor(() => {
    scheduler.flush();
    return store.getState().devices?.[creds.deviceId] !== undefined;
  });
  assert.equal(store.getState().devices?.[creds.deviceId]?.name, 'Test phone');

  // A code from pairing.create works once.
  const pairing = await store.createPairing('device', 'Tablet');
  assert.match(pairing.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.ok(pairing.pairUrl.includes(pairing.code.replace('-', '')));
  const tablet = await pairWithHub({ hubUrl: 'mock://hub', code: pairing.code, name: 'Tablet', store: keys, fetch });
  await assert.rejects(pairWithHub({ hubUrl: 'mock://hub', code: pairing.code, name: 'again', store: keys, fetch }), (e: unknown) => e instanceof BizziError && e.code === 'unauthorized');

  // Revoking the tablet: device.updated reaches the store; its key can no longer get a token.
  await store.revokeDevice(tablet.deviceId);
  await waitFor(() => {
    scheduler.flush();
    return store.getState().devices?.[tablet.deviceId]?.revoked === true;
  });
  const revoked = await hubTokenProvider(tablet, { store: keys, fetch });
  await assert.rejects(revoked.getToken(), (e: unknown) => e instanceof BizziError && e.code === 'unauthorized');
});

test('mock rejects a bad token as unauthorized', async () => {
  const client = new BizziClient({ createSocket: createMockSocketFactory(new MockCore({ speed: 0, autoplay: false })) });
  await assert.rejects(client.connect('mock://local', 'bad'), /invalid token/);
  assert.equal(client.getConnection().state, 'closed');
});
