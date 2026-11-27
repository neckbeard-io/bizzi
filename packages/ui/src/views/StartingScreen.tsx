import type { ReactNode } from 'react';
import { Logo } from '../components/Logo.tsx';
import { TitleBarStrip } from '../components/layout.tsx';
import { Spinner } from '../components/ui.tsx';

/** Desktop app, core not up yet: shown instead of the connect screen until the app reloads onto it. */
export function StartingScreen(props: { onConfigure: () => void }): ReactNode {
  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <TitleBarStrip className="fixed inset-x-0 top-0 z-10" />
      <div className="flex flex-col items-center gap-3 text-center">
        <Logo size={40} />
        <div className="flex items-center gap-2 text-sm text-muted" role="status">
          <Spinner size={14} />
          Starting bizzi…
        </div>
        <button type="button" className="text-xs text-muted underline-offset-2 hover:underline" onClick={props.onConfigure}>
          Connect to something else
        </button>
      </div>
    </div>
  );
}
