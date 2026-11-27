// User-wide preferences (theme choice, density, fonts) synced through the server (theming.md §5). localStorage
// is only a cache for first paint and offline use; the server's value wins on connect.
import type { UserPrefs } from '@bizzi/protocol';

const KEYS = ['themeId', 'density', 'uiFont', 'codeFont'] as const satisfies readonly (keyof UserPrefs)[];

/** Keys present in `patch` replace those in `base`; undefined values are ignored. */
export function mergePrefs(base: UserPrefs, patch: Partial<UserPrefs>): UserPrefs {
  const out: UserPrefs = { ...base };
  for (const k of KEYS) {
    const v = patch[k];
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** Only the keys whose values differ (undefined in `b` counts as unchanged). */
export function prefsDiff(a: UserPrefs, b: Partial<UserPrefs>): Partial<UserPrefs> {
  const out: Partial<UserPrefs> = {};
  for (const k of KEYS) {
    const v = b[k];
    if (v !== undefined && v !== a[k]) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

export function isEmptyPrefs(p: Partial<UserPrefs>): boolean {
  return KEYS.every((k) => p[k] === undefined);
}

export type PrefsReconcile = {
  /** What this device should show now. */
  apply: UserPrefs;
  /** What to send with `prefs.set`, or null when the server is already right. */
  push: Partial<UserPrefs> | null;
};

/**
 * On connect. `local` is what this device chose or last saw (the cache), `server` what `prefs.get` returned,
 * `pending` changes made here that never reached a server (offline). Precedence: pending > server > local.
 * Keys only this device has (a server with no prefs yet, e.g. after an upgrade) seed the server.
 */
export function reconcilePrefs(local: UserPrefs, server: UserPrefs, pending: Partial<UserPrefs> = {}): PrefsReconcile {
  const apply = mergePrefs(mergePrefs(local, server), pending);
  const push: Partial<UserPrefs> = {};
  for (const k of KEYS) {
    const v = apply[k];
    if (v !== undefined && v !== server[k]) (push as Record<string, unknown>)[k] = v;
  }
  return { apply, push: isEmptyPrefs(push) ? null : push };
}
