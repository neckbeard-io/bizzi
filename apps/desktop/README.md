# @bizzi/desktop

Electron shell for bizzi. The core never runs inside Electron: the main process finds or starts a
separate `bizzi serve` process and the renderer talks to it over WebSocket.

## How it finds and runs the core

1. Read `~/.bizzi/serve.json` (`BIZZI_DATA_DIR` overrides the data dir). If its `pid` is alive and
   `GET <http url>/healthz` answers 2xx (the token is sent as `Authorization: Bearer`), **attach**.
   This is how the app shares one node with a launchd `bizzi serve` on the same laptop.
2. Otherwise **spawn** `<node> apps/cli/src/main.ts serve --host 127.0.0.1 --port 0 --data-dir ~/.bizzi`
   as a detached process with stdout piped and stderr appended to `~/.bizzi/logs/core.log`. Read the
   `ServeReady` line from stdout.
3. **Supervise**: a spawned core that exits is restarted with exponential backoff (0.5 s doubling
   to 30 s, ±20% jitter, reset after 60 s of uptime). Each restart runs attach-or-spawn again. An
   attached core is polled on `/healthz` every 5 s and replaced after 2 failures.
4. **Quit** stops the core (SIGTERM, which drains, then SIGKILL after 30 s) only if this app
   spawned it. Ownership is recorded in `~/.bizzi/desktop-core.json`, so if the UI crashes, the
   relaunched app re-adopts the core it had spawned. A core someone else started is left running.

When the connection changes (for example, a restarted core on a new port), the window reloads and
the preload picks up the new `{ url, token }`.

Desktop log lines (supervision, `powerMonitor` suspend/resume) are JSON lines written both to the
app's stderr and to `~/.bizzi/logs/core.log`, so they sit next to the core's own stderr.

## Which Node runs the core

`resolveCoreRuntime()` in `src/core/runtime.ts` is the single place this is decided:

| Order | Runtime | When |
|---|---|---|
| 1 | `BIZZI_NODE` | always wins; must report Node >= 26 |
| 2 | Electron itself with `ELECTRON_RUN_AS_NODE=1` | opt-in: `BIZZI_CORE_RUNTIME=electron` |
| 3 | `<resources>/node/bin/node` (`node.exe` on Windows) | packaged builds |
| 4 | first Node >= 26 on `PATH`, `/opt/homebrew/bin`, `/usr/local/bin`, `~/.volta/bin`, mise shims | dev |

What we found with Electron 45.2.3: its bundled Node is **24.22.2**. Under `ELECTRON_RUN_AS_NODE=1`
it *does* run the core's `.ts` sources (type stripping is on by default) and `node:sqlite` works.
It is still not the default, for two reasons:

- It is Node 24, and the repo's floor is Node >= 26.
- Its native-module ABI is **150**, while Node 26's is **147**. Native addons installed for the
  system Node (`node-pty`, ...) won't load under Electron, and the reverse is also true.

Once Electron ships Node >= 26, tech-choices D0b's "one runtime" plan becomes possible. Rebuild
the staged core's native addons for Electron's ABI (`@electron/rebuild`) and make `electron` the
default in that function.

## UI and security

- Dev: `BIZZI_UI_URL=http://localhost:5173` loads the Vite dev server. Prod: `packages/ui/dist` is
  served at `app://bizzi/` (a privileged custom scheme, with SPA fallback to `index.html`).
  `BIZZI_UI_DIR` overrides the directory.
- `contextIsolation`, `sandbox` and `webSecurity` are on, and `nodeIntegration` is off. Navigation
  outside the UI origin is blocked, and http(s) links open in the browser. Webviews are refused, and
  permissions are denied except clipboard write, notifications and fullscreen.
- CSP (header): `script-src 'self' 'wasm-unsafe-eval'`, `connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:*`,
  `object-src 'none'`, and so on. In dev it also allows the Vite origin, its HMR websocket and
  inline scripts (React Refresh).
- The preload exposes only `window.bizzi = { connection: { url, token }, platform, versions }`, read
  once from main with a sync IPC call that only answers the main window's UI origin.

