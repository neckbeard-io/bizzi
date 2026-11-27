import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatBytes, pillLabel, updateOffered, type UpdateState } from '../src/lib/updates.ts';
import { parseHash } from '../src/lib/router.ts';

const base: UpdateState = { stage: 'idle', currentVersion: '0.1.0', channel: 'stable', autoCheck: true, method: 'mac-app', methodLabel: 'macOS app' };
const latest = { version: '0.1.1', tag: 'v0.1.1', title: 'bizzi v0.1.1', notes: '', url: 'u', publishedAt: '', prerelease: false };

test('updateOffered: only while an update is on offer or on its way in', () => {
  assert.equal(updateOffered(null), false);
  assert.equal(updateOffered({ ...base, stage: 'available' }), false, 'no release yet');
  for (const stage of ['available', 'downloading', 'ready', 'installing'] as const) assert.equal(updateOffered({ ...base, stage, latest }), true, stage);
  for (const stage of ['idle', 'checking', 'up-to-date', 'error'] as const) assert.equal(updateOffered({ ...base, stage, latest }), false, stage);
});

test('pillLabel', () => {
  assert.equal(pillLabel({ ...base, stage: 'available', latest }), 'v0.1.1');
  assert.equal(pillLabel({ ...base, stage: 'downloading', latest, progress: { received: 50, total: 200 } }), '25%');
  assert.equal(pillLabel({ ...base, stage: 'ready', latest }), 'Restart to update');
  assert.equal(pillLabel({ ...base, stage: 'ready', latest, method: 'deb' }), 'Downloaded');
  assert.equal(formatBytes(150 * 1024 * 1024), '150.0 MB');
});

test('the updates settings route parses', () => {
  assert.deepEqual(parseHash('#/settings/updates'), { name: 'settings', section: 'updates' });
});
