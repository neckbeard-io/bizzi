import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BizziClient } from '@bizzi/client';
import { BizziError } from '@bizzi/protocol';
import {
  BASE16_THEMES,
  BUILTIN_CATALOG,
  BUILTIN_THEMES,
  DEFAULT_COLORS,
  SAFETY,
  STATE_KEYS,
  STATE_MIN_CONTRAST,
  base16ToTheme,
  bizziDefault,
  builtinTheme,
  checkStateColors,
  contrast,
  cssVarName,
  deltaE,
  deriveFromTones,
  deviceTheme,
  effectiveDensity,
  fiveToneTheme,
  mix,
  normalizeAccent,
  parseBase16Scheme,
  parseColor,
  parseThemeFile,
  resolveTheme,
  serializeTheme,
  simulateCvd,
  textOn,
  themeCssVars,
  themeFromCurrent,
  validateTheme,
} from '../src/lib/theme/index.ts';
import type { ColorVision, StateKey, Theme } from '../src/lib/theme/index.ts';
import { BASE16_SCHEMES } from '../src/lib/theme/builtins/base16-schemes.ts';
import { FLAX_OVERLAP } from '../src/lib/theme/builtins/flax.ts';
import { scalar } from '../src/lib/theme/base16.ts';
import { isUnsupported, readThemeFiles } from '../src/lib/theme/custom.ts';
import { chromeColors } from '../src/lib/theme/apply.ts';
import { xtermTheme } from '../src/lib/theme/terminal.ts';
import { MockCore, createMockSocketFactory } from '../src/mock/mockServer.ts';

// ---------------------------------------------------------------- color

test('parseColor reads hex, short hex, alpha hex and rgb()/rgba()', () => {
  assert.deepEqual(parseColor('#abc'), { r: 0xaa, g: 0xbb, b: 0xcc, a: 1 });
  assert.deepEqual(parseColor('#112233'), { r: 0x11, g: 0x22, b: 0x33, a: 1 });
  assert.equal(parseColor('#11223380')!.a.toFixed(2), '0.50');
  assert.deepEqual(parseColor('rgba(255,255,255,0.08)'), { r: 255, g: 255, b: 255, a: 0.08 });
  assert.deepEqual(parseColor('rgb(10 20 30 / 50%)'), { r: 10, g: 20, b: 30, a: 0.5 });
  assert.equal(parseColor('teal'), null);
  assert.equal(parseColor('#12345'), null);
});

test('contrast and mix follow WCAG', () => {
  assert.equal(contrast('#000000', '#ffffff').toFixed(1), '21.0');
  assert.equal(contrast('#ffffff', '#ffffff'), 1);
  assert.equal(mix('#000000', '#ffffff', 0.5), '#808080');
  // A translucent foreground is composited over the background it sits on.
  assert.ok(contrast('rgba(255,255,255,0.08)', '#1a1b26') < 1.5);
  assert.ok(deltaE('#ff0000', '#00ff00') > 50);
  assert.ok(deltaE('#4f46e5', '#4f46e6') < 1);
});

// ---------------------------------------------------------------- base16

const LATTE_YAML = `system: "base16"
name: "Catppuccin Latte"
author: "https://github.com/catppuccin/catppuccin"
variant: "light"
palette:
  base00: "#eff1f5" # base
  base01: "#e6e9ef" # mantle
  base02: "#ccd0da" # surface0
  base03: "#bcc0cc" # surface1
  base04: "#acb0be" # surface2
  base05: "#4c4f69" # text
  base06: "#dc8a78" # rosewater
  base07: "#7287fd" # lavender
  base08: "#d20f39" # red
  base09: "#fe640b" # peach
  base0A: "#df8e1d" # yellow
  base0B: "#40a02b" # green
  base0C: "#179299" # teal
  base0D: "#1e66f5" # blue
  base0E: "#8839ef" # mauve
  base0F: "#dd7878" # flamingo
`;

