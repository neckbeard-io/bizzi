// AdapterRegistry: listing decorators, last-known probes, and refusing structured sessions on an
// unsupported install (spec §7).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BizziError } from '@bizzi/protocol';
import { FakeAdapter } from '../src/testing/index.ts';
import { makeNode, tempDir } from './helpers.ts';

async function setup(t: { after: (fn: () => unknown) => void }, version: string) {
  const dir = tempDir();
  const structured = new FakeAdapter({ agent: 'opencode', probe: { version } });
  const terminal = new FakeAdapter({ agent: 'opencode', modes: ['terminal'] });
  const node = await makeNode(dir.path, [structured, terminal]);
  t.after(async () => {
    await node.close();
    dir.cleanup();
  });
  const { workspace } = await node.call('workspace.create', { path: `${dir.path}/ws`, create: true });
  return { node, workspace };
}

test('decorators apply on every list, and lastKnown never probes', async (t) => {
  const { node } = await setup(t, '2.0.25');
  assert.equal(node.registry.lastKnown('opencode'), undefined, 'nothing before the first probe');
  let policy = 'auto' as const as 'auto' | 'pinned';
  const remove = node.registry.addDecorator((l) => ({ ...l, updatePolicy: policy }));
  node.registry.addDecorator(() => {
    throw new Error('broken decorator is skipped');
  });
  const [first] = (await node.call('agents.list', {})).agents;
  assert.equal(first?.updatePolicy, 'auto');
  policy = 'pinned';
  assert.equal((await node.call('agents.list', {})).agents[0]?.updatePolicy, 'pinned', 'cached probe, fresh decoration');
  assert.equal(node.registry.lastKnown('opencode')?.updatePolicy, 'pinned');
  remove();
  assert.equal(node.registry.lastKnown('opencode')?.updatePolicy, undefined);
});

test('structured sessions are refused on an unsupported install; terminal mode still starts', async (t) => {
  const { node, workspace } = await setup(t, '1.14.3');
  node.registry.addDecorator((l) =>
    l.version?.startsWith('1.')
      ? { ...l, support: 'unsupported', supportReason: 'OpenCode v1 is not supported', remedies: [{ kind: 'upgrade', title: 'Upgrade to v2' }] }
      : l,
  );
  // Before any probe nothing is known, so nothing is refused.
  await node.call('session.create', { workspaceId: workspace.id, agent: 'opencode', mode: 'structured' });
  await node.call('agents.list', {});
  for (const mode of ['structured', undefined] as const) {
    await assert.rejects(
      node.call('session.create', { workspaceId: workspace.id, agent: 'opencode', ...(mode ? { mode } : {}) }),
      (err: unknown) => {
        assert.ok(err instanceof BizziError);
        assert.equal(err.code, 'unsupported');
        assert.match(err.message, /OpenCode v1 is not supported\. Start a terminal-mode session instead/);
        assert.deepEqual((err.data as { remedies: unknown[] }).remedies, [{ kind: 'upgrade', title: 'Upgrade to v2' }]);
        return true;
      },
    );
  }
  const { session } = await node.call('session.create', { workspaceId: workspace.id, agent: 'opencode', mode: 'terminal' });
  assert.equal(session.mode, 'terminal');
});
