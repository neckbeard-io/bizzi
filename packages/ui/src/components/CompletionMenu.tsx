import type { ReactNode } from 'react';
import { cx } from './ui.tsx';

export interface MenuItem {
  key: string;
  label: string;
  /** Shown before the label (`@`, `#`, `/`). */
  prefix?: string;
  detail?: string;
  disabled?: boolean;
  /** Why it's disabled, shown on the right. */
  reason?: string;
}

/** The suggestion list above a composer textarea; the textarea keeps focus and the keyboard. */
export function CompletionMenu<T extends MenuItem>(props: { title: string; items: T[]; index: number; onPick: (c: T) => void; onHover: (i: number) => void }): ReactNode {
  return (
    <div role="listbox" aria-label={props.title} className="absolute right-0 bottom-full left-0 z-30 mb-1 max-w-md overflow-hidden rounded-lg border border-border bg-panel py-1 shadow-lg">
      <div className="px-3 pt-0.5 pb-1 text-[10px] font-semibold tracking-wide text-muted uppercase">{props.title}</div>
      {props.items.map((c, i) => (
        <button
          key={c.key}
          type="button"
          role="option"
          aria-selected={i === props.index}
          aria-disabled={c.disabled}
          // Keep focus in the textarea so the caret stays put.
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => props.onHover(i)}
          onClick={() => props.onPick(c)}
          className={cx('flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm', i === props.index && !c.disabled && 'bg-panel-2', c.disabled ? 'cursor-not-allowed text-muted/70' : 'text-fg')}
        >
          <span className="shrink-0 font-medium">
            {c.prefix}
            {c.label}
          </span>
          {c.detail ? <span className="min-w-0 truncate text-xs text-muted">{c.detail}</span> : null}
          {c.reason ? <span className="ml-auto shrink-0 text-xs text-muted">{c.reason}</span> : null}
        </button>
      ))}
    </div>
  );
}
