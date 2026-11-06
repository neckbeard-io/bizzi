import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { parseReadyLine, ReadyLineError, waitForReadyLine } from '../src/core/ready-line.ts';

const READY = { event: 'ready', url: 'ws://127.0.0.1:7777/ws', token: 'tok', machineId: 'm1', pid: 4242 };

test('parses a valid ready line', () => {
  assert.deepEqual(parseReadyLine(JSON.stringify(READY)), READY);
  assert.deepEqual(parseReadyLine(`  ${JSON.stringify(READY)}\r`), READY);
});

test('drops unknown fields', () => {
  assert.deepEqual(parseReadyLine(JSON.stringify({ ...READY, extra: 1 })), READY);
});

test('rejects anything that is not a ready line', () => {
  const bad = [
    '',
    'listening on 7777',
    '{not json',
    '[]',
    'null',
    JSON.stringify({ ...READY, event: 'started' }),
    JSON.stringify({ ...READY, url: 'http://127.0.0.1:7777/ws' }),
    JSON.stringify({ ...READY, url: 'not a url' }),
    JSON.stringify({ ...READY, token: '' }),
    JSON.stringify({ ...READY, token: 7 }),
    JSON.stringify({ ...READY, machineId: undefined }),
    JSON.stringify({ ...READY, pid: '4242' }),
    JSON.stringify({ ...READY, pid: 0 }),
    JSON.stringify({ ...READY, pid: 1.5 }),
  ];
  for (const line of bad) assert.equal(parseReadyLine(line), null, line);
});

test('accepts wss urls', () => {
  assert.ok(parseReadyLine(JSON.stringify({ ...READY, url: 'wss://bizzi.example.com/ws' })));
});

test('waitForReadyLine skips noise, handles chunk splits, keeps reporting later lines', async () => {
  const s = new PassThrough();
  const other: string[] = [];
  const p = waitForReadyLine(s, { timeoutMs: 1000, onOtherLine: (l) => other.push(l) });
  const line = JSON.stringify(READY);
  s.write('booting\n');
  s.write(line.slice(0, 10));
  s.write(line.slice(10) + '\n');
  assert.deepEqual(await p, READY);
  s.write('after\n');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(other, ['booting', 'after']);
  s.end();
});

test('waitForReadyLine accepts a final line without newline at end of stream', async () => {
  const s = new PassThrough();
  const p = waitForReadyLine(s, { timeoutMs: 1000 });
  s.end(JSON.stringify(READY));
  assert.deepEqual(await p, READY);
});

test('waitForReadyLine rejects when the stream closes first', async () => {
  const s = new PassThrough();
  const p = waitForReadyLine(s, { timeoutMs: 1000 });
  s.end('oops\n');
  await assert.rejects(p, (e: unknown) => e instanceof ReadyLineError && e.code === 'closed');
});

test('waitForReadyLine times out', async () => {
  const s = new PassThrough();
  await assert.rejects(waitForReadyLine(s, { timeoutMs: 30 }), (e: unknown) => e instanceof ReadyLineError && e.code === 'timeout');
  s.destroy();
});
