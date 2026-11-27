import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BizziError, decode, encode, isEvent, isRequest, isResponse, newId, parseChannel, sessionChannel, ulid } from '../src/index.ts';

test('ulid is 26 chars and sortable by time', () => {
  const a = ulid(1_000);
  const b = ulid(2_000);
  assert.equal(a.length, 26);
  assert.ok(a.slice(0, 10) < b.slice(0, 10));
});

test('newId carries the prefix', () => {
  assert.match(newId('s'), /^s_[0-9A-HJKMNP-TV-Z]{26}$/);
});

test('channels round-trip', () => {
  assert.deepEqual(parseChannel(sessionChannel('s_1')), { kind: 'session', sessionId: 's_1' });
  assert.deepEqual(parseChannel('global'), { kind: 'global' });
  assert.equal(parseChannel('nope'), null);
});

test('decode classifies messages', () => {
  const req = decode(encode({ id: 'r_1', method: 'machines.list', params: {} }));
  assert.ok(isRequest(req));
  const res = decode('{"id":"r_1","result":{"machines":[]}}');
  assert.ok(isResponse(res));
  const ev = decode('{"ch":"global","seq":1,"ts":"x","type":"workspace.removed","data":{"workspaceId":"w_1"}}');
  assert.ok(isEvent(ev));
});

test('decode rejects garbage with BizziError', () => {
  assert.throws(() => decode('{'), (e: unknown) => e instanceof BizziError && e.code === 'bad_request');
  assert.throws(() => decode('{"x":1}'), (e: unknown) => e instanceof BizziError && e.code === 'bad_request');
});

test('inheritedImportArgs keeps only --import flags, in order', async () => {
  const { inheritedImportArgs } = await import('../src/index.ts');
  assert.deepEqual(inheritedImportArgs([]), []);
  assert.deepEqual(
    inheritedImportArgs(['--inspect', '--import', 'file:///a/hook.ts', '--no-warnings', '--import=file:///b.mjs', '--import']),
    ['--import', 'file:///a/hook.ts', '--import=file:///b.mjs'],
  );
});
