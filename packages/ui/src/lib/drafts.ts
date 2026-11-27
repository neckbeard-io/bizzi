// Unsent composer text, kept in localStorage so it survives a reload, an app restart or an update.
// Written on every change (no debounce): an app quit doesn't wait for timers or unload events.
import { useCallback, useState } from 'react';
import { loadJson, remove, saveJson } from './storage.ts';

const PREFIX = 'bizzi.draft.';
/** Drafts untouched for this long are dropped (sessions get closed; their drafts shouldn't pile up). */
export const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface StoredDraft {
  text: string;
  /** Last change, ms since epoch. */
  ts: number;
}

/** Storage key for a draft: a session id, or a fixed name such as `ask` for the one-pane prompt. */
export function draftKey(id: string): string {
  return PREFIX + id;
}

export function loadDraft(id: string, now: number = Date.now()): string {
  const d = loadJson<StoredDraft>(draftKey(id));
  if (!d || typeof d.text !== 'string') return '';
  if (typeof d.ts !== 'number' || now - d.ts > DRAFT_TTL_MS) {
    remove(draftKey(id));
    return '';
  }
  return d.text;
}

/** Save a draft; an empty or whitespace-only draft is removed. */
export function saveDraft(id: string, text: string, now: number = Date.now()): void {
  if (text.trim() === '') remove(draftKey(id));
  else saveJson(draftKey(id), { text, ts: now } satisfies StoredDraft);
}

/** Drop drafts older than the TTL. Cheap: only `bizzi.draft.*` keys are read. */
export function pruneDrafts(storage: Storage | null = safeStorage(), now: number = Date.now()): void {
  if (!storage) return;
  const keys: string[] = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k?.startsWith(PREFIX)) keys.push(k);
    }
  } catch {
    return;
  }
  for (const k of keys) loadDraft(k.slice(PREFIX.length), now);
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

let pruned = false;

/**
 * Composer text that persists per `id`. When `id` changes (another session), that session's draft
 * is loaded. `initial` wins over a stored draft when it returns text (e.g. a prefill link).
 */
export function useDraft(id: string, initial?: () => string): [string, (text: string) => void] {
  const [state, setState] = useState(() => {
    if (!pruned) {
      pruned = true;
      pruneDrafts();
    }
    const pre = initial?.() ?? '';
    return { id, text: pre !== '' ? pre : loadDraft(id) };
  });
  let text = state.text;
  if (state.id !== id) {
    // Adjust state while rendering when the key changes (React's documented pattern), not in an effect,
    // so the previous session's text never shows for a frame.
    text = loadDraft(id);
    setState({ id, text });
  }
  const set = useCallback(
    (next: string) => {
      setState({ id, text: next });
      saveDraft(id, next);
    },
    [id],
  );
  return [text, set];
}
