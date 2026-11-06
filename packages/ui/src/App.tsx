import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { BizziProvider } from './app/context.tsx';
import { forgetTarget, resolveInitialTarget } from './lib/connection.ts';
import type { ConnectionTarget } from './lib/connection.ts';
import { ConnectScreen } from './views/ConnectScreen.tsx';
import { Shell } from './views/Shell.tsx';

export function App(): ReactNode {
  const [target, setTarget] = useState<ConnectionTarget | null>(() =>
    resolveInitialTarget({ search: window.location.search, bridge: window.bizzi }),
  );
  const [lastError, setLastError] = useState<string | null>(null);

  const disconnect = useCallback(() => {
    forgetTarget();
    if (target?.source === 'mock') {
      const url = new URL(window.location.href);
      url.searchParams.delete('mock');
      window.history.replaceState(null, '', url);
    }
    setTarget(null);
  }, [target]);

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
        onConnect={(t) => {
          setLastError(null);
          setTarget(t);
        }}
      />
    );
  }
  return (
    <BizziProvider target={target} onDisconnect={disconnect}>
      <Shell onFatal={fail} />
    </BizziProvider>
  );
}
