// Theme model (docs/theming.md §2), from Chorus/Terax (Apache-2.0) plus bizzi's own tokens (§3).
// Plain data, no DOM: everything under lib/theme/ except apply.ts runs under `node --test`.

export type ThemeMode = 'light' | 'dark';
/** The user's mode choice; `system` follows `prefers-color-scheme`. Separate from the theme. */
export type ModePref = 'system' | ThemeMode;

export type PanelStyle = 'floating-island' | 'flush-ide' | 'minimal-split';
export type Density = 'compact' | 'comfortable' | 'spacious';

export type LayoutTokens = Partial<{
  /** Accepted and kept, not applied yet (theming.md §7). */
  panelStyle: PanelStyle;
  density: Density;
  fontHeading: string;
  composerRadius: string;
  outerGap: string;
  spineRowHeight: string;
}>;

/** Chorus's token set (shadcn names). Files from Chorus and Terax use exactly these. */
export const CHORUS_COLOR_KEYS = [
  'background',
  'foreground',
  'card',
  'cardForeground',
  'popover',
  'popoverForeground',
  'primary',
  'primaryForeground',
  'secondary',
  'secondaryForeground',
  'muted',
  'mutedForeground',
  'accent',
  'accentForeground',
  'destructive',
  'border',
  'input',
  'ring',
  'sidebar',
  'sidebarForeground',
  'sidebarPrimary',
  'sidebarPrimaryForeground',
  'sidebarAccent',
  'sidebarAccentForeground',
  'sidebarBorder',
  'sidebarRing',
] as const;

/** bizzi-only tokens (theming.md §3 step 2). All optional: missing ones are derived. */
export const BIZZI_COLOR_KEYS = [
  'ok',
  'warn',
  'err',
  'info',
  'code',
  'diffAdd',
  'diffAddForeground',
  'diffDel',
  'diffDelForeground',
  'diffHunk',
  'diffHunkForeground',
  /** Tinted primary surface (badges, selected chips). */
  'primarySoft',
  /** Accent-coloured text (links, accent badges); derived from the primary when omitted. */
  'primaryText',
  'stateWaiting',
  'stateWorking',
  'stateDone',
  'stateFailed',
  'stateIdle',
] as const;

export const STATE_KEYS = ['stateWaiting', 'stateWorking', 'stateDone', 'stateFailed', 'stateIdle'] as const;

export type ChorusColorKey = (typeof CHORUS_COLOR_KEYS)[number];
export type BizziColorKey = (typeof BIZZI_COLOR_KEYS)[number];
export type ColorKey = ChorusColorKey | BizziColorKey;
export type StateKey = (typeof STATE_KEYS)[number];

/** Colour tokens plus `radius` (a CSS length), as in Chorus. */
export type ThemeColors = Partial<Record<ColorKey, string>> & { radius?: string };

export type Ansi16 = readonly [string, string, string, string, string, string, string, string, string, string, string, string, string, string, string, string];

export type TerminalPalette = Partial<{
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selection: string;
  /** black red green yellow blue magenta cyan white, then the bright ones. */
  ansi: Ansi16;
}>;

export type ThemeVariant = { colors?: ThemeColors; terminal?: TerminalPalette; layout?: LayoutTokens };

export type Theme = {
  id: string;
  name: string;
  author?: string;
  description?: string;
  /** Licence of the palette, for built-ins and vendored schemes. */
  license?: string;
  /** Shared by both variants unless a variant overrides it. */
  layout?: LayoutTokens;
  variants: { light?: ThemeVariant; dark?: ThemeVariant };
  /** Syntax-highlight theme for code blocks and diffs, per variant. */
  editorTheme?: { light?: string; dark?: string };
};

/** Every colour token, filled in (resolve.ts). */
export type ResolvedColors = Record<ColorKey, string> & { radius: string };
export type ResolvedTerminal = Required<TerminalPalette>;

export type ResolvedTheme = {
  id: string;
  name: string;
  /** The variant that was used (may differ from the requested mode when the theme lacks it). */
  variant: ThemeMode;
  /** Polarity by background luminance; drives `data-theme` and the `dark:` Tailwind variant. */
  dark: boolean;
  colors: ResolvedColors;
  terminal: ResolvedTerminal;
  layout: LayoutTokens;
  /** What derivation had to fall back on (e.g. state colours replaced by defaults). */
  notes: string[];
};
