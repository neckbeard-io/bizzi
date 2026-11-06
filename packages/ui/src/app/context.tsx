import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { BizziClient, BizziStore } from '@bizzi/client';
import type { BizziState, SocketFactory } from '@bizzi/client';
import type { ConnectionTarget } from '../lib/connection.ts';

export interface BizziContextValue {
  client: BizziClient;
  store: BizziStore;
  target: ConnectionTarget;
  /** Leave this connection (back to the connect screen). */
  disconnect: () => void;
}

const Ctx = createContext<BizziContextValue | null>(null);

export function BizziProvider(props: { target: ConnectionTarget; onDisconnect: () => void; children: ReactNode }): ReactNode {
  const { target, onDisconnect } = props;
  const [value, setValue] = useState<BizziContextValue | null>(null);

  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | null = null;
    void (async () => {
      let createSocket: SocketFactory | undefined;
      if (target.source === 'mock') {
        const { MockCore, createMockSocketFactory } = await import('../mock/mockServer.ts');
        createSocket = createMockSocketFactory(new MockCore());
      }
      if (disposed) return;
      const client = new BizziClient({ clientName: '@bizzi/ui', clientVersion: '0.0.1', ...(createSocket ? { createSocket } : {}) });
      const store = new BizziStore(client);
      client.connect(target.url, target.token).catch(() => {
        // Fatal errors (bad token, protocol mismatch) surface through the connection state.
      });
      const wake = (): void => client.reconnectNow();
      const onVisible = (): void => {
        if (document.visibilityState === 'visible') wake();
      };
      window.addEventListener('online', wake);
      document.addEventListener('visibilitychange', onVisible);
      cleanup = () => {
        window.removeEventListener('online', wake);
        document.removeEventListener('visibilitychange', onVisible);
        store.dispose();
        client.close();
      };
      setValue({ client, store, target, disconnect: onDisconnect });
    })();
    return () => {
      disposed = true;
      cleanup?.();
      setValue(null);
    };
  }, [target, onDisconnect]);

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
