// Right-click menus (machines, workspaces, sessions) and the dialogs they open. One menu, one dialog
// and one toast at a time, rendered by hosts the shell mounts once (components/ContextMenu.tsx).
import { useSyncExternalStore } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { IconName } from '../components/icons.tsx';

export type MenuItem =
  | {
      label: string;
      icon?: IconName;
      /** Runs after the menu closes; a rejection is shown as a toast. */
      onSelect: () => void | Promise<unknown>;
      disabled?: boolean;
      /** Why it's disabled, or extra detail (tooltip). */
      hint?: string;
      danger?: boolean;
    }
  | 'separator';

export interface OpenMenu {
  x: number;
  y: number;
  title?: string;
  items: MenuItem[];
}

/** Dialogs a menu item can open from anywhere (rendered by `GlobalDialogs`). */
export type DialogRequest =
  | { kind: 'renameSession'; sessionId: string }
  | { kind: 'editWorkspace'; workspaceId: string }
  | { kind: 'newWorktree'; workspaceId: string };

export interface Toast {
  id: number;
  message: string;
  tone: 'err' | 'ok';
}

function signal<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) {
      value = next;
      for (const l of listeners) l();
    },
    use(): T {
      return useSyncExternalStore(
        (l) => {
          listeners.add(l);
          return () => listeners.delete(l);
        },
        () => value,
        () => initial,
      );
    },
  };
}

const menu = signal<OpenMenu | null>(null);
const dialog = signal<DialogRequest | null>(null);
const toast = signal<Toast | null>(null);
let toastSeq = 0;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

export const useOpenMenu = menu.use;
export const useDialogRequest = dialog.use;
export const useToast = toast.use;

export function openMenu(m: OpenMenu): void {
  menu.set(m);
}

export function closeMenu(): void {
  if (menu.get()) menu.set(null);
}

/** `onContextMenu` handler: opens `items()` at the pointer (built lazily, so rows stay cheap). */
export function contextMenuHandler(items: () => MenuItem[], title?: string): (e: ReactMouseEvent) => void {
  return (e) => {
    e.preventDefault();
    e.stopPropagation();
    openMenu({ x: e.clientX, y: e.clientY, items: items(), ...(title ? { title } : {}) });
  };
}

/** Open the same menu under a button (the "⋯" in page headers). */
export function menuButtonHandler(items: () => MenuItem[], title?: string): (e: ReactMouseEvent<HTMLElement>) => void {
  return (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    openMenu({ x: r.right, y: r.bottom + 4, items: items(), ...(title ? { title } : {}) });
  };
}

export function openDialog(d: DialogRequest): void {
  dialog.set(d);
}

export function closeDialog(): void {
  dialog.set(null);
}

export function showToast(message: string, tone: Toast['tone'] = 'ok'): void {
  clearTimeout(toastTimer);
  toast.set({ id: ++toastSeq, message, tone });
  toastTimer = setTimeout(() => toast.set(null), tone === 'err' ? 6000 : 2500);
}

export function dismissToast(): void {
  clearTimeout(toastTimer);
  toast.set(null);
}

/** Copy text; says so in a toast. */
export async function copyText(text: string, what: string): Promise<void> {
  await navigator.clipboard.writeText(text);
  showToast(`Copied ${what}`);
}
