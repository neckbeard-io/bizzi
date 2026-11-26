/**
 * Native bridge exposed by the mobile shell (apps/mobile) as `window.bizziNative`. Always feature-detect:
 * browsers and the desktop app don't have it.
 */
export interface BizziNative {
  platform: 'ios' | 'android';
  secureGet(key: string): Promise<string | null>;
  secureSet(key: string, value: string): Promise<void>;
  secureDelete(key: string): Promise<void>;
  /** Returns the scanned text (e.g. a pairUrl) or null if canceled. */
  scanQr(): Promise<string | null>;
}

declare global {
  interface Window {
    bizziNative?: BizziNative;
  }
}

/** The native bridge when running inside the mobile shell, else null. */
export function getNative(): BizziNative | null {
  const g = globalThis as { bizziNative?: BizziNative };
  const n = g.bizziNative;
  return n && typeof n.secureGet === 'function' && typeof n.secureSet === 'function' ? n : null;
}
