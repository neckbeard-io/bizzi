import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { BizziClient, BizziStore, createManualScheduler, loadBaselines, preflightRun, selectAccounts, selectFanoutGroup, selectFanoutGroups, startFanout } from '@bizzi/client';
import { parseHash, routeHref } from '../src/lib/router.ts';
import { FANOUT_GROUP } from '../src/mock/fanout.ts';
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
  await until(() => store.getState().sessionsLoaded && store.getState().agents.m_laptop !== undefined && store.getState().usageState === 'ok');
  return { store, until };
}

test('fanout route round-trips', () => {
  const r = { name: 'fanout', group: 'fo_x/1' } as const;
  assert.deepEqual(parseHash(routeHref(r)), r);
  assert.deepEqual(parseHash('#/fanout'), { name: 'workspaces' });
});

test('mock fan-out: seeded group, baselines, preflight, start a new group', async (t) => {
  const { store, until } = await connect(t);

  // The seeded three-run group lives under acme-shop.
  const groups = selectFanoutGroups(store.getState(), 'w_acme');
  assert.deepEqual(groups.map((g) => [g.group, g.sessions.map((s) => s.agent)]), [[FANOUT_GROUP, ['claude', 'codex', 'opencode']]]);
  await Promise.all(groups[0]!.sessions.map((s) => store.openSession(s.id)));
  await until(() => selectFanoutGroup(store.getState(), FANOUT_GROUP)?.runs.every((r) => r.finalMessage !== null) === true);
  const g = selectFanoutGroup(store.getState(), FANOUT_GROUP)!;
  assert.deepEqual(g.runs.map((r) => r.billing), ['plan', 'metered', 'budgetless']);
  assert.equal(g.meteredUsd, 0.41, 'only the Codex run on an API key counts');
  assert.equal(g.runs[0]?.branch, 'fix/flaky-checkout-fanout-1-claude');
  const diff = await store.client.request('git.diff', { workspaceId: 'w_fo1' });
  assert.match(diff.diff, /payments\.settled/);

  // Baselines: a worktree answers with its repo's; without a target, every online machine's.
  const inWt = await store.client.request('baselines.list', { workspaceId: 'w_fo2' });
  assert.ok(inWt.baselines.length > 0 && inWt.baselines.every((b) => b.workspaceId === 'w_acme'));
  const laptop = await loadBaselines(store, 'm_laptop');
  assert.ok(laptop.every((b) => b.machineId === 'm_laptop'));

  // Preflight on the laptop: Codex's 5-hour window is at 85% (warning), OpenCode is budgetless (but v1 is
  // unsupported, so it isn't offered as a swap until upgraded).
  const ctx = { machineId: 'm_laptop', workspaceId: 'w_acme', agents: store.getState().agents.m_laptop ?? [], accounts: selectAccounts(store.getState()), baselines: laptop, widgets: Object.values(store.getState().widgets) };
  const codex = preflightRun({ agent: 'codex', model: 'gpt-5.5-codex' }, ctx);
  assert.equal(codex.baseline?.tokens, 14_100);
  assert.ok(codex.warnings.some((w) => /85%/.test(w)));
  assert.equal(codex.swap, null);
  const oc = preflightRun({ agent: 'opencode' }, ctx);
  assert.equal(oc.estimate.kind, 'free');
  assert.equal(oc.estimate.kind === 'free' ? oc.estimate.load?.id : null, 'h200');

  // Start a two-run fan-out: two worktrees, two sessions tagged with one group.
  const res = await startFanout(store, { workspaceId: 'w_acme', prompt: 'Add a retry to payments', branchPrefix: 'main-fanout', runs: [{ agent: 'claude', model: 'opus' }, { agent: 'codex', budgetUsd: 1 }] });
  assert.deepEqual(res.runs.map((r) => r.error ?? r.branch), ['main-fanout-1-claude', 'main-fanout-2-codex']);
  await until(() => selectFanoutGroups(store.getState(), 'w_acme').some((x) => x.group === res.group && x.sessions.length === 2));
  const started = selectFanoutGroup(store.getState(), res.group)!;
  assert.equal(started.title, 'Add a retry to payments');
  assert.deepEqual(started.runs.map((r) => r.workspace?.parentWorkspaceId), ['w_acme', 'w_acme']);
  assert.equal(started.runs.find((r) => r.session.agent === 'codex')?.session.budget?.usd, 1);
});
