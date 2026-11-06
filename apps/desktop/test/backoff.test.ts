import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Backoff, backoffDelay } from '../src/core/backoff.ts';

test('backoffDelay grows exponentially and caps', () => {
  const opts = { initialMs: 100, factor: 2, maxMs: 1000 };
  assert.deepEqual([0, 1, 2, 3, 4, 5, 10].map((n) => backoffDelay(n, opts)), [100, 200, 400, 800, 1000, 1000, 1000]);
});

test('Backoff without jitter follows the sequence and counts attempts', () => {
  const b = new Backoff({ initialMs: 500, maxMs: 30_000, jitter: 0 });
  const seq = Array.from({ length: 8 }, () => b.next());
  assert.deepEqual(seq, [500, 1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  assert.equal(b.attempt, 8);
});

test('jitter stays within bounds and never exceeds the cap', () => {
  const lo = new Backoff({ initialMs: 1000, jitter: 0.2, random: () => 0, maxMs: 5000 });
  const hi = new Backoff({ initialMs: 1000, jitter: 0.2, random: () => 0.999999, maxMs: 5000 });
  assert.equal(lo.next(), 800);
  assert.equal(hi.next(), 1200);
  for (let i = 0; i < 10; i++) assert.ok(hi.next() <= 5000);
});

test('a short-lived process keeps backing off; a stable one resets', () => {
  const b = new Backoff({ initialMs: 100, jitter: 0, stableAfterMs: 60_000 });
  b.next();
  b.next();
  b.onExit(5_000);
  assert.equal(b.next(), 400);
  b.onExit(60_000);
  assert.equal(b.attempt, 0);
  assert.equal(b.next(), 100);
});

test('reset starts over', () => {
  const b = new Backoff({ initialMs: 100, jitter: 0 });
  b.next();
  b.next();
  b.reset();
  assert.equal(b.next(), 100);
});
