# bizzi — theming (draft 1)

Companion to [spec.md](spec.md) §11. bizzi adopts the theme model from Chorus (an Apache-2.0 agentic development environment), which in turn descends from Terax (`crynta/terax-ai`). Reviewed 2026-11-09.

## 1. Provenance and license

- Chorus and Terax are both Apache-2.0. Cobalt2 (Wes Bos) is MIT: keep its copyright notice in `NOTICE`. bizzi can reuse the theme model, the converter and the theme definitions with attribution: keep each theme's `author`, and add a `NOTICE` entry naming both projects.
- **base16 schemes** each carry their author's license (mostly MIT, from the tinted-theming ecosystem). Record the license per scheme when vendoring them.
- **flax** (`neckbeard-io/flax`, the user's own Flutter music player) is GPL-3.0 with a single contributor. The palettes are the user's to reuse under bizzi's Apache-2.0 license. The color values are mostly the canonical public palettes (Dracula, Nord, Catppuccin, Gruvbox).
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
  ansi: [16 colors: black red green yellow blue magenta cyan white, then the bright ones] }>;

type LayoutTokens = Partial<{
  panelStyle: 'floating-island' | 'flush-ide' | 'minimal-split';
  density: 'compact' | 'comfortable' | 'spacious';
  fontHeading, composerRadius, outerGap, spineRowHeight }>;
```

- **Mode stays separate from the theme.** The user picks a theme and a mode (`system` / `light` / `dark`, today's `useTheme`). A theme without the requested variant falls back to its other variant. The theme (and density) is one user-wide choice; the mode is per device (§5, Storage).
- `applyTheme` writes tokens as CSS custom properties on `:root`, clearing the previous theme's first, so switching never leaves stale values.

## 3. bizzi's extra tokens

bizzi's UI (`packages/ui/src/index.css`) has tokens Chorus doesn't: status colors (`ok`, `warn`, `err`, `info`), code background, diff colors (`add`, `del`, `hunk`), and the agent state colors of the sidebar marks (spec §11.1: waiting, working, done-unseen, failed, idle). Plan:

1. Rename bizzi's tokens to Chorus's names where they're the same idea (`bg` → `background`, `panel` → `card`, `fg` → `foreground`, `accent` → `primary`, …), so themes from Chorus and Terax drop in unchanged.
2. Add bizzi-only optional tokens: `ok`, `warn`, `err`, `info`, `code`, `diffAdd`, `diffAddForeground`, `diffDel`, `diffDelForeground`, `diffHunk`, `primarySoft` (tinted primary fill), `primaryText` (accent-colored text: links, accent badges, selected labels), plus `stateWaiting`, `stateWorking`, `stateDone`, `stateFailed`, `stateIdle`.
3. **Derive what a theme leaves out.** Status and diff colors come from the theme's ANSI palette (red, yellow, green, blue), which every theme with a terminal palette has. Failing that, they come from bizzi's defaults. State colors derive from the status colors (waiting = warn, failed = err, done = info, working = primary, idle = muted foreground). `primaryText` is the primary nudged toward the foreground until it reads at 4.5:1 on the page, the card, the sidebar and `primarySoft`; it equals the primary whenever the primary already passes. A primary can be a fine fill and still too faint as text on its own soft tint: Dracula's `#bd93f9` was 3.5:1 there.

**Identity colors** (spec §11.1, built 2026-11-25) aren't theme tokens. `resolveTheme` derives `labels` for every theme from `DEFAULT_LABELS` (one set of eight inks per polarity), nudging each one toward the foreground until it reaches 3:1 on `sidebar`, `card` and `background`. They're written as `--label-<name>`. A theme file can't set them, so a theme can't make two machines look alike.

**Color carries state** (spec §11.1), so state colors must stay readable and distinct in every theme: at least 3:1 against `sidebar` and `card`, and the five clearly distinguishable from each other. When a derived set fails, bizzi's defaults for those tokens are used instead.

## 4. Built-in themes