test('YAML scalars: inline comments after quoted and unquoted values, bare #hex kept', () => {
  assert.equal(scalar('"#eff1f5" # base'), '#eff1f5');
  assert.equal(scalar("'#eff1f5' # base"), '#eff1f5');
  assert.equal(scalar('eff1f5 # base'), 'eff1f5');
  assert.equal(scalar('#eff1f5'), '#eff1f5');
});

test('base16 YAML with inline comments parses (the Chorus gotcha)', () => {
  const s = parseBase16Scheme(LATTE_YAML);
  assert.ok(s);
  assert.equal(s.name, 'Catppuccin Latte');
  assert.equal(s.variant, 'light');
  assert.equal(s.palette.base00, '#eff1f5');
  assert.equal(s.palette.base0d, '#1e66f5');
});

test('base16: legacy top-level keys, unquoted values, JSON, and variant inference', () => {
  const legacy = ['scheme: "Old Dark"', 'author: someone', ...Array.from({ length: 16 }, (_, i) => `base0${i.toString(16).toUpperCase()}: ${i < 8 ? '1' : 'c'}${i.toString(16)}${i.toString(16)}111`)].join('\n');
  const s = parseBase16Scheme(legacy);
  assert.ok(s);
  assert.equal(s.name, 'Old Dark');
  assert.equal(s.variant, 'dark');
  const json = JSON.stringify({ name: 'J', palette: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`base0${i.toString(16)}`, i === 0 ? 'ffffff' : '#333333'])) });
  const j = parseBase16Scheme(json);
  assert.ok(j);
  assert.equal(j.variant, 'light');
  assert.equal(parseBase16Scheme(LATTE_YAML.replace(/ {2}base0F.*\n/, '')), null, 'a missing base color rejects the scheme');
  assert.equal(parseBase16Scheme('not: a scheme'), null);
});

test('one converter: an imported scheme file gives exactly the built-in theme', () => {
  const imported = parseThemeFile(LATTE_YAML, 'latte.yaml');
  assert.equal(imported.format, 'base16');
  assert.ok(imported.ok, imported.failures.join('; '));
  const builtin = BASE16_THEMES.find((t) => t.id === 'catppuccin-latte')!;
  const { license: _l, ...expected } = builtin;
  const { author: _a, ...got } = imported.theme!;
  const { author: _b, ...exp } = expected;
  assert.deepEqual(got, exp);
});

test('base16 converter picks readable foregrounds and fills a 16-color terminal', () => {
  for (const scheme of BASE16_SCHEMES) {
    const theme = base16ToTheme(scheme);
    const v = theme.variants[scheme.variant]!;
    assert.equal(v.terminal?.ansi?.length, 16, scheme.name);
    assert.ok(contrast(v.colors!.foreground!, v.colors!.background!) >= 4.5, scheme.name);
  }
  assert.equal(BASE16_SCHEMES.length, 16);
  assert.ok(!BASE16_SCHEMES.some((s) => s.name === 'Dracula'), 'base16 Dracula is replaced by flax');
  assert.ok(BASE16_SCHEMES.every((s) => s.author && s.license), 'each scheme records author and license');
});

// ---------------------------------------------------------------- five-tone

test('five-tone derivation: surface steps, containers, text on accents', () => {
  const d = deriveFromTones({ background: '#000000', foreground: '#ffffff', primary: '#ffffff' });
  assert.equal(d.card, mix('#000000', '#ffffff', 0.06));
  assert.equal(d.border, mix('#000000', '#ffffff', 0.2));
  assert.equal(d.mutedForeground, mix('#000000', '#ffffff', 0.72));
  assert.equal(d.sidebarAccent, mix('#000000', '#ffffff', 0.32), '32% on dark');
  const light = deriveFromTones({ background: '#ffffff', foreground: '#000000', primary: '#000000' });
  assert.equal(light.sidebarAccent, mix('#ffffff', '#000000', 0.2), '20% on light');
  assert.equal(deriveFromTones({ background: '#fff', foreground: '#000', primary: '#ffd319' }).primaryForeground, '#111111');
  assert.equal(deriveFromTones({ background: '#fff', foreground: '#000', primary: '#3b1a99' }).primaryForeground, '#ffffff');
});

