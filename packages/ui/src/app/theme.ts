// Theme state for this device (theming.md §2, §5): which theme, which mode, which density. The choice is
// per device (localStorage); custom themes come from the hub. A module-level store so every
// component (sidebar toggle, settings, terminals) sees the same theme, applied once per change.
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { BizziStore } from '@bizzi/client';
import type { ThemeFile } from '@bizzi/protocol';
import { applyTheme, paintEntry, PAINT_CACHE_KEY } from '../lib/theme/apply.ts';
import type { PaintCache } from '../lib/theme/apply.ts';
import { BUILTIN_CATALOGUE, DEFAULT_THEME_ID, DEVICE_THEME_ID, bizziDefault, builtinTheme, deviceTheme, normalizeAccent } from '../lib/theme/builtins/index.ts';
import { isUnsupported, readThemeFiles, toThemeFile, upsertFile } from '../lib/theme/custom.ts';
import type { CustomTheme } from '../lib/theme/custom.ts';
import { effectiveDensity, resolveTheme } from '../lib/theme/resolve.ts';
import type { Density, ModePref, ResolvedTheme, Theme, ThemeMode } from '../lib/theme/types.ts';
import { loadJson, loadString, saveJson, saveString } from '../lib/storage.ts';

const MODE_KEY = 'bizzi.theme'; // existing key (system|light|dark), also read by theme-init.js
const ID_KEY = 'bizzi.theme.id';
const DENSITY_KEY = 'bizzi.theme.density';
/** The selected custom theme's JSON, so it applies at startup before the hub answers. */
const SELECTED_KEY = 'bizzi.theme.selected';
/** Custom themes when the server has no `themes.*` methods. */
const LOCAL_KEY = 'bizzi.themes.local';

export type DensityPref = Density | 'theme';
export type CustomSource = 'hub' | 'local';

export type ThemeState = {
  mode: ModePref;
  themeId: string;
  density: DensityPref;
  /** A theme shown but not chosen (failed import, unsaved create). */
  preview: Theme | null;
  custom: CustomTheme[];
  customSource: CustomSource | null;
  customError: string | null;
  systemDark: boolean;
  phone: boolean;
  /** Platform accent (desktop: Electron `systemPreferences.getAccentColor()`), or null. */
  accent: string | null;
};

type Listener = () => void;
const listeners = new Set<Listener>();
const hasWindow = typeof window !== 'undefined' && typeof window.matchMedia === 'function';
const mq = (q: string) => (hasWindow ? window.matchMedia(q) : null);
const darkQuery = mq('(prefers-color-scheme: dark)');
const phoneQuery = mq('(max-width: 767px), (pointer: coarse)');

function initialAccent(): string | null {
  if (typeof window === 'undefined') return null;
  return normalizeAccent(window.bizzi?.accentColor);
}

/** `?theme=<id>&mode=light|dark` override the stored choice for this load (demos, screenshots); not saved. */
const urlParams = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
const urlOverride = !!(urlParams?.get('theme') || urlParams?.get('mode'));

let state: ThemeState = {
  mode: ((): ModePref => {
    const m = urlParams?.get('mode') ?? loadString(MODE_KEY);
    return m === 'light' || m === 'dark' ? m : 'system';
  })(),
  themeId: urlParams?.get('theme') ?? loadString(ID_KEY) ?? DEFAULT_THEME_ID,
  density: ((): DensityPref => {
    const d = loadString(DENSITY_KEY);
    return d === 'compact' || d === 'comfortable' || d === 'spacious' ? d : 'theme';
  })(),
  preview: null,
  custom: readThemeFiles(loadJson<ThemeFile[]>(LOCAL_KEY) ?? []),
  customSource: null,
  customError: null,
  systemDark: darkQuery?.matches ?? false,
  phone: phoneQuery?.matches ?? false,
  accent: initialAccent(),
};

/** Last applied snapshot, recomputed on change. */
let current = compute(state);

function selectedCustom(s: ThemeState): Theme | null {
  const fromList = s.custom.find((c) => c.file.id === s.themeId);
  if (fromList) return fromList.ok ? fromList.theme : null;
  const saved = loadJson<ThemeFile>(SELECTED_KEY);
  if (!saved || saved.id !== s.themeId) return null;
  const [c] = readThemeFiles([saved]);
  return c?.ok ? c.theme : null;
}

/** The theme a state selects (falls back to bizzi Default when it's missing or invalid). */
export function themeFor(s: ThemeState): Theme {
  if (s.preview) return s.preview;
  if (s.themeId === DEVICE_THEME_ID) return deviceTheme(s.accent);
  return builtinTheme(s.themeId) ?? selectedCustom(s) ?? bizziDefault;
}

export type ThemeSnapshot = ThemeState & { theme: Theme; resolved: ResolvedTheme; requested: ThemeMode; effectiveDensity: Density };

function compute(s: ThemeState): ThemeSnapshot {
  const theme = themeFor(s);
  const requested: ThemeMode = s.mode === 'system' ? (s.systemDark ? 'dark' : 'light') : s.mode;
  const resolved = resolveTheme(theme, requested);
  const density = effectiveDensity(s.density, resolved.layout.density, s.phone);
  return { ...s, theme, resolved, requested, effectiveDensity: density };
}

