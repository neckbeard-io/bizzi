import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aheadBehind, pendingUpdatesLabel, statusSourceLabel, visibleMarks } from '../src/lib/states.ts';
import { actionVerb } from '../src/lib/provision.ts';

test('status source labels for the explain tooltip', () => {
  assert.equal(statusSourceLabel(undefined), null);
  assert.equal(statusSourceLabel('osc7501'), 'via OSC 7501');
  assert.equal(statusSourceLabel('detector:claude-permission'), 'detector: claude-permission');
  assert.equal(statusSourceLabel('adapter'), 'reported by the adapter');
  assert.equal(statusSourceLabel('bizzi:budget'), 'bizzi: budget');
  assert.equal(statusSourceLabel('hook'), 'via hook');
});

test('sidebar text helpers', () => {
  assert.equal(aheadBehind(2, 0), '↑2');
  assert.equal(aheadBehind(3, 1), '↑3 ↓1');
  assert.equal(aheadBehind(0, 0), '');
  assert.equal(pendingUpdatesLabel(1), 'updates pending: 1 session');
  assert.equal(pendingUpdatesLabel(2), 'updates pending: 2 sessions');
  assert.deepEqual(visibleMarks([1, 2, 3, 4, 5, 6, 7], 4), { shown: [1, 2, 3, 4], more: 3 });
  assert.deepEqual(visibleMarks([1, 2], 4), { shown: [1, 2], more: 0 });
  assert.equal(actionVerb('migrate', 'progressive'), 'Switching install method of');
});
