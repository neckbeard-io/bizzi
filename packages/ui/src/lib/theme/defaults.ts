// bizzi's own palette ("bizzi Default", theming.md §4): indigo primary, neutral grays. These are also the
// fallbacks for tokens a theme leaves out and the derivation can't fill (§3 step 3), and for state
// colors that fail the contrast checks. Keep in sync with the :root / [data-theme='dark'] blocks in
// src/index.css, which paint before any theme is applied.
import type { AgentKind, LabelColor } from '@bizzi/protocol';
import type { Ansi16, ResolvedColors, ThemeMode } from './types.ts';

export const DEFAULT_COLORS: Record<ThemeMode, ResolvedColors> = {
  light: {
    background: '#f7f7f8',
    foreground: '#17171c',
    card: '#ffffff',
    cardForeground: '#17171c',
    popover: '#ffffff',
    popoverForeground: '#17171c',
    primary: '#4f46e5',
    primaryForeground: '#ffffff',
    secondary: '#f1f1f4',
    secondaryForeground: '#17171c',
    muted: '#f1f1f4',
    mutedForeground: '#6b6b76',
    accent: '#f1f1f4',
    accentForeground: '#17171c',
    destructive: '#dc2626',
    border: '#e3e3e8',
    input: '#e3e3e8',
    ring: '#4f46e5',
    sidebar: '#ffffff',
    sidebarForeground: '#17171c',
    sidebarPrimary: '#4f46e5',
    sidebarPrimaryForeground: '#ffffff',
    sidebarAccent: '#f1f1f4',
    sidebarAccentForeground: '#17171c',
    sidebarBorder: '#e3e3e8',
    sidebarRing: '#4f46e5',
    ok: '#15803d',
    warn: '#b45309',
    err: '#dc2626',
    info: '#2563eb',
    code: '#f3f3f6',
    diffAdd: '#e6f7ea',
    diffAddForeground: '#14532d',
    diffDel: '#fdecec',
    diffDelForeground: '#7f1d1d',
    diffHunk: '#eef1fb',
    diffHunkForeground: '#3949ab',
    primarySoft: '#eef0ff',
    primaryText: '#4f46e5',
    stateWaiting: '#c27c00',
    stateWorking: '#0a66ff',
    stateDone: '#0a7d3e',
    stateFailed: '#ee1144',
    stateIdle: '#868c9c',
    radius: '0.5rem',
  },
  dark: {
    background: '#0c0c10',
    foreground: '#e7e7ec',
    card: '#141419',
    cardForeground: '#e7e7ec',
    popover: '#141419',
    popoverForeground: '#e7e7ec',
    primary: '#8b93ff',
    primaryForeground: '#0c0c10',
    secondary: '#1c1c23',
    secondaryForeground: '#e7e7ec',
    muted: '#1c1c23',
    mutedForeground: '#9a9aa6',
    accent: '#1c1c23',
    accentForeground: '#e7e7ec',
    destructive: '#f87171',
    border: '#2a2a33',
    input: '#2a2a33',
    ring: '#8b93ff',
    sidebar: '#141419',
    sidebarForeground: '#e7e7ec',
    sidebarPrimary: '#8b93ff',
    sidebarPrimaryForeground: '#0c0c10',
    sidebarAccent: '#1c1c23',
    sidebarAccentForeground: '#e7e7ec',
    sidebarBorder: '#2a2a33',
    sidebarRing: '#8b93ff',
    ok: '#4ade80',
    warn: '#fbbf24',
    err: '#f87171',
    info: '#60a5fa',
    code: '#1a1a21',
    diffAdd: '#0f2a19',
    diffAddForeground: '#bbf7d0',
    diffDel: '#2f1414',
    diffDelForeground: '#fecaca',
    diffHunk: '#1b1f3a',
    diffHunkForeground: '#a5b4fc',
    primarySoft: '#23244a',
    primaryText: '#8b93ff',
    stateWaiting: '#ffcc00',
    stateWorking: '#3d8bff',
    stateDone: '#7dffd4',
    stateFailed: '#ff3333',
    stateIdle: '#6c7488',
    radius: '0.5rem',
  },
};

