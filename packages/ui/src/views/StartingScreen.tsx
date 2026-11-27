import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Logo } from '../components/Logo.tsx';
import { TitleBarStrip } from '../components/layout.tsx';
import { Spinner } from '../components/ui.tsx';

/** A normal start takes a second or two: until then only the logo shows, so the screen reads as a splash. */
const STATUS_AFTER_MS = 1_000;
/** Still not up after this long: offer a way out (a core that fails outright already gets a native dialog). */
const ESCAPE_AFTER_MS = 10_000;

/** Desktop app, core not up yet: shown instead of the connect screen until the app reloads onto it. */
export function StartingScreen(props: { onConfigure: () => void }): ReactNode {
  const [elapsed, setElapsed] = useState<'splash' | 'status' | 'slow'>('splash');
  useEffect(() => {
    const status = setTimeout(() => setElapsed('status'), STATUS_AFTER_MS);
    const slow = setTimeout(() => setElapsed('slow'), ESCAPE_AFTER_MS);
    return () => {
      clearTimeout(status);
      clearTimeout(slow);
    };
  }, []);

  // Fixed slots (hidden rather than absent) so the logo doesn't jump as lines appear.
  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <TitleBarStrip className="fixed inset-x-0 top-0 z-10" />
      <div className="flex flex-col items-center gap-3 text-center">
        <Logo size={40} />
        <div
          className={`flex items-center gap-2 text-sm text-muted transition-opacity duration-300 ${elapsed === 'splash' ? 'opacity-0' : 'opacity-100'}`}
          role="status"
        >
          <Spinner size={14} />
          {elapsed === 'slow' ? 'Still starting bizzi…' : 'Starting bizzi…'}
        </div>
        <button
          type="button"
          className={`text-xs text-muted underline-offset-2 hover:underline ${elapsed === 'slow' ? '' : 'invisible'}`}
          onClick={props.onConfigure}
        >
          Taking too long? Connect to another bizzi instead
        </button>
      </div>
    </div>
  );
}
