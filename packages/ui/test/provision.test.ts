import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BizziClient, BizziStore, createManualScheduler, selectAgentJob, selectAgents } from '@bizzi/client';
import type { InstallJob } from '@bizzi/client';
import type { AgentListing, InstallPlan } from '@bizzi/protocol';
import {
  actionVerb,
  agentActions,
  hasUpdate,
  isValidSecretName,
  jobLabel,
  jobProgress,
  jobState,
  planSummary,
  stepState,
  suggestedSecretNames,
} from '../src/lib/provision.ts';
import { MACHINE, SERVER } from '../src/mock/fixtures.ts';
import { MockCore, createMockSocketFactory } from '../src/mock/mockServer.ts';
import { mockPlan } from '../src/mock/provision.ts';

function job(p: Partial<InstallJob>): InstallJob {
  return { jobId: 'j1', machineId: 'm_1', agent: 'claude', action: 'install', plan: null, stage: 'Download', done: false, log: [], startedAt: 'x', updatedAt: 'x', ...p };
}

test('agent actions follow the listing', () => {
  const missing: AgentListing = { agent: 'agy', installed: false, auth: 'missing' };
  assert.deepEqual(agentActions(missing), { install: true, update: false, uninstall: false, login: false, loginProminent: false, secrets: true });
  const expired: AgentListing = { agent: 'codex', installed: true, version: '1', auth: 'expired' };
  const a = agentActions(expired);
  assert.equal(a.login && a.loginProminent && a.uninstall && !a.install, true);
  const ok: AgentListing = { agent: 'claude', installed: true, version: '2.4.1', latestVersion: '2.4.3', auth: 'ok' };
  assert.equal(agentActions(ok).loginProminent, false);
  assert.equal(agentActions(ok).update, true);
  assert.equal(hasUpdate({ ...ok, updateAvailable: false }), false, 'updateAvailable wins over a version compare');
  assert.equal(hasUpdate({ ...ok, latestVersion: '2.4.1' }), false);
  const shell: AgentListing = { agent: 'shell', installed: true, auth: 'ok' };
  assert.deepEqual(Object.values(agentActions(shell)), [false, false, false, false, false, false]);
});

test('job progress, state and label', () => {
  assert.equal(jobProgress(job({})), null);
  assert.equal(jobProgress(job({ step: 2, total: 4 })), 0.5);
  assert.equal(jobProgress(job({ step: 2, total: 4, done: true, ok: true })), 1);
  assert.equal(jobState(job({})), 'running');
  assert.equal(jobState(job({ done: true })), 'ok');
  assert.equal(jobState(job({ done: true, ok: false })), 'failed');
  assert.equal(jobLabel(job({ agent: 'agy', step: 2, total: 6 })), 'Installing agy · step 2 of 6');
  assert.equal(jobLabel(job({ action: 'update', done: true, ok: true })), 'Updated claude');
  assert.equal(jobLabel(job({ action: 'uninstall', done: true, ok: false })), 'Uninstall of claude failed');
  assert.equal(jobLabel(job({ action: null, tool: 'node' })), 'Installing node');
  assert.equal(actionVerb('update', 'progressive'), 'Updating');
  assert.equal(stepState(null, 0), 'pending');
  assert.deepEqual([0, 1, 2].map((i) => stepState(job({ step: 2, total: 3 }), i)), ['done', 'running', 'pending']);
  assert.deepEqual([0, 1].map((i) => stepState(job({ step: 1, total: 2, done: true, ok: false }), i)), ['failed', 'pending']);
  assert.deepEqual([0, 1].map((i) => stepState(job({ step: 2, total: 2, done: true, ok: true }), i)), ['done', 'done']);
});

test('secret name suggestions and validation', () => {
  assert.deepEqual(suggestedSecretNames('codex'), ['OPENAI_API_KEY']);
  assert.equal(suggestedSecretNames('claude', ['ANTHROPIC_API_KEY'])[0], 'CLAUDE_CODE_OAUTH_TOKEN');
  assert.deepEqual(suggestedSecretNames('shell'), []);
  assert.equal(isValidSecretName('GEMINI_API_KEY'), true);
  assert.equal(isValidSecretName('1BAD'), false);
  assert.equal(isValidSecretName('has space'), false);
});

