// Fonts (theming.md §7a): the interface font and the code font (code blocks, diffs, terminals). One user-wide
// choice stored with the theme in `prefs.*`; unset means bizzi's default. JetBrains Mono ships with the UI
// (self-hosted, so it works offline and on phones); any other name is used when the device has it installed,
// else the stack falls through to the platform font.

/** The family name the bundled JetBrains Mono registers (`@fontsource-variable/jetbrains-mono`). */
export const BUNDLED_MONO = 'JetBrains Mono Variable';

/** What the pickers show for the bundled font, and the name a user types for it. */
export const JETBRAINS_MONO = 'JetBrains Mono';

/** Pref value meaning "the platform's own font" (no named family first). */
export const SYSTEM_FONT = 'system';

// No CSS-only generic keywords (ui-monospace, system-ui) in the terminal stack: xterm's canvas renderers set
// `ctx.font`, which rejects them and falls back to 10px sans-serif.
const SYSTEM_MONO = ["'SF Mono'", 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', "'DejaVu Sans Mono'", "'Liberation Mono'", 'monospace'];
const SYSTEM_SANS = ['system-ui', '-apple-system', "'Segoe UI'", 'Roboto', "'Helvetica Neue'", 'Arial', 'sans-serif'];

/** Defaults: JetBrains Mono for code, the platform font for the interface. */
export const DEFAULT_CODE_FONT = JETBRAINS_MONO;
export const DEFAULT_UI_FONT = SYSTEM_FONT;

/** Suggestions for the custom field (used only when installed on the device). */
export const CODE_FONT_SUGGESTIONS = ['Fira Code', 'Cascadia Code', 'Source Code Pro', 'IBM Plex Mono', 'Iosevka', 'Hack', 'Menlo', 'SF Mono', 'Consolas'];
export const UI_FONT_SUGGESTIONS = ['Inter', 'IBM Plex Sans', 'Helvetica Neue', 'Segoe UI', 'Roboto', 'Noto Sans'];

export const MAX_FONT_NAME = 80;

/**
 * A family name as typed, cleaned for use in CSS: trimmed, quotes and anything that could end the declaration
 * removed. '' when nothing usable is left.
 */
export function cleanFontName(name: string): string {
  return name
    .replace(/[^\p{L}\p{N} _.\-+&]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_FONT_NAME);
}

/** `name` (unset or '' → `fallbackName`) first, then the platform stack. */
function stack(name: string | undefined, fallbackName: string, platform: string[]): string {
  const n = cleanFontName(name ?? '') || fallbackName;
  const key = n.toLowerCase();
  if (key === SYSTEM_FONT) return platform.join(', ');
  // The bundled copy first; an installed JetBrains Mono (static name) is the same font.
  if (key === JETBRAINS_MONO.toLowerCase() || key === BUNDLED_MONO.toLowerCase()) return [`'${BUNDLED_MONO}'`, `'${JETBRAINS_MONO}'`, ...platform].join(', ');
  return [`'${n}'`, ...platform].join(', ');
}

/** CSS `font-family` for code (code blocks, diffs, `font-mono`, terminals). Safe for xterm too. */
export function codeFontStack(name: string | undefined): string {
  return stack(name, DEFAULT_CODE_FONT, SYSTEM_MONO);
}

/** CSS `font-family` for the interface. */
export function uiFontStack(name: string | undefined): string {
  return stack(name, DEFAULT_UI_FONT, SYSTEM_SANS);
}

/** localStorage key read by public/theme-init.js to set the font variables before React loads. */
export const FONT_CACHE_KEY = 'bizzi.fonts.paint';

export type FontPaint = { '--bizzi-font-mono': string; '--bizzi-font-sans': string };

export function fontVars(uiFont: string | undefined, codeFont: string | undefined): FontPaint {
  return { '--bizzi-font-mono': codeFontStack(codeFont), '--bizzi-font-sans': uiFontStack(uiFont) };
}

export function applyFonts(vars: FontPaint, root: HTMLElement = document.documentElement): void {
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
}