test('five-tone themes carry secondary/tertiary into the terminal palette', () => {
  const t = fiveToneTheme({ id: 'x-test', name: 'X' }, { dark: { background: '#101010', foreground: '#eeeeee', primary: '#ff8800', secondary: '#aa00ff', tertiary: '#00ccaa' } });
  const ansi = t.variants.dark!.terminal!.ansi!;
  assert.equal(ansi[5], '#aa00ff');
  assert.equal(ansi[6], '#00ccaa');
});

test("Chorus's Nord/Catppuccin/Gruvbox accents agree with one of flax's accent tones", () => {
  // Nord and Catppuccin share flax's primary; Chorus's Gruvbox leads with yellow, flax's secondary.
  for (const [id, tones] of Object.entries(FLAX_OVERLAP)) {
    const t = builtinTheme(id)!;
    for (const mode of ['light', 'dark'] as const) {
      const ours = t.variants[mode]!.colors!.primary!;
      const { primary, secondary, tertiary } = tones[mode];
      const nearest = Math.min(...[primary, secondary, tertiary].map((c) => deltaE(ours, c)));
      assert.ok(nearest < 15, `${id} ${mode}: ${ours} vs flax ${primary}/${secondary}/${tertiary}`);
    }
  }
});

// ---------------------------------------------------------------- resolve

test('a theme without the requested variant falls back to the other one', () => {
  const cobalt = builtinTheme('cobalt2')!;
  const r = resolveTheme(cobalt, 'light');
  assert.equal(r.variant, 'dark');
  assert.equal(r.dark, true);
  assert.equal(r.colors.background, '#193549');
  assert.equal(r.colors.popover, '#122738', 'popover follows card');
});

test("status colors derive from the ANSI palette; state colors stay bizzi's", () => {
  const theme: Theme = {
    id: 'ansi-test',
    name: 'ANSI',
    variants: {
      dark: {
        colors: { background: '#101014', foreground: '#e8e8ee', card: '#16161c', sidebar: '#16161c', primary: '#c792ea' },
        terminal: { ansi: ['#000000', '#ff5f5f', '#5fd75f', '#ffd75f', '#5fafff', '#d787ff', '#5fd7d7', '#dddddd', '#555555', '#ff8787', '#87ff87', '#ffff87', '#87d7ff', '#ffafff', '#87ffff', '#ffffff'] },
      },
    },
  };
  const r = resolveTheme(theme, 'dark');
  assert.equal(r.colors.err, '#ff5f5f');
  assert.equal(r.colors.ok, '#5fd75f');
  assert.equal(r.colors.warn, '#ffd75f');
  assert.equal(r.colors.info, '#5fafff');
  // State colors aren't derived from the theme's status colors or primary (a pink primary as "working" is what
  // colorblind users couldn't tell from a blue "done"): a theme that doesn't set them gets bizzi's set.
  for (const k of STATE_KEYS) assert.equal(r.colors[k], DEFAULT_COLORS.dark[k], k);
  assert.notEqual(r.colors.stateWorking, r.colors.primary);
  assert.deepEqual(r.notes, []);
});

test("a theme's own state colors win; ones that collide fall back to bizzi defaults for those tokens", () => {
  const theme: Theme = {
    id: 'own-states',
    name: 'Own',
    variants: { dark: { colors: { background: '#101014', foreground: '#e8e8ee', card: '#16161c', sidebar: '#16161c', stateWorking: '#ff66cc', stateDone: '#ff66cc', stateWaiting: '#ffaa00' } } },
  };
  const r = resolveTheme(theme, 'dark');
  assert.equal(r.colors.stateWaiting, '#ffaa00');
  assert.equal(r.colors.stateWorking, '#ff66cc');
  assert.equal(r.colors.stateDone, DEFAULT_COLORS.dark.stateDone);
  assert.match(r.notes.join(' '), /done/);
});

