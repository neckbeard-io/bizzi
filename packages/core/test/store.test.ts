import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GLOBAL_CHANNEL } from '@bizzi/protocol';
import { EventBus, nullLogger } from '../src/index.ts';
import { Store } from '../src/store.ts';
import { makeNode, tempDir } from './helpers.ts';

test('append assigns monotonic seq per channel and replay returns seq > since', (t) => {
  const dir = tempDir();
  t.after(dir.cleanup);
  const store = new Store(dir.path);
  t.after(() => store.close());
  const bus = new EventBus(store, nullLogger);

  const a1 = bus.append('session:a', { type: 'message.delta', data: { messageId: 'm', role: 'assistant', text: 'x' } });
  const a2 = bus.append('session:a', { type: 'message.delta', data: { messageId: 'm', role: 'assistant', text: 'y' } });
  const g1 = bus.append(GLOBAL_CHANNEL, { type: 'workspace.removed', data: { workspaceId: 'w_1' } });
  assert.equal(a1.seq, 1);
  assert.equal(a2.seq, 2);
  assert.equal(g1.seq, 1);
  assert.match(a1.ts, /^\d{4}-\d{2}-\d{2}T/);

  assert.deepEqual(bus.replay('session:a').map((e) => e.seq), [1, 2]);
  assert.deepEqual(bus.replay('session:a', 1).map((e) => e.seq), [2]);
  assert.deepEqual(bus.replay('session:a', 0, 1).map((e) => e.seq), [1]);
  assert.deepEqual(bus.replay('session:a', 0)[1], a2);
  assert.equal(bus.lastSeq('session:none'), 0);
});

test('events and seq survive reopening the store', (t) => {
  const dir = tempDir();
  t.after(dir.cleanup);
  let store = new Store(dir.path);
  let bus = new EventBus(store, nullLogger);
  for (let i = 0; i < 5; i++) bus.append('global', { type: 'workspace.removed', data: { workspaceId: `w_${i}` } });
  store.close();

  store = new Store(dir.path);
  t.after(() => store.close());
  bus = new EventBus(store, nullLogger);
  assert.equal(bus.lastSeq('global'), 5);
  const ev = bus.append('global', { type: 'workspace.removed', data: { workspaceId: 'w_5' } });
  assert.equal(ev.seq, 6);
  assert.deepEqual(
    bus.replay('global', 3).map((e) => (e.data as { workspaceId: string }).workspaceId),
    ['w_3', 'w_4', 'w_5'],
  );
});

test('bus.subscribe replays then streams live without gaps or duplicates', (t) => {
  const dir = tempDir();
  t.after(dir.cleanup);
  const store = new Store(dir.path);
  t.after(() => store.close());
  const bus = new EventBus(store, nullLogger);
  for (let i = 0; i < 1200; i++) bus.append('ch', { type: 'workspace.removed', data: { workspaceId: String(i) } } as never);
  const seen: number[] = [];
  const sub = bus.subscribe('ch', 100, (ev) => {
    seen.push(ev.seq);
    // Appending from inside a listener during replay must not produce gaps or dupes either.
    if (ev.seq === 500) bus.append('ch', { type: 'workspace.removed', data: { workspaceId: 'inner' } } as never);
  });
  for (let i = 0; i < 10; i++) bus.append('ch', { type: 'workspace.removed', data: { workspaceId: 'live' } } as never);
  sub.unsubscribe();
  bus.append('ch', { type: 'workspace.removed', data: { workspaceId: 'after' } } as never);
  const expected = Array.from({ length: 1211 - 100 }, (_, i) => i + 101);
  assert.deepEqual(seen, expected);
});

test('machine identity is generated once and stable across restarts', async (t) => {
  const dir = tempDir();
  t.after(dir.cleanup);
  const n1 = await makeNode(dir.path);
  const id = n1.machine.id;
  assert.match(id, /^m_/);
  assert.equal(n1.machine.name, 'test-machine');
  assert.deepEqual(n1.machine.roles, ['node']);
  assert.equal(n1.machine.bizziVersion, '0.0.0-test');
  assert.equal(typeof n1.machine.headful, 'boolean');
  await n1.close();
  const n2 = await makeNode(dir.path);
  t.after(() => n2.close());
  assert.equal(n2.machine.id, id);
  const { machines } = await n2.call('machines.list', {});
  assert.equal(machines[0]?.id, id);
});
