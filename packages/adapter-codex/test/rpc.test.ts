import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { JsonRpcConnection, RpcClosedError, RpcError, type IncomingNotification, type IncomingRequest } from '../src/rpc.ts';
import { testLogger } from './helpers.ts';

function setup() {
  const fromServer = new PassThrough();
  const toServer = new PassThrough();
  const notes: IncomingNotification[] = [];
  const reqs: IncomingRequest[] = [];
  const logger = testLogger();
  const rpc = new JsonRpcConnection(fromServer, toServer, { onNotification: (n) => notes.push(n), onRequest: (r) => reqs.push(r) }, logger);
  const written: unknown[] = [];
  let buf = '';
  toServer.setEncoding('utf8');
  toServer.on('data', (d: string) => {
    buf += d;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      written.push(JSON.parse(buf.slice(0, nl)));
      buf = buf.slice(nl + 1);
    }
  });
  return { fromServer, rpc, notes, reqs, written, logger };
}

const flush = () => new Promise((r) => setImmediate(r));

test('requests, responses, notifications and server requests over split/merged lines', async () => {
  const { fromServer, rpc, notes, reqs, written, logger } = setup();
  const p1 = rpc.request('a', { x: 1 });
  const p2 = rpc.request('b', {});
  rpc.notify('initialized');
  await flush();
  assert.deepEqual(written, [{ id: 1, method: 'a', params: { x: 1 } }, { id: 2, method: 'b', params: {} }, { method: 'initialized' }]);

  // One response split across chunks (including a multibyte char split mid-sequence), two messages in one chunk.
  const line = Buffer.from(JSON.stringify({ id: 1, result: { s: 'héllo' } }) + '\n');
  const cut = line.indexOf(0xc3) + 1;
  fromServer.write(line.subarray(0, cut));
  fromServer.write(line.subarray(cut));
  fromServer.write(
    JSON.stringify({ id: 2, error: { code: -32600, message: 'bad' } }) +
      '\n' +
      JSON.stringify({ method: 'n', params: { k: 1 } }) +
      '\n\nnot json\n' +
      JSON.stringify({ id: 'srv', method: 'approve', params: {} }) +
      '\n',
  );
  assert.deepEqual(await p1, { s: 'héllo' });
  await assert.rejects(p2, (e: unknown) => e instanceof RpcError && e.code === -32600 && e.message === 'bad');
  assert.deepEqual(notes, [{ method: 'n', params: { k: 1 } }]);
  assert.deepEqual(reqs, [{ id: 'srv', method: 'approve', params: {} }]);
  assert.ok(logger.lines.some((l) => l.msg === 'codex sent a non-JSON line'));

  rpc.respond('srv', { decision: 'accept' });
  await flush();
  assert.deepEqual(written.at(-1), { id: 'srv', result: { decision: 'accept' } });
});

test('close rejects pending requests; timeouts reject', async () => {
  const { rpc } = setup();
  const slow = rpc.request('slow', {}, 20);
  await assert.rejects(slow, (e: unknown) => e instanceof RpcError && /timed out/.test(e.message));
  const pending = rpc.request('never', {});
  rpc.close('gone');
  await assert.rejects(pending, (e: unknown) => e instanceof RpcClosedError && e.message === 'gone');
  await assert.rejects(rpc.request('after', {}), RpcClosedError);
});
