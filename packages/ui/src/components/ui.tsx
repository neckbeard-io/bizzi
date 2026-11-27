import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import type { SessionStatus } from '@bizzi/protocol';
import type { SessionPrompt } from '@bizzi/client';
import { STATUS_LABEL, STATUS_TONE, errorInfo } from '../lib/format.ts';
import type { Tone } from '../lib/format.ts';
import { Icon } from './icons.tsx';
import type { IconName } from './icons.tsx';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'ok';

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg hover:opacity-90 border-transparent',
  secondary: 'bg-panel text-fg border-border hover:bg-panel-2',
  ghost: 'bg-transparent text-fg border-transparent hover:bg-panel-2',
  // Destructive confirmations use the invariant safety tokens: no theme can restyle them (theming.md §6).
  danger: 'bg-safety-danger text-safety-danger-foreground border-safety-danger-foreground/40 hover:opacity-90',
  ok: 'bg-ok text-white border-transparent hover:opacity-90 dark:text-black',
};

export function Button(
  props: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'sm' | 'md'; icon?: IconName; busy?: boolean },
): ReactNode {
  const { variant = 'secondary', size = 'md', icon, busy, className, children, disabled, ...rest } = props;
  return (
    <button
      type="button"
      disabled={disabled || busy}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-md border font-medium whitespace-nowrap transition-[opacity,background-color] disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-7 px-2 text-xs' : 'h-9 px-3 text-sm',
        VARIANT[variant],
        className,
      )}
      {...rest}
    >
      {busy ? <Spinner size={size === 'sm' ? 12 : 14} /> : icon ? <Icon name={icon} size={size === 'sm' ? 14 : 16} /> : null}
      {children}
    </button>
  );
}

export function IconButton(props: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string; size?: number }): ReactNode {
  const { icon, label, size = 18, className, ...rest } = props;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cx('inline-flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-40', className)}
      {...rest}
    >
      <Icon name={icon} size={size} />
    </button>
  );
}

const TONE: Record<Tone, string> = {
  neutral: 'bg-panel-2 text-muted border-border',
  accent: 'bg-accent-soft text-accent-text border-transparent',
  ok: 'text-ok border-current/30 bg-transparent',
  warn: 'text-warn border-current/30 bg-transparent',
  err: 'text-err border-current/30 bg-transparent',
  info: 'text-info border-current/30 bg-transparent',
};

export function Badge(props: { tone?: Tone; children: ReactNode; className?: string; title?: string }): ReactNode {
  return (
    <span
      title={props.title}
      className={cx('inline-flex items-center gap-1 rounded-full border px-2 py-px text-[11px] leading-4 font-medium whitespace-nowrap', TONE[props.tone ?? 'neutral'], props.className)}
    >
      {props.children}
    </span>
  );
}

/**
 * Approval prompts and permission-mode badges (e.g. bypass permissions): fixed high-contrast colors
 * that themes can't override, so a theme can never camouflage "this agent can run anything" (§6).
 */
export function SafetyBadge(props: { kind?: 'warn' | 'danger'; children: ReactNode; className?: string; title?: string }): ReactNode {
  const danger = props.kind === 'danger';
  return (
    <span
      title={props.title}
      className={cx(
        'inline-flex items-center gap-1 rounded-full border px-2 py-px text-[11px] leading-4 font-semibold whitespace-nowrap',
        danger ? 'border-safety-danger-foreground/60 bg-safety-danger text-safety-danger-foreground' : 'border-safety-warn-foreground/60 bg-safety-warn text-safety-warn-foreground',
        props.className,
      )}
    >
      {props.children}
    </span>
  );
}

/** `title` explains where the status came from (e.g. "via OSC 7501"). */
export function StatusBadge(props: { status: SessionStatus | null | undefined; prompt?: SessionPrompt | null; title?: string }): ReactNode {
  if (!props.status) return null;
  if (props.prompt === 'login' && (props.status === 'waiting_input' || props.status === 'running' || props.status === 'starting')) {
    return (
      <Badge tone="warn" {...(props.title ? { title: props.title } : {})}>
        <Icon name="key" size={11} />
        login
      </Badge>
    );
  }
  if (props.prompt === 'budget' && props.status === 'waiting_input') {
    return (
      <Badge tone="warn" {...(props.title ? { title: props.title } : {})}>
        budget reached
      </Badge>
    );
  }
  const tone = STATUS_TONE[props.status];
  return (
    <Badge tone={tone} {...(props.title ? { title: props.title } : {})}>
      {props.status === 'running' || props.status === 'starting' ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" /> : null}
      {STATUS_LABEL[props.status]}
    </Badge>
  );
}

export function Spinner(props: { size?: number; className?: string }): ReactNode {
  const s = props.size ?? 16;
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" className={cx('animate-spin', props.className)} aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" fill="none" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" />
    </svg>
  );
}

