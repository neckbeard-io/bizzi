import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GLOBAL_CHANNEL, type AccountUsage, type InputBlock, type ThemeFile } from '@bizzi/protocol';
import { createNode, mergeAccountUsage, normalizeAccountUsage, type NodeExtension } from '../src/index.ts';
import { FakeAdapter, type FakeStep } from '../src/testing/index.ts';
import { record, tempDir, waitFor } from './helpers.ts';

/** A turn whose text is a JSON AccountUsage emits it as an `account.usage` session event. */
function usageScript(input: InputBlock[]): FakeStep[] {
  const first = input[0];
  const text = first?.type === 'text' ? first.text : '';
  return [{ type: 'emit', event: { type: 'account.usage', data: JSON.parse(text) as AccountUsage } }, { type: 'text', text: 'ok' }];
}

function snapshot(over: Partial<AccountUsage> = {}): AccountUsage {
  return {
    agent: 'claude',
    accountId: 'mc@example.com',
    label: 'claude · max · mc@…',
    billing: 'plan',
    machines: ['m_elsewhere'],
    windows: [{ id: 'five_hour', label: '5h', usedPercent: 62, resetsAt: '2026-11-10T20:00:00.000Z' }],
    status: 'ok',
    observedAt: '2026-11-10T18:00:00.000Z',
    ...over,
  };
}

async function openNode(dataDir: string, extensions: NodeExtension[] = []) {
  return createNode({
    dataDir,
    adapters: [new FakeAdapter({ script: usageScript })],
    version: '0.0.0-test',
    machineName: 'usage-test',
    extensions,
  });
}

test('account.usage session events become per-login snapshots: newest wins, republished, persisted', async (t) => {
  const dir = tempDir();
  const wsDir = tempDir('bizzi-core-ws-');
  t.after(() => {
    dir.cleanup();
    wsDir.cleanup();
  });
  let node = await openNode(dir.path);
  const global = record(node, GLOBAL_CHANNEL);
  const { workspace } = await node.call('workspace.create', { path: wsDir.path });
  const { session } = await node.call('session.create', { workspaceId: workspace.id, agent: 'claude' });
  const send = async (u: AccountUsage) => {
    const ch = `session:${session.id}`;
    const before = node.bus.replay(ch).filter((e) => e.type === 'turn.completed').length;
    await node.call('session.send', { sessionId: session.id, input: [{ type: 'text', text: JSON.stringify(u) }] });
    await waitFor(() => node.bus.replay(ch).filter((e) => e.type === 'turn.completed').length > before, 5000, 'turn');
  };
  const usageEvents = () => global.events.filter((e) => e.type === 'account.usage');

  await send(snapshot());
  let { accounts } = await node.call('usage.list', {});
  assert.equal(accounts.length, 1);
  assert.deepEqual(accounts[0]!.machines, [node.machine.id], 'machines is this machine');
  assert.equal(accounts[0]!.windows?.[0]?.usedPercent, 62);
  assert.equal(usageEvents().length, 1);
  assert.deepEqual((usageEvents()[0]!.data as { usage: AccountUsage }).usage, accounts[0]);

  // An older observation is ignored.
  await send(snapshot({ observedAt: '2026-11-10T17:00:00.000Z', windows: [{ id: 'five_hour', label: '5h', usedPercent: 10 }] }));
  ({ accounts } = await node.call('usage.list', {}));
  assert.equal(accounts[0]!.windows?.[0]?.usedPercent, 62);
  assert.equal(usageEvents().length, 1);

  // Same values, newer observation: stored, not republished (within the republish interval).
  await send(snapshot({ observedAt: '2026-11-10T18:00:10.000Z' }));
  ({ accounts } = await node.call('usage.list', {}));
  assert.equal(accounts[0]!.observedAt, '2026-11-10T18:00:10.000Z');
  assert.equal(usageEvents().length, 1);

  // A change is republished.
  await send(snapshot({ observedAt: '2026-11-10T18:01:00.000Z', status: 'warning', windows: [{ id: 'five_hour', label: '5h', usedPercent: 85 }] }));
  assert.equal(usageEvents().length, 2);

  // A second login, and an invalid snapshot that is dropped.
  await send(snapshot({ agent: 'codex', accountId: 'acct-2', billing: 'plan', status: 'limited', label: 'codex · pro' }));
  await send({ agent: 'nope' } as unknown as AccountUsage);
  ({ accounts } = await node.call('usage.list', {}));
  assert.deepEqual(accounts.map((a) => a.agent), ['codex', 'claude'], 'most constrained first');
  global.stop();
  await node.close();

  // Persisted across restarts.
  node = await openNode(dir.path);
  t.after(() => node.close());
  ({ accounts } = await node.call('usage.list', {}));
  assert.deepEqual(
    accounts.map((a) => [a.agent, a.accountId, a.status, a.observedAt]),
    [
      ['codex', 'acct-2', 'limited', '2026-11-10T18:00:00.000Z'],
      ['claude', 'mc@example.com', 'warning', '2026-11-10T18:01:00.000Z'],
    ],
  );
});