/** After simulating full protanopia / deuteranopia / tritanopia, state colors must still read as different colors. */
const CVD_MIN_DISTANCE = 18;

test('bizzi default state colors stay distinct under color blindness, in both modes', () => {
  for (const mode of ['light', 'dark'] as const) {
    const D = DEFAULT_COLORS[mode];
    for (const k of STATE_KEYS) {
      assert.ok(contrast(D[k], D.sidebar) >= STATE_MIN_CONTRAST, `${mode} ${k} on sidebar`);
      assert.ok(contrast(D[k], D.card) >= STATE_MIN_CONTRAST, `${mode} ${k} on card`);
    }
    for (const vision of ['protanopia', 'deuteranopia', 'tritanopia'] as ColorVision[]) {
      for (let i = 0; i < STATE_KEYS.length; i++) {
        for (let j = i + 1; j < STATE_KEYS.length; j++) {
          const a: StateKey = STATE_KEYS[i]!;
          const b: StateKey = STATE_KEYS[j]!;
          const d = deltaE(simulateCvd(D[a], vision), simulateCvd(D[b], vision));
          assert.ok(d >= CVD_MIN_DISTANCE, `${mode} ${vision}: ${a} and ${b} are ΔE ${d.toFixed(1)} apart`);
        }
      }
    }
  }
  // The simulation itself: gray is unchanged, and red and green collapse for deuteranopes.
  assert.equal(simulateCvd('#808080', 'deuteranopia'), '#808080');
  assert.ok(deltaE(simulateCvd('#d03030', 'deuteranopia'), simulateCvd('#30a030', 'deuteranopia')) < deltaE('#d03030', '#30a030') / 2);
});

test('the waiting badge text reads on the waiting color', () => {
  for (const t of BUILTIN_THEMES) {
    for (const mode of ['light', 'dark'] as const) {
      const r = resolveTheme(t, mode);
      const vars = themeCssVars(r);
      assert.equal(vars['--state-waiting-foreground'], textOn(r.colors.stateWaiting, '#000000', '#ffffff'));
      assert.ok(contrast(vars['--state-waiting-foreground']!, r.colors.stateWaiting) >= 4.5, `${t.id} ${mode}`);
    }
  }
});

test('state colors of every built-in are readable and distinct in both modes', () => {
  for (const t of BUILTIN_THEMES) {
    for (const mode of ['light', 'dark'] as const) {
      const r = resolveTheme(t, mode);
      const states = Object.fromEntries(STATE_KEYS.map((k) => [k, r.colors[k]])) as Record<(typeof STATE_KEYS)[number], string>;
      assert.deepEqual(checkStateColors(states, { sidebar: r.colors.sidebar, card: r.colors.card }), [], `${t.id} ${mode}`);
    }
  }
});

test('a hostile sidebar still gets readable state colors (nudged defaults)', () => {
  const theme: Theme = { id: 'odd-one', name: 'Odd', variants: { light: { colors: { background: '#ffffff', foreground: '#000000', sidebar: '#808080', card: '#7a7a7a' } } } };
  const r = resolveTheme(theme, 'light');
  for (const k of STATE_KEYS) assert.ok(contrast(r.colors[k], r.colors.sidebar) >= 3 && contrast(r.colors[k], r.colors.card) >= 3, k);
});

test('the terminal palette is derived when a theme has none', () => {
  const r = resolveTheme(builtinTheme('paper')!, 'light');
  assert.equal(r.terminal.ansi.length, 16);
  assert.equal(r.terminal.background, '#fcfbf8', "paper's own terminal background");
  assert.equal(r.terminal.ansi[1], r.colors.err);
  const x = xtermTheme(r.terminal);
  assert.equal(x.red, r.colors.err);
  assert.equal(x.brightWhite, r.terminal.ansi[15]);
  assert.equal(x.selectionBackground, r.terminal.selection);
});

