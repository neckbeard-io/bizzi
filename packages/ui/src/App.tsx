import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { BizziProvider } from './app/context.tsx';
import { forgetTarget, loadStartupEnv, resolveInitialTarget } from './lib/connection.ts';
import type { ConnectionTarget } from './lib/connection.ts';
import { pairCodeFromLocation } from './lib/router.ts';
import { ConnectScreen } from './views/ConnectScreen.tsx';
import { StartingScreen } from './views/StartingScreen.tsx';
import { Shell } from './views/Shell.tsx';

export function App(): ReactNode {
  // Opened from a hub's pairing link: show the pairing form first.
  const [pairCode] = useState(() => pairCodeFromLocation(window.location));
  const [target, setTarget] = useState<ConnectionTarget | null>(() => (pairCode ? null : resolveInitialTarget(loadStartupEnv())));
  const [lastError, setLastError] = useState<string | null>(null);
  // Desktop app whose core is still coming up (or being replaced after an update): wait for it. The
  // app reloads the page with the connection once the core is ready.
  const [waitForCore, setWaitForCore] = useState(() => !pairCode && window.bizzi?.coreStarting === true);

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

  if (!target && waitForCore) return <StartingScreen onConfigure={() => setWaitForCore(false)} />;
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
