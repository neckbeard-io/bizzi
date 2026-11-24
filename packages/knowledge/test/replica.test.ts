import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BizziError } from '@bizzi/protocol';
import { contentHash, parseRemoteItem } from '../src/index.ts';
import { M1, M2, P1, memStore, testClock } from './helpers.ts';

const isBad = (e: unknown) => e instanceof BizziError && e.code === 'bad_request';

test('parseRemoteItem round-trips a stored item through JSON', () => {
  const { store } = memStore();
  const item = store.insert({
    type: 'memory',
    kind: 'gotcha',
    scope: { level: 'project', projectId: P1 },
    appliesTo: ['codex'],
    title: 'Staging DB',
    body: 'Port 6543.',
    tags: ['db'],
    source: { machineId: M1, via: 'harvest', agent: 'claude', ref: 'claude:/x/y.md', projectId: P1 },
    status: 'active',
    noticePending: true,
  });
  assert.deepEqual(parseRemoteItem(JSON.parse(JSON.stringify(item))), item);
});

test('parseRemoteItem rejects malformed records', () => {
  const { store } = memStore();
  const good = JSON.parse(JSON.stringify(store.insert({ type: 'rule', scope: { level: 'global' }, title: 'T', body: 'B', source: { machineId: M1, via: 'ui' }, status: 'active' })));
  const variants: Record<string, unknown>[] = [
    { ...good, id: '' },
    { ...good, hlc: 'yesterday' },
    { ...good, type: 'note' },
    { ...good, status: 'archived' },
    { ...good, scope: { level: 'project' } },
    { ...good, scope: { level: 'planet' } },
    { ...good, tags: 'db' },
    { ...good, appliesTo: ['emacs'] },
    { ...good, source: { via: 'ui' } },
    { ...good, source: { machineId: M1, via: 'fax' } },
    { ...good, kind: 'rumour' },
  ];
  for (const v of variants) assert.throws(() => parseRemoteItem(v), isBad, JSON.stringify(v).slice(0, 80));
  assert.throws(() => parseRemoteItem(null), isBad);
});

test('applyRemote recomputes the content hash instead of trusting the sender', () => {
  const a = memStore().store;
  const b = memStore({ machineId: M2, clock: testClock(Date.parse('2026-11-02T00:00:00Z')) }).store;
  const item = a.insert({ type: 'rule', scope: { level: 'global' }, title: 'Use pnpm', body: 'Never npm.', source: { machineId: M1, via: 'ui' }, status: 'active' });
  assert.equal(b.applyRemote({ ...item, contentHash: 'forged' }), true);
  assert.equal(b.get(item.id)?.contentHash, contentHash('rule', 'Use pnpm', 'Never npm.'));
});
