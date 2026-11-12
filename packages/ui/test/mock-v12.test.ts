import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { BizziError } from '@bizzi/protocol';
import {
  BizziClient,
  BizziStore,
  createManualScheduler,
  selectAccounts,
  selectHelperTreeModel,
  selectMachineSummary,
  selectMachineWorkspaces,
  selectWidgets,
  selectWorkspaceRow,
  versionChip,
} from '@bizzi/client';
import { MockCore, createMockSocketFactory } from '../src/mock/mockServer.ts';

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

async function connect(t: TestContext) {
  const core = new MockCore({ speed: 0, autoplay: false });
  const client = new BizziClient({ createSocket: createMockSocketFactory(core) });
  const scheduler = createManualScheduler();
  const store = new BizziStore(client, { scheduler });
  t.after(() => {
    store.dispose();
    client.close();
    core.dispose();
  });
  await client.connect('mock://local', 'demo');
  const until = (cond: () => boolean): Promise<void> =>
    waitFor(() => {
      scheduler.flush();
      return cond();
    });
  await until(() => store.getState().sessionsLoaded && store.getState().agents.m_laptop !== undefined && store.getState().agents.m_mini !== undefined);
  return { core, store, until };
}

test('mock 1.2: accounts, widgets, sidebar rows, helpers and worktrees', async (t) => {
  const { store, until } = await connect(t);
  await until(() => store.getState().usageState === 'ok' && Object.keys(store.getState().widgets).length > 0);
  const s = store.getState();
  // Codex at 85% is the most constrained login.
  assert.deepEqual(
    selectAccounts(s).map((a) => a.agent),
    ['codex', 'claude', 'opencode'],
  );
  assert.ok(selectWidgets(s, 'bar').some((w) => w.id === 'litellm-billed' && w.format === 'usd'));
  assert.ok(selectWidgets(s, 'machine', 'm_laptop').some((w) => w.error));

  // acme-shop: s_review/s_plan wait; the parent s_lead carries its two helpers.
  const row = selectWorkspaceRow(s, 'w_acme');
  const lead = row.marks.find((m) => m.sessionId === 's_lead');
  assert.equal(lead?.helpers, 2);
  assert.equal(lead?.state, 'waiting', 'the budget-blocked helper escalates the parent mark');
  assert.ok(!row.marks.some((m) => m.sessionId === 's_helper_review' || m.sessionId === 's_helper_explore'));
  assert.equal(row.urgent?.state, 'waiting');

  // mac-mini: a Codex session finished while away; opening it clears "done, not yet seen".
  assert.equal(selectWorkspaceRow(s, 'w_ext').marks[0]?.state, 'done');
  await store.openSession('s_ext');
  await until(() => (store.getState().timelines.s_ext?.lastSeq ?? 0) > 3);
  assert.match(selectWorkspaceRow(store.getState(), 'w_ext').urgent?.text ?? '', /Removed five unused selectors/);
  store.markSeen('s_ext');
  await until(() => selectWorkspaceRow(store.getState(), 'w_ext').marks[0]?.state === 'idle');

  // Worktrees group under their repo; removing a dirty one needs force.
  assert.deepEqual(
    selectMachineWorkspaces(s, 'm_laptop').map((r) => `${r.workspace.id}@${r.depth}`),
    ['w_acme@0', 'w_acme_oauth@1', 'w_fo1@1', 'w_fo2@1', 'w_fo3@1', 'w_notes@0'],
  );
  // A live helper blocks removal outright; after it stops, uncommitted changes still need force.
  await assert.rejects(store.removeWorktree('w_acme_oauth', true), (e: unknown) => e instanceof BizziError && e.code === 'conflict' && (e.data as { sessions?: string[] }).sessions?.[0] === 's_helper_review');
  await store.stop('s_helper_review');
  await assert.rejects(store.removeWorktree('w_acme_oauth'), (e: unknown) => e instanceof BizziError && e.code === 'conflict' && Array.isArray((e.data as { paths?: string[] }).paths));
  const wt = await store.createWorktree({ workspaceId: 'w_acme', branch: 'feat/fanout' });
  assert.equal(wt.parentWorkspaceId, 'w_acme');
  await store.loadGitStatus(wt.id);
  assert.equal(store.getState().gitStatus[wt.id]?.branch, 'feat/fanout');
  await store.removeWorktree(wt.id);
  await store.removeWorktree('w_acme_oauth', true);
  store.flush();
  assert.equal(store.getState().workspaces?.w_acme_oauth, undefined);

  // The tree view counts metered spend only (the Codex reviewer).
  await Promise.all(['s_lead', 's_helper_review', 's_helper_explore'].map((id) => store.openSession(id)));
  await until(() => (selectHelperTreeModel(store.getState(), 's_lead')?.meteredUsd ?? 0) > 0);
  assert.equal(selectHelperTreeModel(store.getState(), 's_lead')?.meteredUsd, 2);
});