export function Card(props: { children: ReactNode; className?: string }): ReactNode {
  return <div className={cx('rounded-lg border border-border bg-panel', props.className)}>{props.children}</div>;
}

export function Field(props: { label: string; hint?: string; children: ReactNode; className?: string }): ReactNode {
  return (
    <label className={cx('flex flex-col gap-1', props.className)}>
      <span className="text-xs font-medium text-muted">{props.label}</span>
      {props.children}
      {props.hint ? <span className="text-xs text-muted">{props.hint}</span> : null}
    </label>
  );
}

const inputCls = 'h-9 rounded-md border border-border bg-panel px-2.5 text-sm placeholder:text-muted/70 focus:border-accent focus:outline-none';

/** Full width unless the caller sets a width (`w-auto`, `w-40`, …): utilities can't override each other reliably. */
function widthCls(className: string | undefined): string {
  return className && /(^|\s)w-/.test(className) ? '' : 'w-full';
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>): ReactNode {
  const { className, ...rest } = props;
  return <input className={cx(inputCls, widthCls(className), className)} {...rest} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>): ReactNode {
  const { className, ...rest } = props;
  return <select className={cx(inputCls, widthCls(className), 'pr-7', className)} {...rest} />;
}

/**
 * A select that looks like a text chip (label + chevron) for toolbars; the transparent native select on
 * top still opens the platform menu and handles the keyboard.
 */
export function ChipSelect(props: SelectHTMLAttributes<HTMLSelectElement> & { display: ReactNode }): ReactNode {
  const { display, className, disabled, ...rest } = props;
  return (
    <span
      className={cx(
        'relative inline-flex h-7 min-w-0 items-center gap-0.5 rounded-md px-1.5 text-xs text-muted hover:bg-panel-2 hover:text-fg has-[select:focus-visible]:bg-panel-2 has-[select:focus-visible]:text-fg',
        disabled && 'opacity-50',
        className,
      )}
    >
      <span className="truncate">{display}</span>
      <Icon name="chevronDown" size={12} className="shrink-0" />
      <select className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed" disabled={disabled} {...rest} />
    </span>
  );
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>): ReactNode {
  const { className, ...rest } = props;
  return <textarea className={cx('w-full rounded-md border border-border bg-panel px-2.5 py-2 text-sm placeholder:text-muted/70 focus:border-accent focus:outline-none', className)} {...rest} />;
}

export function Checkbox(props: { checked: boolean; onChange: (v: boolean) => void; label: string }): ReactNode {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-sm select-none">
      <input type="checkbox" className="h-4 w-4 accent-[var(--primary)]" checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
      {props.label}
    </label>
  );
}

export function Empty(props: { icon?: IconName; title: string; children?: ReactNode }): ReactNode {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center text-muted">
      {props.icon ? <Icon name={props.icon} size={28} className="opacity-60" /> : null}
      <div className="text-sm font-medium text-fg">{props.title}</div>
      {props.children ? <div className="max-w-sm text-sm">{props.children}</div> : null}
    </div>
  );
}

/** An error message; `machine_offline` errors render as a calmer "machine offline" notice. */
export function ErrorText(props: { error: unknown; className?: string }): ReactNode {
  if (!props.error) return null;
  const { message, offline } = errorInfo(props.error);
  if (offline) {
    return (
      <div className={cx('flex items-start gap-2 rounded-md border border-warn/30 bg-warn/5 px-3 py-2 text-sm text-warn', props.className)} role="status">
        <Icon name="wifiOff" size={16} className="mt-0.5 shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="font-medium">Machine offline.</span> {message}
        </span>
      </div>
    );
  }
  return <div className={cx('rounded-md border border-err/30 bg-err/5 px-3 py-2 text-sm text-err', props.className)}>{message}</div>;
}

