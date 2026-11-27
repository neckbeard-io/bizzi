// bizzi Default (theming.md §4): bizzi's own look, indigo primary on neutral grays. The Device theme
// (platform accent color) is this with the accent swapped in.
import { ensureContrast, isColor, mix, textOn } from '../color.ts';
import { DEFAULT_ANSI, DEFAULT_COLORS, DEFAULT_TERMINAL } from '../defaults.ts';
import type { Theme, ThemeMode, ThemeVariant } from '../types.ts';

export const DEFAULT_THEME_ID = 'bizzi-default';
export const DEVICE_THEME_ID = 'device';

function variant(mode: ThemeMode): ThemeVariant {
  return { colors: { ...DEFAULT_COLORS[mode] }, terminal: { ...DEFAULT_TERMINAL[mode], ansi: DEFAULT_ANSI[mode] } };
}

export const bizziDefault: Theme = {
  id: DEFAULT_THEME_ID,
  name: 'bizzi Default',
  author: 'bizzi',
  description: 'Indigo accent on neutral grays.',
  variants: { light: variant('light'), dark: variant('dark') },
};

/**
 * Normalize a platform accent: Electron's `systemPreferences.getAccentColor()` returns `rrggbbaa`
 * without `#`; Android's dynamic color comes as a CSS color. Null when unusable.
 */
export function normalizeAccent(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const v = raw.trim();
  const hex = /^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(v) ? `#${v.slice(0, 6)}` : v;
  return isColor(hex) ? hex : null;
}

/**
 * Device (from flax): bizzi Default with the platform accent as primary, nudged per variant so it
 * stays readable (3:1 against the card). Without an accent it is exactly bizzi Default.
 */
export function deviceTheme(accent: string | null): Theme {
  const base: Theme = { id: DEVICE_THEME_ID, name: 'Device', author: 'bizzi', description: accent ? 'Follows the system accent color.' : 'Follows the system accent color (none available here: bizzi Default).', variants: {} };
  for (const mode of ['light', 'dark'] as const) {
    const v = variant(mode);
    if (accent) {
      const D = DEFAULT_COLORS[mode];
      const primary = ensureContrast(accent, D.card, 3, D.foreground);
      const onPrimary = textOn(primary);
      Object.assign(v.colors!, {
        primary,
        primaryForeground: onPrimary,
        ring: primary,
        sidebarPrimary: primary,
        sidebarPrimaryForeground: onPrimary,
        primarySoft: mix(D.card, primary, mode === 'dark' ? 0.2 : 0.1),
      });
      // State colors keep bizzi's colorblind-safe set: an accent as "working" can sit too close to another state.
      v.terminal = { ...v.terminal, cursor: primary, selection: mix(DEFAULT_TERMINAL[mode].background, primary, 0.3) };
    }
    base.variants[mode] = v;
  }
  return base;
}
