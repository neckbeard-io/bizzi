import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_OSC7501_LENGTH,
  OscScanner,
  ProgramStatusTracker,
  parseProgramStatus,
  stripAnsi,
  summarizeRecord,
  type OscEvent,
  type ProgramStatusReport,
} from '../src/index.ts';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const osc = (body: string, st: 'bel' | 'st' = 'bel') => `\x1b]${body}${st === 'bel' ? '\x07' : '\x1b\\'}`;

function scanAll(chunks: string[]): OscEvent[] {
  const s = new OscScanner();
  return chunks.flatMap((c) => s.push(c));
}

function report(payload: string): ProgramStatusReport {
  const r = parseProgramStatus(payload);
  assert.ok(r.ok, `expected ok for ${payload}: ${r.ok ? '' : r.error}`);
  return r.report;
}

describe('OscScanner', () => {
  it('finds 7501 reports with BEL and ESC \\ terminators', () => {
    const text = `before${osc('7501;state=working')}middle${osc('7501;state=idle', 'st')}after`;
    assert.deepEqual(scanAll([text]), [
      { type: 'osc7501', payload: 'state=working', overflow: false },
      { type: 'osc7501', payload: 'state=idle', overflow: false },
    ]);
  });

  it('handles a sequence split at every possible point', () => {
    const seq = osc(`7501;state=blocked:kind=permission:msg=${b64('Allow Bash?')}`, 'st');
    const text = `x${seq}y`;
    for (let i = 0; i <= text.length; i++) {
      for (let j = i; j <= text.length; j++) {
        const ev = scanAll([text.slice(0, i), text.slice(i, j), text.slice(j)]);
        assert.equal(ev.length, 1, `split at ${i},${j}`);
        assert.equal(ev[0]!.type, 'osc7501');
      }
    }
    // One character at a time.
    assert.equal(scanAll([...text]).length, 1);
  });

  it('ignores other OSCs without buffering them, and recognizes OSC 133;A', () => {
    const big = 'x'.repeat(100_000);
    const ev = scanAll([osc('0;title'), osc(`52;c;${big}`), osc('8;;https://example.com'), osc('133;A'), osc('133;B'), osc('133;A;cl=m')]);
    assert.deepEqual(ev, [{ type: 'prompt-start' }, { type: 'prompt-start' }]);
  });

  it('aborts on ESC + other, CAN and SUB, and recovers for the next sequence', () => {
    assert.deepEqual(scanAll([`\x1b]7501;state=working\x1b[0m${osc('7501;state=idle')}`]), [
      { type: 'osc7501', payload: 'state=idle', overflow: false },
    ]);
    assert.deepEqual(scanAll([`\x1b]7501;state=working\x18${osc('7501;state=done')}`]), [
      { type: 'osc7501', payload: 'state=done', overflow: false },
    ]);
    // ESC ] inside an aborted OSC starts a new one.
    assert.deepEqual(scanAll([`\x1b]7501;state=work\x1b]7501;state=error\x07`]), [
      { type: 'osc7501', payload: 'state=error', overflow: false },
    ]);
  });

  it('flags oversized reports as overflow (and keeps going)', () => {
    const long = `7501;state=working:msg=${'A'.repeat(MAX_OSC7501_LENGTH + 10)}`;
    const ev = scanAll([osc(long).slice(0, 2000), osc(long).slice(2000), osc('7501;state=idle')]);
    assert.equal(ev.length, 2);
    assert.equal(ev[0]!.type === 'osc7501' && ev[0]!.overflow, true);
    assert.deepEqual(ev[1], { type: 'osc7501', payload: 'state=idle', overflow: false });
  });

  it('reset() drops a partial sequence', () => {
    const s = new OscScanner();
    assert.deepEqual(s.push('\x1b]7501;state=wor'), []);
    s.reset();
    assert.deepEqual(s.push('king\x07'), []);
  });

  it('stripAnsi still removes 7501 reports from heuristic text', () => {
    const text = `Do you${osc(`7501;state=blocked:msg=${b64('hi')}`)} want${osc('7501;state=idle', 'st')} to`;
    assert.equal(stripAnsi(text), 'Do you want to');
  });
});