function paint(snap: ThemeSnapshot): void {
  if (typeof document === 'undefined') return;
  applyTheme(snap.resolved, snap.effectiveDensity);
  if (snap.preview || urlOverride) return;
  const cache: PaintCache = {
    light: paintEntry(resolveTheme(snap.theme, 'light')),
    dark: paintEntry(resolveTheme(snap.theme, 'dark')),
    density: snap.effectiveDensity,
  };
  saveJson(PAINT_CACHE_KEY, cache);
}

function set(patch: Partial<ThemeState>): void {
  state = { ...state, ...patch };
  current = compute(state);
  paint(current);
  for (const l of listeners) l();
}

/** Apply the stored choice now (call once at startup; theme-init.js has already painted the cache). */
export function initTheme(): void {
  paint(current);
  darkQuery?.addEventListener('change', (e) => set({ systemDark: e.matches }));
  phoneQuery?.addEventListener('change', (e) => set({ phone: e.matches }));
}

export const themeStore = {
  get: (): ThemeSnapshot => current,
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  setMode(mode: ModePref): void {
    saveString(MODE_KEY, mode);
    set({ mode });
  },
  setTheme(themeId: string): void {
    saveString(ID_KEY, themeId);
    const custom = state.custom.find((c) => c.file.id === themeId);
    if (custom?.ok) saveJson(SELECTED_KEY, custom.file);
    set({ themeId, preview: null });
  },
  setDensity(density: DensityPref): void {
    saveString(DENSITY_KEY, density);
    set({ density });
  },
  /** Show a theme without choosing it (null ends the preview). */
  preview(theme: Theme | null): void {
    set({ preview: theme });
  },
};

// ---------------------------------------------------------------- custom themes (hub, else local)

function saveLocal(files: ThemeFile[]): void {
  saveJson(LOCAL_KEY, files);
}

function localFiles(): ThemeFile[] {
  return loadJson<ThemeFile[]>(LOCAL_KEY) ?? [];
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function loadCustomThemes(store: BizziStore): Promise<void> {
  try {
    const { themes } = await store.client.request('themes.list', {});
    set({ custom: readThemeFiles(themes), customSource: 'hub', customError: null });
  } catch (e) {
    if (isUnsupported(e)) set({ custom: readThemeFiles(localFiles()), customSource: 'local', customError: null });
    else set({ customError: errorText(e) });
  }
  // Keep the selected custom theme's cached copy fresh.
  const sel = state.custom.find((c) => c.file.id === state.themeId);
  if (sel?.ok) saveJson(SELECTED_KEY, sel.file);
}

/** Save (create or replace) a custom theme; returns its file id. */
export async function saveCustomTheme(store: BizziStore, theme: Theme): Promise<string> {
  if (state.customSource !== 'local') {
    try {
      const { theme: file } = await store.client.request('theme.save', { id: theme.id, name: theme.name, data: theme });
      const files = upsertFile(
        state.custom.map((c) => c.file),
        file,
      );
      set({ custom: readThemeFiles(files), customSource: 'hub', customError: null });
      return file.id;
    } catch (e) {
      if (!isUnsupported(e)) throw e;
    }
  }
  const files = upsertFile(localFiles(), toThemeFile(theme));
  saveLocal(files);
  set({ custom: readThemeFiles(files), customSource: 'local' });
  return theme.id;
}

export async function deleteCustomTheme(store: BizziStore, id: string): Promise<void> {
  if (state.customSource !== 'local') {
    try {
      await store.client.request('theme.delete', { id });
      set({ custom: state.custom.filter((c) => c.file.id !== id) });
      if (state.themeId === id) themeStore.setTheme(DEFAULT_THEME_ID);
      return;
    } catch (e) {
      if (!isUnsupported(e)) throw e;
    }
  }
  const files = localFiles().filter((f) => f.id !== id);
  saveLocal(files);
  set({ custom: readThemeFiles(files), customSource: 'local' });
  if (state.themeId === id) themeStore.setTheme(DEFAULT_THEME_ID);
}

/** Every id in use, for picking a fresh one. */
export function themeIdTaken(id: string): boolean {
  return BUILTIN_CATALOGUE.some((e) => e.theme.id === id) || state.custom.some((c) => c.file.id === id);
}

// ---------------------------------------------------------------- hooks

export function useThemeState(): ThemeSnapshot {
  return useSyncExternalStore(themeStore.subscribe, themeStore.get, themeStore.get);
}

export function useResolvedTheme(): ResolvedTheme {
  return useThemeState().resolved;
}

/** Load custom themes once the store is connected (and again after reconnects). */
export function useCustomThemes(store: BizziStore, connected: boolean): void {
  useEffect(() => {
    if (connected) void loadCustomThemes(store);
  }, [store, connected]);
}

/** Mode only (system / light / dark), the original `useTheme` shape: [pref, set, isDark]. */
export function useThemeMode(): [ModePref, (p: ModePref) => void, boolean] {
  const s = useThemeState();
  const setMode = useCallback((p: ModePref) => themeStore.setMode(p), []);
  return [s.mode, setMode, s.resolved.dark];
}
