// Entry point of native-bridge.js: a classic script that the stage step injects into the staged
// index.html *before* the UI bundle, so `window.bizziNative` exists by the time the UI starts.
// Bundled to an IIFE by scripts/bundle-bridge.ts. Does nothing when not running in the native app.

import { Capacitor, SystemBars, registerPlugin } from '@capacitor/core';
import type { SystemBarsStyle } from '@capacitor/core';
import { App } from '@capacitor/app';
import { KeychainAccess, SecureStorage } from '@aparajita/capacitor-secure-storage';
import { createBizziNative } from './bridge.ts';
import type { BizziNativeBridge, QrScanner, SecureStore } from './bridge.ts';
import { PAIR_EVENT, PairLinkInbox } from './deeplink.ts';
import { PUSH_TOKEN_EVENT, registerPush } from './push.ts';
import type { PushPlugin, PushState } from './push.ts';
import { watchTheme } from './theme.ts';

declare const __BIZZI_PUSH__: boolean;
declare const __BIZZI_BRIDGE_VERSION__: string;

declare global {
  interface Window {
    bizziNative?: BizziNativeBridge;
  }
}

/** Keychain/Keystore entries are stored as `<prefix><key>`. */
const KEY_PREFIX = 'bizzi_';

function install(): void {
  const platform = Capacitor.getPlatform();
  if (platform !== 'ios' && platform !== 'android') return;
  if (window.bizziNative) return;

  // --- secure storage: Keychain (iOS) / Android Keystore. Items stay on this device: they are
  // excluded from backups to other devices, matching the per-device keypair model (D8).
  // Sequential on purpose: Capacitor's plugin proxy loads the JS implementation lazily, and two
  // concurrent first calls would each create (and configure) a separate instance.
  const configured = (async () => {
    await SecureStorage.setKeyPrefix(KEY_PREFIX);
    await SecureStorage.setDefaultKeychainAccess(KeychainAccess.afterFirstUnlockThisDeviceOnly);
  })();
  const store: SecureStore = {
    async getItem(key) {
      await configured;
      return SecureStorage.getItem(key);
    },
    async setItem(key, value) {
      await configured;
      await SecureStorage.setItem(key, value);
    },
    async removeItem(key) {
      await configured;
      await SecureStorage.removeItem(key);
    },
  };

  // --- QR scanning: @capacitor/barcode-scanner's native plugin (full-screen native scanner UI).
  const scanner = registerPlugin<QrScanner>('CapacitorBarcodeScanner');

  // --- deep links: bizzi://pair?hub=…&code=…
  const inbox = new PairLinkInbox();
  const push: PushState = { enabled: __BIZZI_PUSH__, token: null };

  window.bizziNative = createBizziNative({
    platform,
    version: __BIZZI_BRIDGE_VERSION__,
    store,
    scanner,
    takePairLink: () => inbox.take(),
    push,
  });

  const onUrl = (url: string | undefined): void => {
    if (!url) return;
    const link = inbox.offer(url, Date.now());
    if (!link) return;
    const event = new CustomEvent(PAIR_EVENT, { detail: { url: link.url, hub: link.hub, code: link.code }, cancelable: true });
    // A listener that handles the link calls preventDefault(); otherwise it stays pending for takePairLink().
    if (!window.dispatchEvent(event)) inbox.consume(link);
  };
  void App.addListener('appUrlOpen', (e) => onUrl(e.url));
  void App.getLaunchUrl().then((r) => onUrl(r?.url), () => {});

  // --- system bars follow the UI theme (the UI draws edge to edge with viewport-fit=cover).
  const applyBars = (style: string): void => {
    void SystemBars.setStyle({ style: style as SystemBarsStyle }).catch(() => {});
  };
  if (document.documentElement) watchTheme(document.documentElement, applyBars);

  // --- push (scaffold, off unless staged with BIZZI_PUSH=1)
  if (__BIZZI_PUSH__) {
    const plugin = registerPlugin<PushPlugin>('PushNotifications');
    void registerPush({
      plugin,
      state: push,
      onToken: (token) => window.dispatchEvent(new CustomEvent(PUSH_TOKEN_EVENT, { detail: { platform, token } })),
      onError: (message) => console.warn('[bizzi] push registration failed:', message),
    }).catch((err: unknown) => console.warn('[bizzi] push registration failed:', err));
  }
}

install();