test('density: theme default, explicit choice, phones at least comfortable', () => {
  assert.equal(effectiveDensity('theme', undefined, false), 'comfortable');
  assert.equal(effectiveDensity('theme', 'compact', false), 'compact');
  assert.equal(effectiveDensity('compact', 'spacious', true), 'comfortable');
  assert.equal(effectiveDensity('spacious', undefined, true), 'spacious');
});

test('CSS variables use shadcn names and never include the safety tokens', () => {
  assert.equal(cssVarName('sidebarPrimaryForeground'), '--sidebar-primary-foreground');
  assert.equal(cssVarName('stateWaiting'), '--state-waiting');
  for (const t of BUILTIN_THEMES) {
    const vars = themeCssVars(resolveTheme(t, 'dark'));
    assert.ok(!Object.keys(vars).some((k) => k.startsWith('--safety')), t.id);
    assert.ok(vars['--background'] && vars['--card'] && vars['--primary'] && vars['--muted-foreground']);
  }
});

// ---------------------------------------------------------------- validation

test('every built-in passes validation', () => {
  assert.ok(BUILTIN_CATALOG.length >= 35);
  for (const t of BUILTIN_THEMES) {
    const v = validateTheme(t);
    assert.ok(v.ok, `${t.id}: ${v.failures.join('; ')}`);
  }
});

test('the shipped set: no Chorus Default; the listed themes are present', () => {
  const ids = new Set(BUILTIN_THEMES.map((t) => t.id));
  assert.ok(!ids.has('chorus-default'));
  for (const id of ['bizzi-default', 'device', 'tokyo-night', 'nord', 'catppuccin', 'gruvbox', 'rose-pine', 'tide', 'sage', 'caffeine', 'graphite', 'paper', 'teletype', 'abyss', 'ink-bone', 'warm-paper-clay', 'evergreen', 'dracula', 'synthwave', 'cobalt2']) {
    assert.ok(ids.has(id), id);
  }
  assert.ok(BUILTIN_THEMES.every((t) => t.author), 'every built-in names its author');
});

test('validation lists every failure and keeps a usable theme for preview', () => {
  const v = validateTheme({
    id: 'Bad Id',
    name: 'Low contrast',
    variants: {
      light: {
        colors: { background: '#ffffff', foreground: '#dddddd', mutedForeground: '#eeeeee', destructive: '#ffeeee', bogus: '#000000', primary: 'blue' },
        terminal: { ansi: ['#000000'] },
      },
    },
  });
  assert.equal(v.ok, false);
  assert.ok(v.theme, 'shape is usable, so it can be previewed');
  const all = v.failures.join('\n');
  for (const needle of ['id must be kebab-case', 'bogus is not a color token', 'primary must be a color', 'ansi must be an array of 16', 'foreground on background', 'muted foreground on card', 'destructive on background']) {
    assert.ok(all.includes(needle), `missing failure: ${needle}\n${all}`);
  }
  assert.equal(validateTheme({ id: 'x-y', name: 'n', variants: {} }).theme, null);
  assert.equal(validateTheme('nope').ok, false);
});

test("a theme's own state colors must pass; safety tokens can't be themed", () => {
  const base = structuredClone(bizziDefault);
  base.id = 'state-test';
  base.variants.light!.colors!.stateWaiting = '#fefefe';
  base.variants.light!.colors!.stateFailed = base.variants.light!.colors!.stateWorking;
  const v = validateTheme(base);
  assert.equal(v.ok, false);
  assert.match(v.failures.join('\n'), /waiting state color is .* on card/);
  assert.match(v.failures.join('\n'), /too similar/);
  const s = validateTheme({ id: 'sneaky', name: 'Sneaky', variants: { dark: { colors: { safetyWarn: '#000000' } } } });
  assert.match(s.failures.join('\n'), /safetyWarn is not a color token/);
});