/**
 * Identity colors (spec §11.1 "Identity color"), by the background's polarity. resolveTheme nudges them
 * toward the foreground until each clears LABEL_MIN_CONTRAST on the theme's sidebar, cards and page, so a
 * light theme gets darker inks and a dark theme lighter ones. Keep in sync with `--label-*` in index.css.
 */
export const DEFAULT_LABELS: Record<ThemeMode, Record<LabelColor, string>> = {
  light: {
    red: '#dc2626',
    orange: '#c2410c',
    yellow: '#a16207',
    green: '#15803d',
    teal: '#0f766e',
    blue: '#2563eb',
    purple: '#9333ea',
    pink: '#db2777',
  },
  dark: {
    red: '#f87171',
    orange: '#fb923c',
    yellow: '#facc15',
    green: '#4ade80',
    teal: '#2dd4bf',
    blue: '#60a5fa',
    purple: '#c084fc',
    pink: '#f472b6',
  },
};

/**
 * Agent identity colors (the glyph tile of a session mark), by the background's polarity: a Claude session
 * and a Codex session should look different at a glance. Like the identity labels they're not theme tokens;
 * resolveTheme nudges them to 3:1 on the theme's surfaces. The glyph carries the identity too, so colorblind
 * users don't depend on the hue. Keep in sync with `--agent-*` in index.css.
 */
export const DEFAULT_AGENT_COLORS: Record<ThemeMode, Record<AgentKind, string>> = {
  light: {
    claude: '#d9480f',
    codex: '#8b3dff',
    opencode: '#0f8a5f',
    agy: '#0b5ad0',
    shell: '#4b505c',
    api: '#d0287f',
  },
  dark: {
    claude: '#ff8f5a',
    codex: '#d6b4ff',
    opencode: '#3ee0a0',
    agy: '#4a8cff',
    shell: '#b4b9c4',
    api: '#ff5fb8',
  },
};

/** Terminal ANSI palettes for themes without one (black red green yellow blue magenta cyan white, then bright). */
export const DEFAULT_ANSI: Record<ThemeMode, Ansi16> = {
  dark: ['#1c1c23', '#f87171', '#4ade80', '#fbbf24', '#60a5fa', '#c084fc', '#22d3ee', '#d4d4d8', '#6b6b76', '#fca5a5', '#86efac', '#fde68a', '#93c5fd', '#d8b4fe', '#67e8f9', '#ffffff'],
  // Light: "white" is a mid gray and bright white a dark one, so `white` text stays readable on white.
  light: ['#17171c', '#dc2626', '#15803d', '#a16207', '#1d4ed8', '#9333ea', '#0e7490', '#a1a1aa', '#6b6b76', '#b91c1c', '#166534', '#854d0e', '#1e40af', '#7e22ce', '#155e75', '#52525b'],
};

/** Terminal chrome for bizzi Default (the terminal sits on a card surface). */
export const DEFAULT_TERMINAL = {
  light: { background: '#ffffff', foreground: '#17171c', cursor: '#4f46e5', cursorAccent: '#ffffff', selection: '#c7cbff' },
  dark: { background: '#0c0c10', foreground: '#e7e7ec', cursor: '#8b93ff', cursorAccent: '#0c0c10', selection: '#3b3f7a' },
} as const;

/**
 * Invariant safety tokens (theming.md §6): approval prompts, permission-mode badges (bypass
 * permissions) and destructive confirmations. Self-contained fill + text + border pairs that read on
 * any background, light or dark. Not part of the theme model: no theme, import or custom file can set
 * them, and applyTheme never writes them.
 */
export const SAFETY = {
  warn: '#f5b400',
  warnForeground: '#1a1300',
  danger: '#c81e1e',
  dangerForeground: '#ffffff',
} as const;
