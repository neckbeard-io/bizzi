// Theme + mode → every token filled in (theming.md §2, §3 step 3, §8). Pure: the DOM side is apply.ts.
import { contrast, deltaE, ensureContrast, isDark, mix, textOn } from './color.ts';
import { AGENT_KINDS, LABEL_COLORS } from '@bizzi/protocol';
import type { AgentKind, LabelColor } from '@bizzi/protocol';
import { DEFAULT_AGENT_COLORS, DEFAULT_ANSI, DEFAULT_COLORS, DEFAULT_LABELS } from './defaults.ts';
import { deriveFromTones } from './fiveTone.ts';
import { CHORUS_COLOR_KEYS, STATE_KEYS } from './types.ts';
import type { Ansi16, ColorKey, Density, ResolvedColors, ResolvedTerminal, ResolvedTheme, StateKey, Theme, ThemeColors, ThemeMode, ThemeVariant } from './types.ts';

/** State colors must clear this against `sidebar` and `card` (spec §11.1). */
export const STATE_MIN_CONTRAST = 3;
/** …and be at least this far apart from each other (CIE76 ΔE). */
export const STATE_MIN_DISTANCE = 12;
/** Identity colors (stripes, dots, icon tiles) are graphics: WCAG 1.4.11's 3:1 on sidebar, card and page. */
export const LABEL_MIN_CONTRAST = 3;
/** Derived status colors (ok/warn/err/info) are text; they're nudged to this against `card`. */
export const STATUS_MIN_CONTRAST = 4.5;

/** The variant to use for `mode`; a theme without it falls back to its other variant (§2). */
export function pickVariant(theme: Theme, mode: ThemeMode): { key: ThemeMode; variant: ThemeVariant } {
  const other: ThemeMode = mode === 'dark' ? 'light' : 'dark';
  const v = theme.variants[mode];
  if (v) return { key: mode, variant: v };
  const o = theme.variants[other];
  if (o) return { key: other, variant: o };
  return { key: mode, variant: {} };
}

const STATE_LABEL: Record<StateKey, string> = {
  stateWaiting: 'waiting',
  stateWorking: 'working',
  stateDone: 'done',
  stateFailed: 'failed',
  stateIdle: 'idle',
};

type StateProblems = { lowContrast: { key: StateKey; surface: 'sidebar' | 'card'; ratio: number }[]; similar: { a: StateKey; b: StateKey; d: number }[] };

function stateProblems(states: Record<StateKey, string>, surfaces: { sidebar: string; card: string }): StateProblems {
  const out: StateProblems = { lowContrast: [], similar: [] };
  for (const key of STATE_KEYS) {
    for (const surface of ['sidebar', 'card'] as const) {
      const ratio = contrast(states[key], surfaces[surface]);
      if (ratio < STATE_MIN_CONTRAST) out.lowContrast.push({ key, surface, ratio });
    }
  }
  for (let i = 0; i < STATE_KEYS.length; i++) {
    for (let j = i + 1; j < STATE_KEYS.length; j++) {
      const a = STATE_KEYS[i]!;
      const b = STATE_KEYS[j]!;
      const d = deltaE(states[a], states[b]);
      if (d < STATE_MIN_DISTANCE) out.similar.push({ a, b, d });
    }
  }
  return out;
}

/** Failures of a state-color set against its surfaces: contrast with sidebar and card, and distinctness. */
export function checkStateColors(states: Record<StateKey, string>, surfaces: { sidebar: string; card: string }): string[] {
  const p = stateProblems(states, surfaces);
  return [
    ...p.lowContrast.map((x) => `${STATE_LABEL[x.key]} state color is ${x.ratio.toFixed(2)}:1 on ${x.surface} (needs ${STATE_MIN_CONTRAST}:1)`),
    ...p.similar.map((x) => `${STATE_LABEL[x.a]} and ${STATE_LABEL[x.b]} state colors are too similar (ΔE ${x.d.toFixed(1)})`),
  ];
}

