import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { parseHash, routeHref } from '../lib/router.ts';
import type { Route } from '../lib/router.ts';
import { loadString, saveString } from '../lib/storage.ts';

function subscribeHash(cb: () => void): () => void {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash, () => '');
  return parseHash(hash);
}

export function navigate(r: Route, opts: { replace?: boolean } = {}): void {
  const href = routeHref(r);
  if (opts.replace) {
    const url = new URL(window.location.href);
    url.hash = href;
    window.history.replaceState(null, '', url);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    window.location.hash = href;
  }
}

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (cb: () => void) => {
      const mq = window.matchMedia(query);
      mq.addEventListener('change', cb);
      return () => mq.removeEventListener('change', cb);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
}

/** Desktop layout (multi-pane) vs. phone layout (single column + bottom nav). */
export function useIsWide(): boolean {
  return useMediaQuery('(min-width: 768px)');
}

export type ThemePref = 'system' | 'light' | 'dark';

function applyTheme(pref: ThemePref): void {
  const dark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

export function useTheme(): [ThemePref, (p: ThemePref) => void, boolean] {
  const [pref, setPref] = useState<ThemePref>(() => (loadString('bizzi.theme') as ThemePref | null) ?? 'system');
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)');
  useEffect(() => applyTheme(pref), [pref, systemDark]);
  const set = useCallback((p: ThemePref) => {
    saveString('bizzi.theme', p);
    setPref(p);
  }, []);
  const isDark = pref === 'dark' || (pref === 'system' && systemDark);
  return [pref, set, isDark];
}

/** Current theme as seen in the DOM (for canvas renderers like xterm). */
export function useDomTheme(): 'light' | 'dark' {
  const subscribe = useCallback((cb: () => void) => {
    const mo = new MutationObserver(cb);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);
  return useSyncExternalStore(subscribe, () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'), () => 'light');
}

/** The current time, re-rendering every `intervalMs` while mounted (countdowns, "last seen" labels). */
export function useNow(intervalMs = 1000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs, enabled]);
  return now;
}

/** Run an async action with busy/error state. */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>): { run: (...args: A) => Promise<R | undefined>; busy: boolean; error: unknown; reset: () => void } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = useCallback(
    async (...args: A) => {
      setBusy(true);
      setError(null);
      try {
        return await fn(...args);
      } catch (e) {
        setError(e);
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [fn],
  );
  return { run, busy, error, reset: () => setError(null) };
}
