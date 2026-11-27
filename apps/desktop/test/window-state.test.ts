import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialBounds, parseWindowState } from '../src/shared/window-state.ts';

const primary = { x: 0, y: 25, width: 1440, height: 875 };
const right = { x: 1440, y: 0, width: 2560, height: 1415 };
const fallback = { width: 1280, height: 820 };
const min = { width: 720, height: 480 };
const state = (x: number, y: number, width: number, height: number) => ({ bounds: { x, y, width, height }, maximized: false, fullScreen: false });

test('parse: keeps valid state, rejects junk', () => {
  assert.deepEqual(parseWindowState({ bounds: { x: 10.4, y: -20, width: 900, height: 600 }, maximized: true }), {
    bounds: { x: 10, y: -20, width: 900, height: 600 },
    maximized: true,
    fullScreen: false,
  });
  assert.equal(parseWindowState(null), null);
  assert.equal(parseWindowState({}), null);
  assert.equal(parseWindowState({ bounds: { x: 0, y: 0, width: 0, height: 600 } }), null);
  assert.equal(parseWindowState({ bounds: { x: 'a', y: 0, width: 900, height: 600 } }), null);
});

test('no saved state: default size, centered by the OS', () => {
  assert.deepEqual(initialBounds(null, [primary], fallback, min), { width: 1280, height: 820 });
});

test('saved bounds on a connected display are kept', () => {
  assert.deepEqual(initialBounds(state(100, 60, 1000, 700), [primary, right], fallback, min), { x: 100, y: 60, width: 1000, height: 700 });
  assert.deepEqual(initialBounds(state(1600, 100, 2000, 1200), [primary, right], fallback, min), { x: 1600, y: 100, width: 2000, height: 1200 });
});

test('a window on an unplugged display opens on the primary at its saved size', () => {
  assert.deepEqual(initialBounds(state(1600, 100, 1000, 700), [primary], fallback, min), { width: 1000, height: 700 });
});

test('too big or hanging off the edge: shrunk and nudged into the work area', () => {
  assert.deepEqual(initialBounds(state(1600, 100, 2000, 1200), [primary], fallback, min), { width: 1440, height: 875 });
  assert.deepEqual(initialBounds(state(1000, 0, 1000, 700), [primary], fallback, min), { x: 440, y: 25, width: 1000, height: 700 });
});