/** Which state keeps the theme's own color when two collide: earlier wins (waiting and failed carry the most meaning). */
const STATE_PRIORITY: readonly StateKey[] = ['stateWaiting', 'stateFailed', 'stateWorking', 'stateIdle', 'stateDone'];

/**
 * Replace failing tokens with bizzi's defaults, one at a time (§3: "bizzi's defaults for those tokens"):
 * a token below the contrast floor, or the lower-priority one of a too-similar pair.
 */
function settleStates(start: Record<StateKey, string>, defaults: Record<StateKey, string>, surfaces: { sidebar: string; card: string }): { set: Record<StateKey, string>; replaced: StateKey[] } {
  const set = { ...start };
  const replaced = new Set<StateKey>();
  for (let guard = 0; guard < STATE_KEYS.length * 2; guard++) {
    const p = stateProblems(set, surfaces);
    let victim = p.lowContrast.find((x) => !replaced.has(x.key))?.key;
    if (!victim) {
      for (const { a, b } of p.similar) {
        const [hi, lo] = STATE_PRIORITY.indexOf(a) < STATE_PRIORITY.indexOf(b) ? [a, b] : [b, a];
        victim = !replaced.has(lo) ? lo : !replaced.has(hi) ? hi : undefined;
        if (victim) break;
      }
    }
    if (!victim) break;
    set[victim] = defaults[victim];
    replaced.add(victim);
  }
  return { set, replaced: STATE_KEYS.filter((k) => replaced.has(k)) };
}

function pickStates(src: Partial<Record<StateKey, string>>, fallback: Record<StateKey, string>): Record<StateKey, string> {
  const out = {} as Record<StateKey, string>;
  for (const k of STATE_KEYS) out[k] = src[k] ?? fallback[k];
  return out;
}

