// OSC 7501 wired into the terminal-mode session, against a fake PTY backend (no processes).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  TerminalAdapter,
  TerminalHost,
  TerminalSession,
  detectorsFor,
  explainSessionStatus,
  formatStatusProvenance,
  shellSpec,
  claudeSpec,
  DEFAULT_DETECTORS,
  type ExitInfo,
  type PromptDetector,
  type PtyBackend,
  type TerminalAdapterOptions,
} from '../src/index.ts';
import { EventLog, ctx, logger, sleep, startOpts } from './helpers.ts';

class FakeBackend implements PtyBackend {
  readonly pid = 4242;
  written: Buffer[] = [];
  #data: ((d: Buffer) => void) | undefined;
  #exit: ((i: ExitInfo) => void) | undefined;
  write(data: Buffer): void {
    this.written.push(data);
  }
  resize(): void {}
  kill(signal = 'SIGHUP'): void {
    this.exit({ exitCode: null, signal });
  }
  onData(cb: (d: Buffer) => void): void {
    this.#data = cb;
  }
  onExit(cb: (i: ExitInfo) => void): void {
    this.#exit = cb;
  }
  out(text: string): void {
    this.#data!(Buffer.from(text, 'utf8'));
  }
  exit(info: ExitInfo): void {
    this.#exit?.(info);
  }
}

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const psp = (fields: string) => `\x1b]7501;${fields}\x07`;

function setup(over: TerminalAdapterOptions & { agent?: 'claude' | 'shell'; detectors?: readonly PromptDetector[] } = {}) {
  const backend = new FakeBackend();
  const host = new TerminalHost(backend, { coalesceMs: 1 });
  const log = new EventLog();
  const spec = over.agent === 'claude' ? claudeSpec() : shellSpec({ command: 'fake' });
  const opts: TerminalAdapterOptions = { idleMs: 150, settleMs: 40, submitDelayMs: 0, ...over };
  const session = new TerminalSession(host, spec, opts, log.emit, logger, undefined, detectorsFor(spec.agent, over.detectors ?? DEFAULT_DETECTORS));
  const statuses = () => log.ofType('session.status').map((e) => e.data);
  return { backend, host, log, session, statuses };
}

