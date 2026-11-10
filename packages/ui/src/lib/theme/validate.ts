// Theme validation (theming.md §6), after Chorus's validateTheme. Applied to built-ins in tests and to
// imports and custom themes at load. Unlike Chorus it collects every failure, and a theme whose shape
// is sound comes back for preview even when its contrast fails (an import stays preview-only until
// fixed).
import { contrast, isColor } from './color.ts';
import { checkStateColors, resolveTheme } from './resolve.ts';
import { BIZZI_COLOR_KEYS, CHORUS_COLOR_KEYS, STATE_KEYS } from './types.ts';
import type { Density, LayoutTokens, PanelStyle, StateKey, TerminalPalette, Theme, ThemeColors, ThemeMode, ThemeVariant } from './types.ts';

export type ValidationResult = {
  /** True when the theme can be applied. */
  ok: boolean;
  /** The normalised theme when its shape is usable (also when `ok` is false: preview only). */
  theme: Theme | null;
  failures: string[];
};

const COLOR_KEYS: readonly string[] = [...CHORUS_COLOR_KEYS, ...BIZZI_COLOR_KEYS];
const PANEL_STYLES: readonly PanelStyle[] = ['floating-island', 'flush-ide', 'minimal-split'];
const DENSITIES: readonly Density[] = ['compact', 'comfortable', 'spacious'];
export const THEME_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
/** Chorus layout keys bizzi doesn't use; accepted and dropped so `.chorus-theme` files load. */
const IGNORED_LAYOUT_KEYS = new Set(['defaultFocusSurface']);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

function parseLayout(raw: unknown, path: string, fail: (m: string) => void): LayoutTokens | undefined {
  if (raw === undefined) return undefined;
  if (!isObj(raw)) {
    fail(`${path} must be an object`);
    return undefined;
  }
  const out: LayoutTokens = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'panelStyle') {
      if (typeof v === 'string' && (PANEL_STYLES as readonly string[]).includes(v)) out.panelStyle = v as PanelStyle;
      else fail(`${path}.panelStyle must be one of: ${PANEL_STYLES.join(', ')}`);
    } else if (k === 'density') {
      if (typeof v === 'string' && (DENSITIES as readonly string[]).includes(v)) out.density = v as Density;
      else fail(`${path}.density must be one of: ${DENSITIES.join(', ')}`);
    } else if (k === 'fontHeading' || k === 'composerRadius' || k === 'outerGap' || k === 'spineRowHeight') {
      if (isStr(v)) out[k] = v;
      else fail(`${path}.${k} must be a non-empty string`);
    } else if (!IGNORED_LAYOUT_KEYS.has(k)) {
      fail(`${path}.${k} is not a layout token`);
    }
  }
  return out;
}

function parseColors(raw: unknown, path: string, fail: (m: string) => void): ThemeColors | undefined {
  if (raw === undefined) return undefined;
  if (!isObj(raw)) {
    fail(`${path} must be an object`);
    return undefined;
  }
  const out: ThemeColors = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'radius') {
      if (isStr(v) && /^\d*\.?\d+(px|rem|em)?$/.test(v.trim())) out.radius = v.trim();
      else fail(`${path}.radius must be a CSS length (e.g. 0.5rem)`);
    } else if (!COLOR_KEYS.includes(k)) {
      fail(`${path}.${k} is not a colour token`);
    } else if (!isColor(v)) {
      fail(`${path}.${k} must be a colour (#rrggbb, #rrggbbaa or rgb()/rgba()), got ${JSON.stringify(v)}`);
    } else {
      out[k as keyof ThemeColors] = v.trim();
    }
  }
  return out;
}

function parseTerminal(raw: unknown, path: string, fail: (m: string) => void): TerminalPalette | undefined {
  if (raw === undefined) return undefined;
  if (!isObj(raw)) {
    fail(`${path} must be an object`);
    return undefined;
  }
  const out: TerminalPalette = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'ansi') {
      if (!Array.isArray(v) || v.length !== 16) fail(`${path}.ansi must be an array of 16 colours`);
      else if (!v.every(isColor)) fail(`${path}.ansi must contain only colours`);
      else out.ansi = v.map((x: string) => x.trim()) as unknown as TerminalPalette['ansi'];
    } else if (k === 'background' || k === 'foreground' || k === 'cursor' || k === 'cursorAccent' || k === 'selection') {
      if (isColor(v)) out[k] = v.trim();
      else fail(`${path}.${k} must be a colour`);
    } else {
      fail(`${path}.${k} is not a terminal token`);
    }
  }
  return out;
}

