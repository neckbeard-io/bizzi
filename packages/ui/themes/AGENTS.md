# Creating a bizzi theme

Guidance for agents (and people) asked for a theme, e.g. "make me a theme like Nord but warmer". The model and the rules are in `docs/theming.md`; the code is `packages/ui/src/lib/theme/`.

## The file

- A `.bizzi-theme` file is JSON in the shape of `bizzi-theme.schema.json` (next to this file). Start from `example-warm-nord.bizzi-theme`, or from Settings → Appearance → **Create from current**, which downloads the current theme as JSON.
- `id`: kebab-case, 2–64 characters, not a built-in id (`nord`, `tokyo-night`, …). `name`, `author`, `description` are free text.
- `variants.light` and/or `variants.dark`. A theme with one variant is used for both modes.
- Each variant has `colors`, optionally `terminal` (cursor, selection, 16 `ansi` colours: black red green yellow blue magenta cyan white, then the bright ones) and `layout` (`density`: compact / comfortable / spacious).
- Colours: `#rrggbb`, `#rrggbbaa`, `rgb()` or `rgba()`. Unknown keys are rejected.

## Give as little as you can

Every token is optional. The quickest theme is three colours per variant, `background`, `foreground` and `primary`; everything else is derived (surfaces step from background toward foreground, borders at about 20%, muted text at about 72%, text on the primary is near-black or white). Add tokens only to override a derived one:

- surfaces: `card`, `popover`, `secondary`, `muted` (a surface), `accent` (hover surface), `sidebar`, `border`, `input`, `ring`, and their `*Foreground` text colours;
- bizzi's own: `ok`, `warn`, `err`, `info`, `code`, `diffAdd`/`diffDel`/`diffHunk` (+ `*Foreground`), `primarySoft`, `primaryText` (accent-coloured text; usually leave it out and bizzi derives a readable one from the primary), and the agent state colours `stateWaiting`, `stateWorking`, `stateDone`, `stateFailed`, `stateIdle`.

With a terminal `ansi` palette, status and diff colours come from its red, yellow, green and blue. State colours come from the status colours (waiting = warn, failed = err, done = info, working = primary, idle = muted text). Usually leave the state colours out: if the derived ones clash, bizzi swaps in its defaults for just those.

## It has to pass validation

Imports are checked; a failing file can be previewed but not applied. The checks:

- `foreground` on `background` at least 4.5:1;
- `mutedForeground` at least 4.5:1 on `card` and on `sidebar` (light themes fail here most often: darken it);
- `destructive` at least 3:1 on `background`;
- state colours you set yourself: at least 3:1 on `sidebar` and `card`, and clearly different from each other.

Approval prompts, permission badges and destructive confirmations use fixed safety colours that no theme can change, so don't try.

## Check your work

```sh
node -e "import('./packages/ui/src/lib/theme/index.ts').then(async (m) => { const fs = await import('node:fs'); const r = m.parseThemeFile(fs.readFileSync(process.argv[1], 'utf8'), process.argv[1]); console.log(r.ok ? 'ok' : r.failures.join('\n')); })" path/to/my.bizzi-theme
```

Then Settings → Appearance → **Import**. Saved themes are stored on the hub, so every device sees them; the choice of theme and mode stays per device.

## base16 schemes

A base16 or base24 scheme (`.yaml` or `.json` from the tinted-theming ecosystem) imports as-is; there's no need to convert it by hand. Record the scheme's author and licence in `author` / `license` if you vendor one.
