import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { base64UrlToBytes, bytesToBase64Url, webPushSupport } from '../src/lib/webPush.ts';

test('webPush: base64url helpers round-trip a 65-byte key; node is not a push runtime', () => {
  const key = new Uint8Array(65).map((_, i) => (i * 37) & 0xff);
  const s = bytesToBase64Url(key.buffer);
  assert.doesNotMatch(s, /[+/=]/);
  assert.deepEqual([...base64UrlToBytes(s)], [...key]);
  assert.equal(webPushSupport(), 'unsupported');
});

type Handler = (event: Record<string, unknown>) => void;

/** Load public/sw.js into a fake ServiceWorkerGlobalScope. */
function loadWorker(opts: { fetchOk?: boolean; windows?: { url: string; focused?: boolean }[] } = {}) {
  const handlers: Record<string, Handler> = {};
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const posted: unknown[] = [];
  const opened: string[] = [];
  const fetched: { url: string; body: unknown }[] = [];
  const windows = (opts.windows ?? []).map((w) => ({
    url: w.url,
    focused: Boolean(w.focused),
    visibilityState: 'visible',
    postMessage: (m: unknown) => posted.push(m),
    focus: async () => {},
  }));
  const scope = 'https://bizzi.example.com/';
  const self: Record<string, unknown> = {
    addEventListener: (type: string, fn: Handler) => (handlers[type] = fn),
    skipWaiting: () => {},
    registration: { scope, showNotification: async (title: string, options: Record<string, unknown>) => void shown.push({ title, options }) },
    clients: { claim: async () => {}, matchAll: async () => windows, openWindow: async (url: string) => void opened.push(url) },
  };
  const fetch = async (url: string, init: { body: string }) => {
    fetched.push({ url, body: JSON.parse(init.body) });
    if (opts.fetchOk === false) return { ok: false, status: 401 };
    return { ok: true, status: 200 };
  };
  runInNewContext(readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), { self, fetch, URL, JSON, console });
  /** Dispatch an event and wait for its waitUntil promise. */
  const dispatch = async (type: string, event: Record<string, unknown>) => {
    let wait: Promise<unknown> = Promise.resolve();
    handlers[type]!({ ...event, waitUntil: (p: Promise<unknown>) => (wait = p) });
    await wait;
  };
  return { dispatch, shown, posted, opened, fetched };
}

const approvalPayload = {
  v: 1,
  title: 'Approval needed: Fix tests',
  body: 'Run rm -rf build?\non pusher',
  tag: 'session:s_1',
  url: 'https://bizzi.example.com/#/s/s_1',
  sessionId: 's_1',
  urgent: true,
  approval: { sessionId: 's_1', approvalId: 'a_1', options: ['allow', 'deny'], token: 'tok', actionUrl: 'https://bizzi.example.com/api/push/action' },
};
const pushData = (p: unknown) => ({ json: () => p, text: () => JSON.stringify(p) });

test('sw.js: an approval push shows Approve / Deny; Approve posts the token', async () => {
  const w = loadWorker();
  await w.dispatch('push', { data: pushData(approvalPayload) });
  assert.equal(w.shown.length, 1);
  const n = w.shown[0]!;
  assert.equal(n.title, 'Approval needed: Fix tests');
  assert.equal(n.options.tag, 'session:s_1');
  assert.equal(n.options.requireInteraction, true);
  assert.deepEqual(
    [...(n.options.actions as { action: string }[]).map((a) => a.action)],
    ['allow', 'deny'],
  );
  await w.dispatch('notificationclick', { action: 'allow', notification: { data: n.options.data, close: () => {} } });
  assert.deepEqual(w.fetched, [{ url: 'https://bizzi.example.com/api/push/action', body: { token: 'tok', decision: 'allow' } }]);
  assert.deepEqual(w.opened, []);
});

test('sw.js: a failed action or a plain click opens the session (in an open window if there is one)', async () => {
  const w = loadWorker({ fetchOk: false });
  await w.dispatch('push', { data: pushData(approvalPayload) });
  const data = w.shown[0]!.options.data;
  await w.dispatch('notificationclick', { action: 'deny', notification: { data, close: () => {} } });
  assert.equal(w.fetched.length, 1);
  assert.deepEqual(w.opened, ['https://bizzi.example.com/#/s/s_1']);

  const open = loadWorker({ windows: [{ url: 'https://bizzi.example.com/#/inbox' }] });
  await open.dispatch('notificationclick', { action: '', notification: { data, close: () => {} } });
  assert.deepEqual(JSON.parse(JSON.stringify(open.posted)), [{ type: 'bizzi:open', url: 'https://bizzi.example.com/#/s/s_1' }]);
  assert.deepEqual(open.opened, []);
});

test('sw.js: skips the notification when that session is focused; tolerates a non-JSON push', async () => {
  const w = loadWorker({ windows: [{ url: 'https://bizzi.example.com/#/s/s_1', focused: true }] });
  await w.dispatch('push', { data: pushData(approvalPayload) });
  assert.equal(w.shown.length, 0);
  await w.dispatch('push', { data: { json: () => { throw new Error('not json'); }, text: () => 'hello' } });
  assert.equal(w.shown.length, 1);
  assert.equal(w.shown[0]!.title, 'bizzi');
  assert.equal(w.shown[0]!.options.body, 'hello');
});