describe('OSC 7501 in TerminalSession', () => {
  it('maps reports to session.status with source osc7501 and the msg as reason', async () => {
    const { backend, statuses, session } = setup();
    backend.out(`hello${psp('state=working:app=fake')}`);
    await sleep(10);
    backend.out(psp(`state=blocked:kind=permission:msg=${b64('Allow Bash(rm -rf build)?')}`));
    await sleep(10);
    backend.out(psp('state=blocked:kind=question'));
    await sleep(10);
    backend.out(psp('state=blocked:kind=auth'));
    await sleep(10);
    backend.out(psp(`state=done:title=${b64('Finished')}`));
    await sleep(10);
    assert.deepEqual(statuses(), [
      { status: 'running', reason: 'working', source: 'osc7501' },
      { status: 'waiting_approval', prompt: 'approval', reason: 'Allow Bash(rm -rf build)?', source: 'osc7501' },
      { status: 'waiting_input', prompt: 'question', reason: 'blocked:question', source: 'osc7501' },
      { status: 'waiting_input', prompt: 'login', reason: 'blocked:auth', source: 'osc7501' },
      { status: 'idle', reason: 'Finished', source: 'osc7501' },
    ]);
    const p = session.statusProvenance()!;
    assert.equal(p.source, 'osc7501');
    assert.deepEqual(p.osc, { id: '', state: 'done', title: 'Finished', records: 1 });
    assert.ok(!Number.isNaN(Date.parse(p.at)));
    assert.deepEqual(explainSessionStatus(session), p);
    assert.match(formatStatusProvenance(p), /^idle from OSC 7501 root record: done, "Finished" at /);
    await session.stop();
  });

  it('reports split across PTY reads still apply', async () => {
    const { backend, statuses, session } = setup();
    const seq = psp(`state=blocked:kind=permission:msg=${b64('Edit main.ts?')}`).replace('\x07', '\x1b\\');
    for (const ch of seq) backend.out(ch);
    await sleep(20);
    assert.deepEqual(statuses().at(-1), { status: 'waiting_approval', prompt: 'approval', reason: 'Edit main.ts?', source: 'osc7501' });
    await session.stop();
  });

  it('takes precedence over the detectors and the idle timer while records are live', async () => {
    const { backend, statuses, session, log } = setup({ agent: 'claude', idleMs: 80, settleMs: 20 });
    // The program says it is working; the screen shows text a detector would match.
    backend.out(`${psp('state=working')}Do you want to proceed?\r\n❯ 1. Yes`);
    await sleep(200);
    assert.deepEqual(statuses(), [{ status: 'running', reason: 'working', source: 'osc7501' }], 'detector suppressed');
    // A turn sent while the program is reporting: its idle report completes the turn.
    await session.send('t_1', [{ type: 'text', text: 'go' }]);
    backend.out(psp('state=working'));
    await sleep(200);
    assert.equal(log.ofType('turn.completed').length, 0, 'quiet output does not end a turn the program says is running');
    backend.out(psp('state=idle'));
    await sleep(10);
    assert.deepEqual(log.ofType('turn.completed')[0]!.data, { turnId: 't_1', stopReason: 'end_turn' });
    assert.deepEqual(statuses().at(-1), { status: 'waiting_input', prompt: 'input', reason: 'idle', source: 'osc7501' });
    await session.stop();
  });

  it('error completes the in-flight turn as error but leaves the session alive', async () => {
    const { backend, statuses, session, log } = setup();
    await session.send('t_1', [{ type: 'text', text: 'go' }]);
    backend.out(psp(`state=error:msg=${b64('API overloaded')}`));
    await sleep(10);
    assert.deepEqual(log.ofType('turn.completed')[0]!.data, { turnId: 't_1', stopReason: 'error', error: 'API overloaded' });
    assert.deepEqual(statuses().at(-1), { status: 'waiting_input', prompt: 'input', reason: 'error: API overloaded', source: 'osc7501' });
    await session.stop();
  });

  it('falls back to the detectors when records are stale (no report since the last send) or cleared', async () => {
    const { backend, statuses, session, log } = setup({ idleMs: 80, settleMs: 20 });
    backend.out(psp('state=idle'));
    await sleep(10);
    // bizzi types a prompt; the program never reports again.
    await session.send('t_1', [{ type: 'text', text: 'ls' }]);
    backend.out('file1 file2\r\nuser@host ~ % ');
    await sleep(150);
    assert.equal(log.ofType('turn.completed').length, 1);
    assert.deepEqual(statuses().at(-1), { status: 'waiting_input', prompt: 'input', reason: 'input:shell-prompt', source: 'detector:shell-prompt' });
    const p = session.statusProvenance()!;
    assert.equal(p.detector!.id, 'shell-prompt');
    assert.equal(p.detector!.excerpt, '%');
    assert.match(p.detector!.origin!, /^builtin@/);
    assert.match(formatStatusProvenance(p), /detector shell-prompt \(last line ends in a typical shell prompt/);

    // Records cleared: the heuristics are in charge again.
    backend.out(psp('state=working'));
    await sleep(10);
    backend.out(psp('state=clear'));
    await sleep(10);
    assert.equal(session.programStatusRecords().length, 0);
    backend.out('Overwrite? [y/N] ');
    await sleep(100);
    assert.deepEqual(statuses().at(-1), { status: 'waiting_input', prompt: 'approval', reason: 'approval:yes-no', source: 'detector:yes-no' });
    await session.stop();
  });

  it('OSC 133;A drops working/blocked records', async () => {
    const { backend, statuses, session } = setup({ idleMs: 5000 });
    backend.out(psp('state=working:id=build') + psp('state=done:id=lint'));
    await sleep(10);
    assert.deepEqual(statuses().at(-1), { status: 'running', reason: 'working', source: 'osc7501' });
    backend.out('\x1b]133;A\x07$ ');
    await sleep(10);
    assert.deepEqual(
      session.programStatusRecords().map((r) => [r.id, r.state]),
      [['lint', 'done']],
    );
    assert.deepEqual(statuses().at(-1), { status: 'idle', reason: 'done', source: 'osc7501' });

    // With nothing left, the new prompt itself means "waiting for input".
    backend.out(psp('state=clear') + psp('state=blocked:kind=permission'));
    await sleep(10);
    backend.out('\x1b]133;A\x1b\\');
    await sleep(10);
    assert.equal(session.programStatusRecords().length, 0);
    assert.deepEqual(statuses().at(-1), { status: 'waiting_input', prompt: 'input', reason: 'new prompt', source: 'osc133' });
    await session.stop();
  });

  it('nested ids: the most urgent record decides; clearing a parent clears its children', async () => {
    const { backend, statuses, session } = setup({ idleMs: 5000 });
    backend.out(psp('state=idle:id=agent') + psp('state=working:id=agent/sub1') + psp(`state=blocked:id=agent/sub2:kind=question:msg=${b64('Which DB?')}`));
    await sleep(10);
    assert.deepEqual(statuses().at(-1), { status: 'waiting_input', prompt: 'question', reason: 'Which DB?', source: 'osc7501' });
    assert.equal(session.statusProvenance()!.osc!.id, 'agent/sub2');
    assert.equal(session.statusProvenance()!.osc!.records, 3);
    backend.out(psp('state=clear:id=agent/sub2'));
    await sleep(10);
    assert.deepEqual(statuses().at(-1), { status: 'running', reason: 'working', source: 'osc7501' });
    backend.out(psp('state=clear:id=agent'));
    await sleep(10);
    assert.equal(session.programStatusRecords().length, 0);
    await session.stop();
  });

  it('discards bad reports, ignores ? queries (no reply written), and does not repeat unchanged statuses', async () => {
    const { backend, statuses, session } = setup({ idleMs: 5000 });
    backend.out(psp('state=working:msg=!!!') + psp(`state=working:msg=${'A'.repeat(5000)}`) + psp('?'));
    await sleep(10);
    assert.deepEqual(statuses(), []);
    assert.deepEqual(backend.written, [], 'nothing written back to the program');
    backend.out(psp('state=working:progress=10') + psp('state=working:progress=20'));
    await sleep(10);
    assert.equal(statuses().length, 1);
    assert.equal(session.statusProvenance()!.osc!.progress, 20, 'provenance tracks the latest report');
    await session.stop();
  });

  it('process exit drops all records and reports with source process', async () => {
    const { backend, statuses, session } = setup({ idleMs: 5000 });
    backend.out(psp('state=blocked:kind=permission'));
    await sleep(10);
    backend.exit({ exitCode: 0 });
    await sleep(10);
    assert.equal(session.programStatusRecords().length, 0);
    assert.deepEqual(statuses().at(-1), { status: 'ended', reason: 'exit code 0', source: 'process' });
  });

  it('programStatus: false turns parsing off', async () => {
    const { backend, statuses, session } = setup({ idleMs: 60, programStatus: false });
    backend.out(psp('state=blocked:kind=permission'));
    await sleep(120);
    assert.deepEqual(statuses(), [{ status: 'waiting_input', reason: 'idle', source: 'activity:idle' }]);
    await session.stop();
  });

  it('detectorsEnabled: false leaves only OSC 7501 and the idle timer', async () => {
    const { backend, statuses, session } = setup({ idleMs: 60, detectors: [] });
    backend.out('Overwrite? [y/N] ');
    await sleep(120);
    assert.deepEqual(statuses(), [{ status: 'waiting_input', reason: 'idle', source: 'activity:idle' }]);
    await session.stop();
  });
});

describe('TerminalAdapter detector loading', () => {
  it('detectorsEnabled: false (what BIZZI_DETECTORS=off sets) reaches real sessions', async () => {
    const adapter = new TerminalAdapter(shellSpec({ command: 'bash', args: ['--norc', '--noprofile', '-c', 'printf "Overwrite? [y/N] "; read x'] }), {
      supervisor: false,
      idleMs: 200,
      settleMs: 50,
      detectorsEnabled: false,
    });
    const log = new EventLog();
    const session = await adapter.start(startOpts(), log.emit, ctx);
    await log.waitFor(() => log.ofType('session.status').length > 0, 'status');
    assert.deepEqual(log.ofType('session.status')[0]!.data, { status: 'waiting_input', reason: 'idle', source: 'activity:idle' });
    await session.stop();
  });

  it('a real process emitting OSC 7501 drives the status', async () => {
    const script = `printf '\\033]7501;state=blocked:kind=permission:msg=${b64('Allow?')}\\007'; read x; printf '\\033]7501;state=done\\033\\\\'; read y`;
    const adapter = new TerminalAdapter(shellSpec({ command: 'bash', args: ['--norc', '--noprofile', '-c', script] }), {
      supervisor: false,
      idleMs: 300,
      settleMs: 50,
    });
    const log = new EventLog();
    const session = await adapter.start(startOpts(), log.emit, ctx);
    await log.waitFor(() => log.ofType('session.status').some((e) => e.data.status === 'waiting_approval'), 'waiting_approval');
    assert.deepEqual(log.ofType('session.status')[0]!.data, { status: 'waiting_approval', prompt: 'approval', reason: 'Allow?', source: 'osc7501' });
    session.writeTerminal!(Buffer.from('y\r'));
    await log.waitFor(() => log.ofType('session.status').some((e) => e.data.status === 'idle'), 'idle');
    assert.equal(log.ofType('session.status').at(-1)!.data.source, 'osc7501');
    assert.equal(explainSessionStatus(session)!.osc!.state, 'done');
    await session.stop();
  });
});
