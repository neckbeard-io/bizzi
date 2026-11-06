// StartSessionOptions.command: run that argv instead of the agent's TUI (e.g. a login command).

import assert from 'node:assert/strict';
import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { BizziError } from '@bizzi/protocol';
import { TerminalAdapter, claudeSpec, codexSpec, listSupervisors } from '../src/index.ts';
import { EventLog, ctx, startOpts, tempDir } from './helpers.ts';

const dir = tempDir('bzc-');
const runtimeDir = tempDir('bzcs-');
after(() => {
  for (const s of listSupervisors(runtimeDir)) {
    if (s.alive) {
      try {
        process.kill(s.pid, 'SIGKILL');
        process.kill(s.supervisorPid, 'SIGKILL');
      } catch {}
    }
  }
  rmSync(dir, { recursive: true, force: true });
  rmSync(runtimeDir, { recursive: true, force: true });
});

const SYSTEM_PATH = '/usr/bin:/bin';
const SCRIPT = 'echo "cmd=$0 arg=$1 cwd=$(pwd) foo=$FOO size=$(stty size)"; exit 0';

/** A claude adapter that can't find `claude`: the custom command must not need it. */
function claudeWithoutBinary(supervisor: false | { runtimeDir: string } = false) {
  return new TerminalAdapter(claudeSpec(), { path: '/nonexistent', extraDirs: [], supervisor, idleMs: 300 });
}

describe('StartSessionOptions.command', () => {
  it('runs the argv instead of the agent TUI, keeping cwd, env and size', async () => {
    const adapter = claudeWithoutBinary();
    const log = new EventLog();
    const session = await adapter.start(
      startOpts({
        cwd: dir,
        cols: 100,
        rows: 30,
        env: { PATH: SYSTEM_PATH, FOO: 'bar' },
        model: 'sonnet',
        command: ['bash', '--norc', '--noprofile', '-c', SCRIPT, 'login-cmd', 'first'],
      }),
      log.emit,
      ctx,
    );
    await log.waitFor(() => log.ofType('term.exited').length > 0, 'term.exited');
    assert.match(log.output(), new RegExp(`cmd=login-cmd arg=first cwd=${dir} foo=bar size=30 100`));
    assert.deepEqual(log.ofType('term.exited')[0]!.data, { exitCode: 0 });
    assert.equal(log.ofType('session.status').at(-1)!.data.status, 'ended');
    // No claude session id was invented for a non-agent command.
    assert.equal(session.agentSessionRef(), undefined);
    assert.equal(log.ofType('session.info').length, 0);
    await session.stop();
  });

  it('resolves a relative command against the session cwd', async () => {
    const script = join(dir, 'login.sh');
    writeFileSync(script, '#!/bin/sh\necho "relative ok $1"\n');
    chmodSync(script, 0o755);
    const adapter = new TerminalAdapter(codexSpec(), { path: '/nonexistent', extraDirs: [], supervisor: false });
    const log = new EventLog();
    await adapter.start(startOpts({ cwd: dir, command: ['./login.sh', 'x'] }), log.emit, ctx);
    await log.waitFor(() => log.ofType('term.exited').length > 0, 'term.exited');
    assert.match(log.output(), /relative ok x/);
  });

  it('rejects a missing or malformed command', async () => {
    const adapter = claudeWithoutBinary();
    await assert.rejects(
      adapter.start(startOpts({ env: { PATH: SYSTEM_PATH }, command: ['definitely-not-a-binary-bizzi'] }), () => {}, ctx),
      (e: BizziError) => e.code === 'agent_unavailable',
    );
    await assert.rejects(
      adapter.start(startOpts({ command: [''] }), () => {}, ctx),
      (e: BizziError) => e.code === 'bad_request',
    );
    // An empty command means "the agent TUI" (which isn't installed here).
    await assert.rejects(
      adapter.start(startOpts({ command: [] }), () => {}, ctx),
      (e: BizziError) => e.code === 'agent_unavailable',
    );
  });

  it('runs the command under a supervisor too', async () => {
    const adapter = claudeWithoutBinary({ runtimeDir });
    const log = new EventLog();
    const session = await adapter.start(
      startOpts({ cwd: dir, env: { PATH: SYSTEM_PATH, FOO: 'sup' }, command: ['bash', '--norc', '--noprofile', '-c', SCRIPT, 'c', 'd'] }),
      log.emit,
      ctx,
    );
    assert.match(session.agentSessionRef() ?? '', /^pty:[a-z2-7]{16}$/, 'reattach ref without a native id');
    await log.waitFor(() => log.ofType('term.exited').length > 0, 'term.exited');
    assert.match(log.output(), /cmd=c arg=d .* foo=sup/);
    await session.stop();
  });

  it('leaves probe() unaffected', async () => {
    const p = await claudeWithoutBinary().probe();
    assert.deepEqual([p.agent, p.installed], ['claude', false]);
  });
});
