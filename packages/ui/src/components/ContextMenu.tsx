// Hosts for app/contextMenu.ts: the right-click menu, the dialogs its items open, and the toast.
// Mounted once by the shell.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { closeDialog, closeMenu, dismissToast, showToast, useDialogRequest, useOpenMenu, useToast } from '../app/contextMenu.ts';
import type { MenuItem } from '../app/contextMenu.ts';
import { useBizzi, useStore } from '../app/context.tsx';
import { useAction } from '../app/hooks.ts';
import { WorkspaceIdentityDialog, WorktreeDialog } from '../views/workspaces/WorkspaceDialogs.tsx';
import { Icon } from './icons.tsx';
import { Button, ErrorText, Input, Modal, cx } from './ui.tsx';

export function ContextMenuHost(): ReactNode {
  const m = useOpenMenu();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [active, setActive] = useState(-1);

  // Keep the menu on screen: flip left/up when it would overflow.
  useLayoutEffect(() => {
    if (!m || !ref.current) return setPos(null);
    const r = ref.current.getBoundingClientRect();
    const left = m.x + r.width > window.innerWidth - 8 ? Math.max(8, m.x - r.width) : m.x;
    const top = m.y + r.height > window.innerHeight - 8 ? Math.max(8, window.innerHeight - 8 - r.height) : m.y;
    setPos({ left, top });
    setActive(-1);
    ref.current.focus();
  }, [m]);

  useEffect(() => {
    if (!m) return;
    const close = (e: Event): void => {
      if (e.type === 'mousedown' && ref.current?.contains(e.target as Node)) return;
      closeMenu();
    };
    window.addEventListener('mousedown', close, true);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('mousedown', close, true);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [m]);

  if (!m) return null;
  const enabled = m.items.map((it, i) => (it !== 'separator' && !it.disabled ? i : -1)).filter((i) => i >= 0);
  const run = (it: MenuItem): void => {
    if (it === 'separator' || it.disabled) return;
    closeMenu();
    Promise.resolve()
      .then(() => it.onSelect())
      .catch((e: unknown) => showToast(e instanceof Error ? e.message : String(e), 'err'));
  };
  const step = (dir: 1 | -1): void => {
    if (enabled.length === 0) return;
    const at = enabled.indexOf(active);
    setActive(enabled[(at + dir + enabled.length) % enabled.length] ?? -1);
  };

  return (
    <div
      ref={ref}
      role="menu"
      tabIndex={-1}
      aria-label={m.title}
      className="fixed z-50 min-w-52 rounded-lg border border-border bg-panel py-1 text-sm shadow-lg outline-none"
      style={{ left: pos?.left ?? m.x, top: pos?.top ?? m.y, visibility: pos ? 'visible' : 'hidden' }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') closeMenu();
        else if (e.key === 'ArrowDown') step(1);
        else if (e.key === 'ArrowUp') step(-1);
        else if (e.key === 'Enter' && active >= 0) run(m.items[active]!);
        else return;
        e.preventDefault();
      }}
    >
      {m.title ? <div className="truncate px-3 pt-1 pb-1.5 text-xs font-semibold text-muted">{m.title}</div> : null}
      {m.items.map((it, i) =>
        it === 'separator' ? (
          <div key={`sep-${i}`} className="my-1 border-t border-border" role="separator" />
        ) : (
          <button
            key={`${i}-${it.label}`}
            type="button"
            role="menuitem"
            disabled={it.disabled}
            title={it.hint}
            onMouseEnter={() => setActive(i)}
            onClick={() => run(it)}
            className={cx(
              'flex w-full items-center gap-2 px-3 py-1.5 text-left disabled:cursor-not-allowed disabled:opacity-40',
              active === i && !it.disabled && 'bg-panel-2',
              it.danger ? 'text-err' : 'text-fg',
            )}
          >
            <span className="flex w-4 shrink-0 justify-center text-muted">{it.icon ? <Icon name={it.icon} size={14} className={it.danger ? 'text-err' : undefined} /> : null}</span>
            <span className="min-w-0 flex-1 truncate">{it.label}</span>
          </button>
        ),
      )}
    </div>
  );
}

export function GlobalDialogs(): ReactNode {
  const d = useDialogRequest();
  const ws = useBizzi((s) => (d && d.kind !== 'renameSession' ? (s.workspaces?.[d.workspaceId] ?? null) : null));
  if (!d) return null;
  switch (d.kind) {
    case 'renameSession':
      return <RenameSessionDialog sessionId={d.sessionId} />;
    case 'editWorkspace':
      return ws ? <WorkspaceIdentityDialog workspace={ws} onClose={closeDialog} /> : null;
    case 'newWorktree':
      return ws ? <WorktreeDialog workspace={ws} onClose={closeDialog} /> : null;
  }
}

function RenameSessionDialog(props: { sessionId: string }): ReactNode {
  const store = useStore();
  const session = useBizzi((s) => s.sessions[props.sessionId] ?? null);
  const [title, setTitle] = useState(session?.title ?? '');
  const save = useAction(async () => {
    await store.setSession(props.sessionId, { title: title.trim() });
    closeDialog();
  });
  if (!session) return null;
  return (
    <Modal
      title="Rename session"
      onClose={closeDialog}
      footer={
        <>
          <Button variant="ghost" onClick={closeDialog}>
            Cancel
          </Button>
          <Button variant="primary" busy={save.busy} onClick={() => void save.run()}>
            Rename
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save.run();
        }}
        className="flex flex-col gap-2"
      >
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Untitled session" maxLength={200} autoFocus onFocus={(e) => e.target.select()} />
        <span className="text-xs text-muted">Leave empty to clear it. The agent won't rename it after this.</span>
        <ErrorText error={save.error} />
      </form>
    </Modal>
  );
}

export function ToastHost(): ReactNode {
  const t = useToast();
  if (!t) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-16 z-50 flex justify-center px-4" role="status" aria-live="polite">
      {t.action ? (
        <div
          className={cx(
            'pointer-events-auto flex max-w-lg items-center gap-3 rounded-md border py-1 pr-1 pl-3 text-sm shadow-lg',
            t.tone === 'err' ? 'border-err/40 bg-panel text-err' : 'border-border bg-panel text-fg',
          )}
        >
          <span className="min-w-0 truncate">{t.message}</span>
          <button
            type="button"
            className="shrink-0 rounded px-2 py-1 font-medium text-accent-text hover:bg-panel-2"
            onClick={() => {
              const run = t.action?.run;
              dismissToast();
              run?.();
            }}
          >
            {t.action.label}
          </button>
          <button type="button" onClick={dismissToast} className="shrink-0 rounded p-1 text-muted hover:bg-panel-2 hover:text-fg" aria-label="Dismiss">
            <Icon name="x" size={14} />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={dismissToast}
          className={cx(
            'pointer-events-auto max-w-lg rounded-md border px-3 py-2 text-sm shadow-lg',
            t.tone === 'err' ? 'border-err/40 bg-panel text-err' : 'border-border bg-panel text-fg',
          )}
        >
          {t.message}
        </button>
      )}
    </div>
  );
}
