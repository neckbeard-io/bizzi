import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentSearchDirs, agentSearchPath, isProjectBinDir } from '../src/index.ts';

test('isProjectBinDir: node_modules/.bin, npm script bins and relative dirs', () => {
  for (const d of [
    '/Users/me/repo/app/node_modules/.bin',
    '/Users/me/repo/app/node_modules/.bin/',
    '/Users/me/repo/app/packages/x/node_modules/.bin',
    '/node_modules/.bin',
    'C:\\work\\app\\node_modules\\.bin',
    '/opt/homebrew/lib/node_modules/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin',
    'node_modules/.bin',
    './bin',
    '.',
    '',
  ]) {
    assert.equal(isProjectBinDir(d), true, d);
  }
  for (const d of ['/usr/local/bin', '/opt/homebrew/bin', '/Users/me/.local/bin', '/Users/me/.npm-global/bin', '/opt/homebrew/lib/node_modules/.bin-tools', 'C:\\Program Files\\nodejs']) {
    assert.equal(isProjectBinDir(d), false, d);
  }
});

test('agentSearchDirs / agentSearchPath keep the order of the rest', () => {
  assert.deepEqual(agentSearchDirs(['/a/node_modules/.bin', '/usr/bin', 'rel', '/bin']), ['/usr/bin', '/bin']);
  assert.equal(agentSearchPath('/a/node_modules/.bin:/usr/bin:/bin', ':'), '/usr/bin:/bin');
  assert.equal(agentSearchPath(undefined, ':'), '');
});
