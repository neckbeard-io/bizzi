import type { ReactNode } from 'react';
import { useIsWide } from '../app/hooks.ts';
import { IconButton, cx } from './ui.tsx';

/**
 * Desktop with the native title bar hidden: a themed, draggable strip the height of the title bar
 * (theming.md §8). The traffic lights (macOS) or window controls (Windows/Linux) sit over it.
 */
export function TitleBarStrip(props: { className?: string }): ReactNode {
  const bar = window.bizzi?.titleBar;
  if (!bar) return null;
  return <div aria-hidden className={cx('app-drag shrink-0', props.className)} style={{ height: bar.height }} data-titlebar />;
}

export function PageHeader(props: { title: ReactNode; subtitle?: ReactNode; back?: () => void; actions?: ReactNode; className?: string }): ReactNode {
  const wide = useIsWide();
  return (
    <header className={cx('flex min-h-14 shrink-0 items-center gap-2 border-b border-border bg-panel px-3 py-2 md:px-5', props.className)}>
      {props.back && !wide ? <IconButton icon="back" label="Back" onClick={props.back} className="-ml-1" /> : null}
      <div className="min-w-0 flex-1">
        <div className="truncate text-base font-semibold">{props.title}</div>
        {props.subtitle ? <div className="truncate text-xs text-muted">{props.subtitle}</div> : null}
      </div>
      {props.actions ? <div className="flex shrink-0 items-center gap-1.5">{props.actions}</div> : null}
    </header>
  );
}

export function Page(props: { header: ReactNode; children: ReactNode }): ReactNode {
  return (
    <div className="flex h-full flex-col">
      {props.header}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-4xl p-3 md:p-5">{props.children}</div>
      </div>
    </div>
  );
}

export function SectionTitle(props: { children: ReactNode; actions?: ReactNode }): ReactNode {
  return (
    <div className="mt-6 mb-2 flex items-center gap-2 first:mt-0">
      <h2 className="flex-1 text-xs font-semibold tracking-wide text-muted uppercase">{props.children}</h2>
      {props.actions}
    </div>
  );
}
