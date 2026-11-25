// Container workspaces (topology.md §7): with a ProcessLauncher the SDK's Claude Code process is
// spawned through it (`spawnClaudeCodeProcess`), as the `claude` installed in the target.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LaunchSpec, ProcessLauncher } from '@bizzi/protocol';
import { ClaudeAdapter, claudeLaunchArgs } from '../src/index.ts';
import { collector, fakeQueryFn, silentLogger } from './fake.ts';

test('claudeLaunchArgs: a host JS entry point or native path becomes `claude` with the same flags', () => {
  assert.deepEqual(claudeLaunchArgs('/usr/local/bin/node', ['/app/node_modules/x/cli.js', '--print', '--verbose']), {
    command: 'claude',
    args: ['--print', '--verbose'],
  });
  assert.deepEqual(claudeLaunchArgs('/opt/sdk/claude', ['--print']), { command: 'claude', args: ['--print'] });
  assert.deepEqual(claudeLaunchArgs('claude', []), { command: 'claude', args: [] });
  // A runtime whose first arg isn't a script keeps it.
  assert.deepEqual(claudeLaunchArgs('bun', ['--print']), { command: 'claude', args: ['--print'] });
});

test('a launcher: no host binary lookup, and the SDK spawns through it', async () => {
  const seen: LaunchSpec[] = [];
  const launcher: ProcessLauncher = {
    label: 'container test',
    wrap(spec) {
      seen.push(spec);
      // Stands in for `docker exec`: prints what it was asked to run.
      return {
        command: process.execPath,
        args: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--', spec.command, ...spec.args],
        cwd: process.cwd(),
        env: spec.env,
      };
    },
  };
  const fq = fakeQueryFn(() => {});
  // claudePath would be searched without a launcher; with one it never is.
  const adapter = new ClaudeAdapter({ claudePath: '/nonexistent/claude', queryFn: fq.queryFn });
  const c = collector();
  const session = await adapter.start({ sessionId: 's_1', mode: 'structured', cwd: '/workspaces/acme', launcher }, c.emit, { logger: silentLogger });
  try {
    const o = fq.last().options;
    assert.equal(o.pathToClaudeCodeExecutable, 'claude');
    assert.equal(typeof o.spawnClaudeCodeProcess, 'function');

    const ac = new AbortController();
    const child = o.spawnClaudeCodeProcess!({
      command: '/usr/local/bin/node',
      args: ['/sdk/cli.js', '--output-format', 'stream-json'],
      cwd: '/workspaces/acme',
      env: { PATH: '/usr/bin', CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' },
      signal: ac.signal,
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    const code = await new Promise<number | null>((resolve) => child.once('exit', (c) => resolve(c)));
    assert.equal(code, 0);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(JSON.parse(out), ['claude', '--output-format', 'stream-json']);
    assert.deepEqual(seen, [
      { command: 'claude', args: ['--output-format', 'stream-json'], cwd: '/workspaces/acme', env: { PATH: '/usr/bin', CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' } },
    ]);
  } finally {
    await session.stop();
  }
});
