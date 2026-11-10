# bizzi — theming (draft 1)

Companion to [spec.md](spec.md) §11. bizzi adopts the theme model from Chorus (an Apache-2.0 agentic development environment), which in turn descends from Terax (`crynta/terax-ai`). Reviewed 2026-11-09.

## 1. Provenance and licence

- Chorus and Terax are both Apache-2.0. Cobalt2 (Wes Bos) is MIT: keep its copyright notice in `NOTICE`. bizzi can reuse the theme model, the converter and the theme definitions with attribution: keep each theme's `author`, and add a `NOTICE` entry naming both projects.
- **base16 schemes** each carry their author's licence (mostly MIT, from the tinted-theming ecosystem). Record the licence per scheme when vendoring them.
- **flax** (`neckbeard-io/flax`, the user's own Flutter music player) is GPL-3.0 with a single contributor. The palettes are the user's to reuse under whatever licence bizzi ends up with (bizzi has no licence yet). The colour values are mostly the canonical public palettes (Dracula, Nord, Catppuccin, Gruvbox).
- **Don't ship Chorus's house palette** (deep teal and emerald, "Chorus Default") as bizzi's look: that's Chorus's identity, not a generic theme. bizzi keeps its own default.

## 2. Theme model (from Chorus)

These aren't VS Code theme files. A theme is semantic UI tokens (shadcn-style names), a terminal palette and layout tokens, per light/dark variant:

```ts
type Theme = {
  id: string; name: string; author?: string; description?: string;
  layout?: LayoutTokens;                       // shared by both variants unless overridden
  variants: { light?: ThemeVariant; dark?: ThemeVariant };
  editorTheme?: { light?: string; dark?: string };   // syntax-highlight theme for code blocks and diffs
};
type ThemeVariant = { colors?: ThemeColors; terminal?: TerminalPalette; layout?: LayoutTokens };

type ThemeColors = Partial<{                   // Chorus's set
  background, foreground, card, cardForeground, popover, popoverForeground,
  primary, primaryForeground, secondary, secondaryForeground, muted, mutedForeground,
  accent, accentForeground, destructive, border, input, ring,
  sidebar, sidebarForeground, sidebarPrimary, sidebarPrimaryForeground,
  sidebarAccent, sidebarAccentForeground, sidebarBorder, sidebarRing, radius }>;

type TerminalPalette = Partial<{ background, foreground, cursor, cursorAccent, selection,
  ansi: [16 colours: black red green yellow blue magenta cyan white, then the bright ones] }>;

type LayoutTokens = Partial<{
  panelStyle: 'floating-island' | 'flush-ide' | 'minimal-split';
  density: 'compact' | 'comfortable' | 'spacious';
  fontHeading, composerRadius, outerGap, spineRowHeight }>;
```

- **Mode stays separate from the theme.** The user picks a theme and a mode (`system` / `light` / `dark`, today's `useTheme`). A theme without the requested variant falls back to its other variant. The theme (and density) is one user-wide choice; the mode is per device (§5, Storage).
- `applyTheme` writes tokens as CSS custom properties on `:root`, clearing the previous theme's first, so switching never leaves stale values.

## 3. bizzi's extra tokens

bizzi's UI (`packages/ui/src/index.css`) has tokens Chorus doesn't: status colours (`ok`, `warn`, `err`, `info`), code background, diff colours (`add`, `del`, `hunk`), and the agent state colours of the sidebar marks (spec §11.1: waiting, working, done-unseen, failed, idle). Plan:

1. Rename bizzi's tokens to Chorus's names where they're the same idea (`bg` → `background`, `panel` → `card`, `fg` → `foreground`, `accent` → `primary`, …), so themes from Chorus and Terax drop in unchanged.
2. Add bizzi-only optional tokens: `ok`, `warn`, `err`, `info`, `code`, `diffAdd`, `diffAddForeground`, `diffDel`, `diffDelForeground`, `diffHunk`, plus `stateWaiting`, `stateWorking`, `stateDone`, `stateFailed`, `stateIdle`.
3. **Derive what a theme leaves out.** Status and diff colours come from the theme's ANSI palette (red, yellow, green, blue), which every theme with a terminal palette has. Failing that, they come from bizzi's defaults. State colours derive from the status colours (waiting = warn, failed = err, done = info, working = primary, idle = muted foreground).

**Colour carries state** (spec §11.1), so state colours must stay readable and distinct in every theme: at least 3:1 against `sidebar` and `card`, and the five clearly distinguishable from each other. When a derived set fails, bizzi's defaults for those tokens are used instead.

## 4. Built-in themes

**bizzi Default:** today's palette (indigo accent, neutral greys), light and dark.

Hand-authored, from Chorus/Terax:

| Theme | Character |
|---|---|
| Tokyo Night | calm, blue-leaning dark |
| Nord | arctic, north-bluish |
| Catppuccin | Mocha + Latte, soothing pastel |
| Gruvbox | warm, earthy retro |
| Rosé Pine | Soho vibes, pine and rose |
| Tide | deep slate with muted teal |
| Sage | muted forest green |
| Caffeine | warm coffee tones, cream and espresso |
| Graphite | neutral cool greys, periwinkle primary |
| Paper | warm light sheet |
| Teletype | terminal-native charcoal, amber primary |
| Abyss | deep navy, cyan primary, violet selection |
| Ink & Bone | warm charcoal, monochrome primary, so only status carries colour |
| Warm Paper & Clay | editorial paper, clay accent |

From flax (the user's picks; five tones per variant, converted as in §5):

| Theme | Light (bg / fg / primary / secondary / tertiary) | Dark (bg / fg / primary / secondary / tertiary) |
|---|---|---|
| Evergreen | `#F2F7F2` `#1B2A20` `#2E7D4F` `#4F7A5B` `#8A6D1F` | `#151D18` `#DDE8DF` `#6FCF97` `#A3D9A5` `#E3C27A` |
| Nord | `#ECEFF4` `#2E3440` `#4C6F9A` `#5E81AC` `#8F6A89` | `#2E3440` `#ECEFF4` `#88C0D0` `#81A1C1` `#B48EAD` |
| Catppuccin | `#EFF1F5` `#4C4F69` `#8839EF` `#EA76CB` `#7287FD` | `#1E1E2E` `#CDD6F4` `#CBA6F7` `#F5C2E7` `#B4BEFE` |
| Dracula | `#FFFBEB` `#1F1F1F` `#644AC9` `#A3144D` `#036A96` | `#282A36` `#F8F8F2` `#BD93F9` `#FF79C6` `#8BE9FD` |
| Gruvbox | `#FBF1C7` `#3C3836` `#AF3A03` `#B57614` `#427B58` | `#282828` `#EBDBB2` `#FE8019` `#FABD2F` `#8EC07C` |
| Synthwave | `#FDF4FF` `#2A1036` `#C2187A` `#00838F` `#8A6A00` | `#1A1029` `#F2E9FF` `#FF3EA5` `#2DE2E6` `#FFD319` |

- **Where flax and Chorus overlap** (Nord, Catppuccin, Gruvbox): ship one entry per name. Use Chorus's hand-authored token sets, which include terminal palettes, and check their accents agree with flax's tones.
- **Dracula, Evergreen and Synthwave** come from flax. flax's Dracula is the only one with a light variant; the base16 Dracula is dark only, so it's dropped in favour of flax's.
- **Device** (also from flax): follows the platform accent colour, from Electron's `systemPreferences.getAccentColor()` on macOS and Windows and Material You dynamic colour on Android. Elsewhere it falls back to bizzi Default.

**Cobalt2** (Wes Bos, `wesbos/cobalt2-vscode`, MIT; dark only). Its colours come from the VS Code theme, not the base24 port (`tinted-theming/schemes` `base24/cobalt2.yaml`, which swaps the blue-greys for plain greys):

| Token | Value | VS Code source |
|---|---|---|
| `background` | `#193549` | `editor.background` |
| `sidebar` | `#15232d` | `sideBar.background` |
| `card` | `#122738` | `activityBar.background` |
| `foreground` | `#ffffff` | `editor.foreground` |
| `primary` | `#ffc600` (text on it: `#193549`) | `editorCursor.foreground`, the signature yellow |
| `ring` | `#0088ff` | `button.background` |
| `border` | `#0d3a58` | `focusBorder` |
| terminal background / foreground / cursor / selection | `#122738` / `#ffffff` / `#ffc600` / `#0050A4` | `terminal.*`, `editor.selectionBackground` |
| ANSI 0–7 | `#000000` `#ff628c` `#3ad900` `#ffc600` `#0088ff` `#fb94ff` `#80fcff` `#ffffff` | `terminal.ansi*` |
| ANSI 8–15 | `#0050A4` `#ff628c` `#3ad900` `#ffc600` `#0088ff` `#fb94ff` `#80fcff` `#ffffff` | `terminal.ansiBright*` |

There's no upstream light variant, so light mode falls back to dark (§2) unless a bizzi-made "Cobalt Light" is added as a five-tone palette.

**base16 catalogue** (16 schemes from Chorus, converted at load; its Dracula is replaced by flax's): Ayu Dark, Ayu Light, Catppuccin Latte, Everforest, GitHub, Gruvbox Light Hard, Kanagawa, Material Palenight, Monokai, One Light, OneDark, PaperColor Light, Solarized Dark, Solarized Light, Tomorrow Night, Twilight.

**Not yet:** Chorus's layout presets (Compact IDE Grid, Triad Cockpit, Carbon Glass, Monochrome Capsule). They depend on panel styles bizzi doesn't have (§7).

## 5. Import and custom themes

- **base16 / base24:** `.yaml` or `.json` schemes from the tinted-theming ecosystem. A scheme's 16 colours have fixed meanings, enough to derive both the UI palette and the ANSI palette. **One converter** serves built-ins and imports (Chorus's rule): the shipped base16 themes go through the same code as an imported file, so a converter bug shows up in the built-ins first. Keep Chorus's YAML gotcha handling: an inline comment after a value (`base00: "#eff1f5" # base`).
- **Five-tone palettes** (flax's model): background, foreground, primary, secondary and tertiary per variant, with everything else derived:
  - surfaces step from background toward foreground (`card` about 6%, raised surfaces 9–13%, `border` about 20%, `mutedForeground` about 72%);
  - accent containers mix background with the accent (32% dark, 20% light);
  - text on an accent is near-black or white by luminance.

  This is the quickest way to author a theme: five colours, and validation (§6) catches the rest.
- **Native files:** `.bizzi-theme` (JSON, the model in §2, with a JSON Schema). bizzi also reads `.chorus-theme` files, which use the same shape, so Chorus users bring their themes along.
- **VS Code themes** (`colors` + `tokenColors` JSON): not supported by Chorus. A later converter could map `editor.background`, `sideBar.*`, `terminal.ansi*` and friends onto §2.
- **Creating a theme:** "Create" starts from the current theme. Theme files are plain JSON with a schema, and the themes directory has an `AGENTS.md`, so "make me a theme like Nord but warmer" is a request to your agent (as with widgets, [usage.md](usage.md) §4).
- **Storage:** custom themes live on the hub, so every device sees them. The **selected theme and the density** are one user-wide setting, `UserPrefs { themeId?, density? }`, stored on the server the client is connected to (the hub, shared by every device; a node in local mode keeps its own) and read and written with `prefs.get` / `prefs.set`. `prefs.set` merges and emits a global `prefs.updated`, so a change on one device repaints the others live. In the client, localStorage is only a cache for first paint and offline use: on connect the server's value wins; a change made offline is pushed on the next connect; a server with no prefs yet (fresh, or upgraded from per-device themes) is seeded with this device's choice. Servers without `prefs.*` answer `unsupported` and the choice stays on the device. The **mode** (`system` default / `light` / `dark`) stays per device in localStorage: the phone may run light while the desktop runs dark. A URL `?theme=` override is never saved or synced.

## 6. Validation

From Chorus's `validateTheme`, applied to built-ins in tests and to imports at load:

- foreground on background at least 4.5:1, and muted foreground at least 4.5:1 on the raised surfaces (`card`, `sidebar`). Light themes fail here most often.
- destructive readable on background.
- **Invariant safety tokens:** approval prompts, permission-mode badges (e.g. bypass permissions) and destructive confirmations use fixed high-contrast tokens that no theme can override. A theme must never be able to camouflage "this agent can run anything".
- An import that fails gets a list of failures and stays usable as a preview, but isn't applied until fixed.

## 7. Layout tokens

- **`density` first.** Compact, comfortable or spacious changes row heights and padding. The phone enforces at least comfortable for hit targets (44 px, spec §11.1) whatever the theme says.
- **`panelStyle` later** (floating islands, a flush IDE grid, a minimal split). It's a layout system, not a palette, and it waits on the desktop layout settling.
- Radii, gaps and heading font apply as soon as they're defined.

## 8. Terminal, editor and surfaces

- **Terminal:** xterm.js gets the theme's terminal palette (background, foreground, cursor, selection and the 16 ANSI colours). When a theme has none, they're derived from its UI colours. This applies to terminal-mode sessions and login PTYs alike.
- **Syntax highlighting:** `editorTheme` picks the highlight theme for code blocks and diffs, per variant.
- **Phone:** the Capacitor status bar and the browser `theme-color` follow the theme's background.
- **Later, desktop only:** Chorus's background image layer. It pauses during window resize and while hidden, which keeps it within the performance guardrails (tech-choices D0b).

## 9. Phasing

With the M2 desktop and phone shells:

1. the token rename (§3);
2. the model and `applyTheme`;
3. the built-ins and base16 import;
4. validation;
5. density.

Later: `panelStyle`, VS Code import, background images.
