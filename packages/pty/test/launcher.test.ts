// Container workspaces (topology.md §7): with a ProcessLauncher the PTY runs what the launcher returns
// (e.g. `docker exec -it … <container> <agent>`), and the agent binary is looked up inside the target.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LaunchSpec, ProcessLauncher } from '@bizzi/protocol';
import { TerminalAdapter, claudeSpec, shellSpec } from '../src/index.ts';
import { EventLog, ctx, startOpts, tempDir } from './helpers.ts';

/** Stands in for `docker exec`: prints what it was asked to run, from the host-side cwd it chose. */
function echoLauncher(seen: LaunchSpec[], hostCwd: string): ProcessLauncher {
  return {
    label: 'container test',
    wrap(spec) {
      seen.push(spec);
      return {
        command: 'bash',
        args: ['--norc', '--noprofile', '-c', 'echo "ran: $0 $* in $(pwd) T=$TERM"', spec.command, ...spec.args],
        cwd: hostCwd,
        env: spec.env,
      };
    },
  };
}

describe('TerminalAdapter with a launcher', () => {
  it('wraps the agent by name (not a host path) with a tty, in the agent-side cwd', async () => {
    const seen: LaunchSpec[] = [];
    const host = tempDir();
    const adapter = new TerminalAdapter(claudeSpec(), { supervisor: false, idleMs: 300, settleMs: 100, path: '/nonexistent' });
    const log = new EventLog();
    const s = await adapter.start(startOpts({ cwd: '/workspaces/acme', launcher: echoLauncher(seen, host), model: 'opus' }), log.emit, ctx);
    try {
      await log.waitForOutput('ran:');
      assert.equal(seen.length, 1);
      assert.equal(seen[0]!.command, 'claude');
      assert.equal(seen[0]!.cwd, '/workspaces/acme');
      assert.equal(seen[0]!.tty, true);
      assert.ok(seen[0]!.args.includes('--model'));
      assert.equal(seen[0]!.env.TERM, 'xterm-256color');
      assert.match(log.output(), new RegExp(`ran: claude --session-id \\S+ --model opus in ${host}`));
    } finally {
      await s.stop();
    }
  });

  it('a shell inside the target is bash when it has one, else sh', async () => {
    const seen: LaunchSpec[] = [];
    const adapter = new TerminalAdapter(shellSpec(), { supervisor: false, idleMs: 300, settleMs: 100 });
    const log = new EventLog();
    const s = await adapter.start(startOpts({ cwd: '/w', launcher: echoLauncher(seen, tempDir()) }), log.emit, ctx);
    try {
      await log.waitForOutput('ran:');
      assert.equal(seen[0]!.command, 'sh');
      assert.equal(seen[0]!.args[0], '-c');
      assert.match(seen[0]!.args[1]!, /exec bash -l/);
    } finally {
      await s.stop();
    }
  });

  it('a custom command is passed through by name', async () => {
    const seen: LaunchSpec[] = [];
    const adapter = new TerminalAdapter(shellSpec(), { supervisor: false, idleMs: 300, settleMs: 100 });
    const log = new EventLog();
    const s = await adapter.start(startOpts({ cwd: '/w', command: ['htop', '-d', '5'], launcher: echoLauncher(seen, tempDir()) }), log.emit, ctx);
    try {
      await log.waitForOutput('ran:');
      assert.equal(seen[0]!.command, 'htop');
      assert.deepEqual(seen[0]!.args, ['-d', '5']);
    } finally {
      await s.stop();
    }
  });
});
