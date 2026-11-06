// The `window.bizziNative` object, built from injected plugin facades so the logic is testable
// under Node without Capacitor. `install.ts` wires the real plugins.

import { parsePairLink } from './deeplink.ts';
import type { PairLink } from './deeplink.ts';

export type NativePlatform = 'ios' | 'android';

/** The contract the UI feature-detects (`if (window.bizziNative) …`). */
export interface BizziNative {
  platform: NativePlatform;
  secureGet(key: string): Promise<string | null>;
  secureSet(key: string, value: string): Promise<void>;
  secureDelete(key: string): Promise<void>;
  /** Scanned text (e.g. a pairing URL), or null if the user cancelled. */
  scanQr(): Promise<string | null>;
}

/** Extras on top of the contract. Optional for the UI: feature-detect each one. */
export interface BizziNativeExtras {
  /** Bridge version, for diagnostics. */
  version: string;
  /**
   * Return and clear a pairing link that arrived before the UI was listening for `bizzi:pair`
   * (typically: the app was cold-started by tapping a `bizzi://pair` link).
   */
  takePairLink(): PairLink | null;
  /** Parse `bizzi://pair?hub=…&code=…` (e.g. text from scanQr()); null if it isn't one. */
  parsePairLink(text: string): PairLink | null;
  /** Push registration state (scaffold; see README "Push"). */
  push: { enabled: boolean; token: string | null };
}

export type BizziNativeBridge = BizziNative & BizziNativeExtras;

/** String key/value store backed by the Keychain (iOS) / Keystore (Android). */
export interface SecureStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** Minimal shape of `@capacitor/barcode-scanner`'s native plugin. */
export interface QrScanner {
  scanBarcode(options: Record<string, unknown>): Promise<{ ScanResult?: string | null }>;
}

// Values from @capacitor/barcode-scanner's definitions (Html5QrcodeSupportedFormats.QR_CODE, BACK,
// ADAPTIVE). Inlined so the bundle doesn't pull the plugin's web fallback (html5-qrcode).
export const SCAN_HINT_QR_CODE = 0;
export const SCAN_CAMERA_BACK = 1;
export const SCAN_ORIENTATION_ADAPTIVE = 3;
/** Error code the scanner rejects with when the user closes the scanner. */
export const SCAN_CANCELLED_CODE = 'OS-PLUG-BARC-0006';
export const SCAN_CAMERA_DENIED_CODE = 'OS-PLUG-BARC-0007';

export const MAX_KEY_LENGTH = 256;

export function assertKey(key: unknown): asserts key is string {
  if (typeof key !== 'string' || key.length === 0) throw new TypeError('bizziNative: key must be a non-empty string');
  if (key.length > MAX_KEY_LENGTH) throw new TypeError(`bizziNative: key longer than ${MAX_KEY_LENGTH} characters`);
}

function errorCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

export function isScanCancelled(err: unknown): boolean {
  if (errorCode(err) === SCAN_CANCELLED_CODE) return true;
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return /cancel/i.test(msg);
}

export interface BridgeDeps {
  platform: NativePlatform;
  version: string;
  store: SecureStore;
  scanner: QrScanner;
  takePairLink(): PairLink | null;
  push: { enabled: boolean; token: string | null };
  /** Text shown in the scanner UI. */
  scanInstructions?: string;
}

export function createBizziNative(deps: BridgeDeps): BizziNativeBridge {
  const { store, scanner } = deps;
  const bridge: BizziNativeBridge = {
    platform: deps.platform,
    version: deps.version,
    async secureGet(key) {
      assertKey(key);
      const v = await store.getItem(key);
      return typeof v === 'string' ? v : null;
    },
    async secureSet(key, value) {
      assertKey(key);
      if (typeof value !== 'string') throw new TypeError('bizziNative: value must be a string');
      await store.setItem(key, value);
    },
    async secureDelete(key) {
      assertKey(key);
      await store.removeItem(key);
    },
    async scanQr() {
      let result: { ScanResult?: string | null };
      try {
        result = await scanner.scanBarcode({
          hint: SCAN_HINT_QR_CODE,
          scanInstructions: deps.scanInstructions ?? 'Scan the pairing QR code shown on your desktop',
          scanButton: false,
          scanText: ' ',
          cameraDirection: SCAN_CAMERA_BACK,
          scanOrientation: SCAN_ORIENTATION_ADAPTIVE,
          cancelButtonAccessibilityLabel: 'Cancel',
          android: { scanningLibrary: 'mlkit' },
        });
      } catch (err) {
        if (errorCode(err) === SCAN_CAMERA_DENIED_CODE) {
          throw new Error('Camera access was denied. Allow camera access for bizzi in Settings, or enter the code by hand.', { cause: err });
        }
        if (isScanCancelled(err)) return null;
        throw err;
      }
      const text = typeof result?.ScanResult === 'string' ? result.ScanResult.trim() : '';
      return text || null;
    },
    takePairLink: () => deps.takePairLink(),
    parsePairLink: (text) => parsePairLink(text),
    push: deps.push,
  };
  return bridge;
}