function parseVariant(raw: unknown, path: string, fail: (m: string) => void): ThemeVariant | undefined {
  if (!isObj(raw)) {
    fail(`${path} must be an object`);
    return undefined;
  }
  const v: ThemeVariant = {};
  const colors = parseColors(raw.colors, `${path}.colors`, fail);
  const terminal = parseTerminal(raw.terminal, `${path}.terminal`, fail);
  const layout = parseLayout(raw.layout, `${path}.layout`, fail);
  if (colors) v.colors = colors;
  if (terminal) v.terminal = terminal;
  if (layout && Object.keys(layout).length > 0) v.layout = layout;
  return v;
}

/** Shape checks; returns the normalised theme (or null) and the structural failures. */
export function parseTheme(raw: unknown): { theme: Theme | null; failures: string[] } {
  const failures: string[] = [];
  const fail = (m: string) => failures.push(m);
  if (!isObj(raw)) return { theme: null, failures: ['a theme must be a JSON object'] };
  const id = typeof raw.id === 'string' ? raw.id : '';
  if (!THEME_ID_RE.test(id)) fail('id must be kebab-case (a-z, 0-9, -), 2–64 characters');
  if (!isStr(raw.name)) fail('name must be a non-empty string');
  const layout = parseLayout(raw.layout, 'layout', fail);
  const variants: Theme['variants'] = {};
  if (!isObj(raw.variants)) {
    fail('variants must be an object with light and/or dark');
  } else {
    for (const k of Object.keys(raw.variants)) {
      if (k !== 'light' && k !== 'dark') fail(`variants.${k}: only light and dark are allowed`);
    }
    for (const mode of ['light', 'dark'] as const) {
      if (raw.variants[mode] === undefined) continue;
      const v = parseVariant(raw.variants[mode], `variants.${mode}`, fail);
      if (v) variants[mode] = v;
    }
    if (!variants.light && !variants.dark) fail('variants must contain light or dark');
  }
  if (!variants.light && !variants.dark) return { theme: null, failures };
  const theme: Theme = { id: THEME_ID_RE.test(id) ? id : 'invalid-id', name: isStr(raw.name) ? raw.name.trim() : 'Untitled', variants };
  if (layout && Object.keys(layout).length > 0) theme.layout = layout;
  if (isStr(raw.author)) theme.author = raw.author;
  if (isStr(raw.description)) theme.description = raw.description;
  if (isStr(raw.license)) theme.license = raw.license;
  if (isObj(raw.editorTheme)) {
    const et: NonNullable<Theme['editorTheme']> = {};
    if (isStr(raw.editorTheme.light)) et.light = raw.editorTheme.light;
    if (isStr(raw.editorTheme.dark)) et.dark = raw.editorTheme.dark;
    if (et.light || et.dark) theme.editorTheme = et;
  }
  return { theme, failures };
}

/** Readability checks on every variant the theme defines, on its resolved tokens. */
export function contrastFailures(theme: Theme): string[] {
  const out: string[] = [];
  for (const mode of ['light', 'dark'] as const satisfies ThemeMode[]) {
    const v = theme.variants[mode];
    if (!v) continue;
    const r = resolveTheme(theme, mode).colors;
    const at = (m: string) => out.push(`${mode}: ${m}`);
    const check = (fg: string, bg: string, min: number, what: string) => {
      const ratio = contrast(fg, bg);
      if (ratio < min) at(`${what} is ${ratio.toFixed(2)}:1 (needs ${min}:1)`);
    };
    check(r.foreground, r.background, 4.5, 'foreground on background');
    check(r.mutedForeground, r.card, 4.5, 'muted foreground on card');
    check(r.mutedForeground, r.sidebar, 4.5, 'muted foreground on sidebar');
    check(r.destructive, r.background, 3, 'destructive on background');
    // A theme's own state colours must pass as given (derived ones fall back silently).
    const own = STATE_KEYS.filter((k) => v.colors?.[k]);
    if (own.length > 0) {
      const set = {} as Record<StateKey, string>;
      for (const k of STATE_KEYS) set[k] = v.colors?.[k] ?? r[k];
      for (const f of checkStateColors(set, { sidebar: r.sidebar, card: r.card })) at(f);
    }
  }
  return out;
}

export function validateTheme(raw: unknown): ValidationResult {
  const { theme, failures } = parseTheme(raw);
  if (theme) failures.push(...contrastFailures(theme));
  return { ok: theme !== null && failures.length === 0, theme, failures };
}
