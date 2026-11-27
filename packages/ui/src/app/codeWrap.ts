// Whether code blocks in messages wrap long lines (the default) or scroll sideways. Per device, in
// localStorage; applied as a class on <html> so the markdown CSS can follow it.
import { useSyncExternalStore } from 'react';
import { loadString, saveString } from '../lib/storage.ts';

const KEY = 'bizzi.code.wrap';
const NOWRAP_CLASS = 'code-nowrap';

let wrap = loadString(KEY) !== 'off';
const listeners = new Set<() => void>();

function apply(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle(NOWRAP_CLASS, !wrap);
}

/** Apply the stored choice (call once at startup). */
export function initCodeWrap(): void {
  apply();
}

export const codeWrapStore = {
  get: (): boolean => wrap,
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  set(next: boolean): void {
    if (next === wrap) return;
    wrap = next;
    saveString(KEY, next ? 'on' : 'off');
    apply();
    for (const l of listeners) l();
  },
};

export function useCodeWrap(): boolean {
  return useSyncExternalStore(codeWrapStore.subscribe, codeWrapStore.get, codeWrapStore.get);
}