test('plan summary and mock recipes', () => {
  const plan: InstallPlan = mockPlan('codex', 'install', SERVER);
  assert.equal(plan.method, 'npm');
  assert.ok(plan.steps.some((s) => s.command === 'npm i -g @openai/codex'));
  assert.equal(mockPlan('codex', 'install', MACHINE).method, 'brew');
  assert.match(mockPlan('claude', 'install', MACHINE).steps[0]?.command ?? '', /claude\.ai\/install\.sh/);
  assert.ok(mockPlan('agy', 'install', MACHINE).steps.some((s) => s.command === 'brew install antigravity-cli'));
  const s = planSummary(mockPlan('agy', 'install', SERVER));
  assert.equal(s.sudo, true);
  assert.equal(s.title, 'Install agy via script');
  assert.equal(planSummary(plan).sudo, false);
  assert.throws(() => mockPlan('shell', 'install', MACHINE), /built in/);
});

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

test('mock: install job streams progress by jobId, then the agent list shows the install', async (t) => {
  const core = new MockCore({ speed: 0, autoplay: false });
  const client = new BizziClient({ createSocket: createMockSocketFactory(core) });
  const scheduler = createManualScheduler();
  const store = new BizziStore(client, { scheduler });
  t.after(() => {
    store.dispose();
    client.close();
  });
  await client.connect('mock://local');
  const flushUntil = (cond: () => boolean): Promise<void> =>
    waitFor(() => {
      scheduler.flush();
      return cond();
    });
  await flushUntil(() => selectAgents(store.getState(), MACHINE.id) !== null);
  const plan = await store.planAgent({ machineId: MACHINE.id, agent: 'agy', action: 'install' });
  assert.equal(plan.method, 'brew');
  const started = await store.installAgent({ machineId: MACHINE.id, agent: 'agy', action: 'install' });
  assert.equal(started.machineId, MACHINE.id);
  await flushUntil(() => store.getState().jobs[started.jobId]?.done === true);
  const done = store.getState().jobs[started.jobId];
  assert.equal(done?.ok, true);
  assert.equal(done?.step, done?.total);
  assert.ok((done?.log.length ?? 0) >= plan.steps.length);
  assert.equal(selectAgentJob(store.getState(), MACHINE.id, 'agy')?.jobId, started.jobId);
  await flushUntil(() => selectAgents(store.getState(), MACHINE.id)?.find((a) => a.agent === 'agy')?.installed === true);

  // Offline machines refuse provisioning.
  await assert.rejects(store.planAgent({ machineId: SERVER.id, agent: 'claude', action: 'update' }), (e: unknown) => (e as { code?: string }).code === 'machine_offline');
});

test('mock: login prints a URL and code, completes after the code is typed', async (t) => {
  const core = new MockCore({ speed: 0, autoplay: false });
  const client = new BizziClient({ createSocket: createMockSocketFactory(core) });
  const scheduler = createManualScheduler();
  const store = new BizziStore(client, { scheduler });
  t.after(() => {
    store.dispose();
    client.close();
  });
  await client.connect('mock://local');
  const flushUntil = (cond: () => boolean): Promise<void> =>
    waitFor(() => {
      scheduler.flush();
      return cond();
    });
  const session = await store.loginAgent({ machineId: MACHINE.id, agent: 'codex' });
  assert.equal(session.mode, 'terminal');
  await store.openSession(session.id);
  await flushUntil(() => (store.getState().timelines[session.id]?.login?.urls.length ?? 0) > 0);
  const login = store.getState().timelines[session.id]?.login;
  assert.equal(login?.codes.length, 1);
  assert.equal(login?.awaitingCodeInput, true);
  assert.equal(store.getState().timelines[session.id]?.prompt, 'login');
  await store.termInput(session.id, 'ABC123\r');
  await flushUntil(() => store.getState().timelines[session.id]?.login?.result?.ok === true);
  assert.equal(store.getState().timelines[session.id]?.terminalExit?.exitCode, 0);
  await store.loadAgents(MACHINE.id);
  scheduler.flush();
  assert.equal(selectAgents(store.getState(), MACHINE.id)?.find((a) => a.agent === 'codex')?.auth, 'ok');

  // Secrets: seeded key, set, delete.
  const before = await store.listSecrets(MACHINE.id);
  assert.deepEqual(before.map((s) => s.name), ['ANTHROPIC_API_KEY']);
  await store.setSecret({ machineId: MACHINE.id, agent: 'agy', name: 'GEMINI_API_KEY', value: 'x' });
  assert.equal((await store.listSecrets(MACHINE.id, 'agy')).length, 1);
  await store.deleteSecret({ machineId: MACHINE.id, agent: 'agy', name: 'GEMINI_API_KEY' });
  assert.equal((await store.listSecrets(MACHINE.id)).length, 1);
});
