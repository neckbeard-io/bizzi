// Identity colour and icon (spec §11.1): machine.set { color }, workspace.set { name, color, icon }.

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { BizziError, GLOBAL_CHANNEL, LABEL_COLORS, isLabelColor, isLabelIcon } from '@bizzi/protocol';
import { makeNode, record, tempDir } from './helpers.ts';

const rejectsWith = (code: string) => (err: unknown) => err instanceof BizziError && err.code === code;

test('label predicates: palette names and short icons', () => {
  for (const c of LABEL_COLORS) assert.ok(isLabelColor(c));
  for (const bad of ['Red', '#ff0000', '', 'grey', 1, null]) assert.equal(isLabelColor(bad), false, String(bad));
  for (const ok of ['A', 'ab', 'λ', '🚀', '👩‍💻', '🇸🇪', '🏴󠁧󠁢󠁳󠁣󠁴󠁿', 'W1']) assert.ok(isLabelIcon(ok), ok);
  for (const bad of ['', 'abc', 'a b', ' a', '\n', 'a‮', '​', '🚀🚀🚀', 'x'.repeat(17), 3]) assert.equal(isLabelIcon(bad), false, JSON.stringify(bad));
});

test('machine.set stores a colour, keeps it across restarts, and clears it with an empty string', async (t) => {
  const dir = tempDir();
  t.after(() => dir.cleanup());
  const node = await makeNode(dir.path);
  const log = record(node, GLOBAL_CHANNEL);
  await node.call('machine.set', { tags: ['gui'], description: 'Mac mini.' });
  const { machine } = await node.call('machine.set', { color: 'teal' });
  assert.equal(machine.color, 'teal');
  assert.deepEqual(machine.tags, ['gui'], 'other fields are kept');
  assert.equal(machine.description, 'Mac mini.');
  const ev = await log.waitFor('machine.updated', (e) => e.data.machine.color === 'teal');
  assert.deepEqual(ev.data.machine.tags, ['gui']);
  // Tags and description edits keep the colour.
  assert.equal((await node.call('machine.set', { tags: ['gui', 'always-on'] })).machine.color, 'teal');
  log.stop();
  await node.close();

  const again = await makeNode(dir.path);
  try {
    assert.equal(again.machine.color, 'teal');
    assert.equal((await again.call('machines.list', {})).machines[0]?.color, 'teal');
    const cleared = await again.call('machine.set', { color: '' });
    assert.equal(cleared.machine.color, undefined);
    assert.equal('color' in again.machine, false);
    await assert.rejects(again.call('machine.set', { color: 'magenta' as never }), rejectsWith('bad_request'));
    await assert.rejects(again.call('machine.set', { color: '#ff0000' as never }), rejectsWith('bad_request'));
    await assert.rejects(again.call('machine.set', { color: 3 as never }), rejectsWith('bad_request'));
    assert.equal(again.machine.color, undefined, 'a rejected call changes nothing');
  } finally {
    await again.close();
  }
});

test('workspace.set renames and sets colour and icon, emits workspace.updated, and persists', async (t) => {
  const dir = tempDir();
  t.after(() => dir.cleanup());
  const wsDir = join(dir.path, 'site');
  mkdirSync(wsDir);
  const node = await makeNode(join(dir.path, 'data'));
  const { workspace: created } = await node.call('workspace.create', { path: wsDir });
  const log = record(node, GLOBAL_CHANNEL);

  const { workspace } = await node.call('workspace.set', { workspaceId: created.id, name: '  Website  ', color: 'orange', icon: ' 🚀 ' });
  assert.equal(workspace.name, 'Website');
  assert.equal(workspace.color, 'orange');
  assert.equal(workspace.icon, '🚀');
  assert.equal(workspace.path, created.path, 'the directory is untouched');
  const ev = await log.waitFor('workspace.updated', (e) => e.data.workspace.id === created.id);
  assert.deepEqual(ev.data.workspace, workspace);

  // Omitted fields are kept; a call that changes nothing emits nothing.
  const same = await node.call('workspace.set', { workspaceId: created.id, color: 'orange' });
  assert.deepEqual(same.workspace, workspace);
  const icon = await node.call('workspace.set', { workspaceId: created.id, icon: '' });
  assert.equal(icon.workspace.icon, undefined);
  assert.equal(icon.workspace.color, 'orange');
  await log.waitFor('workspace.updated', (e) => e.data.workspace.icon === undefined);
  assert.equal(log.events.filter((e) => e.type === 'workspace.updated').length, 2);
  log.stop();
  await node.close();

  const again = await makeNode(join(dir.path, 'data'));
  try {
    const [w] = (await again.call('workspaces.list', {})).workspaces;
    assert.equal(w?.name, 'Website');
    assert.equal(w?.color, 'orange');
    assert.equal(w?.icon, undefined);
    const cleared = await again.call('workspace.set', { workspaceId: created.id, color: '' });
    assert.equal('color' in cleared.workspace, false);
  } finally {
    await again.close();
  }
});

test('workspace.set validates its fields and the workspace', async (t) => {
  const dir = tempDir();
  const wsDir = join(dir.path, 'repo');
  mkdirSync(wsDir);
  const node = await makeNode(join(dir.path, 'data'));
  t.after(async () => {
    await node.close();
    dir.cleanup();
  });
  const { workspace } = await node.call('workspace.create', { path: wsDir });
  const id = workspace.id;
  await assert.rejects(node.call('workspace.set', { workspaceId: 'w_nope', color: 'red' }), rejectsWith('not_found'));
  await assert.rejects(node.call('workspace.set', { color: 'red' } as never), rejectsWith('bad_request'));
  await assert.rejects(node.call('workspace.set', { workspaceId: id, color: 'brown' as never }), rejectsWith('bad_request'));
  await assert.rejects(node.call('workspace.set', { workspaceId: id, icon: 'abc' }), rejectsWith('bad_request'));
  await assert.rejects(node.call('workspace.set', { workspaceId: id, icon: 'a b' }), rejectsWith('bad_request'));
  await assert.rejects(node.call('workspace.set', { workspaceId: id, icon: 7 as never }), rejectsWith('bad_request'));
  await assert.rejects(node.call('workspace.set', { workspaceId: id, name: '   ' }), rejectsWith('bad_request'));
  await assert.rejects(node.call('workspace.set', { workspaceId: id, name: 'x'.repeat(201) }), rejectsWith('bad_request'));
  await assert.rejects(node.call('workspace.set', { workspaceId: id, name: 'a\nb' }), rejectsWith('bad_request'));
  // A bad field rejects the whole call: the good ones aren't applied either.
  await assert.rejects(node.call('workspace.set', { workspaceId: id, color: 'red', icon: 'toolong' }), rejectsWith('bad_request'));
  const [w] = (await node.call('workspaces.list', {})).workspaces;
  assert.equal(w?.color, undefined);
  assert.equal(w?.name, 'repo');
});