/** Fill in every token for `theme` in `mode`. */
export function resolveTheme(theme: Theme, mode: ThemeMode): ResolvedTheme {
  const { key, variant } = pickVariant(theme, mode);
  const c: ThemeColors = variant.colors ?? {};
  const notes: string[] = [];

  const bg = c.background ?? DEFAULT_COLORS[key].background;
  const dark = isDark(bg);
  const D = DEFAULT_COLORS[dark ? 'dark' : 'light'];
  const fg = c.foreground ?? (contrast(D.foreground, bg) >= 4.5 ? D.foreground : ensureContrast(D.foreground, bg, 4.5));
  const primary = c.primary ?? D.primary;
  const tones = deriveFromTones({ background: bg, foreground: fg, primary });

  // Chorus tokens: given → related given token (shadcn conventions) → derived from the tones.
  const related: Partial<Record<ColorKey, ColorKey[]>> = {
    cardForeground: ['foreground'],
    popover: ['card'],
    popoverForeground: ['cardForeground', 'foreground'],
    secondaryForeground: ['foreground'],
    accentForeground: ['foreground'],
    input: ['border'],
    ring: ['primary'],
    sidebar: ['card'],
    sidebarForeground: ['foreground'],
    sidebarPrimary: ['primary'],
    sidebarPrimaryForeground: ['primaryForeground'],
    sidebarAccent: ['accent'],
    sidebarAccentForeground: ['accentForeground', 'foreground'],
    sidebarBorder: ['border'],
    sidebarRing: ['ring', 'primary'],
  };
  const colors = {} as ResolvedColors;
  for (const k of CHORUS_COLOR_KEYS) {
    let v = c[k];
    for (const r of related[k] ?? []) v ??= c[r];
    colors[k] = v ?? tones[k];
  }
  colors.background = bg;
  colors.foreground = fg;
  colors.primary = primary;
  colors.radius = c.radius ?? D.radius;
  const card = colors.card;
  if (!c.mutedForeground) {
    // Derived muted text must stay readable on whichever raised surface the theme did give.
    const worst = contrast(colors.mutedForeground, card) < contrast(colors.mutedForeground, colors.sidebar) ? card : colors.sidebar;
    colors.mutedForeground = ensureContrast(colors.mutedForeground, worst, 4.5, fg);
  }

  // Status colors: the theme's own, else its ANSI palette, else bizzi's defaults (§3 step 3).
  const t = variant.terminal ?? {};
  const ansi = t.ansi;
  const status = (k: 'ok' | 'warn' | 'err' | 'info', ansiIndex: number): string => {
    const own = c[k];
    if (own) return own;
    const from = ansi?.[ansiIndex] ?? D[k];
    return ensureContrast(from, card, STATUS_MIN_CONTRAST, fg);
  };
  colors.ok = status('ok', 2);
  colors.warn = status('warn', 3);
  colors.err = status('err', 1);
  colors.info = status('info', 4);

  // Code and diff surfaces derive from the card and the status hues.
  colors.code = c.code ?? mix(card, fg, dark ? 0.04 : 0.035);
  const diff = (bgKey: 'diffAdd' | 'diffDel' | 'diffHunk', fgKey: 'diffAddForeground' | 'diffDelForeground' | 'diffHunkForeground', hue: string) => {
    const surface = c[bgKey] ?? mix(card, hue, dark ? 0.16 : 0.11);
    colors[bgKey] = surface;
    colors[fgKey] = c[fgKey] ?? ensureContrast(mix(hue, fg, dark ? 0.45 : 0.35), surface, 4.5, fg);
  };
  diff('diffAdd', 'diffAddForeground', colors.ok);
  diff('diffDel', 'diffDelForeground', colors.err);
  diff('diffHunk', 'diffHunkForeground', colors.info);
  colors.primarySoft = c.primarySoft ?? mix(card, primary, dark ? 0.2 : 0.1);
  // Accent-colored text sits on the page, the card, the sidebar and the soft fill: readable on all of them.
  let primaryText = c.primaryText ?? primary;
  if (!c.primaryText) for (const s of [card, bg, colors.sidebar, colors.primarySoft]) primaryText = ensureContrast(primaryText, s, 4.5, fg);
  colors.primaryText = primaryText;

  // State colors (§3): the theme's own → bizzi's defaults → defaults nudged to contrast. They aren't derived
  // from the theme's primary or status colors: bizzi's set is picked to stay apart under color blindness, and a
  // theme's hues aren't (a pink primary as "working" next to a blue "done" reads as one color to many people).
  const surfaces = { sidebar: colors.sidebar, card };
  const own: Partial<Record<StateKey, string>> = {};
  for (const k of STATE_KEYS) if (c[k]) own[k] = c[k];
  const defaults = pickStates({}, D);
  let states = settleStates(pickStates(own, defaults), defaults, surfaces);
  if (states.replaced.some((k) => own[k])) notes.push(`state colors: bizzi defaults for ${states.replaced.filter((k) => own[k]).map((k) => STATE_LABEL[k]).join(', ')} (the theme's own failed contrast or distinctness)`);
  if (checkStateColors(states.set, surfaces).length > 0) {
    // Even bizzi's defaults don't fit this sidebar/card: nudge them toward the foreground, which moves
    // away from both surfaces (they sit on the background's side).
    const set = {} as Record<StateKey, string>;
    for (const k of STATE_KEYS) set[k] = ensureContrast(ensureContrast(defaults[k], surfaces.sidebar, STATE_MIN_CONTRAST, fg), card, STATE_MIN_CONTRAST, fg);
    states = { set, replaced: [...STATE_KEYS] };
    notes.push('state colors: bizzi defaults adjusted for contrast with this sidebar/card');
  }
  Object.assign(colors, states.set);

  const labels = resolveLabels(dark, [colors.sidebar, card, bg], fg);
  const agents = resolveAgentColors(dark, [colors.sidebar, card, bg], fg);

  // Terminal (§8): the theme's palette, else derived from its UI colors.
  const termBg = t.background ?? bg;
  const termFg = t.foreground ?? fg;
  let derivedAnsi: Ansi16 | undefined;
  if (!ansi) {
    const base = [...DEFAULT_ANSI[dark ? 'dark' : 'light']];
    base[1] = colors.err;
    base[2] = colors.ok;
    base[3] = colors.warn;
    base[4] = colors.info;
    derivedAnsi = base as unknown as Ansi16;
  }
  const terminal: ResolvedTerminal = {
    background: termBg,
    foreground: termFg,
    cursor: t.cursor ?? primary,
    cursorAccent: t.cursorAccent ?? termBg,
    selection: t.selection ?? mix(termBg, primary, dark ? 0.35 : 0.25),
    ansi: ansi ?? derivedAnsi!,
  };

  const layout = { ...theme.layout, ...variant.layout };
  return { id: theme.id, name: theme.name, variant: key, dark, colors, terminal, labels, agents, layout, notes };
}

