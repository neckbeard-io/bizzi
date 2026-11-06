// Runs the real native-bridge.js bundle in a VM against a fake Capacitor native runtime
// (window.androidBridge + Capacitor.PluginHeaders/nativePromise/nativeCallback, the same hooks the
// native-injected Capacitor bridge provides), and checks the calls that reach "native".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { bundleBridge } from '../scripts/bundle-bridge.ts';
import type { BizziNativeBridge } from '../src/bridge/bridge.ts';

const bundleCache = new Map<boolean, string>();
async function bundle(push = false): Promise<string> {
  const cached = bundleCache.get(push);
  if (cached) return cached;
  const dir = mkdtempSync(join(tmpdir(), 'bizzi-bridge-'));
  try {
    const outfile = join(dir, 'native-bridge.js');
    await bundleBridge({ outfile, push });
    const code = readFileSync(outfile, 'utf8');
    bundleCache.set(push, code);
    return code;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface NativeCall {
  plugin: string;
  method: string;
  options: Record<string, unknown> | undefined;
}

type Responder = (call: NativeCall) => unknown;

const HEADERS = [
  { name: 'SecureStorage', methods: ['internalGetItem', 'internalSetItem', 'internalRemoveItem'] },
  { name: 'CapacitorBarcodeScanner', methods: ['scanBarcode'] },
  { name: 'App', methods: ['getLaunchUrl'], callbacks: ['addListener'] },
  { name: 'SystemBars', methods: ['setStyle'] },
  { name: 'PushNotifications', methods: ['checkPermissions', 'requestPermissions', 'register'], callbacks: ['addListener'] },
];

function fakeNative(opts: { platform?: 'android' | 'ios' | 'web'; respond?: Responder; theme?: string } = {}) {
  const calls: NativeCall[] = [];
  const listeners = new Map<string, (data: unknown) => void>();
  const events = new EventTarget();
  const observers: Array<() => void> = [];
  const root = { dataset: { theme: opts.theme } as Record<string, string | undefined> };
  const warnings: unknown[][] = [];

  const respond: Responder = opts.respond ?? (() => ({}));
  const capacitor = {
    PluginHeaders: HEADERS.map((h) => ({
      name: h.name,
      methods: [
        ...h.methods.map((name) => ({ name, rtype: 'promise' })),
        ...(h.callbacks ?? []).map((name) => ({ name, rtype: 'callback' })),
      ],
    })),
    nativePromise: (plugin: string, method: string, options?: Record<string, unknown>) => {
      const call = { plugin, method, options };
      calls.push(call);
      try {
        return Promise.resolve(respond(call));
      } catch (err) {
        return Promise.reject(err);
      }
    },
    nativeCallback: (plugin: string, method: string, options: { eventName: string }, cb: (data: unknown) => void) => {
      calls.push({ plugin, method, options });
      listeners.set(`${plugin}.${options.eventName}`, cb);
      return `cb-${listeners.size}`;
    },
  };

  const ctx: Record<string, unknown> = {
    Capacitor: capacitor,
    CustomEvent,
    EventTarget,
    URL,
    URLSearchParams,
    Promise,
    setTimeout,
    console: { ...console, warn: (...a: unknown[]) => warnings.push(a), error: (...a: unknown[]) => warnings.push(a) },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
    document: { documentElement: root },
    MutationObserver: class {
      readonly #cb: () => void;
      constructor(cb: () => void) {
        this.#cb = cb;
      }
      observe() {
        observers.push(this.#cb);
      }
      disconnect() {}
    },
  };
  if (opts.platform === 'android' || opts.platform === undefined) ctx['androidBridge'] = { postMessage() {} };
  if (opts.platform === 'ios') ctx['webkit'] = { messageHandlers: { bridge: { postMessage() {} } } };
  ctx['window'] = ctx;
  ctx['globalThis'] = ctx;
  vm.createContext(ctx);

  return {
    ctx,
    calls,
    events,
    root,
    warnings,
    run: (code: string) => vm.runInContext(code, ctx),
    get bridge() {
      return ctx['bizziNative'] as BizziNativeBridge | undefined;
    },
    fire: (key: string, data: unknown) => listeners.get(key)?.(data),
    hasListener: (key: string) => listeners.has(key),
    themeChanged: () => observers.forEach((cb) => cb()),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 10));
/** Values from the VM realm have foreign prototypes; compare them as plain data. */
const plain = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

test('bundle stays inert outside the native app (plain browser)', async () => {
  const env = fakeNative({ platform: 'web' });
  env.run(await bundle());
  await tick();
  assert.equal(env.bridge, undefined);
  assert.equal(env.calls.length, 0);
});

test('bundle installs window.bizziNative with the right platform', async () => {
  for (const platform of ['android', 'ios'] as const) {
    const env = fakeNative({ platform });
    env.run(await bundle());
    assert.equal(env.bridge?.platform, platform);
    assert.equal(env.bridge?.version, '0.0.1');
    assert.equal(env.bridge?.push.enabled, false);
  }
});

test('secure storage goes to the SecureStorage plugin with the bizzi_ prefix, device-only access', async () => {
  const store = new Map<string, string>();
  const env = fakeNative({
    respond: ({ plugin, method, options }) => {
      if (plugin !== 'SecureStorage') return {};
      const key = String(options?.['prefixedKey']);
      if (method === 'internalSetItem') store.set(key, String(options?.['data']));
      if (method === 'internalGetItem') return { data: store.get(key) ?? null };
      if (method === 'internalRemoveItem') return { success: store.delete(key) };
      return {};
    },
  });
  env.run(await bundle());
  const b = env.bridge!;
  await b.secureSet('identity', 'secret-jwk');
  assert.deepEqual([...store.entries()], [['bizzi_identity', 'secret-jwk']]);
  const set = env.calls.find((c) => c.method === 'internalSetItem');
  assert.equal(set?.options?.['access'], 3, 'KeychainAccess.afterFirstUnlockThisDeviceOnly');
  assert.equal(set?.options?.['sync'], false, 'never synced to iCloud Keychain');
  assert.equal(await b.secureGet('identity'), 'secret-jwk');
  await b.secureDelete('identity');
  assert.equal(await b.secureGet('identity'), null);
});

test('scanQr calls the native scanner and maps cancel to null', async () => {
  let mode: 'ok' | 'cancel' = 'ok';
  const env = fakeNative({
    respond: ({ plugin }) => {
      if (plugin !== 'CapacitorBarcodeScanner') return {};
      if (mode === 'cancel') throw Object.assign(new Error('cancelled'), { code: 'OS-PLUG-BARC-0006' });
      return { ScanResult: 'bizzi://pair?hub=https%3A%2F%2Fh.example&code=AB12', format: 0 };
    },
  });
  env.run(await bundle());
  assert.equal(await env.bridge!.scanQr(), 'bizzi://pair?hub=https%3A%2F%2Fh.example&code=AB12');
  const call = env.calls.find((c) => c.method === 'scanBarcode');
  assert.equal(call?.options?.['hint'], 0);
  mode = 'cancel';
  assert.equal(await env.bridge!.scanQr(), null);
});

test('cold start: the launch URL is kept for takePairLink() when nobody handles bizzi:pair', async () => {
  const url = 'bizzi://pair?hub=https%3A%2F%2Fh.example&code=AB12';
  const env = fakeNative({ respond: ({ plugin, method }) => (plugin === 'App' && method === 'getLaunchUrl' ? { url } : {}) });
  const seen: unknown[] = [];
  env.events.addEventListener('bizzi:pair', (e) => seen.push((e as CustomEvent).detail));
  env.run(await bundle());
  await tick();
  assert.deepEqual(plain(seen), [{ url, hub: 'https://h.example', code: 'AB12' }]);
  // iOS/Android may also report the launch URL as appUrlOpen: deduped.
  env.fire('App.appUrlOpen', { url });
  assert.equal(seen.length, 1);
  assert.deepEqual(plain(env.bridge!.takePairLink()), { url, hub: 'https://h.example', code: 'AB12' });
  assert.equal(env.bridge!.takePairLink(), null);
});

test('warm start: appUrlOpen dispatches bizzi:pair; preventDefault() marks it handled', async () => {
  const env = fakeNative();
  env.events.addEventListener('bizzi:pair', (e) => e.preventDefault());
  env.run(await bundle());
  await tick();
  assert.ok(env.hasListener('App.appUrlOpen'));
  env.fire('App.appUrlOpen', { url: 'bizzi://pair?hub=https%3A%2F%2Fh.example&code=ZZ' });
  assert.equal(env.bridge!.takePairLink(), null, 'handled by the listener');
  env.fire('App.appUrlOpen', { url: 'https://example.com/other' });
  env.fire('App.appUrlOpen', { url: 'bizzi://session?id=1' });
  assert.equal(env.bridge!.takePairLink(), null, 'non-pairing links are ignored');
});

test('system bars follow data-theme', async () => {
  const env = fakeNative({ theme: undefined });
  env.run(await bundle());
  env.root.dataset['theme'] = 'dark';
  env.themeChanged();
  env.root.dataset['theme'] = 'light';
  env.themeChanged();
  env.themeChanged(); // unchanged: no extra call
  await tick();
  const styles = env.calls.filter((c) => c.plugin === 'SystemBars').map((c) => c.options?.['style']);
  assert.deepEqual(plain(styles), ['DEFAULT', 'DARK', 'LIGHT']);
});

test('push stub: off by default, registers and publishes the token when built with BIZZI_PUSH=1', async () => {
  const off = fakeNative();
  off.run(await bundle(false));
  await tick();
  assert.equal(off.calls.filter((c) => c.plugin === 'PushNotifications').length, 0);

  const on = fakeNative({
    respond: ({ plugin, method }) => (plugin === 'PushNotifications' && method.endsWith('Permissions') ? { receive: 'granted' } : {}),
  });
  const tokens: unknown[] = [];
  on.events.addEventListener('bizzi:push-token', (e) => tokens.push((e as CustomEvent).detail));
  on.run(await bundle(true));
  await tick();
  assert.equal(on.bridge!.push.enabled, true);
  assert.ok(on.calls.some((c) => c.plugin === 'PushNotifications' && c.method === 'register'));
  on.fire('PushNotifications.registration', { value: 'fcm-token' });
  assert.deepEqual(plain(tokens), [{ platform: 'android', token: 'fcm-token' }]);
  assert.equal(on.bridge!.push.token, 'fcm-token');
});
