import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { BizziError } from '@bizzi/protocol';
import { TerminalAdapter, TerminalHost, claudeSpec, createAdapters, shellSpec } from '../src/index.ts';
import { EventLog, ctx, sleep, startOpts } from './helpers.ts';

const SCRIPT = 'echo hi; read x; echo got $x; stty size; exit 3';

function bashAdapter(script: string, opts: ConstructorParameters<typeof TerminalAdapter>[1] = {}) {
  return new TerminalAdapter(shellSpec({ command: 'bash', args: ['--norc', '--noprofile', '-c', script] }), {
    supervisor: false,
    idleMs: 300,
    settleMs: 100,
    ...opts,
  });
}

describe('TerminalHost', () => {
  it('spawns, echoes input, resizes, reports exit and keeps scrollback', async () => {
    const host = TerminalHost.spawn({
      command: 'bash',
      args: ['--norc', '--noprofile', '-c', SCRIPT],
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      scrollbackBytes: 1024,
    });
    const chunks: Buffer[] = [];
    host.onOutput((c) => chunks.push(c));
    const out = () => Buffer.concat(chunks).toString();
    while (!out().includes('hi')) await sleep(10);
    host.resize(100, 40);
    host.write('yo\r');
    const exit = await host.exitPromise;
    assert.deepEqual(exit, { exitCode: 3 });
    assert.match(out(), /got yo/);
    assert.match(out(), /40 100/);
    assert.equal(host.scrollback().toString(), out());
    assert.equal(host.outputOffset, Buffer.concat(chunks).length);
  });

  it('sets TERM=xterm-256color', async () => {
    const host = TerminalHost.spawn({ command: 'bash', args: ['--norc', '-c', 'echo "T=$TERM"'], cwd: process.cwd() });
    await host.exitPromise;
    assert.match(host.scrollback().toString(), /T=xterm-256color/);
  });
});

describe('TerminalAdapter (in-process PTY)', () => {
  // A failed assertion skips a test's own stop(); a live PTY would then keep the file running forever.
  type Session = Awaited<ReturnType<TerminalAdapter['start']>>;
  const live: Session[] = [];
  afterEach(async () => {
    await Promise.allSettled(live.splice(0).map((s) => s.stop()));
  });
  async function start(adapter: TerminalAdapter, opts: Parameters<TerminalAdapter['start']>[0], emit: Parameters<TerminalAdapter['start']>[1]): Promise<Session> {
    const s = await adapter.start(opts, emit, ctx);
    live.push(s);
    return s;
  }

  it('streams term.output, takes input, resizes and reports the exit code', async () => {
    const adapter = bashAdapter(SCRIPT);
    const log = new EventLog();
    const session = await start(adapter, startOpts(), log.emit);
    await log.waitForOutput('hi');
    session.resizeTerminal!(100, 40);
    session.writeTerminal!(new TextEncoder().encode('yo\r'));
    await log.waitFor(() => log.ofType('term.exited').length > 0, 'term.exited');
    assert.match(log.output(), /got yo/);
    assert.match(log.output(), /40 100/);
    assert.deepEqual(log.ofType('term.exited')[0]!.data, { exitCode: 3 });
    const status = log.ofType('session.status').at(-1)!.data;
    assert.equal(status.status, 'failed');
    assert.equal(status.reason, 'exit code 3');
    await session.stop();
  });

  it('send() types text + Enter and completes the turn when output goes idle', async () => {
    const adapter = bashAdapter('read x; echo "got $x"; read y; echo "bye $y"');
    const log = new EventLog();
    const session = await start(adapter, startOpts(), log.emit);
    await session.send('t_1', [{ type: 'text', text: 'hello world' }]);
    // Under load the program's reply can trail the echoed input by more than idleMs; wait for both.
    await log.waitForOutput('got hello world');
    await log.waitFor(() => log.ofType('turn.completed').length === 1, 'turn.completed');
    assert.deepEqual(log.ofType('turn.completed')[0]!.data, { turnId: 't_1', stopReason: 'end_turn' });
    assert.match(log.output(), /got hello world/);
    const waiting = log.ofType('session.status').filter((e) => e.data.status === 'waiting_input');
    assert.ok(waiting.length >= 1, 'waiting_input after idle');
    // turn.completed comes before the waiting_input status.
    const iCompleted = log.events.findIndex((e) => e.type === 'turn.completed');
    const iWaiting = log.events.findIndex((e, i) => i > iCompleted && e.type === 'session.status');
    assert.ok(iWaiting > iCompleted);

    await session.send('t_2', [{ type: 'text', text: 'there' }]);
    await log.waitFor(() => log.ofType('term.exited').length > 0, 'exit');
    assert.match(log.output(), /bye there/);
    assert.deepEqual(log.ofType('turn.completed')[1]!.data, { turnId: 't_2', stopReason: 'end_turn' });
    assert.equal(log.ofType('session.status').at(-1)!.data.status, 'ended');
    await assert.rejects(session.send('t_3', [{ type: 'text', text: 'x' }]), (e: BizziError) => e.code === 'conflict');
  });

  it('emits waiting_input after output stops, and running when it resumes', async () => {
    const adapter = bashAdapter('echo one; read x; echo two; sleep 0.2; echo three; read y', { idleMs: 250 });
    const log = new EventLog();
    const session = await start(adapter, startOpts(), log.emit);
    await log.waitFor(() => log.ofType('session.status').some((e) => e.data.status === 'waiting_input'), 'waiting_input');
    assert.equal(log.ofType('session.status')[0]!.data.reason, 'idle');
    session.writeTerminal!(Buffer.from('go\r'));
    await log.waitForOutput('three');
    await log.waitFor(
      () => log.ofType('session.status').filter((e) => e.data.status === 'waiting_input').length === 2,
      'second waiting_input',
    );
    const statuses = log.ofType('session.status').map((e) => e.data.status);
    assert.deepEqual(statuses, ['waiting_input', 'running', 'waiting_input']);
    await session.stop();
    assert.equal(log.ofType('session.status').at(-1)!.data.status, 'ended');
    assert.equal(log.ofType('session.status').at(-1)!.data.reason, 'stopped');
  });

  it('interrupt() sends Ctrl-C and completes the in-flight turn as interrupted', async () => {
    // `exec` keeps the pid, so the Ctrl-C lands on sleep; waiting for `ready` means the tty is set up first.
    const adapter = new TerminalAdapter(shellSpec({ command: 'sh', args: ['-c', 'echo ready; exec sleep 30'] }), { supervisor: false, idleMs: 5000 });
    const log = new EventLog();
    const session = await start(adapter, startOpts(), log.emit);
    await log.waitForOutput('ready');
    await session.send('t_1', [{ type: 'text', text: '' }]);
    await session.interrupt();
    assert.deepEqual(log.ofType('turn.completed')[0]!.data, { turnId: 't_1', stopReason: 'interrupted' });
    await log.waitFor(() => log.ofType('term.exited').length > 0, 'term.exited');
    assert.deepEqual(log.ofType('term.exited')[0]!.data, { exitCode: null, signal: 'SIGINT' });
    await session.stop();
  });

  it('stop() kills the process and is idempotent', async () => {
    const adapter = new TerminalAdapter(shellSpec({ command: 'sleep', args: ['30'] }), { supervisor: false });
    const log = new EventLog();
    const session = await start(adapter, startOpts(), log.emit);
    await Promise.all([session.stop(), session.stop()]);
    await session.stop();
    assert.equal(log.ofType('term.exited').length, 1);
    assert.equal(log.ofType('term.exited')[0]!.data.signal, 'SIGHUP');
    assert.equal(log.ofType('session.status').at(-1)!.data.status, 'ended');
  });

  it('rejects structured mode, approvals and image-only input', async () => {
    const adapter = bashAdapter('read x');
    await assert.rejects(
      adapter.start(startOpts({ mode: 'structured' }), () => {}, ctx),
      (e: BizziError) => e.code === 'unsupported',
    );
    const session = await start(adapter, startOpts(), () => {});
    await assert.rejects(session.respondApproval('ap_1', { decision: 'allow' }), (e: BizziError) => e.code === 'unsupported');
    await assert.rejects(
      session.send('t_1', [{ type: 'image', mediaType: 'image/png', dataBase64: '' }]),
      (e: BizziError) => e.code === 'unsupported',
    );
    await session.stop();
  });
});