/** Each ink nudged toward the foreground until it clears LABEL_MIN_CONTRAST on every surface. */
function readableInks<K extends string>(names: readonly K[], base: Record<K, string>, surfaces: readonly string[], fg: string): Record<K, string> {
  const out = {} as Record<K, string>;
  for (const name of names) {
    let c = base[name];
    // Twice round: a step that fixes one surface can't undo another (they sit on the same side of fg).
    for (let i = 0; i < 2; i++) for (const s of surfaces) c = ensureContrast(c, s, LABEL_MIN_CONTRAST, fg);
    out[name] = c;
  }
  return out;
}

/** bizzi's identity palette for this polarity, each nudged toward the foreground until it reads on every surface. */
export function resolveLabels(dark: boolean, surfaces: readonly string[], fg: string): Record<LabelColor, string> {
  return readableInks(LABEL_COLORS, DEFAULT_LABELS[dark ? 'dark' : 'light'], surfaces, fg);
}

/** Agent identity colors for this polarity, nudged the same way. */
export function resolveAgentColors(dark: boolean, surfaces: readonly string[], fg: string): Record<AgentKind, string> {
  return readableInks(AGENT_KINDS, DEFAULT_AGENT_COLORS[dark ? 'dark' : 'light'], surfaces, fg);
}

/** Phones keep at least comfortable density for 44 px hit targets (§7, spec §11.1). */
export function effectiveDensity(choice: Density | 'theme', themeDensity: Density | undefined, phone: boolean): Density {
  const d = choice === 'theme' ? (themeDensity ?? 'comfortable') : choice;
  return phone && d === 'compact' ? 'comfortable' : d;
}

/** `camelCase` token → `--kebab-case` CSS custom property. */
export function cssVarName(token: string): string {
  return `--${token.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;
}

/** The CSS custom properties applyTheme writes for a resolved theme. */
export function themeCssVars(r: ResolvedTheme): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.colors)) out[cssVarName(k)] = v;
  const t = r.terminal;
  out['--terminal-background'] = t.background;
  out['--terminal-foreground'] = t.foreground;
  out['--terminal-cursor'] = t.cursor;
  out['--terminal-cursor-accent'] = t.cursorAccent;
  out['--terminal-selection'] = t.selection;
  for (const [name, v] of Object.entries(r.labels)) out[`--label-${name}`] = v;
  for (const [name, v] of Object.entries(r.agents)) out[`--agent-${name}`] = v;
  // Text on a solid waiting fill (the "Needs you" badge, the ! in the waiting symbol).
  out['--state-waiting-foreground'] = textOn(r.colors.stateWaiting, '#000000', '#ffffff');
  const l = r.layout;
  if (l.fontHeading) out['--font-heading'] = l.fontHeading;
  if (l.composerRadius) out['--composer-radius'] = l.composerRadius;
  if (l.outerGap) out['--outer-gap'] = l.outerGap;
  if (l.spineRowHeight) out['--spine-row-height'] = l.spineRowHeight;
  return out;
}
