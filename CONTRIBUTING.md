# Contributing to bizzi

Start with [AGENTS.md](AGENTS.md) for the layout and conventions, then [docs/spec.md](docs/spec.md) and
[docs/tech-choices.md](docs/tech-choices.md) for the design.

## Setup

You need Node 26 (see `.nvmrc`; `nvm use` / `fnm use` / `mise use` pick it up) and npm 11.

```sh
npm run setup      # npm ci + download the Electron binary
```

`setup` runs `npm ci`, then `node node_modules/electron/install.js` (`npm run setup:electron`). The
Electron package doesn't download its binary at install time, so this step fetches it up front; it
is a no-op once the binary is there. You only need it for the desktop app.

### Dependency install scripts

npm 11 blocks dependency install scripts unless `allowScripts` in the root `package.json` allows them
(`npm help install-scripts`). Current decisions:

| Package | Decision | Why |
|---|---|---|
| `esbuild` | allowed (pinned version) | `install.js` checks the platform binary and links it into `bin/`; offline, node-only |
| `fsevents` | denied | ships a prebuilt `fsevents.node`; the inferred `node-gyp rebuild` would only recompile it |
| `electron-winstaller` | denied | only for Squirrel.Windows installers (we build NSIS); it copies a 7-Zip `.exe` |

Electron 45, `@lydell/node-pty` and `@openai/codex` have no install scripts (prebuilt per-platform
packages). CI runs `npm ci --strict-allow-scripts`, so a new dependency with install scripts fails CI
until someone reviews it: run `npm install-scripts ls`, then `npm install-scripts approve <pkg>` or
`npm install-scripts deny <pkg>`, and add a row here.

## Check

```sh
npm run check      # typecheck + tests + UI build (what CI runs)
npm run typecheck
npm test           # every workspace; or: npm test -w @bizzi/core
npm run build:ui   # packages/ui/dist
```

Tests must pass offline, without agent logins, and without a display. Tests that probe real agent
binaries skip when the binary isn't installed. Live tests against real agents are opt-in with
`BIZZI_LIVE=1` (they use your logins and can cost a few cents).

## Dev loops

**Desktop against the real core:**

```sh
npm run dev:desktop
```

Builds the UI, bundles the Electron main/preload and launches Electron on `packages/ui/dist`. The
desktop attaches to a core already running in the data dir or spawns one. The data dir is
`.bizzi-dev/data` in the repo (git-ignored); set `BIZZI_DATA_DIR` to use another one. For UI hot
reload, run the Vite dev server (`npm run dev -w @bizzi/ui`) and start the desktop with
`BIZZI_UI_URL=http://localhost:5173 npm run dev -w @bizzi/desktop`. More options (stub core, smoke
screenshot) are in [apps/desktop/README.md](apps/desktop/README.md).

**A core on its own:**

```sh
npm run serve                 # bizzi serve --data-dir .bizzi-dev/data (port 7777)
npm run serve -- --fake       # plus scripted fake adapters
```

It prints a `ready` line with the WebSocket URL and token. A `npm run dev:desktop` started
afterwards attaches to it.

**UI in mock mode** (no core, in the browser):

```sh
npm run dev:ui                # Vite dev server, opens /?mock=1
```

**Offline end-to-end smoke tests** (a real hub and node in temp dirs, fake adapters, a few seconds each):

```sh
npm run smoke:hub             # pairing, a session through the hub, offline node, replay
npm run smoke:v12             # protocol 1.2: worktrees, markSeen across devices, widgets → usage.list,
                              # themes, orchestration settings, agents.list, the bizzi-agents MCP tools
```

**Live smoke test** against a real agent (uses its login, costs a few cents):

```sh
npm run smoke:live                    # claude, haiku
npm run smoke:live -- opencode <model>
```

**Docker image:** `docker build -f deploy/Dockerfile.node -t bizzi/node:latest .`. See
[deploy/README.md](deploy/README.md).

## CI

`.github/workflows/ci.yml` runs on every push and pull request:

- `check` on ubuntu-latest and macos-latest: `npm ci --strict-allow-scripts`, typecheck, tests, UI build,
  `smoke:hub` and `smoke:v12`.
- `docker`: builds `deploy/Dockerfile.node` (no push), with a buildx cache.
- `desktop-pack` (pushes to `main` only): `npm run pack -w @bizzi/desktop` on macOS, unsigned, and
  uploads the zipped `.app` as an artifact.

## Conventions

The full list is in [AGENTS.md](AGENTS.md). In short:

- Node >= 26, ESM only. Node runs the TypeScript directly, so use erasable syntax only (no `enum`,
  `namespace`, parameter properties or decorators), `.ts` extensions in relative imports, and
  `import type` for type-only imports.
- Every package has `typecheck` (`tsc -p .`) and `test` (`node --test`). Tests use `node:test` +
  `node:assert/strict` in `test/*.test.ts`.
- Keep the wire protocol (`packages/protocol`) changes additive.
- Few, mainstream dependencies. No secrets in the repo. Don't write outside the repo or the data dir
  you're given.
- `.editorconfig`: 2 spaces, LF, UTF-8.

## Commits

Plain, descriptive commit messages. No AI or tool attribution: no `Co-Authored-By` trailers for
assistants, no "Generated with ..." lines, in commits or in pull request descriptions.
