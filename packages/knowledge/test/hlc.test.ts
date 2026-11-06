import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HybridLogicalClock, compareHlc, formatHlc, parseHlc } from '../src/index.ts';

test('format/parse round-trip and fixed width', () => {
  const s = formatHlc({ wallMs: 1_762_000_000_000, counter: 7, node: 'm_A' });
  assert.equal(s, '001762000000000-000007-m_A');
  assert.deepEqual(parseHlc(s), { wallMs: 1_762_000_000_000, counter: 7, node: 'm_A' });
  assert.throws(() => parseHlc('nope'));
});

test('now() is strictly increasing even when the wall clock stalls or goes backwards', () => {
  let t = 1000;
  const c = new HybridLogicalClock('m_A', () => t);
  const a = c.now();
  const b = c.now(); // same ms
  t = 500; // clock went backwards
  const d = c.now();
  t = 2000;
  const e = c.now();
  assert.ok(compareHlc(a, b) < 0);
  assert.ok(compareHlc(b, d) < 0);
  assert.ok(compareHlc(d, e) < 0);
  assert.equal(parseHlc(e).counter, 0);
});

test('update() moves past a remote timestamp from the future', () => {
  let t = 1000;
  const local = new HybridLogicalClock('m_A', () => t);
  const remote = new HybridLogicalClock('m_B', () => 5000);
  const r = remote.now();
  const merged = local.update(r);
  assert.ok(compareHlc(merged, r) > 0, 'receive is after send');
  const next = local.now();
  assert.ok(compareHlc(next, merged) > 0);
  assert.equal(parseHlc(next).wallMs, 5000, 'local adopts the remote wall time while its own clock lags');
  t = 9000;
  assert.equal(parseHlc(local.now()).wallMs, 9000);
});

test('lexicographic order matches (wall, counter, node) order', () => {
  const xs = [
    formatHlc({ wallMs: 2, counter: 0, node: 'a' }),
    formatHlc({ wallMs: 1, counter: 10, node: 'b' }),
    formatHlc({ wallMs: 1, counter: 9, node: 'z' }),
    formatHlc({ wallMs: 1, counter: 9, node: 'a' }),
    formatHlc({ wallMs: 100, counter: 0, node: 'a' }),
  ];
  const sorted = [...xs].sort(compareHlc).map(parseHlc);
  assert.deepEqual(
    sorted.map((x) => [x.wallMs, x.counter, x.node]),
    [
      [1, 9, 'a'],
      [1, 9, 'z'],
      [1, 10, 'b'],
      [2, 0, 'a'],
      [100, 0, 'a'],
    ],
  );
});

test('observe() fast-forwards without issuing', () => {
  const c = new HybridLogicalClock('m_A', () => 10);
  c.observe(formatHlc({ wallMs: 50, counter: 3, node: 'm_B' }));
  assert.equal(c.now(), formatHlc({ wallMs: 50, counter: 4, node: 'm_A' }));
});
