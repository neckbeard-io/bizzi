// Five-tone palettes (flax's model, docs/theming.md §5): background, foreground, primary, secondary and
// tertiary per variant; every other UI token is derived. resolve.ts also uses this to fill in tokens a
// partial theme leaves out, so a theme with just background/foreground/primary is complete.
import { contrast, ensureContrast, isDark, mix, textOn } from './color.ts';
import { DEFAULT_ANSI } from './defaults.ts';
import type { Ansi16, ChorusColorKey, Theme, ThemeMode } from './types.ts';

/** `secondary` and `tertiary` are accent hues (flax), not the shadcn `secondary` surface. */
export type FiveTone = { background: string; foreground: string; primary: string; secondary?: string; tertiary?: string };

/** Step sizes toward the foreground (§5). */
export const STEP = { sidebar: 0.03, card: 0.06, secondary: 0.09, muted: 0.11, accent: 0.13, border: 0.2, input: 0.24, mutedForeground: 0.72 } as const;

/** Accent containers: background mixed with the accent, 32% on dark, 20% on light. */
export function containerWeight(dark: boolean): number {
  return dark ? 0.32 : 0.2;
}

/** The full Chorus token set from five tones. */
export function deriveFromTones(t: FiveTone): Record<ChorusColorKey, string> {
  const { background: bg, foreground: fg, primary } = t;
  const dark = isDark(bg);
  const step = (w: number) => mix(bg, fg, w);
  const card = step(STEP.card);
  const raised = step(STEP.secondary);
  const accent = step(STEP.accent);
  // About 72% toward the foreground, pushed further if that misses 4.5:1 on the card (the raised surface).
  const mutedForeground = ensureContrast(step(STEP.mutedForeground), card, 4.5, fg);
  const border = step(STEP.border);
  const container = mix(bg, primary, containerWeight(dark));
  const onPrimary = textOn(primary);
  return {
    background: bg,
    foreground: fg,
    card,
    cardForeground: fg,
    popover: card,
    popoverForeground: fg,
    primary,
    primaryForeground: onPrimary,
    secondary: raised,
    secondaryForeground: fg,
    muted: step(STEP.muted),
    mutedForeground,
    accent,
    accentForeground: fg,
    destructive: dark ? '#f87171' : '#dc2626',
    border,
    input: step(STEP.input),
    ring: primary,
    sidebar: step(STEP.sidebar),
    sidebarForeground: fg,
    sidebarPrimary: primary,
    sidebarPrimaryForeground: onPrimary,
    sidebarAccent: container,
    sidebarAccentForeground: contrast(fg, container) >= 4.5 ? fg : textOn(container),
    sidebarBorder: border,
    sidebarRing: primary,
  };
}

/** A theme from five tones per variant (flax palettes, the Device theme). */
export function fiveToneTheme(meta: Omit<Theme, 'variants'>, tones: Partial<Record<ThemeMode, FiveTone>>): Theme {
  const variants: Theme['variants'] = {};
  for (const mode of ['light', 'dark'] as const) {
    const t = tones[mode];
    if (!t) continue;
    // Terminal: bizzi's ANSI set for the polarity, with secondary and tertiary as magenta and cyan.
    const base = DEFAULT_ANSI[isDark(t.background) ? 'dark' : 'light'];
    const ansi = [...base] as string[];
    if (t.secondary) ansi[5] = ansi[13] = t.secondary;
    if (t.tertiary) ansi[6] = ansi[14] = t.tertiary;
    variants[mode] = {
      colors: deriveFromTones(t),
      terminal: { cursor: t.primary, cursorAccent: t.background, selection: mix(t.background, t.primary, 0.3), ansi: ansi as unknown as Ansi16 },
    };
  }
  return { ...meta, variants };
}