test('mock 1.2: provisioning alerts, migrate, policies, restart a stale session', async (t) => {
  const { store, until } = await connect(t);
  const summary = selectMachineSummary(store.getState(), 'm_laptop');
  assert.deepEqual(summary.unsupported, ['opencode']);
  assert.equal(summary.staleSessions, 1);

  // Structured sessions refuse an unsupported install; terminal mode still works.
  await assert.rejects(store.createSession({ workspaceId: 'w_notes', agent: 'opencode', mode: 'structured' }), (e: unknown) => e instanceof BizziError && e.code === 'agent_unavailable');
  await store.createSession({ workspaceId: 'w_notes', agent: 'opencode', mode: 'terminal' });

  // Migrate: dry run previews the plan, then the job switches the method.
  const preview = await store.migrateAgent({ machineId: 'm_laptop', agent: 'claude', toMethod: 'installer', dryRun: true });
  assert.equal(preview.job, null);
  assert.equal(preview.plan.method, 'installer');
  const { job } = await store.migrateAgent({ machineId: 'm_laptop', agent: 'claude', toMethod: 'installer' });
  assert.ok(job);
  assert.equal(job.action, 'migrate');
  await until(() => store.getState().jobs[job.jobId]?.done === true);
  await until(() => store.getState().agents.m_laptop?.find((a) => a.agent === 'claude')?.method === 'installer');

  // Upgrade OpenCode v1 → v2 clears the alert.
  const up = await store.installAgent({ machineId: 'm_laptop', agent: 'opencode', action: 'update' });
  assert.ok(up.plan?.steps.some((st) => st.command === 'opencode upgrade --major'));
  await until(() => store.getState().agents.m_laptop?.find((a) => a.agent === 'opencode')?.support === 'ok');

  const listing = await store.setAgentPolicy({ machineId: 'm_laptop', agent: 'codex', update: 'pinned', restart: 'manual' });
  assert.equal(listing.updatePolicy, 'pinned');
  assert.equal(store.getState().agents.m_laptop?.find((a) => a.agent === 'codex')?.restartPolicy, 'manual');

  // s_demo runs 2.4.0; after the migration 2.4.3 is installed. Restart shows a divider and updates the chip.
  const claude = store.getState().agents.m_laptop?.find((a) => a.agent === 'claude');
  assert.equal(versionChip(store.getState().sessions.s_demo ?? {}, claude)?.stale, true);
  await store.openSession('s_demo');
  await store.restartSession('s_demo');
  await until(() => store.getState().sessions.s_demo?.agentVersion === claude?.version);
  const tl = store.getState().timelines.s_demo;
  assert.ok(tl && Object.values(tl.items).some((i) => i.kind === 'restart' && i.state === 'ok'));
  // The migration installed a newer version, so s_plan and s_lead (2.4.1) are stale now too; s_demo no longer is.
  await until(() => (store.getState().agents.m_laptop?.find((a) => a.agent === 'claude')?.staleSessions ?? -1) === 2);

  // Orchestration settings: machine defaults with a workspace override.
  const ws = await store.getOrchestrationSettings({ machineId: 'm_laptop', workspaceId: 'w_acme' });
  assert.equal(ws.maxDepth, 1);
  assert.equal(ws.maxHelpersPerMachine, 6);
  const next = await store.setOrchestrationSettings({ machineId: 'm_laptop', settings: { onLimit: 'queue' } });
  assert.equal(next.onLimit, 'queue');
  await assert.rejects(store.setOrchestrationSettings({ machineId: 'm_laptop', settings: { maxDepth: 9 } }), (e: unknown) => e instanceof BizziError && e.code === 'bad_request');
});

test('mock: machine.set updates tags and description through the store', async (t) => {
  const { store, until } = await connect(t);
  const next = await store.setMachine({ machineId: 'm_mini', tags: ['gui', 'Always-On'], description: 'Builds.' });
  assert.deepEqual(next.tags, ['gui', 'always-on']);
  await until(() => store.getState().machines.m_mini?.description === 'Builds.');
  assert.equal(store.getState().machines.m_mini?.online, true);
  await store.setMachine({ machineId: 'm_mini', description: '' });
  await until(() => store.getState().machines.m_mini?.description === undefined);
  await assert.rejects(store.setMachine({ machineId: 'm_mini', tags: ['bad tag'] }), (e: unknown) => e instanceof BizziError && e.code === 'bad_request');
  await assert.rejects(store.setMachine({ machineId: 'm_server', tags: [] }), (e: unknown) => e instanceof BizziError && e.code === 'machine_offline');
});
