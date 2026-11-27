// Sidebar preferences for this device (spec §11.1): the width, auto (fit content) or a dragged width, and
// whether sessions are listed by workspace or by state. Module-level so the shell, the hotkeys and Appearance
// settings share them; persisted to localStorage on commit only.
import { useSyncExternalStore } from 'react';
import { readGroupBy } from '../lib/sidebarTree.ts';
import type { SidebarGroupBy } from '../lib/sidebarTree.ts';
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

const GROUP_KEY = 'bizzi.sidebar.groupBy';

let groupBy: SidebarGroupBy = readGroupBy(loadJson(GROUP_KEY));
const groupListeners = new Set<() => void>();

export const sidebarGroupStore = {
  get: (): SidebarGroupBy => groupBy,
  subscribe(l: () => void): () => void {
    groupListeners.add(l);
    return () => groupListeners.delete(l);
  },
  set(next: SidebarGroupBy): void {
    if (next === groupBy) return;
    groupBy = next;
    saveJson(GROUP_KEY, groupBy);
    for (const l of groupListeners) l();
  },
  /** ⌘G and the View menu: by workspace ↔ by state. */
  toggle(): void {
    sidebarGroupStore.set(groupBy === 'state' ? 'workspace' : 'state');
  },
};

export function useSidebarGroupBy(): SidebarGroupBy {
  return useSyncExternalStore(sidebarGroupStore.subscribe, sidebarGroupStore.get, sidebarGroupStore.get);
}