**bizzi Default:** today's palette (indigo accent, neutral grays), light and dark.

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
| Graphite | neutral cool grays, periwinkle primary |
| Paper | warm light sheet |
| Teletype | terminal-native charcoal, amber primary |
| Abyss | deep navy, cyan primary, violet selection |
| Ink & Bone | warm charcoal, monochrome primary, so only status carries color |
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
- **Dracula, Evergreen and Synthwave** come from flax. flax's Dracula is the only one with a light variant; the base16 Dracula is dark only, so it's dropped in favor of flax's.
- **Device** (also from flax): follows the platform accent color, from Electron's `systemPreferences.getAccentColor()` on macOS and Windows and Material You dynamic color on Android. Elsewhere it falls back to bizzi Default.

**Cobalt2** (Wes Bos, `wesbos/cobalt2-vscode`, MIT; dark only). Its colors come from the VS Code theme, not the base24 port (`tinted-theming/schemes` `base24/cobalt2.yaml`, which swaps the blue-grays for plain grays):

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

**base16 catalog** (16 schemes from Chorus, converted at load; its Dracula is replaced by flax's): Ayu Dark, Ayu Light, Catppuccin Latte, Everforest, GitHub, Gruvbox Light Hard, Kanagawa, Material Palenight, Monokai, One Light, OneDark, PaperColor Light, Solarized Dark, Solarized Light, Tomorrow Night, Twilight.

**Not yet:** Chorus's layout presets (Compact IDE Grid, Triad Cockpit, Carbon Glass, Monochrome Capsule). They depend on panel styles bizzi doesn't have (§7).

## 5. Import and custom themes

- **base16 / base24:** `.yaml` or `.json` schemes from the tinted-theming ecosystem. A scheme's 16 colors have fixed meanings, enough to derive both the UI palette and the ANSI palette. **One converter** serves built-ins and imports (Chorus's rule): the shipped base16 themes go through the same code as an imported file, so a converter bug shows up in the built-ins first. Keep Chorus's YAML gotcha handling: an inline comment after a value (`base00: "#eff1f5" # base`).
- **Five-tone palettes** (flax's model): background, foreground, primary, secondary and tertiary per variant, with everything else derived:
  - surfaces step from background toward foreground (`card` about 6%, raised surfaces 9–13%, `border` about 20%, `mutedForeground` about 72%);
  - accent containers mix background with the accent (32% dark, 20% light);
  - text on an accent is near-black or white by luminance.

  This is the quickest way to author a theme: five colors, and validation (§6) catches the rest.
- **Native files:** `.bizzi-theme` (JSON, the model in §2, with a JSON Schema). bizzi also reads `.chorus-theme` files, which use the same shape, so Chorus users bring their themes along.
- **VS Code themes** (`colors` + `tokenColors` JSON): not supported by Chorus. A later converter could map `editor.background`, `sideBar.*`, `terminal.ansi*` and friends onto §2.
- **Creating a theme:** "Create" starts from the current theme. Theme files are plain JSON with a schema, and the themes directory has an `AGENTS.md`, so "make me a theme like Nord but warmer" is a request to your agent (as with widgets, [usage.md](usage.md) §4).
- **Storage:** custom themes live on the hub, so every device sees them. The **selected theme and the density** are one user-wide setting, `UserPrefs { themeId?, density? }`, stored on the server the client is connected to (the hub, shared by every device; a node in local mode keeps its own) and read and written with `prefs.get` / `prefs.set`. `prefs.set` merges and emits a global `prefs.updated`, so a change on one device repaints the others live. In the client, localStorage is only a cache for first paint and offline use: on connect the server's value wins; a change made offline is pushed on the next connect; a server with no prefs yet (fresh, or upgraded from per-device themes) is seeded with this device's choice. Servers without `prefs.*` answer `unsupported` and the choice stays on the device. The **mode** (`system` default / `light` / `dark`) stays per device in localStorage: the phone may run light while the desktop runs dark. A URL `?theme=` override is never saved or synced.

## 6. Validation

From Chorus's `validateTheme`, applied to built-ins in tests and to imports at load:

- foreground on background at least 4.5:1, and muted foreground at least 4.5:1 on the raised surfaces (`card`, `sidebar`). Light themes fail here most often.
- destructive readable on background.
- **every fill carries readable text**, at 4.5:1: `primaryForeground` on `primary` (buttons), `sidebarPrimaryForeground` on `sidebarPrimary`, `primaryText` on `primarySoft` and on `card` (accent badges), and the foreground of each surface pair (`secondary`, `accent`, `sidebarAccent`, `popover`). The base16 converter steps a scheme's `base02` back toward the card when it's too close to the text (Solarized).
- **Utilities must win over element CSS.** Unlayered CSS beats every `@layer`, so element resets in `index.css` (`button`, `input`, `body`, `:focus-visible`) live in `@layer base`. An unlayered `button { color: inherit }` once overrode `text-accent-fg` on every button: Tokyo Night's primary equals its foreground, so primary buttons went blank. A test fails on any unlayered element rule.
- **Invariant safety tokens:** approval prompts, permission-mode badges (e.g. bypass permissions) and destructive confirmations use fixed high-contrast tokens that no theme can override. A theme must never be able to camouflage "this agent can run anything".
- An import that fails gets a list of failures and stays usable as a preview, but isn't applied until fixed.

## 7. Layout tokens

- **`density` first.** Compact, comfortable or spacious changes row heights and padding. The phone enforces at least comfortable for hit targets (44 px, spec §11.1) whatever the theme says.
- **`panelStyle` later** (floating islands, a flush IDE grid, a minimal split). It's a layout system, not a palette, and it waits on the desktop layout settling.
- Radii, gaps and heading font apply as soon as they're defined.

## 8. Terminal, editor and surfaces

- **Terminal:** xterm.js gets the theme's terminal palette (background, foreground, cursor, selection and the 16 ANSI colors). When a theme has none, they're derived from its UI colors. This applies to terminal-mode sessions and login PTYs alike.
- **Syntax highlighting:** `editorTheme` picks the highlight theme for code blocks and diffs, per variant.
- **Phone:** the Capacitor status bar and the browser `theme-color` follow the theme's background.
- **Desktop title bar.** The native title bar follows the OS appearance, so a dark theme used to get a gray strip on top. bizzi hides it and paints its own strip, the title bar's height, at the top of each column: `sidebar` over the sidebar and `card` over the main column, so it runs into the page header below. The strip drags the window (`app-drag`); dialogs, menus and the sidebar resize handle opt out (`no-drag`). The connect and connecting screens get a transparent strip, so the window can be dragged before there's a connection. Code: `apps/desktop/src/shared/chrome.ts`, `TitleBarStrip` in `packages/ui/src/components/layout.tsx`.
  - **macOS:** `titleBarStyle: 'hidden'` (28 px). The traffic lights keep their standard place, over the sidebar strip's left end.
  - **Windows and Linux:** `titleBarStyle: 'hidden'` with `titleBarOverlay` (32 px), so the OS still draws the window controls, at the main strip's right end. Their color (`card`) and symbol color (`foreground`) follow the theme live via `win.setTitleBarOverlay()`.
  - **Wiring:** `applyTheme` calls `window.bizzi.setChrome({ background, card, sidebar, foreground, dark })`, flattened to `#rrggbb`. Main accepts it only from the app's own frame and only as four `#rrggbb` colors and a boolean. It sets the overlay and `win.setBackgroundColor()` (no white flash on resize or reload), and saves the colors in `chrome.json` in the profile, so the next launch's first frame already matches.
  - **Not `nativeTheme.themeSource`:** forcing it to the theme's light/dark would also force `prefers-color-scheme` in the page, and the UI's `system` mode reads that, so the mode could never follow the OS again. Native menus and context menus follow the OS appearance.
  - **Opt out:** `BIZZI_NATIVE_TITLEBAR=1` keeps the native title bar (no strip).
  - **Known gap:** in macOS full screen the traffic lights hide, but the 28 px strip stays.
  - **Browsers and phones:** nothing extra. The browser `theme-color` and the Capacitor status bar already follow the background.
- **Later, desktop only:** Chorus's background image layer. It pauses during window resize and while hidden, which keeps it within the performance guardrails (tech-choices D0b).

## 9. Phasing

With the M2 desktop and phone shells:

1. the token rename (§3);
2. the model and `applyTheme`;
3. the built-ins and base16 import;
4. validation;
5. density;
6. the themed desktop title bar (§8, done).

Later: `panelStyle`, VS Code import, background images.
