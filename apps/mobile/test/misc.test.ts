import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { barStyleForTheme } from '../src/bridge/theme.ts';
import { registerPush } from '../src/bridge/push.ts';
import type { PushPlugin } from '../src/bridge/push.ts';
import { encodePng, renderIcon } from '../scripts/icons.ts';

test('barStyleForTheme', () => {
  assert.equal(barStyleForTheme('dark'), 'DARK');
  assert.equal(barStyleForTheme('light'), 'LIGHT');
  assert.equal(barStyleForTheme(undefined), 'DEFAULT');
  assert.equal(barStyleForTheme('sepia'), 'DEFAULT');
});

function fakePush(receive: string, afterPrompt = receive) {
  const calls: string[] = [];
  const cbs: Record<string, (x: never) => void> = {};
  const plugin: PushPlugin = {
    checkPermissions: async () => (calls.push('check'), { receive }),
    requestPermissions: async () => (calls.push('request'), { receive: afterPrompt }),
    register: async () => void calls.push('register'),
    addListener: async (event: string, cb: (x: never) => void) => {
      cbs[event] = cb;
      return {};
    },
  } as PushPlugin;
  return { plugin, calls, cbs };
}

test('registerPush: prompts once, registers when granted, records the token', async () => {
  const { plugin, calls, cbs } = fakePush('prompt', 'granted');
  const state = { enabled: true, token: null as string | null };
  const tokens: string[] = [];
  assert.equal(await registerPush({ plugin, state, onToken: (t) => tokens.push(t), onError: () => {} }), true);
  assert.deepEqual(calls, ['check', 'request', 'register']);
  (cbs['registration'] as (t: { value: string }) => void)({ value: 'apns-hex' });
  assert.equal(state.token, 'apns-hex');
  assert.deepEqual(tokens, ['apns-hex']);
});

test('registerPush: does not register when denied', async () => {
  const { plugin, calls } = fakePush('denied');
  assert.equal(await registerPush({ plugin, state: { enabled: true, token: null }, onToken: () => {}, onError: () => {} }), false);
  assert.deepEqual(calls, ['check']);
});

test('placeholder icon: valid PNG of the right size, opaque for iOS', () => {
  const size = 48;
  const png = encodePng(size, size, renderIcon(size, 'square', true), 3);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), size);
  assert.equal(png.readUInt32BE(20), size);
  assert.equal(png[25], 2, 'RGB, no alpha channel');
  const idatLen = png.readUInt32BE(33);
  assert.equal(png.toString('ascii', 37, 41), 'IDAT');
  const raw = inflateSync(png.subarray(41, 41 + idatLen));
  assert.equal(raw.length, (size * 3 + 1) * size);
  // round icons are transparent in the corners
  const round = renderIcon(size, 'circle');
  assert.equal(round[3], 0);
  assert.equal(round[((size / 2) * size + size / 2) * 4 + 3], 255);
});
