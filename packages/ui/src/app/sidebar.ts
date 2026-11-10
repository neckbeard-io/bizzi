// Sidebar width preference for this device (spec §11.1): auto (fit content) or a dragged width.
// Module-level so the shell and Appearance settings share it; persisted to localStorage on commit only.
import { useSyncExternalStore } from 'react';
import { readSidebarPref } from '../lib/sidebarWidth.ts';
import type { SidebarPref } from '../lib/sidebarWidth.ts';
import { loadJson, saveJson } from '../lib/storage.ts';

const KEY = 'bizzi.sidebar.width';

let pref: SidebarPref = readSidebarPref(loadJson(KEY));
const listeners = new Set<() => void>();

function commit(next: SidebarPref): void {
  if (next.mode === pref.mode && next.width === pref.width) return;
  pref = next;
  saveJson(KEY, pref);
  for (const l of listeners) l();
}

export const sidebarStore = {
  get: (): SidebarPref => pref,
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  /** A dragged or keyed width: switches to manual. */
  setWidth(width: number): void {
    commit({ mode: 'manual', width: Math.round(width) });
  },
  /** Back to fitting the content (double-click on the handle, or the toggle). */
  setAuto(auto: boolean, width: number = pref.width): void {
    commit({ mode: auto ? 'auto' : 'manual', width: Math.round(width) });
  },
};

export function useSidebarPref(): SidebarPref {
  return useSyncExternalStore(sidebarStore.subscribe, sidebarStore.get, sidebarStore.get);
}
