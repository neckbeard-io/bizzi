// base16 / base24 schemes (tinted-theming) → bizzi themes. Ported from Chorus's base16.ts
// (Apache-2.0; see NOTICE). One converter serves the built-in catalog and imports
// (theming.md §5), so a converter bug shows up in the built-ins first.
//
//   base00 default background      base08 red      (variables, deleted)
//   base01 lighter background      base09 orange   (integers, constants)
//   base02 selection background    base0A yellow   (classes, search)
//   base03 comments, invisibles    base0B green    (strings, inserted)
//   base04 dark foreground         base0C cyan     (support, escapes)
//   base05 default foreground      base0D blue     (functions, headings)
//   base06 light foreground        base0E magenta  (keywords)
//   base07 light background        base0F brown    (deprecated)
//
// base24 adds base10–base17: a darker background pair and true bright ANSI colors.
import { contrast, luminance, mix } from './color.ts';
import type { Ansi16, TerminalPalette, Theme, ThemeColors } from './types.ts';

export type Base16Variant = 'dark' | 'light';

export type Base16Scheme = {
  system: 'base16' | 'base24';
  name: string;
  author?: string;
  /** License of the scheme, recorded for vendored built-ins (theming.md §1). */
  license?: string;
  variant: Base16Variant;
  /** Lowercase keys: `base00`…`base0f`, plus `base10`…`base17` for base24. */
  palette: Record<string, string>;
};

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function normalizeHex(value: string): string | null {
  const v = scalar(value);
  const hex = v.startsWith('#') ? v : `#${v}`;
  if (!HEX_RE.test(hex)) return null;
  if (hex.length === 4) return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`.toLowerCase();
  return hex.toLowerCase();
}

/**
 * One YAML scalar. Published schemes carry inline comments after the value
 * (`base00: "#eff1f5" # base`); a naive quote-strip turns that into `#eff1f5" # base` and rejects the
 * whole scheme. A quoted scalar ends at its closing quote; an unquoted one at the first whitespace
 * followed by `#`, which keeps a bare `#abc123` value from being read as a comment.
 */
export function scalar(raw: string): string {
  const value = raw.trim();
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const end = value.indexOf(quote, 1);
    return end === -1 ? value.slice(1) : value.slice(1, end);
  }
  const comment = value.search(/\s#/);
  return (comment === -1 ? value : value.slice(0, comment)).trim();
}

/**
 * Parse a tinted-theming scheme: the published YAML (a flat mapping, optionally with a nested
 * `palette:` block; older files put `base00:` at the top level) or the equivalent JSON. A tiny YAML
 * subset reader, not a YAML library: the scheme format is flat. Null when it isn't a usable scheme.
 */
export function parseBase16Scheme(text: string): Base16Scheme | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const palette: Record<string, string> = {};
  let name = '';
  let author: string | undefined;
  let variant: Base16Variant | null = null;
  let system: 'base16' | 'base24' = 'base16';

  if (trimmed.startsWith('{')) {
    let raw: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
      raw = parsed as Record<string, unknown>;
    } catch {
      return null;
    }
    name = typeof raw.name === 'string' ? raw.name : typeof raw.scheme === 'string' ? raw.scheme : '';
    author = typeof raw.author === 'string' && raw.author ? raw.author : undefined;
    if (raw.variant === 'light' || raw.variant === 'dark') variant = raw.variant;
    if (raw.system === 'base24') system = 'base24';
    const source = typeof raw.palette === 'object' && raw.palette !== null ? (raw.palette as Record<string, unknown>) : raw;
    for (const [k, v] of Object.entries(source)) {
      if (typeof v !== 'string' || !/^base[0-9a-f]{2}$/i.test(k)) continue;
      const hex = normalizeHex(v);
      if (hex) palette[k.toLowerCase()] = hex;
    }
  } else {
    for (const line of trimmed.split(/\r?\n/)) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const m = /^(\s*)([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
      if (!m) continue;
      const [, indent, key, rest] = m as unknown as [string, string, string, string];
      const value = scalar(rest);
      if (/^base[0-9a-f]{2}$/i.test(key)) {
        const hex = normalizeHex(value);
        if (hex) palette[key.toLowerCase()] = hex;
        continue;
      }
      if (indent.length > 0) continue;
      if (key === 'name') name = value;
      else if (key === 'scheme') name ||= value;
      else if (key === 'author') author = value || undefined;
      else if (key === 'variant' && (value === 'light' || value === 'dark')) variant = value;
      else if (key === 'system' && value === 'base24') system = 'base24';
    }
  }

  // All sixteen base colors are required; a missing one would surface as `undefined` downstream.
  for (let i = 0; i < 16; i++) if (!palette[`base0${i.toString(16)}`]) return null;
  if (!name) return null;
  if (!variant) variant = luminance(palette.base00!) > 0.5 ? 'light' : 'dark';
  const scheme: Base16Scheme = { system, name, variant, palette };
  if (author) scheme.author = author;
  return scheme;
}

/**
 * First candidate that clears `min` on `bg`; else walk the preferred one toward `extreme` (base07, the
 * far end of the ramp). A scheme is authored for syntax highlighting, not chrome: handing base03
 * straight through as muted text lands below the legibility floor.
 */