test('the invariant safety pairs are high contrast and match index.css', () => {
  assert.ok(contrast(SAFETY.warnForeground, SAFETY.warn) >= 7);
  assert.ok(contrast(SAFETY.dangerForeground, SAFETY.danger) >= 4.5);
  const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
  assert.ok(css.includes(`--safety-warn: ${SAFETY.warn};`));
  assert.ok(css.includes(`--safety-danger: ${SAFETY.danger};`));
});

test('index.css paints bizzi Default exactly (defaults.ts and the stylesheet agree)', () => {
  const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
  const block = (selector: string) => {
    const start = css.indexOf(`${selector} {`);
    return css.slice(start, css.indexOf('}', start));
  };
  for (const [mode, sel] of [
    ['light', ':root'],
    ['dark', "[data-theme='dark']"],
  ] as const) {
    const b = block(sel);
    for (const [k, v] of Object.entries(DEFAULT_COLORS[mode])) assert.ok(b.includes(`${cssVarName(k)}: ${v};`), `${mode} ${k}`);
  }
});

test('index.css element rules sit in a layer, so utilities still color buttons and inputs', () => {
  // Unlayered CSS beats every @layer: an unlayered `button { color: inherit }` hid the primary button
  // text in Tokyo Night (text-accent-fg lost to the inherited foreground, which equals its primary).
  const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  // Top-level selectors only: anything nested in `@layer … { }` (or another at-rule) is skipped.
  let depth = 0;
  let selector = '';
  for (const ch of css) {
    if (ch === '{') {
      const sel = selector.trim();
      if (depth === 0 && !sel.startsWith('@')) assert.doesNotMatch(sel, /^(html|body|button|select|input|textarea|:focus)|[\s,]+(button|select|input|textarea)\b/, `unlayered element rule: ${sel}`);
      depth++;
      selector = '';
    } else if (ch === '}') {
      depth--;
      selector = '';
    } else if (ch === ';') {
      selector = '';
    } else {
      selector += ch;
    }
  }
});

