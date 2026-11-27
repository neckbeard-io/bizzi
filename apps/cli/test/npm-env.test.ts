// `bizzi serve` started from an npm script takes npm's script environment out before spawning agents.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Logger } from '@bizzi/protocol';
import { dropNpmScriptEnv } from '../src/serve.ts';

function recorder(): Logger & { lines: { msg: string; fields?: Record<string, unknown> }[] } {
  const lines: { msg: string; fields?: Record<string, unknown> }[] = [];
  const logger: Logger & { lines: typeof lines } = {
    lines,
    log: (_level, msg, fields) => void lines.push({ msg, ...(fields ? { fields } : {}) }),
    child: () => logger,
  };
  return logger;
}

test('dropNpmScriptEnv cleans the environment in place and logs what it dropped', { skip: process.platform === 'win32' }, () => {
  const env: NodeJS.ProcessEnv = {
    HOME: '/Users/me',
    BIZZI_LOG_LEVEL: 'debug',
    PATH: '/Users/me/repo/bizzi/node_modules/.bin:/Users/me/repo/node_modules/.bin:/opt/homebrew/bin:/usr/bin:/bin',
    INIT_CWD: '/Users/me/repo/bizzi',
    npm_config_local_prefix: '/Users/me/repo/bizzi',
    npm_package_name: 'bizzi',
    npm_lifecycle_event: 'dev',
  };
  const log = recorder();
  dropNpmScriptEnv(log, env);
  assert.deepEqual(env, { HOME: '/Users/me', BIZZI_LOG_LEVEL: 'debug', PATH: '/opt/homebrew/bin:/usr/bin:/bin' });
  assert.deepEqual(log.lines, [{ msg: 'dropped the npm script environment', fields: { vars: 4, pathEntries: 2 } }]);

  // Nothing to drop: untouched, and quiet.
  dropNpmScriptEnv(log, env);
  assert.equal(log.lines.length, 1);
});