function pickForContrast(bg: string, min: number, candidates: string[], extreme: string): string {
  for (const c of candidates) if (contrast(c, bg) >= min) return c;
  const preferred = candidates[candidates.length - 1] ?? candidates[0]!;
  for (const w of [0.2, 0.4, 0.6, 0.8, 1]) {
    const m = mix(preferred, extreme, w);
    if (contrast(m, bg) >= min) return m;
  }
  return extreme;
}

export function schemeId(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug.length >= 2 ? slug : 'imported-scheme';
}

/**
 * Convert a parsed scheme. Surfaces come from the scheme's background ramp; foregrounds are picked by
 * measured contrast from the scheme's own candidates.
 */
export function base16ToTheme(scheme: Base16Scheme): Theme {
  const p = scheme.palette as Record<string, string> & { base00: string };
  const at = (k: string) => p[k]!;
  const bg = at('base00');
  const surface = at('base01');
  const raised = at('base02');
  const extreme = at('base07');
  const blue = at('base0d');

  // Body text must clear AA on both the page and the card, with one color.
  const worst = contrast(at('base05'), bg) < contrast(at('base05'), surface) ? bg : surface;
  const fg = pickForContrast(worst, 4.5, [at('base05')], extreme);
  const sidebar = scheme.variant === 'light' ? mix(bg, surface, 0.5) : surface;
  // Muted text sits on raised surfaces (card, sidebar); check the worse of the two.
  const mutedOn = contrast(at('base04'), surface) < contrast(at('base04'), sidebar) ? surface : sidebar;
  const mutedForeground = pickForContrast(mutedOn, 4.5, [at('base04'), at('base03'), fg], extreme);
  // Borders are non-text: 3:1 against what they separate (WCAG 1.4.11).
  const border = pickForContrast(bg, 3, [raised, at('base03'), at('base04')], extreme);
  // Text on the primary needs the full 4.5:1; prefer the scheme's own ends, then white or black.
  const onPrimary = ((): string => {
    const ranked = [bg, extreme].sort((a, b) => contrast(b, blue) - contrast(a, blue));
    for (const c of ranked) if (contrast(c, blue) >= 4.5) return c;
    return contrast('#ffffff', blue) >= contrast('#000000', blue) ? '#ffffff' : '#000000';
  })();
  const destructive = pickForContrast(bg, 3, [at('base08')], extreme);
  // Hover and selected surfaces (secondary, muted, accent) carry body and muted text. Some schemes'
  // base02 sits too close to base05 (Solarized), so step it back toward the card until both read.
  const tinted = ((): string => {
    for (const w of [1, 0.8, 0.6, 0.4, 0.2]) {
      const c = mix(surface, raised, w);
      if (contrast(fg, c) >= 4.5 && contrast(mutedForeground, c) >= 3) return c;
    }
    return surface;
  })();

  const colors: ThemeColors = {
    background: bg,
    foreground: fg,
    card: surface,
    cardForeground: fg,
    popover: surface,
    popoverForeground: fg,
    primary: blue,
    primaryForeground: onPrimary,
    secondary: tinted,
    secondaryForeground: fg,
    muted: tinted,
    mutedForeground,
    accent: tinted,
    accentForeground: fg,
    destructive,
    border,
    input: border,
    ring: blue,
    sidebar,
    sidebarForeground: fg,
    sidebarPrimary: blue,
    sidebarPrimaryForeground: onPrimary,
    sidebarAccent: tinted,
    sidebarAccentForeground: fg,
    sidebarBorder: border,
    sidebarRing: blue,
  };

  // base24 has true bright colors; base16 reuses the normal ones (the base16 terminal convention).
  const bright = (normal: string, key: string) => p[key] ?? normal;
  const ansi: Ansi16 = [
    scheme.system === 'base24' ? (p.base10 ?? bg) : bg,
    at('base08'),
    at('base0b'),
    at('base0a'),
    blue,
    at('base0e'),
    at('base0c'),
    fg,
    at('base03'),
    bright(at('base08'), 'base12'),
    bright(at('base0b'), 'base14'),
    bright(at('base0a'), 'base13'),
    bright(blue, 'base16'),
    bright(at('base0e'), 'base17'),
    bright(at('base0c'), 'base15'),
    extreme,
  ];
  const terminal: TerminalPalette = { background: bg, foreground: fg, cursor: fg, cursorAccent: bg, selection: mix(bg, raised, 0.8), ansi };

  const theme: Theme = {
    id: schemeId(scheme.name),
    name: scheme.name,
    description: `${scheme.system} scheme, ${scheme.variant}.`,
    variants: { [scheme.variant]: { colors, terminal } },
  };
  if (scheme.author) theme.author = scheme.author;
  if (scheme.license) theme.license = scheme.license;
  return theme;
}

/** Parse and convert in one step; null when the text isn't a usable scheme. */
export function themeFromBase16Text(text: string): Theme | null {
  const scheme = parseBase16Scheme(text);
  return scheme ? base16ToTheme(scheme) : null;
}
