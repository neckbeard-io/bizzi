// Which `codex` the probe (and so every session) runs: never a package's node_modules/.bin.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { codexVersion, findCodex } from '../src/index.ts';

function script(path: string, body: string): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

test("findCodex skips a package's node_modules/.bin ahead of the install on PATH", { skip: process.platform === 'win32' }, async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bizzi-codex-locate-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const installed = script(join(dir, 'bin', 'codex'), 'echo "codex-cli 0.172.0"');
  // What `npm run` in a worktree with @openai/codex as a dev dependency puts first on PATH.
  const projectBin = join(dir, 'repo', 'worktree', 'node_modules', '.bin');
  script(join(projectBin, 'codex'), 'echo "codex-cli 0.167.0"');
  const env = { PATH: [projectBin, join(dir, 'bin'), '/usr/bin', '/bin'].join(delimiter) };

  const found = await findCodex({ env });
  assert.equal(found, installed);
  assert.equal(await codexVersion(found!, env), '0.172.0');
  // The same answer every time, whichever entries come first.
  assert.equal(await findCodex({ env: { PATH: [join(dir, 'bin'), projectBin].join(delimiter) } }), installed);
  // An explicit path is still honoured as given.
  assert.equal(await findCodex({ codexPath: join(projectBin, 'codex'), env }), join(projectBin, 'codex'));
});