**Note for the core:** the renderer's origin is `app://bizzi`, or the Vite origin in dev. If the
core checks `Origin` on the WebSocket upgrade, or serves HTTP that the UI fetches, it must allow
that origin (CORS).

## Shell behavior

Single-instance lock. On macOS a menu bar icon (the bee, a template image) stays up; closing the
window hides it (and the Dock icon), and Quit exits. Windows and Linux get the color bee in the tray.

The application menu (`src/main/menu.ts`) is bizzi's own: the bizzi app menu on macOS (About,
Settings… ⌘,, Hide, Quit), File (New Prompt… ⌘N, Add Workspace… ⇧⌘N, Pair a Device…), Edit, View
(Machines ⌘1, Inbox ⌘2, Knowledge ⌘3, reload, zoom, full screen), Go (Back ⌘[, Forward ⌘]), Window
and Help (Show Core Log, Open Data Folder). Items that open part of the UI send a hash route
(`#/inbox`) over `bizzi:navigate`; the preload sets it only if it is a `#/…` route.

Icons: `assets/icon.svg` and `assets/tray.svg` are the sources. `npm run icons -w @bizzi/desktop`
(rsvg-convert, and iconutil on macOS) renders `assets/*.png` (runtime: tray, window and dev Dock
icon) and `build-resources/icon.{png,icns,ico}` (electron-builder). The outputs are committed.

In dev on macOS, the menu bar name and the Dock icon come from the app bundle, so `npm run dev`
launches `.dev-app/bizzi.app`: a cloned Electron.app with `CFBundleName` bizzi and the bee icon,
signed again ad hoc and rebuilt when Electron or the icon changes. `BIZZI_DEV_PLAIN_ELECTRON=1`
runs plain Electron. `bizzi://` is registered for packaged builds (Info.plist/registry
via electron-builder). In dev it is registered only with `BIZZI_REGISTER_PROTOCOL=1`. Deep links
currently only bring the window forward.

## Scripts

```sh
npm run dev -w @bizzi/desktop        # esbuild main/preload -> out/, launch Electron (as bizzi.app on macOS)
npm run icons -w @bizzi/desktop      # render assets/*.svg to the PNG / icns / ico icons
npm test -w @bizzi/desktop           # node:test, uses test/fixtures/stub-core.ts
npm run pack -w @bizzi/desktop       # build + stage + electron-builder --dir (unpacked, unsigned)
npm run dist:mac|dist:linux|dist:win # dmg (arm64+x64) | AppImage+deb | nsis
```

Try the shell without the real core or UI:

```sh
BIZZI_DATA_DIR=$PWD/.bizzi-dev/data \
BIZZI_CORE_ENTRY=$PWD/apps/desktop/test/fixtures/stub-core.ts \
BIZZI_UI_DIR=$PWD/apps/desktop/test/fixtures/static \
npm run dev -w @bizzi/desktop
# add BIZZI_SMOKE_MS=1500 to log what the page sees, save <data dir>/smoke.png and quit
```

## Packaging plan (status)

`scripts/stage.ts` fills `staging/`, which electron-builder copies to the app's resources (outside
`app.asar`):

- `ui/`: `packages/ui/dist`, or a placeholder page. **Done.**
- `core/`: root package files, `packages/*` (except `ui`) and `apps/cli` sources. **Done.**
  `npm ci --omit=dev` under the target Node is behind `BIZZI_STAGE_INSTALL=1`. It works for the
  host arch only and will need a pruned lockfile. **Stub.**
- `node/`: a Node >= 26 runtime per target, copied from `BIZZI_STAGE_NODE_DIR`. The plan is to
  download the nodejs.org tarball per platform/arch and check it against `SHASUMS256.txt`. Native
  addons must be installed per arch, so mac arm64 and x64 need separate staging (per-arch CI
  runners). **Stub.**
- Signing and notarization (mac), including the bundled `node` binary: not yet (`identity: null`).
- App icon: the bee (`build-resources/icon.{icns,ico,png}`). **Done.**