describe('probe and capabilities', () => {
  it('reports a missing binary as not installed', async () => {
    const shell = new TerminalAdapter(shellSpec({ command: 'definitely-not-a-binary-bizzi' }));
    const p = await shell.probe();
    assert.equal(p.installed, false);
    assert.equal(p.auth, 'unknown');

    const claude = new TerminalAdapter(claudeSpec(), { path: '/nonexistent', extraDirs: [] });
    const c = await claude.probe();
    assert.deepEqual([c.agent, c.installed], ['claude', false]);
    await assert.rejects(
      claude.start(startOpts(), () => {}, ctx),
      (e: BizziError) => e.code === 'agent_unavailable',
    );
  });

  it('finds bash and reads its version', async () => {
    const p = await new TerminalAdapter(shellSpec({ command: 'bash' })).probe();
    assert.equal(p.installed, true);
    assert.match(p.version ?? '', /^\d+\.\d+/);
  });

  it('createAdapters returns the five terminal adapters with terminal-only capabilities', async () => {
    const adapters = createAdapters({ supervisor: false });
    assert.deepEqual(
      adapters.map((a) => a.agent),
      ['shell', 'agy', 'claude', 'codex', 'opencode'],
    );
    for (const a of adapters) {
      const caps = a.capabilities('terminal');
      assert.deepEqual(caps.modes, ['terminal']);
      assert.equal(caps.terminal, true);
      assert.equal(caps.interrupt, true);
      assert.equal(caps.streaming, 'none');
      assert.equal(caps.approvals, 'none');
      assert.equal(caps.steer, false);
      assert.equal(caps.resumeAfterNodeRestart, false);
      const probe = await a.probe(); // must never throw
      assert.equal(probe.agent, a.agent);
    }
    assert.equal(createAdapters()[0]!.capabilities('terminal').resumeAfterNodeRestart, process.platform !== 'win32');
  });

  it('maps claude start options to verified CLI flags', () => {
    const plan = claudeSpec().buildLaunch(
      startOpts({
        model: 'sonnet',
        permissionMode: 'plan',
        effort: 'high',
        systemPromptAppend: 'be brief',
        mcpServers: { mem: { type: 'stdio', command: 'mem-mcp' } },
      }),
      undefined,
    );
    assert.ok(plan.nativeRef && /^[0-9a-f-]{36}$/.test(plan.nativeRef));
    assert.deepEqual(plan.args.slice(0, 2), ['--session-id', plan.nativeRef]);
    assert.ok(plan.args.join(' ').includes('--model sonnet --permission-mode plan --effort high --append-system-prompt be brief'));
    const resumed = claudeSpec().buildLaunch(startOpts(), 'abc');
    assert.deepEqual(resumed.args, ['--resume', 'abc']);
    assert.equal(resumed.nativeRef, 'abc');
  });
});