describe('parseProgramStatus', () => {
  it('parses state, id, app, kind, progress and base64 title/msg', () => {
    const r = report(`state=blocked:id=build/tests:app=claude:kind=permission:progress=40:title=${b64('Bash')}:msg=${b64('Allow rm -rf? ✓')}`);
    assert.deepEqual(r, {
      type: 'set',
      record: { id: 'build/tests', state: 'blocked', app: 'claude', kind: 'permission', progress: 40, title: 'Bash', msg: 'Allow rm -rf? ✓' },
    });
  });

  it('skips malformed pairs but keeps the report', () => {
    const r = report('garbage:=x:state=working:Bad Key=1:progress=3/4:noeq');
    assert.deepEqual(r, { type: 'set', record: { id: '', state: 'working', progress: 75 } });
  });

  it('ignores kind on non-blocked states and invalid progress', () => {
    assert.deepEqual(report('state=idle:kind=permission:progress=50'), { type: 'set', record: { id: '', state: 'idle' } });
    assert.deepEqual(report('state=working:progress=200'), { type: 'set', record: { id: '', state: 'working' } });
    assert.deepEqual(report('state=blocked:kind=weird'), { type: 'set', record: { id: '', state: 'blocked' } });
  });

  it('discards the whole report on bad base64 or bad UTF-8', () => {
    assert.deepEqual(parseProgramStatus('state=working:msg=@@notbase64'), { ok: false, error: 'bad base64 in msg' });
    assert.deepEqual(parseProgramStatus('state=working:title=abcde'), { ok: false, error: 'bad base64 in title' });
    const badUtf8 = Buffer.from([0xff, 0xfe, 0xfd]).toString('base64');
    assert.equal(parseProgramStatus(`state=working:msg=${badUtf8}`).ok, false);
  });

  it('discards oversized reports and reports without a valid state', () => {
    assert.deepEqual(parseProgramStatus('state=working', true), { ok: false, error: 'report too large' });
    assert.equal(parseProgramStatus('id=x').ok, false);
    assert.equal(parseProgramStatus('state=sleeping').ok, false);
    assert.equal(parseProgramStatus(`state=working:id=${'x'.repeat(300)}`).ok, false);
  });

  it('parses clear, the ? query, and normalizes nested ids', () => {
    assert.deepEqual(report('state=clear:id=/a//b/'), { type: 'clear', id: 'a/b' });
    assert.deepEqual(report('state=clear'), { type: 'clear', id: '' });
    assert.deepEqual(report('?'), { type: 'query' });
  });

  it('accepts unpadded base64', () => {
    assert.deepEqual(report('state=done:msg=aGk'), { type: 'set', record: { id: '', state: 'done', msg: 'hi' } });
  });
});

describe('ProgramStatusTracker', () => {
  it('a report replaces its record; the most urgent record wins', () => {
    const t = new ProgramStatusTracker();
    t.apply(report('state=working:id=a'), 1);
    t.apply(report('state=idle:id=b'), 2);
    assert.equal(t.current()?.id, 'a');
    t.apply(report(`state=blocked:id=b:kind=question:msg=${b64('Which file?')}`), 3);
    assert.deepEqual(t.summary() && { status: t.summary()!.status, prompt: t.summary()!.prompt, reason: t.summary()!.reason }, {
      status: 'waiting_input',
      prompt: 'question',
      reason: 'Which file?',
    });
    t.apply(report('state=done:id=b'), 4);
    assert.equal(t.size, 2);
    assert.equal(t.current()?.id, 'a', 'working beats done');
  });

  it('clear removes a record and its nested children; root clear removes all', () => {
    const t = new ProgramStatusTracker();
    t.apply(report('state=working:id=build'));
    t.apply(report('state=working:id=build/tests'));
    t.apply(report('state=working:id=buildx'));
    t.apply(report('state=idle'));
    assert.equal(t.apply(report('state=clear:id=build')), true);
    assert.deepEqual(
      t.records().map((r) => r.id),
      ['', 'buildx'],
    );
    assert.equal(t.apply(report('state=clear:id=nothing')), false);
    t.apply(report('state=clear'));
    assert.equal(t.size, 0);
  });

  it('dropTransient removes working/blocked records only', () => {
    const t = new ProgramStatusTracker();
    t.apply(report('state=working:id=a'));
    t.apply(report('state=blocked:id=b'));
    t.apply(report('state=done:id=c'));
    assert.equal(t.dropTransient(), true);
    assert.deepEqual(
      t.records().map((r) => r.id),
      ['c'],
    );
    assert.equal(t.dropTransient(), false);
  });

  it('ignores queries', () => {
    const t = new ProgramStatusTracker();
    assert.equal(t.apply({ type: 'query' }), false);
    assert.equal(t.lastReportAt, -Infinity);
  });

  it('maps states to session statuses', () => {
    const m = (payload: string) => {
      const r = report(payload);
      assert.equal(r.type, 'set');
      const s = summarizeRecord({ ...(r as Extract<ProgramStatusReport, { type: 'set' }>).record, at: 0, order: 0 });
      return [s.status, s.prompt, s.reason];
    };
    assert.deepEqual(m('state=working'), ['running', undefined, 'working']);
    assert.deepEqual(m(`state=blocked:kind=permission:title=${b64('Edit file')}`), ['waiting_approval', 'approval', 'Edit file']);
    assert.deepEqual(m('state=blocked:kind=question'), ['waiting_input', 'question', 'blocked:question']);
    assert.deepEqual(m('state=blocked:kind=auth'), ['waiting_input', 'login', 'blocked:auth']);
    assert.deepEqual(m('state=blocked'), ['waiting_input', 'input', 'blocked']);
    assert.deepEqual(m('state=idle'), ['waiting_input', 'input', 'idle']);
    assert.deepEqual(m(`state=done:msg=${b64('All tests pass')}`), ['idle', undefined, 'All tests pass']);
    assert.deepEqual(m(`state=error:msg=${b64('API overloaded')}`), ['waiting_input', 'input', 'error: API overloaded']);
  });
});
