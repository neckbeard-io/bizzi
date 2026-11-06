import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCAN_CANCELLED_CODE, SCAN_CAMERA_DENIED_CODE, SCAN_HINT_QR_CODE, createBizziNative, isScanCancelled } from '../src/bridge/bridge.ts';
import type { BridgeDeps, QrScanner, SecureStore } from '../src/bridge/bridge.ts';

function memoryStore(): SecureStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, v) => void data.set(k, v),
    removeItem: async (k) => void data.delete(k),
  };
}

function makeBridge(over: Partial<BridgeDeps> = {}) {
  const store = memoryStore();
  const scanner: QrScanner = { scanBarcode: async () => ({ ScanResult: 'bizzi://pair?hub=https%3A%2F%2Fh&code=A' }) };
  const bridge = createBizziNative({
    platform: 'ios',
    version: '0.0.1',
    store,
    scanner,
    takePairLink: () => null,
    push: { enabled: false, token: null },
    ...over,
  });
  return { bridge, store };
}

test('exposes the contract', () => {
  const { bridge } = makeBridge({ platform: 'android' });
  assert.equal(bridge.platform, 'android');
  for (const fn of ['secureGet', 'secureSet', 'secureDelete', 'scanQr'] as const) assert.equal(typeof bridge[fn], 'function');
});

test('secure storage round-trip; missing keys read as null', async () => {
  const { bridge, store } = makeBridge();
  assert.equal(await bridge.secureGet('device'), null);
  await bridge.secureSet('device', '{"deviceId":"D1"}');
  assert.equal(store.data.get('device'), '{"deviceId":"D1"}');
  assert.equal(await bridge.secureGet('device'), '{"deviceId":"D1"}');
  await bridge.secureSet('device', '');
  assert.equal(await bridge.secureGet('device'), '', 'empty string is a value, not "missing"');
  await bridge.secureDelete('device');
  assert.equal(await bridge.secureGet('device'), null);
  await bridge.secureDelete('device'); // deleting a missing key is fine
});

test('secureGet maps undefined from the plugin to null', async () => {
  const { bridge } = makeBridge({
    store: { getItem: async () => undefined as unknown as null, setItem: async () => {}, removeItem: async () => {} },
  });
  assert.equal(await bridge.secureGet('k'), null);
});

test('rejects bad keys and non-string values', async () => {
  const { bridge } = makeBridge();
  await assert.rejects(bridge.secureGet(''), TypeError);
  await assert.rejects(bridge.secureGet(42 as unknown as string), TypeError);
  await assert.rejects(bridge.secureSet('k'.repeat(257), 'v'), TypeError);
  await assert.rejects(bridge.secureSet('k', { a: 1 } as unknown as string), TypeError);
  await assert.rejects(bridge.secureDelete(''), TypeError);
});

test('scanQr asks for a QR code and returns the trimmed text', async () => {
  let opts: Record<string, unknown> = {};
  const { bridge } = makeBridge({
    scanner: {
      scanBarcode: async (o) => {
        opts = o;
        return { ScanResult: '  bizzi://pair?hub=x&code=y \n' };
      },
    },
  });
  assert.equal(await bridge.scanQr(), 'bizzi://pair?hub=x&code=y');
  assert.equal(opts['hint'], SCAN_HINT_QR_CODE);
});

test('scanQr returns null on cancel or an empty result', async () => {
  const cancelled = Object.assign(new Error('Couldn’t scan because the process was cancelled.'), { code: SCAN_CANCELLED_CODE });
  assert.equal(await makeBridge({ scanner: { scanBarcode: async () => Promise.reject(cancelled) } }).bridge.scanQr(), null);
  assert.equal(await makeBridge({ scanner: { scanBarcode: async () => ({ ScanResult: '' }) } }).bridge.scanQr(), null);
  assert.equal(await makeBridge({ scanner: { scanBarcode: async () => ({}) } }).bridge.scanQr(), null);
});

test('scanQr surfaces camera denial and other errors', async () => {
  const denied = Object.assign(new Error('no camera'), { code: SCAN_CAMERA_DENIED_CODE });
  await assert.rejects(makeBridge({ scanner: { scanBarcode: async () => Promise.reject(denied) } }).bridge.scanQr(), /Camera access was denied/);
  const other = Object.assign(new Error('boom'), { code: 'OS-PLUG-BARC-0004' });
  await assert.rejects(makeBridge({ scanner: { scanBarcode: async () => Promise.reject(other) } }).bridge.scanQr(), /boom/);
});

test('isScanCancelled recognises the code and the message', () => {
  assert.equal(isScanCancelled({ code: SCAN_CANCELLED_CODE }), true);
  assert.equal(isScanCancelled(new Error('User cancelled')), true);
  assert.equal(isScanCancelled(new Error('boom')), false);
  assert.equal(isScanCancelled(null), false);
});

test('extras: takePairLink delegates; push state is shared by reference', () => {
  const link = { url: 'bizzi://pair?hub=https%3A%2F%2Fh&code=A', hub: 'https://h', code: 'A' };
  const push = { enabled: true, token: null as string | null };
  const { bridge } = makeBridge({ takePairLink: () => link, push });
  assert.equal(bridge.takePairLink(), link);
  push.token = 'tok';
  assert.equal(bridge.push.token, 'tok');
  assert.equal(bridge.parsePairLink('bizzi://pair?hub=https%3A%2F%2Fh&code=A')?.hub, 'https://h');
  assert.equal(bridge.parsePairLink('hello'), null);
});