test('desktop chrome colors: opaque #rrggbb from the resolved theme, translucent ones flattened', () => {
  const r = resolveTheme(builtinTheme('tokyo-night')!, 'dark');
  assert.deepEqual(chromeColors(r), { background: '#1a1b26', card: '#1f2030', sidebar: '#1f2030', foreground: '#c0caf5', dark: true });
  const glass = resolveTheme({ id: 'glass', name: 'Glass', variants: { light: { colors: { background: '#ffffff', card: 'rgba(0,0,0,0.5)' } } } }, 'light');
  assert.equal(chromeColors(glass).card, '#808080');
  for (const t of BUILTIN_THEMES) for (const mode of ['light', 'dark'] as const) {
    const c = chromeColors(resolveTheme(t, mode));
    for (const v of [c.background, c.card, c.sidebar, c.foreground]) assert.match(v, /^#[0-9a-f]{6}$/, `${t.id} ${mode}`);
  }
});

// ---------------------------------------------------------------- files

test('import: .bizzi-theme and .chorus-theme JSON, failures listed for junk', () => {
  const own = parseThemeFile(serializeTheme(builtinTheme('tide')!), 'tide.bizzi-theme');
  assert.equal(own.format, 'bizzi');
  assert.ok(own.ok, own.failures.join('; '));
  assert.equal(own.theme!.name, 'Tide');
  const chorus = parseThemeFile(JSON.stringify({ ...builtinTheme('graphite')!, id: 'v10-graphite', layout: { panelStyle: 'flush-ide', defaultFocusSurface: 'terminal', density: 'compact' } }), 'g.chorus-theme');
  assert.equal(chorus.format, 'chorus');
  assert.ok(chorus.ok, chorus.failures.join('; '));
  assert.equal(chorus.theme!.layout?.density, 'compact');
  const junk = parseThemeFile('hello: world', 'x.yaml');
  assert.equal(junk.ok, false);
  assert.equal(junk.theme, null);
  assert.equal(junk.failures.length, 1);
  assert.equal(parseThemeFile('{"a":1}', 'x.json').ok, false);
});

test('the example in packages/ui/themes/ is a valid minimal theme', () => {
  const url = new URL('../themes/example-warm-nord.bizzi-theme', import.meta.url);
  const r = parseThemeFile(readFileSync(url, 'utf8'), url.pathname);
  assert.ok(r.ok, r.failures.join('; '));
  assert.equal(r.format, 'bizzi');
});

test('create from current copies the theme under a fresh id', () => {
  const t = themeFromCurrent(builtinTheme('nord')!, 'Nord', (id) => id === 'nord');
  assert.equal(t.id, 'nord-2');
  assert.equal(t.name, 'Nord');
  assert.match(t.description!, /Based on Nord by/);
  assert.ok(validateTheme(t).ok);
  assert.notEqual(t.variants, builtinTheme('nord')!.variants, 'a deep copy');
});

test('device theme: platform accent as primary, else bizzi Default', () => {
  assert.equal(normalizeAccent('0a84ffff'), '#0a84ff');
  assert.equal(normalizeAccent('#ff0000'), '#ff0000');
  assert.equal(normalizeAccent(''), null);
  assert.equal(normalizeAccent(undefined), null);
  const none = deviceTheme(null);
  assert.deepEqual(none.variants, bizziDefault.variants);
  const pink = deviceTheme('#ff2d55');
  for (const mode of ['light', 'dark'] as const) {
    const r = resolveTheme(pink, mode);
    assert.ok(contrast(r.colors.primary, r.colors.card) >= 3, mode);
    assert.ok(validateTheme(pink).ok);
  }
  // The accent never becomes a state color (it could sit too close to another state for colorblind users).
  assert.equal(resolveTheme(pink, 'dark').colors.stateWorking, DEFAULT_COLORS.dark.stateWorking);
  // A pale accent gets darkened for the light variant.
  assert.notEqual(resolveTheme(deviceTheme('#ffe066'), 'light').colors.primary, '#ffe066');
});

// ---------------------------------------------------------------- custom themes

test('custom theme files: hub ids in any format, invalid ones kept for preview', () => {
  const [good, bad] = readThemeFiles([
    { id: 'th_01HX', name: 'Mine', data: builtinTheme('sage'), updatedAt: '2026-11-01T00:00:00Z' },
    { id: 'broken', name: 'Broken', data: { variants: { dark: { colors: { background: '#000', foreground: '#111' } } } }, updatedAt: '2026-11-01T00:00:00Z' },
  ]);
  assert.ok(good!.ok, good!.failures.join('; '));
  assert.equal(good!.theme!.id, 'th_01HX');
  assert.equal(good!.theme!.name, 'Mine');
  assert.equal(bad!.ok, false);
  assert.ok(bad!.theme);
  assert.ok(isUnsupported(new BizziError('unsupported', 'x')));
  assert.ok(!isUnsupported(new BizziError('internal', 'x')));
});

test('mock server stores custom themes, or answers unsupported like an old server', async (t) => {
  const connect = async (demo: string[]) => {
    const core = new MockCore({ speed: 0, autoplay: false, demo });
    const client = new BizziClient({ createSocket: createMockSocketFactory(core) });
    t.after(() => client.close());
    await client.connect('mock://local', 'demo');
    return client;
  };
  const client = await connect([]);
  const { themes } = await client.request('themes.list', {});
  assert.ok(themes.length >= 1);
  assert.ok(readThemeFiles(themes).every((c) => c.ok));
  const { theme } = await client.request('theme.save', { id: 'mine', name: 'Mine', data: builtinTheme('nord') });
  assert.equal(theme.id, 'mine');
  assert.ok((await client.request('themes.list', {})).themes.some((f) => f.id === 'mine'));
  await client.request('theme.delete', { id: 'mine' });
  assert.ok(!(await client.request('themes.list', {})).themes.some((f) => f.id === 'mine'));

  const old = await connect(['nothemes']);
  await assert.rejects(old.request('themes.list', {}), (e: unknown) => isUnsupported(e));
});
