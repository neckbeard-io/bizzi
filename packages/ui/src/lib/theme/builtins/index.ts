// The built-in themes (theming.md §4), in picker order: bizzi's own, hand-authored, flax five-tone,
// Cobalt2, then the base16 catalog through the same converter as imports.
import { base16ToTheme } from '../base16.ts';
import type { Theme } from '../types.ts';
import { BASE16_SCHEMES } from './base16-schemes.ts';
import { DEFAULT_THEME_ID, DEVICE_THEME_ID, bizziDefault, deviceTheme } from './bizzi.ts';
import { abyss, caffeine, catppuccin, graphite, gruvbox, inkBone, nord, paper, rosePine, sage, teletype, tide, tokyoNight, warmPaperClay } from './chorus.ts';
import { cobalt2 } from './cobalt2.ts';
import { dracula, evergreen, synthwave } from './flax.ts';

export { DEFAULT_THEME_ID, DEVICE_THEME_ID, bizziDefault, deviceTheme, normalizeAccent } from './bizzi.ts';

export type ThemeGroup = 'bizzi' | 'hand-authored' | 'five-tone' | 'base16' | 'custom';

export type CatalogEntry = { theme: Theme; group: ThemeGroup };

export const BASE16_THEMES: Theme[] = BASE16_SCHEMES.map(base16ToTheme);

const GROUPS: [ThemeGroup, Theme[]][] = [
  ['bizzi', [bizziDefault, deviceTheme(null)]],
  ['hand-authored', [tokyoNight, nord, catppuccin, gruvbox, rosePine, tide, sage, caffeine, graphite, paper, teletype, abyss, inkBone, warmPaperClay, cobalt2]],
  ['five-tone', [evergreen, dracula, synthwave]],
  ['base16', BASE16_THEMES],
];

/** Every built-in; ids are checked here because a collision would silently shadow a theme. */
export const BUILTIN_CATALOG: CatalogEntry[] = (() => {
  const seen = new Set<string>();
  const out: CatalogEntry[] = [];
  for (const [group, themes] of GROUPS) {
    for (const theme of themes) {
      if (seen.has(theme.id)) throw new Error(`duplicate built-in theme id: ${theme.id}`);
      seen.add(theme.id);
      out.push({ theme, group });
    }
  }
  return out;
})();

export const BUILTIN_THEMES: Theme[] = BUILTIN_CATALOG.map((e) => e.theme);

const BY_ID = new Map(BUILTIN_THEMES.map((t) => [t.id, t]));

export function builtinTheme(id: string): Theme | undefined {
  return BY_ID.get(id);
}

export function isBuiltinId(id: string): boolean {
  return BY_ID.has(id) || id === DEVICE_THEME_ID || id === DEFAULT_THEME_ID;
}
