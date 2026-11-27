import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanNpmScriptEnv, isNpmScriptPathDir, isNpmScriptVar } from '../src/index.ts';

const GYP = '/opt/homebrew/lib/node_modules/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin';

/** Roughly what `npm run install:local` in a worktree, started from inside another script, gives. */
function scriptEnv(): Record<string, string> {
  return {
    HOME: '/Users/me',
    SHELL: '/bin/zsh',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
    NPM_CONFIG_PREFIX: '/Users/me/.npm-global',
    NODE_OPTIONS: '--max-old-space-size=4096',
    PATH: [
      '/Users/me/repo/app/node_modules/.bin',
      '/Users/me/repo/node_modules/.bin',
      '/Users/me/node_modules/.bin',
      '/node_modules/.bin',
      GYP,
      '/Users/me/repo/other/node_modules/.bin',
      GYP,
      './node_modules/.bin',
      '/Users/me/.local/bin',
      '/opt/homebrew/bin',
      '/usr/bin',
      '/opt/homebrew/bin',
      '/bin',
    ].join(':'),
    INIT_CWD: '/Users/me/repo/app',
    NODE: '/opt/homebrew/bin/node',
    COLOR: '1',
    npm_node_execpath: '/opt/homebrew/bin/node',
    npm_execpath: '/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js',
    npm_command: 'run-script',
    npm_config_local_prefix: '/Users/me/repo/app',
    npm_config_global_prefix: '/opt/homebrew',
    npm_config_user_agent: 'npm/11.0.0 node/v26.0.0 darwin arm64',
    npm_package_name: 'app',
    npm_package_json: '/Users/me/repo/app/package.json',
    npm_lifecycle_event: 'install:local',
    npm_lifecycle_script: 'node scripts/install-local.ts',
  };
}

test('cleanNpmScriptEnv drops npm script variables and node_modules/.bin PATH entries, keeps the rest', () => {
  const { env, removed, removedPath } = cleanNpmScriptEnv(scriptEnv(), ':');
  assert.deepEqual(env, {
    HOME: '/Users/me',
    SHELL: '/bin/zsh',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
    NPM_CONFIG_PREFIX: '/Users/me/.npm-global',
    NODE_OPTIONS: '--max-old-space-size=4096',
    // The user's relative entry stays; npm's absolute ones and the duplicates go.
    PATH: './node_modules/.bin:/Users/me/.local/bin:/opt/homebrew/bin:/usr/bin:/bin',
  });
  assert.equal(removed.length, 13);
  assert.ok(removed.includes('INIT_CWD') && removed.includes('NODE') && removed.includes('COLOR'));
  assert.equal(removedPath.length, 8);
});

test('cleanNpmScriptEnv leaves an environment npm never touched alone', () => {
  const plain = { HOME: '/Users/me', PATH: '/usr/bin:/bin', NODE: '/usr/local/bin/node', COLOR: 'never' };
  const { env, removed, removedPath } = cleanNpmScriptEnv(plain, ':');
  assert.deepEqual(env, plain);
  assert.deepEqual(removed, []);
  assert.deepEqual(removedPath, []);
  assert.deepEqual(cleanNpmScriptEnv({ HOME: '/h' }, ':').env, { HOME: '/h' }, 'no PATH stays no PATH');
});

test('isNpmScriptVar / isNpmScriptPathDir', () => {
  assert.equal(isNpmScriptVar('npm_config_cache'), true);
  assert.equal(isNpmScriptVar('NPM_CONFIG_REGISTRY'), false, "users' own npm config stays");
  assert.equal(isNpmScriptVar('NODE', { NODE: '/a/node', npm_node_execpath: '/b/node' }), false);
  assert.equal(isNpmScriptVar('NODE', { NODE: '/a/node', npm_node_execpath: '/a/node' }), true);
  assert.equal(isNpmScriptVar('COLOR', { COLOR: '1' }), false);
  assert.equal(isNpmScriptPathDir('/x/node_modules/.bin/'), true);
  assert.equal(isNpmScriptPathDir('C:\\x\\node_modules\\.bin'), true);
  assert.equal(isNpmScriptPathDir(GYP), true);
  assert.equal(isNpmScriptPathDir('node_modules/.bin'), false);
  assert.equal(isNpmScriptPathDir('/opt/homebrew/lib/node_modules/npm/bin'), false);
});
