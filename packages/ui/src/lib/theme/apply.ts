// The DOM side of theming (theming.md §2): write a resolved theme's tokens as CSS custom properties on
// :root, clearing the previous theme's first so switching never leaves stale values.
import type { ChromeColors } from '../connection.ts';
import { flatten, toHex } from './color.ts';
import { themeCssVars } from './resolve.ts';
import type { Density, ResolvedTheme } from './types.ts';

/** localStorage key read by public/theme-init.js to paint the last theme before React loads. */
export const PAINT_CACHE_KEY = 'bizzi.theme.paint';

export type PaintEntry = { dark: boolean; vars: Record<string, string> };
export type PaintCache = { light: PaintEntry; dark: PaintEntry; density: Density };

let written: string[] = [];

export function applyTheme(r: ResolvedTheme, density: Density, root: HTMLElement = document.documentElement): void {
  const vars = themeCssVars(r);
  for (const name of written) if (!(name in vars)) root.style.removeProperty(name);
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  written = Object.keys(vars);
  root.dataset.theme = r.dark ? 'dark' : 'light';
  root.dataset.density = density;
  root.dataset.themeId = r.id;
  root.style.colorScheme = r.dark ? 'dark' : 'light';
  // Browser chrome and the phone status bar follow the background (§8). The mobile shell's system-bar
  // style follows data-theme (apps/mobile/src/bridge/theme.ts).
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  meta.content = r.colors.background;
  // Desktop: the window background and the themed title bar strip's OS controls follow the theme too.
  try {
    window.bizzi?.setChrome?.(chromeColors(r));
  } catch {
    // An older desktop shell without setChrome, or a page outside Electron.
  }
}

/** The colors the desktop window chrome needs, as opaque `#rrggbb` (themes may use rgba()). */
export function chromeColors(r: ResolvedTheme): ChromeColors {
  const bg = toHex(flatten(r.colors.background, r.dark ? '#000000' : '#ffffff'));
  const opaque = (c: string) => toHex(flatten(c, bg));
  return { background: bg, card: opaque(r.colors.card), sidebar: opaque(r.colors.sidebar), foreground: opaque(r.colors.foreground), dark: r.dark };
}

/** Remove everything applyTheme wrote (back to the stylesheet's bizzi Default). */
export function clearTheme(root: HTMLElement = document.documentElement): void {
  for (const name of written) root.style.removeProperty(name);
  written = [];
  delete root.dataset.themeId;
}

export function paintEntry(r: ResolvedTheme): PaintEntry {
  return { dark: r.dark, vars: themeCssVars(r) };
}
