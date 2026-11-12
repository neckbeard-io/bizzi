// machine.set: user-owned machine fields (tags, description) for knowledge.md §9.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BizziError, GLOBAL_CHANNEL } from '@bizzi/protocol';
import { makeNode, record, tempDir } from './helpers.ts';

const rejectsWith = (code: string) => (err: unknown) => err instanceof BizziError && err.code === code;

test('machine.set stores tags and description, emits machine.updated, and survives a restart', async (t) => {
  const dir = tempDir();
  t.after(() => dir.cleanup());
  const node = await makeNode(dir.path);
  const log = record(node, GLOBAL_CHANNEL);
  const { machine } = await node.call('machine.set', { tags: ['Prod-Access', 'gui', 'gui'], description: '  Production investigations happen here.  ' });
  assert.deepEqual(machine.tags, ['prod-access', 'gui']);
  assert.equal(machine.description, 'Production investigations happen here.');
  assert.deepEqual(node.machine.tags, ['prod-access', 'gui']);
  const ev = await log.waitFor('machine.updated', (e) => e.data.machine.tags.length === 2);
  assert.equal(ev.data.machine.description, 'Production investigations happen here.');

  // Omitted fields are kept; '' clears the description.
  const kept = await node.call('machine.set', { machineId: node.machine.id, description: '' });
  assert.deepEqual(kept.machine.tags, ['prod-access', 'gui']);
  assert.equal(kept.machine.description, undefined);
  await node.call('machine.set', { description: 'Laptop.' });
  log.stop();
  await node.close();

  const again = await makeNode(dir.path);
  try {
    assert.deepEqual(again.machine.tags, ['prod-access', 'gui']);
    assert.equal(again.machine.description, 'Laptop.');
    assert.deepEqual((await again.call('hello', { protocol: 'bizzi/1', client: { name: 't', version: '0' } })).machine.tags, ['prod-access', 'gui']);
  } finally {
    await again.close();
  }
});

test('machine.set validates tags, description and the target machine', async (t) => {
  const dir = tempDir();
  const node = await makeNode(dir.path);
  t.after(async () => {
    await node.close();
    dir.cleanup();
  });
  await assert.rejects(node.call('machine.set', { tags: ['has space'] }), rejectsWith('bad_request'));
  await assert.rejects(node.call('machine.set', { tags: ['-leading'] }), rejectsWith('bad_request'));
  await assert.rejects(node.call('machine.set', { tags: 'gui' as never }), rejectsWith('bad_request'));
  await assert.rejects(node.call('machine.set', { tags: Array.from({ length: 33 }, (_, i) => `t${i}`) }), rejectsWith('bad_request'));
  await assert.rejects(node.call('machine.set', { description: 'x'.repeat(2001) }), rejectsWith('bad_request'));
  await assert.rejects(node.call('machine.set', { machineId: 'm_other', tags: [] }), rejectsWith('not_found'));
  assert.deepEqual(node.machine.tags, []);
});
