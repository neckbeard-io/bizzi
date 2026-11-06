import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ActivityMonitor,
  DEFAULT_DETECTORS,
  OutputCoalescer,
  ScrollbackBuffer,
  detectorsFor,
  parseResumeRef,
  formatPtyRef,
  stripAnsi,
  type IdleResult,
} from '../src/index.ts';
import { sleep } from './helpers.ts';

describe('ScrollbackBuffer', () => {
  it('keeps the most recent bytes with absolute offsets', () => {
    const rb = new ScrollbackBuffer(8);
    rb.write(Buffer.from('abcde'));
    assert.equal(rb.read().toString(), 'abcde');
    assert.equal(rb.start, 0);
    rb.write(Buffer.from('fghij'));
    assert.equal(rb.end, 10);
    assert.equal(rb.start, 2);
    assert.equal(rb.size, 8);
    assert.equal(rb.read().toString(), 'cdefghij');
    assert.equal(rb.read(7).toString(), 'hij');
    assert.equal(rb.read(0).toString(), 'cdefghij', 'clamped to what is held');
    assert.equal(rb.has(2), true);
    assert.equal(rb.has(1), false);
  });

  it('handles writes larger than the capacity', () => {
    const rb = new ScrollbackBuffer(4);
    rb.write(Buffer.from('xy'));
    rb.write(Buffer.from('0123456789'));
    assert.equal(rb.read().toString(), '6789');
    assert.equal(rb.end, 12);
  });

  it('clear and resetAt keep offsets meaningful', () => {
    const rb = new ScrollbackBuffer(16);
    rb.write(Buffer.from('hello'));
    rb.clear();
    assert.equal(rb.size, 0);
    assert.equal(rb.end, 5);
    rb.write(Buffer.from('!'));
    assert.equal(rb.read().toString(), '!');
    rb.resetAt(100);
    rb.write(Buffer.from('abc'));
    assert.equal(rb.start, 100);
    assert.equal(rb.read(101).toString(), 'bc');
  });

  it('defaults to 2 MiB', () => {
    assert.equal(new ScrollbackBuffer().capacity, 2 * 1024 * 1024);
  });
});

describe('OutputCoalescer', () => {
  it('batches small writes within the window', async () => {
    const out: string[] = [];
    const c = new OutputCoalescer((b) => out.push(b.toString()), { delayMs: 20 });
    c.push(Buffer.from('a'));
    c.push(Buffer.from('b'));
    c.push(Buffer.from('c'));
    assert.deepEqual(out, []);
    await sleep(50);
    assert.deepEqual(out, ['abc']);
  });

  it('flushes immediately at the byte cap and splits oversize input', () => {
    const out: Buffer[] = [];
    const c = new OutputCoalescer((b) => out.push(b), { delayMs: 1000, maxBytes: 4 });
    c.push(Buffer.from('0123456789'));
    assert.deepEqual(
      out.map((b) => b.toString()),
      ['0123', '4567'],
    );
    c.flush();
    assert.equal(out[2]?.toString(), '89');
    c.dispose();
  });
});

describe('stripAnsi', () => {
  it('removes colours, OSC titles and keeps words apart on cursor moves', () => {
    const s = stripAnsi('\x1b]0;title\x07\x1b[1;32mDo\x1b[1Cyou\x1b[0m want\r\n\x1b[2;1Hnext');
    assert.equal(s, 'Do you want\n\nnext');
  });
});

describe('ActivityMonitor', () => {
  it('reports idle once after output goes quiet', async () => {
    const idle: IdleResult[] = [];
    let active = 0;
    const m = new ActivityMonitor({ idleMs: 60, onIdle: (r) => idle.push(r), onActive: () => active++ });
    m.output('working...');
    await sleep(30);
    m.output('still working');
    await sleep(40);
    assert.equal(idle.length, 0, 'timer reset by new output');
    await sleep(60);
    assert.equal(idle.length, 1);
    assert.equal(idle[0]!.reason, 'idle');
    assert.equal(active, 1);
    await sleep(100);
    assert.equal(idle.length, 1, 'only once per burst');
    m.dispose();
  });

  it('uses the settle delay and reports the matching detector', async () => {
    const idle: IdleResult[] = [];
    const m = new ActivityMonitor({
      idleMs: 5000,
      settleMs: 40,
      detectors: detectorsFor('claude'),
      onIdle: (r) => idle.push(r),
    });
    m.output('\x1b[1mDo you want to proceed?\x1b[0m\r\n❯ 1. Yes\r\n  2. No');
    await sleep(100);
    assert.equal(idle.length, 1);
    assert.equal(idle[0]!.kind, 'approval');
    assert.equal(idle[0]!.reason, 'approval:claude-permission');
    m.dispose();
  });

  it('ignores small echo right after input, and kick() starts a burst without output', async () => {
    const idle: IdleResult[] = [];
    const m = new ActivityMonitor({ idleMs: 40, onIdle: (r) => idle.push(r) });
    m.input();
    m.output('l');
    await sleep(80);
    assert.equal(idle.length, 0, 'echo did not start a burst');
    m.kick();
    await sleep(80);
    assert.equal(idle.length, 1);
    m.dispose();
  });

  it('detects the claude folder-trust dialog (captured from claude 2.1.311)', () => {
    const captured =
      '\x1b[2G\x1b[38;2;177;185;249m❯\x1b[4GNo,\x1b[8Gexit\x1b[39m\r\r\n\x1b[4GYes,\x1b[9GI\x1b[11Gtrust\x1b[17Gthis\x1b[22Gfolder\r\r\n' +
      '\r\r\n\x1b[2G\x1b[38;2;153;153;153mEnter\x1b[8Gto\x1b[11Gconfirm\x1b[19G·\x1b[21GEsc\x1b[25Gto\x1b[28Gcancel\x1b[39m\r\r\n';
    assert.match(stripAnsi(captured), /Yes, I trust this folder/);
    assert.equal(detectorsFor('claude').find((d) => d.test(stripAnsi(captured)))?.id, 'claude-trust');
  });

  it('detects shell prompts and yes/no questions', () => {
    const shell = detectorsFor('shell');
    const match = (text: string) => shell.find((d) => d.test(stripAnsi(text)))?.id;
    assert.equal(match('ls\r\nfoo bar\r\nuser@host ~ % '), 'shell-prompt');
    assert.equal(match('Overwrite file? [y/N] '), 'yes-no');
    assert.equal(match('compiling 3/10'), undefined);
    // Agent-specific detectors only apply to their agent.
    assert.ok(!shell.some((d) => d.id === 'claude-permission'));
    assert.ok(DEFAULT_DETECTORS.length >= 6);
  });
});

describe('resume refs', () => {
  it('round-trips supervisor and native refs', () => {
    const id = 'abcdefghijklmnop';
    assert.deepEqual(parseResumeRef(formatPtyRef(id)), { supervisorId: id, nativeRef: undefined });
    assert.deepEqual(parseResumeRef(formatPtyRef(id, 'uuid-1')), { supervisorId: id, nativeRef: 'uuid-1' });
    assert.deepEqual(parseResumeRef('8f9c-native'), { nativeRef: '8f9c-native' });
    assert.deepEqual(parseResumeRef(undefined), {});
  });
});
