import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { KnowledgeStore, compareHlc, detectFts5 } from '../src/index.ts';
import type { NewKnowledgeItem } from '../src/index.ts';
import { CTX, M1, M2, P1, memStore, tempDir, testClock } from './helpers.ts';

const mem = (over: Partial<NewKnowledgeItem> = {}): NewKnowledgeItem => ({
  type: 'memory',
  scope: { level: 'project', projectId: P1 },
  kind: 'fact',
  title: 'Staging DB location',
  body: 'The staging database runs on server-a port 5433.',
  source: { via: 'ui', machineId: M1 },
  status: 'active',
  ...over,
});

test("Node's bundled SQLite has FTS5", () => {
  assert.equal(detectFts5(), true);
  const { store } = memStore();
  assert.equal(store.ftsAvailable, true);
});

test('insert/get round-trip normalizes scope and tags', () => {
  const { store } = memStore();
  const item = store.insert(
    mem({ scope: { level: 'project', projectId: P1, machineId: 'ignored' }, tags: [' db ', 'db', 'staging'], appliesTo: ['codex', 'codex'] }),
  );
  assert.match(item.id, /^k_/);
  assert.deepEqual(item.scope, { level: 'project', projectId: P1 });
  assert.deepEqual(item.tags, ['db', 'staging']);
  assert.deepEqual(item.appliesTo, ['codex']);
  assert.deepEqual(store.get(item.id), item);
  assert.equal(item.contentHash.length, 64);
});

test('validation: scope ids, one-line title, kinds', () => {
  const { store } = memStore();
  assert.throws(() => store.insert(mem({ scope: { level: 'project' } })), /requires projectId/);
  assert.throws(() => store.insert(mem({ title: 'a\nb' })), /one line/);
  assert.throws(() => store.insert(mem({ title: '  ' })), /title is required/);
  assert.throws(() => store.insert(mem({ kind: 'nope' as never })), /unknown memory kind/);
});

test('patch bumps hlc and updatedAt; FTS index follows edits', () => {
  const { store, clock } = memStore();
  const a = store.insert(mem());
  clock.advance(1000);
  const b = store.patch(a.id, { body: 'Moved: staging now lives on server-b port 6543.' });
  assert.ok(compareHlc(b.hlc, a.hlc) > 0);
  assert.notEqual(b.updatedAt, a.updatedAt);
  assert.notEqual(b.contentHash, a.contentHash);
  assert.equal(store.search('server-a').length, 0);
  assert.equal(store.search('server-b')[0]?.item.id, a.id);
});

test('search: prefix matching, title weighs more, visibility filter', () => {
  const { store } = memStore();
  const inTitle = store.insert(mem({ title: 'Flaky checkout test', body: 'Retries hide it.' }));
  const inBody = store.insert(mem({ title: 'CI notes', body: 'The checkout suite is flaky on Mondays.' }));
  store.insert(mem({ title: 'Unrelated', body: 'Nothing to see.' }));
  store.insert(mem({ title: 'Flaky elsewhere', body: 'other project', scope: { level: 'project', projectId: 'p_OTHER' } }));
  const hits = store.search('flak checkout', { context: CTX });
  assert.deepEqual(
    hits.map((h) => h.item.id),
    [inTitle.id, inBody.id],
  );
  assert.ok(hits.every((h) => h.relevance > 0));
  assert.equal(store.search('flaky').length, 3, 'without a context: all active');
  assert.deepEqual(store.search('   '), []);
});

test('LIKE fallback search works when FTS is disabled', () => {
  const { store } = memStore({ disableFts: true });
  assert.equal(store.ftsAvailable, false);
  const t = store.insert(mem({ title: 'Flaky checkout test', body: 'x' }));
  const b = store.insert(mem({ title: 'CI', body: 'checkout is flaky (100%)' }));
  const hits = store.search('flaky checkout', { context: CTX });
  assert.deepEqual(
    hits.map((h) => h.item.id),
    [t.id, b.id],
  );
  store.insert(mem({ title: 'Naming', body: 'uses snake_case names' }));
  store.insert(mem({ title: 'Other', body: 'snakeXcase' }));
  assert.equal(store.search('snake_case').length, 1, 'LIKE wildcards are escaped');
});

test('tombstones replicate; applyRemote is last-writer-wins by HLC', () => {
  const clockA = testClock();
  const clockB = testClock(clockA.now() + 10_000); // node B's clock runs ahead
  const a = new KnowledgeStore({ path: ':memory:', machineId: M1, now: clockA.now });
  const b = new KnowledgeStore({ path: ':memory:', machineId: M2, now: clockB.now });
  const item = a.insert(mem());
  for (const x of a.changesSince()) assert.equal(b.applyRemote(x), true);
  assert.deepEqual(b.get(item.id), item);
  // B forgets it (tombstone), A edits it concurrently but with an older HLC.
  const tomb = b.setStatus(item.id, 'deleted');
  const edit = a.patch(item.id, { title: 'Staging DB (edited)' });
  assert.ok(compareHlc(tomb.hlc, edit.hlc) > 0);
  assert.equal(a.applyRemote(tomb), true, 'newer tombstone wins on A');
  assert.equal(b.applyRemote(edit), false, 'older edit loses on B');
  assert.equal(a.get(item.id)?.status, 'deleted');
  assert.equal(b.get(item.id)?.status, 'deleted');
  // A's clock has moved past what it received.
  const after = a.insert(mem({ title: 'Later' }));
  assert.ok(compareHlc(after.hlc, tomb.hlc) > 0);
  assert.deepEqual(
    a.changesSince(edit.hlc).map((x) => x.id),
    [item.id, after.id],
  );
});

test('on-disk store: settings persist and HLC stays monotonic across reopen', () => {
  const tmp = tempDir();
  try {
    const path = join(tmp.dir, 'k.db');
    const frozen = () => 1_000;
    const s1 = new KnowledgeStore({ path, machineId: M1, now: frozen });
    const x = s1.insert(mem());
    s1.setSetting('x', { a: 1 });
    s1.close();
    const s2 = new KnowledgeStore({ path, machineId: M1, now: frozen });
    const y = s2.insert(mem({ title: 'Second' }));
    assert.ok(compareHlc(y.hlc, x.hlc) > 0);
    assert.deepEqual(s2.getSetting('x'), { a: 1 });
    s2.close();
  } finally {
    tmp.cleanup();
  }
});
