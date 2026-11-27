import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { BizziClient, BizziStore, hubTokenProvider } from '@bizzi/client';
import type { BizziState, FetchLike, SocketFactory, StoreCache, StoreSnapshot, TokenProvider } from '@bizzi/client';
import { connectionKey, staleDesktopKeys, type ConnectionTarget } from '../lib/connection.ts';
import { restorableHash } from '../lib/router.ts';
import { keys, loadJson, loadString, remove, saveJson, saveString } from '../lib/storage.ts';

export interface BizziContextValue {
  client: BizziClient;
  store: BizziStore;
  target: ConnectionTarget;
  /** This device's id on the hub (hub connections), to mark it in the device list. */
  deviceId: string | null;
  /** Leave this connection (back to the connect screen). */
  disconnect: () => void;
}

const Ctx = createContext<BizziContextValue | null>(null);

function localStorageCache(key: string): StoreCache {
  return {
    load: () => loadJson<StoreSnapshot>(`bizzi.cache.${key}`),
    save: (snap) => saveJson(`bizzi.cache.${key}`, snap),
  };
}

export function BizziProvider(props: { target: ConnectionTarget; onDisconnect: () => void; onError: (message: string) => void; children: ReactNode }): ReactNode {
  const { target, onDisconnect, onError } = props;
  const [value, setValue] = useState<BizziContextValue | null>(null);

  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | null = null;
    void (async () => {
      let createSocket: SocketFactory | undefined;
      let hubFetch: FetchLike | undefined;
      let deviceId: string | null = target.hub?.deviceId ?? null;
      let cache: StoreCache | undefined = target.mock ? undefined : localStorageCache(connectionKey(target));
      if (target.mock) {
        const mock = await import('../mock/index.ts');
        const core = target.source === 'hub' ? mock.sharedMockHub() : new mock.MockCore({ role: target.mock.role, demo: target.mock.demo });
        createSocket = mock.createMockSocketFactory(core);
        hubFetch = mock.createMockHubFetch(core);
        if (target.source === 'mock' && target.mock.role === 'hub') deviceId = 'd_mac';
        if (target.mock.role === 'hub') {
          const snap = mock.mockSnapshot();
          cache = { load: () => snap, save: () => {} };
        }
      }
      let auth: string | TokenProvider | undefined = target.token;
      if (target.hub) {
        try {
          auth = await hubTokenProvider(target.hub, hubFetch ? { fetch: hubFetch } : {});
        } catch (e) {
          if (!disposed) onError(e instanceof Error ? e.message : String(e));
          return;
        }
      }
      if (disposed) return;
      const key = connectionKey(target);
      if (target.source === 'electron') for (const k of staleDesktopKeys(keys())) remove(k);
      const machineKey = `bizzi.machine.${key}`;
      const client = new BizziClient({ clientName: '@bizzi/ui', clientVersion: '0.0.1', ...(createSocket ? { createSocket } : {}) });
      const store = new BizziStore(client, {
        initialMachineId: loadString(machineKey),
        ...(cache ? { cache } : {}),
      });
      let lastMachine = store.getState().selectedMachineId;
      const unsubMachine = store.subscribe(() => {
        const id = store.getState().selectedMachineId;
        if (id && id !== lastMachine) {
          lastMachine = id;
          saveString(machineKey, id);
        }
      });
      // Opened without a route (the desktop app after a restart or an update, a bookmark of the bare
      // URL): go back to the page you were on with this connection, then keep that up to date.
      const routeKey = `bizzi.route.${key}`;
      const saved = target.mock ? null : loadString(routeKey);
      if (saved && !window.location.hash.replace(/^#\/?/, '') && restorableHash(saved)) {
        const url = new URL(window.location.href);
        url.hash = saved;
        window.history.replaceState(null, '', url);
      }
      const saveRoute = (): void => {
        const href = restorableHash(window.location.hash);
        if (href && !target.mock) saveString(routeKey, href);
      };
      saveRoute();
      window.addEventListener('hashchange', saveRoute);
      client.connect(target.url, auth).catch(() => {
        // Fatal errors (bad token, revoked device, protocol mismatch) surface through the connection state.
      });
      const wake = (): void => client.reconnectNow();
      const onVisible = (): void => {
        if (document.visibilityState === 'visible') wake();
      };
      window.addEventListener('online', wake);
      document.addEventListener('visibilitychange', onVisible);
      cleanup = () => {
        window.removeEventListener('online', wake);
        window.removeEventListener('hashchange', saveRoute);
        document.removeEventListener('visibilitychange', onVisible);
        unsubMachine();
        store.dispose();
        client.close();
      };
      setValue({ client, store, target, deviceId, disconnect: onDisconnect });
    })();
    return () => {
      disposed = true;
      cleanup?.();
      setValue(null);
    };
  }, [target, onDisconnect, onError]);

  if (!value) return null;
  return <Ctx.Provider value={value}>{props.children}</Ctx.Provider>;
}

export function useBizziContext(): BizziContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useBizziContext outside BizziProvider');
  return v;
}

export function useStore(): BizziStore {
  return useBizziContext().store;
}

/**
 * Subscribe to a slice of the store. Re-renders only when the selected value changes (by `isEqual`),
 * so a streaming delta re-renders the one row that shows it.
 */
export function useBizzi<T>(selector: (s: BizziState) => T, isEqual: (a: T, b: T) => boolean = Object.is): T {
  const store = useStore();
  const ref = useRef<{ version: number; value: T; selector: (s: BizziState) => T } | null>(null);
  const getSnapshot = (): T => {
    const s = store.getState();
    const prev = ref.current;
    if (prev && prev.version === s.version && prev.selector === selector) return prev.value;
    const next = selector(s);
    if (prev && isEqual(prev.value, next)) {
      prev.version = s.version;
      prev.selector = selector;
      return prev.value;
    }
    ref.current = { version: s.version, value: next, selector };
    return next;
  };
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}
