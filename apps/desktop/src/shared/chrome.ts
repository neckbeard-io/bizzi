// Themed window chrome (docs/theming.md §8): the native title bar is hidden and the UI paints its own
// strip in the theme's colours. Pure helpers shared by main and tests; no Electron imports.

/** Colours the renderer sends after each theme change (`window.bizzi.setChrome`). */
export interface ChromeColors {
  /** Page background: the window background behind everything (first frame, resizes). */
  background: string;
  /** Main column strip, the colour of the page headers below it; also the Windows/Linux controls overlay. */
  card: string;
  /** Sidebar column strip. */
  sidebar: string;
  /** Text colour, used for the Windows/Linux window-control symbols. */
  foreground: string;
  dark: boolean;
}

/**
 * How the window draws its title bar, as the UI sees it:
 * - `inset`: macOS, traffic lights over the UI's strip at the top left;
 * - `overlay`: Windows/Linux, OS window controls over the UI's strip at the top right;
 * - `native`: the OS title bar (opt-out, or an unknown platform); the UI draws no strip.
 */
export type TitleBarStyle = 'inset' | 'overlay' | 'native';

export interface TitleBar {
  style: TitleBarStyle;
  /** Height of the strip the UI reserves, in CSS px (0 for native). */
  height: number;
}

/** macOS: the standard title bar height, where `hidden` keeps the traffic lights vertically centred. */
export const MAC_TITLEBAR_HEIGHT = 28;
/** Windows/Linux: the controls overlay height. */
export const OVERLAY_TITLEBAR_HEIGHT = 32;

export const DEFAULT_CHROME: ChromeColors = { background: '#0c0c10', card: '#141419', sidebar: '#141419', foreground: '#e7e7ec', dark: true };

export function titleBarFor(platform: string, env: Record<string, string | undefined>): TitleBar {
  if (env['BIZZI_NATIVE_TITLEBAR'] === '1') return { style: 'native', height: 0 };
  if (platform === 'darwin') return { style: 'inset', height: MAC_TITLEBAR_HEIGHT };
  if (platform === 'win32' || platform === 'linux') return { style: 'overlay', height: OVERLAY_TITLEBAR_HEIGHT };
  return { style: 'native', height: 0 };
}

const HEX = /^#[0-9a-f]{6}$/i;

export const CHROME_COLOR_KEYS = ['background', 'card', 'sidebar', 'foreground'] as const;

/** Validate what the renderer sent: four `#rrggbb` colours and a boolean, nothing else. */
export function parseChrome(raw: unknown): ChromeColors | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['dark'] !== 'boolean') return null;
  const out = { dark: r['dark'] } as ChromeColors;
  for (const k of CHROME_COLOR_KEYS) {
    const v = r[k];
    if (typeof v !== 'string' || !HEX.test(v)) return null;
    out[k] = v.toLowerCase();
  }
  return out;
}

/** The BrowserWindow options for a title bar style and the last-known theme colours. */
export function windowChromeOptions(bar: TitleBar, colors: ChromeColors): Record<string, unknown> {
  // The first frame (before the UI paints) and every resize show the theme's background, not white.
  const base = { backgroundColor: colors.background };
  switch (bar.style) {
    case 'inset':
      return { ...base, titleBarStyle: 'hidden' };
    case 'overlay':
      return { ...base, titleBarStyle: 'hidden', titleBarOverlay: overlayFor(colors, bar.height) };
    case 'native':
      return base;
  }
}

/** Windows/Linux controls overlay: sits over the main column's strip, so it takes the card colour. */
export function overlayFor(colors: ChromeColors, height: number): { color: string; symbolColor: string; height: number } {
  return { color: colors.card, symbolColor: colors.foreground, height };
}