test('extensions report widget-backed logins through node.usage', async (t) => {
  const dir = tempDir();
  t.after(() => dir.cleanup());
  let reported: AccountUsage | undefined;
  const ext: NodeExtension = {
    methods: {},
    start: (ctx) => {
      reported = ctx.node.usage.report({
        agent: 'claude',
        accountId: 'claude-via-litellm',
        label: 'billed',
        billing: 'metered',
        machines: [],
        spend: { usd: 554, capUsd: 2474 },
        status: 'ok',
        observedAt: new Date().toISOString(),
      });
    },
  };
  const node = await openNode(dir.path, [ext]);
  t.after(() => node.close());
  assert.equal(reported?.machines[0], node.machine.id);
  const { accounts } = await node.call('usage.list', {});
  assert.deepEqual(accounts[0]!.spend, { usd: 554, capUsd: 2474 });
});

test('mergeAccountUsage: newest observation wins, machines are the union', () => {
  const a = snapshot({ machines: ['m_a'], observedAt: '2026-11-10T18:00:00.000Z' });
  const b = snapshot({ machines: ['m_b'], observedAt: '2026-11-10T19:00:00.000Z', status: 'warning' });
  const merged = mergeAccountUsage([b, a]);
  assert.equal(merged?.status, 'warning');
  assert.deepEqual(merged?.machines, ['m_a', 'm_b']);
  assert.equal(mergeAccountUsage([]), undefined);
  assert.equal(normalizeAccountUsage({ agent: 'claude', accountId: 'x' }), undefined, 'billing is required');
  const n = normalizeAccountUsage({ agent: 'claude', accountId: 'x', billing: 'plan', windows: [{ id: 'w' }, { id: 'v', usedPercent: 3 }], extra: 1 });
  assert.deepEqual(n?.windows, [{ id: 'v', label: 'v', usedPercent: 3 }]);
  assert.equal(n?.status, 'unknown');
  assert.equal('extra' in (n ?? {}), false);
});

test('themes CRUD on a node (local mode), persisted', async (t) => {
  const dir = tempDir();
  t.after(() => dir.cleanup());
  let node = await openNode(dir.path);
  const { theme } = await node.call('theme.save', { name: '  Warm Nord ', data: { palette: { bg: '#2e3440' } } });
  assert.match(theme.id, /^th_[0-9A-Z]{26}$/);
  assert.equal(theme.name, 'Warm Nord');
  const { theme: renamed } = await node.call('theme.save', { id: theme.id, name: 'Nord warm', data: { palette: { bg: '#3b4252' } } });
  assert.equal(renamed.id, theme.id);
  await node.call('theme.save', { id: 'custom-1', name: 'Another', data: [] });
  let { themes } = await node.call('themes.list', {});
  assert.deepEqual(themes.map((x: ThemeFile) => [x.id, x.name]), [
    ['custom-1', 'Another'],
    [theme.id, 'Nord warm'],
  ]);

  await assert.rejects(node.call('theme.save', { name: '', data: {} }), { code: 'bad_request' });
  await assert.rejects(node.call('theme.save', { name: 'x' } as never), { code: 'bad_request' });
  await assert.rejects(node.call('theme.save', { name: 'big', data: 'x'.repeat(300 * 1024) }), { code: 'bad_request' });
  await assert.rejects(node.call('theme.save', { id: '../etc', name: 'bad id', data: {} }), { code: 'bad_request' });
  await assert.rejects(node.call('theme.delete', { id: 'missing' }), { code: 'not_found' });
  await node.call('theme.delete', { id: 'custom-1' });
  await node.close();

  node = await openNode(dir.path);
  t.after(() => node.close());
  ({ themes } = await node.call('themes.list', {}));
  assert.deepEqual(themes.map((x: ThemeFile) => x.data), [{ palette: { bg: '#3b4252' } }]);
});
