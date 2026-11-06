import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { BizziProvider } from './app/context.tsx';
import { forgetTarget, loadStartupEnv, resolveInitialTarget } from './lib/connection.ts';
import type { ConnectionTarget } from './lib/connection.ts';
import { pairCodeFromLocation } from './lib/router.ts';
import { ConnectScreen } from './views/ConnectScreen.tsx';
import { Shell } from './views/Shell.tsx';

export function App(): ReactNode {
  // Opened from a hub's pairing link: show the pairing form first.
  const [pairCode] = useState(() => pairCodeFromLocation(window.location));
  const [target, setTarget] = useState<ConnectionTarget | null>(() => (pairCode ? null : resolveInitialTarget(loadStartupEnv())));
  const [lastError, setLastError] = useState<string | null>(null);

  const disconnect = useCallback(() => {
    forgetTarget();
    const url = new URL(window.location.href);
    if (url.searchParams.has('mock') || url.searchParams.has('pair')) {
      url.searchParams.delete('mock');
      url.searchParams.delete('demo');
      url.searchParams.delete('pair');
      window.history.replaceState(null, '', url);
    }
    setTarget(null);
  }, []);

  const fail = useCallback(
    (message: string) => {
      setLastError(message);
      disconnect();
    },
    [disconnect],
  );

  if (!target) {
    return (
      <ConnectScreen
        error={lastError}
        pairCode={pairCode}
        onConnect={(t) => {
          setLastError(null);
          if (window.location.hash.startsWith('#/pair')) {
            const url = new URL(window.location.href);
            url.hash = '';
            window.history.replaceState(null, '', url);
          }
          setTarget(t);
        }}
      />
    );
  }
  return (
    <BizziProvider target={target} onDisconnect={disconnect} onError={fail}>
      <Shell onFatal={fail} />
    </BizziProvider>
  );
}
