// Container workspaces (topology.md §7): with a ProcessLauncher the adapter spawns what the launcher
// returns (e.g. `docker exec … codex app-server`) instead of this machine's codex.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LaunchSpec, ProcessLauncher } from '@bizzi/protocol';
import { CodexAdapter } from '../src/index.ts';
import { ctx, EventLog, FAKE_SERVER, startOpts } from './helpers.ts';

test('a launcher runs `codex app-server` in the target; the thread cwd is the agent-side path', async () => {
  const seen: LaunchSpec[] = [];
  // Stands in for `docker exec`: runs the fake app-server on this machine.
  const launcher: ProcessLauncher = {
    label: 'container test',
    wrap(spec) {
      seen.push(spec);
      return { command: process.execPath, args: [FAKE_SERVER, ...spec.args], cwd: process.cwd(), env: spec.env };
    },
  };
  // No codex on this "machine" at all: the launcher's target has its own.
  const adapter = new CodexAdapter({ codexPath: '/nonexistent/codex', requestTimeoutMs: 5000, interruptTimeoutMs: 2000 });
  const log = new EventLog();
  const s = await adapter.start(startOpts({ cwd: '/workspaces/acme', launcher, env: { OPENAI_API_KEY: 'sk-x' } }), log.emit, ctx());
  try {
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.command, 'codex');
    assert.deepEqual(seen[0]!.args, ['app-server']);
    assert.equal(seen[0]!.cwd, '/workspaces/acme');
    assert.equal(seen[0]!.env.OPENAI_API_KEY, 'sk-x');
    assert.equal(seen[0]!.env.NO_COLOR, '1');
    const ts = log.received('thread/start')[0] as { cwd: string };
    assert.equal(ts.cwd, '/workspaces/acme');
  } finally {
    await s.stop();
  }
});