/** Centered dialog with a backdrop; closes on Escape and backdrop click. */
export function Modal(props: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }): ReactNode {
  const { onClose } = props;
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    panel.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        className={cx('flex max-h-[92vh] w-full flex-col rounded-t-xl border border-border bg-panel shadow-xl outline-none sm:rounded-xl', props.wide ? 'sm:max-w-2xl' : 'sm:max-w-md')}
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1 truncate font-semibold">{props.title}</div>
          <IconButton icon="x" label="Close" onClick={onClose} className="-mr-2" />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{props.children}</div>
        {props.footer ? <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-4 py-3">{props.footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

/** Copies `text` to the clipboard and confirms briefly. */
export function CopyButton(props: { text: string; label?: string; size?: 'sm' | 'md'; variant?: ButtonVariant; className?: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <Button
      size={props.size ?? 'sm'}
      variant={props.variant ?? 'secondary'}
      icon={copied ? 'check' : 'copy'}
      className={props.className}
      onClick={() => {
        void navigator.clipboard?.writeText(props.text).then(
          () => setCopied(true),
          () => setCopied(false),
        );
      }}
    >
      {copied ? 'Copied' : (props.label ?? 'Copy')}
    </Button>
  );
}

/** Determinate (value 0..1) or indeterminate (value null) progress bar. */
export function ProgressBar(props: { value: number | null; tone?: 'accent' | 'ok' | 'err'; className?: string }): ReactNode {
  const color = props.tone === 'ok' ? 'bg-ok' : props.tone === 'err' ? 'bg-err' : 'bg-accent';
  return (
    <div className={cx('relative h-1.5 w-full overflow-hidden rounded-full bg-panel-2', props.className)} role="progressbar" aria-valuenow={props.value === null ? undefined : Math.round(props.value * 100)}>
      {props.value === null ? (
        <span className={cx('absolute inset-y-0 w-1/3 animate-[indeterminate_1.2s_ease-in-out_infinite] rounded-full', color)} />
      ) : (
        <span className={cx('absolute inset-y-0 left-0 rounded-full transition-[width] duration-300', color)} style={{ width: `${Math.round(Math.min(1, Math.max(0, props.value)) * 100)}%` }} />
      )}
    </div>
  );
}

/** A row of mutually exclusive buttons. */
export function Segmented<T extends string>(props: { value: T; onChange: (v: T) => void; items: { value: T; label: ReactNode }[]; className?: string; size?: 'sm' | 'md' }): ReactNode {
  return (
    <div className={cx('inline-flex gap-0.5 rounded-md border border-border bg-panel p-0.5', props.className)} role="radiogroup">
      {props.items.map((it) => (
        <button
          key={it.value}
          type="button"
          role="radio"
          aria-checked={props.value === it.value}
          onClick={() => props.onChange(it.value)}
          className={cx(
            'rounded px-2 whitespace-nowrap',
            props.size === 'sm' ? 'h-6 text-xs' : 'h-7 text-sm',
            props.value === it.value ? 'bg-panel-2 font-medium text-fg' : 'text-muted hover:text-fg',
          )}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>(props: { value: T; onChange: (v: T) => void; items: { value: T; label: string; icon?: IconName; badge?: ReactNode }[]; className?: string }): ReactNode {
  return (
    <div role="tablist" className={cx('flex gap-1 overflow-x-auto', props.className)}>
      {props.items.map((it) => (
        <button
          key={it.value}
          role="tab"
          type="button"
          aria-selected={props.value === it.value}
          onClick={() => props.onChange(it.value)}
          className={cx(
            'inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm whitespace-nowrap',
            props.value === it.value ? 'bg-panel-2 font-medium text-fg' : 'text-muted hover:text-fg',
          )}
        >
          {it.icon ? <Icon name={it.icon} size={15} /> : null}
          {it.label}
          {it.badge}
        </button>
      ))}
    </div>
  );
}

/** Collapsible section with a clickable header. */
export function Disclosure(props: { header: ReactNode; children: () => ReactNode; defaultOpen?: boolean; className?: string }): ReactNode {
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  return (
    <div className={props.className}>
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full min-w-0 items-center gap-1.5 text-left" aria-expanded={open}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} className="shrink-0 text-muted" />
        {props.header}
      </button>
      {open ? props.children() : null}
    </div>
  );
}

export function Kbd(props: { children: ReactNode }): ReactNode {
  return <kbd className="rounded border border-border bg-panel-2 px-1 font-mono text-[10px] text-muted">{props.children}</kbd>;
}
