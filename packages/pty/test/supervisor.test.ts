import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { TerminalAdapter, TerminalSession, listSupervisors, parseResumeRef, shellSpec } from '../src/index.ts';
import { EventLog, ctx, sleep, startOpts, tempDir } from './helpers.ts';

const runtimeDir = tempDir('bzs-');
after(() => {
  // Kill anything a failed test left behind.
  for (const s of listSupervisors(runtimeDir)) {
    if (s.alive) {
      try {
        process.kill(s.pid, 'SIGKILL');
        process.kill(s.supervisorPid, 'SIGKILL');
      } catch {}
    }
  }
  rmSync(runtimeDir, { recursive: true, force: true });
});

function adapter(script: string, supervisor: object = {}) {
  return new TerminalAdapter(shellSpec({ command: 'bash', args: ['--norc', '--noprofile', '-c', script] }), {
    supervisor: { runtimeDir, ...supervisor },
    idleMs: 300,
  });
}

/** Any adapter can reattach: the ref carries everything. */
const reattacher = adapter('exit 99');

describe('PTY supervisor', () => {
  it('runs a session under a supervisor and reattaches after detach', async () => {
    const log1 = new EventLog();
    const s1 = (await adapter('echo hi; read x; echo got $x; read y; echo bye $y; exit 5').start(
      startOpts(),
      log1.emit,
      ctx,
    )) as TerminalSession;
    const ref = s1.agentSessionRef()!;
    assert.match(ref, /^pty:[a-z2-7]{16}$/);
    assert.deepEqual(log1.ofType('session.info')[0]!.data, { agentSessionRef: ref });
    assert.ok(existsSync(join(runtimeDir, `${parseResumeRef(ref).supervisorId}.sock`)));
    await log1.waitForOutput('hi');
    s1.writeTerminal(Buffer.from('yo\r'));
    await log1.waitForOutput('got yo');
    await sleep(50); // let the ack reach the supervisor
    await s1.detach();

    const log2 = new EventLog();
    const s2 = (await reattacher.start(startOpts({ resumeRef: ref }), log2.emit, ctx)) as TerminalSession;
    assert.equal(s2.agentSessionRef(), ref);
    assert.doesNotMatch(log2.output(), /hi/, 'already-delivered output is not replayed');
    assert.match(s2.host.scrollback().toString(), /hi[\s\S]*got yo/, 'scrollback survives reattach');
    s2.resizeTerminal(90, 30);
    s2.writeTerminal(Buffer.from('there\r'));
    await log2.waitFor(() => log2.ofType('term.exited').length > 0, 'term.exited');
    assert.match(log2.output(), /bye there/);
    assert.deepEqual(log2.ofType('term.exited')[0]!.data, { exitCode: 5 });
    // The supervisor cleans up after delivering the exit.
    await log2.waitFor(() => listSupervisors(runtimeDir).every((s) => s.id !== parseResumeRef(ref).supervisorId), 'cleanup');
  });

  it('survives the owning node being killed and replays missed output', async () => {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL('./fixtures/supervised-child.ts', import.meta.url)),
        runtimeDir,
        'echo hi; sleep 1.5; echo later; read x; echo got $x; exit 7',
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    const line = await new Promise<string>((resolve, reject) => {
      let buf = '';
      child.stdout!.on('data', (d: Buffer) => {
        buf += d.toString();
        const nl = buf.indexOf('\n');
        if (nl >= 0) resolve(buf.slice(0, nl));
      });
      child.on('exit', (code) => reject(new Error(`child exited early (${code})`)));
    });
    const { ref, output } = JSON.parse(line) as { ref: string; output: string };
    assert.match(output, /hi/);
    await sleep(100); // ack in flight
    child.kill('SIGKILL'); // the "node" dies without cleanup
    await new Promise((r) => child.once('exit', r));

    await sleep(2000); // "later" is printed while nobody is attached
    const log = new EventLog();
    const s = (await reattacher.start(startOpts({ resumeRef: ref }), log.emit, ctx)) as TerminalSession;
    assert.match(log.output(), /later/, 'missed output is replayed');
    assert.doesNotMatch(log.output(), /hi/, 'delivered output is not replayed');
    assert.match(s.host.scrollback().toString(), /hi[\s\S]*later/);
    s.writeTerminal(Buffer.from('again\r'));
    await log.waitFor(() => log.ofType('term.exited').length > 0, 'term.exited');
    assert.match(log.output(), /got again/);
    assert.deepEqual(log.ofType('term.exited')[0]!.data, { exitCode: 7 });
  });

  it('reports an exit that happened while detached', async () => {
    const log1 = new EventLog();
    const s1 = (await adapter('echo hi; sleep 0.3; exit 4', { lingerMs: 100 }).start(
      startOpts(),
      log1.emit,
      ctx,
    )) as TerminalSession;
    const ref = s1.agentSessionRef()!;
    await log1.waitForOutput('hi');
    await s1.detach();
    // Supervisor exits after lingering; the meta file keeps the exit status.
    const id = parseResumeRef(ref).supervisorId!;
    await log1.waitFor(() => !existsSync(join(runtimeDir, `${id}.sock`)), 'supervisor exit');

    const log2 = new EventLog();
    await reattacher.start(startOpts({ resumeRef: ref }), log2.emit, ctx);
    assert.deepEqual(log2.ofType('term.exited')[0]!.data, { exitCode: 4 });
    assert.equal(log2.ofType('session.status')[0]!.data.status, 'failed');
    assert.equal(existsSync(join(runtimeDir, `${id}.json`)), false, 'meta collected');
  });

  it('starts fresh (with a warning) when the supervisor is gone, and stop() tears it down', async () => {
    const log = new EventLog();
    const s = (await adapter('echo hi; read x').start(
      startOpts({ resumeRef: 'pty:aaaaaaaaaaaaaaaa' }),
      log.emit,
      ctx,
    )) as TerminalSession;
    assert.equal(log.ofType('error')[0]?.data.code, 'pty_lost');
    await log.waitForOutput('hi');
    const id = parseResumeRef(s.agentSessionRef()).supervisorId!;
    assert.notEqual(id, 'aaaaaaaaaaaaaaaa');
    await s.stop();
    assert.equal(log.ofType('term.exited')[0]!.data.signal, 'SIGHUP');
    assert.equal(log.ofType('session.status').at(-1)!.data.status, 'ended');
    await log.waitFor(() => listSupervisors(runtimeDir).every((x) => x.id !== id), 'supervisor cleanup');
  });
});
