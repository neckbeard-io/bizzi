import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { BizziNode } from '../src/index.ts';
import { createNode, median } from '../src/index.ts';
import { FakeAdapter, type FakeStep } from '../src/testing/index.ts';
import { tempDir, waitFor } from './helpers.ts';
import type { InputBlock } from '@bizzi/protocol';

/** A turn whose text is "ctx <n>" reports context.updated { used: n }. */
function script(input: InputBlock[]): FakeStep[] {
  const first = input[0];
  const m = first?.type === 'text' ? /^ctx (\d+)/.exec(first.text) : null;
  const steps: FakeStep[] = [];
  if (m) steps.push({ type: 'emit', event: { type: 'context.updated', data: { used: Number(m[1]), window: 200_000 } } });
  steps.push({ type: 'text', text: 'ok' });
  return steps;
}

function open(dataDir: string): Promise<BizziNode> {
  return createNode({ dataDir, adapters: [new FakeAdapter({ script })], version: '0.0.0-test', machineName: 'baselines-test' });
}

async function turn(node: BizziNode, sessionId: string, text: string): Promise<void> {
  const ch = `session:${sessionId}`;
  const before = node.bus.replay(ch).filter((e) => e.type === 'turn.completed').length;
  await waitFor(() => node.sessions.get(sessionId).session.status === 'idle', 5000, 'idle');
  await node.call('session.send', { sessionId, input: [{ type: 'text', text }] });
  await waitFor(() => node.bus.replay(ch).filter((e) => e.type === 'turn.completed').length > before, 5000, 'turn');
}

test('median: odd, even, empty', () => {
  assert.equal(median([]), 0);
  assert.equal(median([5]), 5);
  assert.equal(median([9, 1, 5]), 5);
  assert.equal(median([1, 2, 3, 10]), 3); // (2 + 3) / 2 rounded
  assert.equal(median([10_000, 14_000]), 12_000);
});

test('baselines: first context report per session, rolling median of the last 10, persisted', async (t) => {
  const dir = tempDir();
  const wsDir = tempDir('bizzi-core-ws-');
  t.after(() => {
    dir.cleanup();
    wsDir.cleanup();
  });
  let node = await open(dir.path);
  const { workspace } = await node.call('workspace.create', { path: wsDir.path });

  // Only the first report of a session counts.
  const { session: a } = await node.call('session.create', { workspaceId: workspace.id, agent: 'claude', model: 'opus' });
  await turn(node, a.id, 'ctx 14000');
  await turn(node, a.id, 'ctx 90000');
  let { baselines } = await node.call('baselines.list', {});
  assert.equal(baselines.length, 1);
  assert.equal(baselines[0]?.agent, 'claude');
  assert.equal(baselines[0]?.workspaceId, workspace.id);
  assert.equal(baselines[0]?.machineId, node.machine.id);
  assert.equal(baselines[0]?.tokens, 14_000);
  assert.equal(baselines[0]?.samples, 1);
  const model = baselines[0]?.model;

  // Twelve more sessions: only the last 10 samples are kept.
  for (let i = 0; i < 12; i++) {
    const { session } = await node.call('session.create', { workspaceId: workspace.id, agent: 'claude', model: 'opus' });
    await turn(node, session.id, `ctx ${20_000 + i * 1000}`);
  }
  ({ baselines } = await node.call('baselines.list', { workspaceId: workspace.id }));
  assert.equal(baselines.length, 1);
  assert.equal(baselines[0]?.samples, 10);
  // Samples 22k..31k → median (26k + 27k) / 2.
  assert.equal(baselines[0]?.tokens, 26_500);

  // A machineId other than ours is not_found; an unknown workspace returns nothing.
  await assert.rejects(node.call('baselines.list', { machineId: 'm_other' }), /not this node/);
  assert.deepEqual((await node.call('baselines.list', { workspaceId: 'w_nope' })).baselines, []);

  // Persisted across a restart; the already-sampled session doesn't count again.
  await node.close();
  node = await open(dir.path);
  t.after(() => node.close());
  ({ baselines } = await node.call('baselines.list', {}));
  assert.equal(baselines[0]?.tokens, 26_500);
  assert.equal(baselines[0]?.samples, 10);
  assert.equal(baselines[0]?.model, model);
});

test('baselines: worktree sessions count toward the repo workspace; group is stored on the session', async (t) => {
  const dir = tempDir();
  const repo = tempDir('bizzi-core-repo-');
  t.after(() => {
    dir.cleanup();
    repo.cleanup();
  });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo.path, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo.path, 'a.txt'), 'a\n');
  git('add', '.');
  git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');

  const node = await open(dir.path);
  t.after(async () => {
    await node.close();
    // `git worktree add` puts worktrees next to the repo (<repo>.worktrees/…).
    rmSync(`${repo.path}.worktrees`, { recursive: true, force: true });
  });
  const { workspace } = await node.call('workspace.create', { path: repo.path });
  const { workspace: wt } = await node.call('worktree.create', { workspaceId: workspace.id, branch: 'main-fanout-1-claude' });
  const { session } = await node.call('session.create', { workspaceId: wt.id, agent: 'claude', group: 'fo_test' });
  assert.equal(session.group, 'fo_test');
  assert.equal(node.sessions.get(session.id).session.group, 'fo_test');
  await assert.rejects(node.call('session.create', { workspaceId: wt.id, agent: 'claude', group: 'x'.repeat(129) }), /at most 128/);
  await turn(node, session.id, 'ctx 12000');
  const { baselines } = await node.call('baselines.list', { workspaceId: wt.id });
  assert.equal(baselines.length, 1);
  assert.equal(baselines[0]?.workspaceId, workspace.id);
  assert.equal(baselines[0]?.tokens, 12_000);
});

