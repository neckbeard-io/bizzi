// Terminal agents resolve the same install for the probe and the session, whatever is on PATH.

import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { TerminalAdapter, agySpec, claudeSpec, codexSpec, findBinary, opencodeSpec } from '../src/index.ts';

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bizzi-pty-lookup-')));
after(() => rmSync(dir, { recursive: true, force: true }));

function script(path: string, body: string): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe("agent lookup ignores a package's node_modules/.bin", { skip: process.platform === 'win32' }, () => {
  const bin = join(dir, 'bin');
  const projectBin = join(dir, 'repo', 'worktree', 'node_modules', '.bin');
  const path = [projectBin, bin, '/usr/bin', '/bin'].join(delimiter);

  for (const [name, spec] of [
    ['claude', claudeSpec],
    ['codex', codexSpec],
    ['opencode', opencodeSpec],
    ['agy', agySpec],
  ] as const) {
    it(name, async () => {
      const installed = script(join(bin, name), `echo "${name} 2.0.0"`);
      script(join(projectBin, name), `echo "${name} 1.0.0"`);
      const p = await new TerminalAdapter(spec(), { path, extraDirs: [] }).probe();
      assert.equal(p.path, installed);
      assert.equal(p.version, '2.0.0');
    });
  }

  it('a command typed for a terminal session is still looked up on the whole PATH', () => {
    const tool = script(join(projectBin, 'only-in-project'), 'true');
    assert.equal(findBinary('only-in-project', { path, extraDirs: [] }), tool);
    assert.equal(findBinary('only-in-project', { path, extraDirs: [], agent: true }), undefined);
  });
});
