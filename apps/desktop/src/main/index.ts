// Electron main process. Deliberately thin: window, tray/menu bar, menus, single-instance lock,
// `bizzi://` deep links, and the core supervisor (which runs the core as a separate process).
// No product logic lives here; the renderer talks to the core directly over WebSocket.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  powerMonitor,
  screen,
  session,
  shell,
  systemPreferences,
  Tray,
} from 'electron';
import type { LogLevel, ServeReady } from '@bizzi/protocol';
import { createLogger, fileSink, stderrSink } from '../core/log.ts';
import { ensureCoreCopy, pruneCoreCopies, readCoreId } from '../core/copy.ts';
import { CoreManager, type CoreStatus } from '../core/manager.ts';
import { coreNodeArgs, resolveCoreEntry, resolveCoreRuntime, resolveDataDir, testBuildFor } from '../core/runtime.ts';
import { DEFAULT_CHROME, overlayFor, parseChrome, titleBarFor, windowChromeOptions, type ChromeColors } from '../shared/chrome.ts';
import { IPC_BOOTSTRAP, IPC_CHROME, IPC_COMMAND, IPC_NAVIGATE, isMenuCommand, isMenuRoute, type Bootstrap, type MenuCommand } from '../shared/ipc.ts';
import { initialBounds, parseWindowState, type WindowState } from '../shared/window-state.ts';
import { IPC_UPDATE_ACTION, IPC_UPDATE_STATE, parseUpdateAction } from '../shared/update.ts';
import { filePrefs, UpdateController } from '../update/controller.ts';
import { detectInstall, installUpdate, relaunchEnv } from '../update/install.ts';
import { buildCsp } from './csp.ts';
import { appMenu } from './menu.ts';
import { presenceFor, smokeOptions, smokePassed, withRoute, type CheckResult, type SmokeOptions } from './presence.ts';
import { trayIcon } from './tray.ts';
import { APP_ORIGIN, handleAppProtocol, registerAppScheme, resolveUiSource, uiEntryUrl } from './ui.ts';

const DEEP_LINK_SCHEME = 'bizzi';
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'notifications', 'fullscreen']);
const isMac = process.platform === 'darwin';
const env = process.env;

// A build run from a bizzi checkout keeps apart from the installed app (runtime.ts, TestBuild).
const testBuild = testBuildFor(app.getAppPath(), env);
// Headless runs (smoke checks) and background runs stay off your screen and never take focus (presence.ts).
const presence = presenceFor(env);
const headless = presence === 'headless';
const smoke = smokeOptions(env);
/**
 * A headless run gets a throwaway Electron profile, so it never meets the single-instance lock of a
 * test build that's open (which would bring that one's window forward) or of another headless run.
 * `npm run dev` hands it one (BIZZI_USER_DATA_DIR) and removes it after exit; otherwise we make it.
 */
const scratchUserData = headless && !env['BIZZI_USER_DATA_DIR'] ? mkdtempSync(join(tmpdir(), 'bizzi-headless-')) : null;
if (env['BIZZI_USER_DATA_DIR']) app.setPath('userData', env['BIZZI_USER_DATA_DIR']);
else if (scratchUserData) app.setPath('userData', scratchUserData);
else if (testBuild) app.setPath('userData', testBuild.userDataDir);
// Before launch finishes, so macOS never makes the app active or gives it a Dock icon.
if (isMac && presence !== 'foreground') app.setActivationPolicy(headless ? 'prohibited' : 'accessory');
// Chromium still writes to the profile while it shuts down, so it goes only at the very end.
if (scratchUserData) process.on('exit', () => rmSync(scratchUserData, { recursive: true, force: true }));
/** Set when a smoke check fails: the process exits with it. */
let exitCode = 0;
const appName = testBuild ? 'bizzi (test build)' : 'bizzi';

const appDir = app.getAppPath();
/** The bee icons (scripts/icons.ts); inside app.asar when packaged. */
const assetsDir = join(appDir, 'assets');
const appIcon = join(assetsDir, testBuild ? 'icon-test.png' : 'icon.png');
const dataDir = resolveDataDir(env, testBuild);
const logFile = join(dataDir, 'logs', 'core.log');
// Desktop log lines go to our stderr and into the core's log file (its stderr channel).
const log = createLogger([stderrSink, fileSink(logFile)], { proc: 'desktop' }, (env['BIZZI_LOG_LEVEL'] as LogLevel) || 'info');

const ui = resolveUiSource(env, app.isPackaged, process.resourcesPath, appDir);
const uiOrigin = ui.kind === 'dev' ? new URL(ui.url).origin : APP_ORIGIN;
const csp = buildCsp(ui.kind === 'dev' ? { devOrigin: uiOrigin } : {});

const titleBar = titleBarFor(process.platform, env);
/** The theme's last chrome colors, kept so the next launch's first frame already matches. */
const chromeFile = join(app.getPath('userData'), 'chrome.json');
let chrome: ChromeColors = loadChrome();
/** The main window's last size, position and maximized/full-screen state, restored on the next launch. */
const windowStateFile = join(app.getPath('userData'), 'window.json');
let windowStateTimer: NodeJS.Timeout | null = null;

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let stopped = false;
/** Set by "Quit and Stop Sessions": stop the core on quit instead of leaving it running. */
let stopCoreOnQuit = false;
/**
 * The packaged core's id (core/copy.ts). With one, the core runs from its own copy and outlives the
 * app; without (dev runs, BIZZI_CORE_ENTRY, older bundles) quitting stops it as before.
 */
const bundledCoreId = app.isPackaged && !env['BIZZI_CORE_ENTRY'] ? readCoreId(process.resourcesPath) : null;
/**
 * The connection the current page bootstrapped with; a different one triggers a reload. Undefined
 * while a load is under way and the page hasn't asked yet: it will pick up the current one.
 */
let loadedConn: ServeReady | null | undefined;

const manager = new CoreManager({
  dataDir,
  logFile,
  logger: log,
  coreId: bundledCoreId,
  resolveLaunch: async () => {
    // Run the core from its copy, so replacing the app later doesn't pull files from under it.
    const resourcesPath = bundledCoreId ? await ensureCoreCopy(process.resourcesPath, dataDir, bundledCoreId) : process.resourcesPath;
    const runtime = await resolveCoreRuntime({
      env,
      platform: process.platform,
      isPackaged: app.isPackaged,
      resourcesPath,
      execPath: process.execPath,
      electronNodeVersion: process.versions.node,
    });
    const entry = resolveCoreEntry({ env, isPackaged: app.isPackaged, resourcesPath, appDir });
    if (!existsSync(entry)) throw new Error(`core entry not found: ${entry}`);
    log.log('info', 'core runtime', { kind: runtime.kind, command: runtime.command, nodeVersion: runtime.nodeVersion, entry });
    // A test build's core gets its data dir, secrets and widgets apart from the installed app's.
    const isolated: Record<string, string> = testBuild ? { BIZZI_DATA_DIR: dataDir, ...testBuild.coreEnv } : {};
    const coreEnv = Object.fromEntries(Object.entries(isolated).filter(([k]) => !env[k]));
    return { command: runtime.command, args: [...coreNodeArgs(entry), entry], env: { ...coreEnv, ...runtime.env } };
  },
  onStatus: (status) => onCoreStatus(status),
});

// Self-update from GitHub Releases (src/update/). Downloads go to a temp dir; prefs live in userData.
const updateTarget = detectInstall({ isPackaged: app.isPackaged, platform: process.platform, execPath: process.execPath, env, testBuild: testBuild?.checkout ?? null });
const updates = new UpdateController({
  currentVersion: app.getVersion(),
  arch: process.arch,
  target: updateTarget,
  fetch: (url, init) => fetch(url, init),
  prefs: filePrefs(join(app.getPath('userData'), 'update.json')),
  downloadDir: join(app.getPath('temp'), 'bizzi-updates'),
  install: (file) =>
    installUpdate({
      target: updateTarget,
      file,
      pid: process.pid,
      quit: () => app.quit(),
      openPath: (f) => shell.openPath(f),
      logFile: join(dataDir, 'logs', 'update.log'),
      env: relaunchEnv(env),
    }),
  onState: (s) => {
    if (win && !win.isDestroyed()) win.webContents.send(IPC_UPDATE_STATE, s);
  },
  log: (level, msg, fields) => log.log(level, msg, { component: 'update', ...fields }),
});

registerAppScheme();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  setup();
}

function setup(): void {
  app.on('second-instance', (_e, argv) => {
    const link = argv.find((a) => a.startsWith(`${DEEP_LINK_SCHEME}://`));
    if (link) handleDeepLink(link);
    else showWindow();
  });
  app.on('open-url', (e, url) => {
    e.preventDefault();
    handleDeepLink(url);
  });
  registerDeepLinks();

  app.on('web-contents-created', (_e, wc) => {
    wc.setWindowOpenHandler(({ url }) => {
      openExternalIfHttp(url);
      return { action: 'deny' };
    });
    wc.on('will-navigate', (e, url) => {
      if (originOf(url) !== uiOrigin) {
        e.preventDefault();
        openExternalIfHttp(url);
      }
    });
    wc.on('will-attach-webview', (e) => e.preventDefault());
  });

  app.on('before-quit', (e) => {
    if (stopped) return;
    e.preventDefault();
    if (quitting) return;
    quitting = true;
    saveWindowState();
    // The core keeps running (and its sessions with it) unless it runs from inside the bundle or
    // the user chose to stop it; the next launch re-adopts it.
    const keepCore = bundledCoreId !== null && !stopCoreOnQuit;
    log.log('info', 'quitting', { keepCore });
    updates.stop();
    (keepCore ? manager.detach() : manager.stop())
      .catch((err: unknown) => log.log('error', 'core stop failed', { error: String(err) }))
      .finally(() => {
        stopped = true;
        tray?.destroy();
        // Next tick: detach() settles within the same turn as this before-quit, and Electron drops
        // an app.quit() made while it is still unwinding the quit this handler just cancelled.
        setImmediate(() => (exitCode ? app.exit(exitCode) : app.quit()));
      });
  });
  app.on('window-all-closed', () => {
    if (!isMac) app.quit();
  });
  app.on('activate', () => showWindow());

  void app.whenReady().then(onReady);
}

async function onReady(): Promise<void> {
  log.log('info', 'desktop starting', {
    version: app.getVersion(),
    ...(testBuild ? { testBuild: testBuild.checkout } : {}),
    electron: process.versions.electron,
    packaged: app.isPackaged,
    dataDir,
    ui: ui.kind === 'dev' ? ui.url : ui.dir,
    ...(presence !== 'foreground' ? { presence } : {}),
  });

  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(ALLOWED_PERMISSIONS.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));
  ses.webRequest.onHeadersReceived((details, cb) => {
    if (details.resourceType !== 'mainFrame' && details.resourceType !== 'subFrame') return cb({});
    cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
  });
  if (ui.kind === 'dir') handleAppProtocol(ui.dir, csp);

  ipcMain.on(IPC_CHROME, (e, raw: unknown) => {
    if (win === null || e.sender !== win.webContents || originOf(e.senderFrame?.url ?? '') !== uiOrigin) return;
    const c = parseChrome(raw);
    if (c) applyChrome(c);
  });
  ipcMain.on(IPC_BOOTSTRAP, (e) => {
    const trusted = win !== null && e.sender === win.webContents && originOf(e.senderFrame?.url ?? '') === uiOrigin;
    if (!trusted) log.log('warn', 'refused bootstrap to untrusted frame', { url: e.senderFrame?.url });
    e.returnValue = trusted ? bootstrap() : null;
  });

  ipcMain.handle(IPC_UPDATE_ACTION, async (e, raw: unknown) => {
    if (!trustedSender(e)) return null;
    if (raw !== 'get') {
      const action = parseUpdateAction(raw);
      if (!action) return null;
      await updates.act(action);
    }
    return updates.state;
  });

  powerMonitor.on('suspend', () => log.log('info', 'system suspend', { component: 'power' }));
  powerMonitor.on('resume', () => log.log('info', 'system resume', { component: 'power' }));

  app.setAboutPanelOptions({
    applicationName: 'bizzi',
    applicationVersion: app.getVersion(),
    version: `Electron ${process.versions.electron}`,
    copyright: 'bizzi contributors',
    ...(isMac ? {} : { iconPath: appIcon }),
  });
  // Packaged builds carry the icon in the bundle; in dev the Dock would show Electron's.
  // A packaged test build would otherwise pass for the installed app.
  if (isMac && !headless && (!app.isPackaged || testBuild)) app.dock?.setIcon(appIcon);
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      appMenu(process.platform, {
        navigate: (hash) => openRoute(hash),
        command: (name) => runCommand(name),
        back: () => win?.webContents.navigationHistory.goBack(),
        forward: () => win?.webContents.navigationHistory.goForward(),
        showCoreLog: () => shell.showItemInFolder(logFile),
        openDataDir: () => void shell.openPath(dataDir),
        checkForUpdates: () => checkForUpdates(),
      }),
    ),
  );
  if (!headless) {
    tray = new Tray(trayIcon(process.platform, assetsDir, testBuild !== null));
    tray.setToolTip(appName);
    // The macOS menu bar icon is a monochrome template, so a test build says so in text.
    if (isMac && testBuild) tray.setTitle('test');
    if (!isMac) tray.on('click', () => showWindow());
    updateTray(manager.status);
  }

  // The window comes up right away and shows "starting" until the core is there (replacing an
  // out-of-date core takes a moment); then it reloads onto the connection (onCoreStatus).
  createWindow();
  if (updateTarget.method !== 'unsupported') updates.start();
  const conn = await manager.start();
  if (bundledCoreId) {
    try {
      const removed = pruneCoreCopies(dataDir, [bundledCoreId, manager.runningCoreId]);
      if (removed.length) log.log('info', 'removed old core copies', { removed });
    } catch (err) {
      log.log('warn', 'could not prune old core copies', { error: String(err) });
    }
  }
  if (!conn && !quitting && !headless) {
    void dialog.showMessageBox({
      type: 'warning',
      message: 'bizzi could not start its core',
      detail: `${manager.status.lastError ?? 'unknown error'}\n\nRetrying in the background. Log: ${logFile}`,
    });
  }
}

/** Menu / tray: open Settings › Updates and check now. */
function checkForUpdates(): void {
  openRoute('#/settings/updates');
  void updates.check({ silent: false });
}

function trustedSender(e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): boolean {
  return win !== null && e.sender === win.webContents && originOf(e.senderFrame?.url ?? '') === uiOrigin;
}

function bootstrap(): Bootstrap {
  const status = manager.status;
  const c = status.connection;
  loadedConn = c;
  return {
    connection: c ? { url: c.url, token: c.token } : null,
    // No connection yet but one is on its way: the UI waits instead of offering to configure one.
    coreStarting: !c && status.state !== 'stopping' && status.state !== 'stopped',
    appVersion: app.getVersion(),
    accentColor: accentColor(),
    titleBar,
  };
}

function loadChrome(): ChromeColors {
  try {
    return parseChrome(JSON.parse(readFileSync(chromeFile, 'utf8'))) ?? DEFAULT_CHROME;
  } catch {
    return DEFAULT_CHROME;
  }
}

/** Theme changed in the UI: window background, the Windows/Linux controls overlay, and the saved copy. */
function applyChrome(c: ChromeColors): void {
  if (JSON.stringify(c) === JSON.stringify(chrome)) return;
  chrome = c;
  if (win) {
    win.setBackgroundColor(c.background);
    if (titleBar.style === 'overlay') win.setTitleBarOverlay(overlayFor(c, titleBar.height));
  }
  try {
    writeFileSync(chromeFile, JSON.stringify(c));
  } catch (err) {
    log.log('warn', 'could not save chrome colors', { error: String(err) });
  }
}

/** The platform accent color (`rrggbbaa`) for the UI's Device theme; macOS and Windows only. */
function accentColor(): string | null {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return null;
  try {
    return systemPreferences.getAccentColor() || null;
  } catch {
    return null;
  }
}

function onCoreStatus(status: CoreStatus): void {
  updateTray(status);
  const c = status.connection;
  if (!c || !win || quitting) return;
  if (loadedConn === undefined) return; // still loading; the page bootstraps with this connection
  if (loadedConn && loadedConn.url === c.url && loadedConn.token === c.token) return;
  log.log('info', 'core connection changed; reloading window', { url: c.url });
  loadedConn = undefined;
  win.webContents.reload();
}

function loadWindowState(): WindowState | null {
  try {
    return parseWindowState(JSON.parse(readFileSync(windowStateFile, 'utf8')));
  } catch {
    return null;
  }
}

function saveWindowState(): void {
  if (windowStateTimer) clearTimeout(windowStateTimer);
  windowStateTimer = null;
  if (!win || win.isDestroyed() || headless) return;
  const state: WindowState = { bounds: win.getNormalBounds(), maximized: win.isMaximized(), fullScreen: win.isFullScreen() };
  try {
    writeFileSync(windowStateFile, JSON.stringify(state));
  } catch (err) {
    log.log('warn', 'could not save window state', { error: String(err) });
  }
}

/** Moves and resizes fire continuously while dragging; write once things settle. */
function saveWindowStateSoon(): void {
  if (windowStateTimer) clearTimeout(windowStateTimer);
  windowStateTimer = setTimeout(saveWindowState, 500);
}

function createWindow(): void {
  // One main window: a second one (say, the Dock clicked while the core starts) would be refused
  // its bootstrap and show the connect screen.
  if (win && !win.isDestroyed()) {
    showWindow();
    return;
  }
  const saved = headless ? null : loadWindowState();
  const primary = screen.getPrimaryDisplay();
  const workAreas = [primary, ...screen.getAllDisplays().filter((d) => d.id !== primary.id)].map((d) => d.workArea);
  const min = { width: 720, height: 480 };
  win = new BrowserWindow({
    ...initialBounds(saved, workAreas, smoke?.size ?? { width: 1280, height: 820 }, min),
    minWidth: min.width,
    minHeight: min.height,
    show: false,
    title: appName,
    ...(isMac ? {} : { icon: appIcon }),
    ...windowChromeOptions(titleBar, chrome),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      // Headless: the page renders in memory and never reaches the screen; capturePage still works.
      offscreen: headless,
      // A smoke check screenshots a window that may sit behind other apps; keep it painting.
      ...(smoke ? { backgroundThrottling: false } : {}),
    },
  });
  win.once('ready-to-show', () => {
    if (!win || headless) return;
    // A test build or a background run opens behind whatever you're working in rather than taking
    // focus; the Dock or the tray brings it forward.
    const behind = testBuild !== null || presence === 'background';
    if (behind) win.showInactive();
    if (saved?.maximized) win.maximize();
    if (!behind) win.show();
    if (saved?.fullScreen) win.setFullScreen(true);
  });
  win.on('resize', saveWindowStateSoon);
  win.on('move', saveWindowStateSoon);
  win.on('maximize', saveWindowStateSoon);
  win.on('unmaximize', saveWindowStateSoon);
  win.on('enter-full-screen', saveWindowStateSoon);
  win.on('leave-full-screen', saveWindowStateSoon);
  win.on('close', (e) => {
    saveWindowState();
    // macOS: closing the window keeps bizzi in the menu bar; Quit exits.
    if (isMac && !quitting) {
      e.preventDefault();
      win?.hide();
      app.dock?.hide();
    }
  });
  win.on('closed', () => {
    win = null;
  });
  if (smoke) smokeTest(win, smoke);
  loadedConn = undefined;
  void win.loadURL(withRoute(uiEntryUrl(ui), smoke?.route ?? null));
}

function showWindow(): void {
  // Headless runs never come on screen, whatever asks (a second launch, a deep link, the Dock).
  if (!app.isReady() || headless) return;
  if (!win) createWindow();
  else {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  void app.dock?.show();
}

/** A menu item's UI route: bring the window up, then let the preload set the hash once the page is there. */
function openRoute(hash: string): void {
  if (!isMenuRoute(hash)) return;
  showWindow();
  const wc = win?.webContents;
  if (!wc) return;
  if (wc.isLoading()) wc.once('did-finish-load', () => wc.send(IPC_NAVIGATE, hash));
  else wc.send(IPC_NAVIGATE, hash);
}

function runCommand(name: MenuCommand): void {
  if (!isMenuCommand(name)) return;
  showWindow();
  const wc = win?.webContents;
  if (!wc) return;
  if (wc.isLoading()) wc.once('did-finish-load', () => wc.send(IPC_COMMAND, name));
  else wc.send(IPC_COMMAND, name);
}

function updateTray(status: CoreStatus): void {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show bizzi', click: () => showWindow() },
      { type: 'separator' },
      { label: coreLabel(status), enabled: false },
      { label: 'Show Core Log', click: () => shell.showItemInFolder(logFile) },
      { label: 'Check for Updates…', click: () => checkForUpdates() },
      { type: 'separator' },
      { label: 'Quit bizzi', accelerator: isMac ? 'Command+Q' : undefined, click: () => app.quit() },
      ...(bundledCoreId && status.owned
        ? [
            {
              label: 'Quit and Stop Sessions',
              toolTip: 'Quit and stop the core too; running agents stop. Plain Quit leaves them running.',
              click: () => {
                stopCoreOnQuit = true;
                app.quit();
              },
            },
          ]
        : []),
    ]),
  );
}

function coreLabel(s: CoreStatus): string {
  const pid = s.connection ? ` (pid ${s.connection.pid})` : '';
  switch (s.state) {
    case 'attached':
      return `Core: attached${pid}${s.owned ? '' : ', external'}`;
    case 'running':
      return `Core: running${pid}`;
    case 'restarting':
      return `Core: restarting${s.lastError ? ` (${s.lastError.slice(0, 60)})` : ''}`;
    default:
      return `Core: ${s.state}`;
  }
}

function registerDeepLinks(): void {
  // Packaged builds also declare the scheme in Info.plist / .desktop / registry (electron-builder).
  // In dev, registration would point the OS at the bare Electron binary, so it's opt-in. A packaged
  // test build never claims it: bizzi:// links belong to the installed app.
  if (app.isPackaged && !testBuild) app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
  else if (env['BIZZI_REGISTER_PROTOCOL'] === '1' && process.argv[1]) {
    app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [resolve(process.argv[1])]);
  }
  const initial = process.argv.find((a) => a.startsWith(`${DEEP_LINK_SCHEME}://`));
  if (initial) app.whenReady().then(() => handleDeepLink(initial), () => {});
}

function handleDeepLink(url: string): void {
  // Minimal for now: bring the app forward. Routing (pairing codes, session links) comes later.
  let host = '';
  try {
    host = new URL(url).host;
  } catch {
    return;
  }
  log.log('info', 'deep link', { host });
  showWindow();
}

function openExternalIfHttp(url: string): void {
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
}

/** scheme://host[:port]. (URL#origin is "null" for non-special schemes like app://.) */
function originOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
}

/**
 * Smoke check (BIZZI_SMOKE_MS=n, presence.ts): once the page has settled n ms after its last load
 * (it reloads when the core connects), run the BIZZI_SMOKE_EVAL check, save smoke.png and
 * smoke.json, then quit, with exit code 1 when the check failed.
 */
function smokeTest(w: BrowserWindow, o: SmokeOptions): void {
  const consoleErrors: string[] = [];
  w.webContents.on('console-message', (e) => {
    log.log('info', 'renderer console', { level: e.level, message: e.message });
    if (e.level === 'error' && consoleErrors.length < 50) consoleErrors.push(e.message);
  });
  const outDir = o.outDir ?? dataDir;
  let timer: NodeJS.Timeout | null = null;
  w.webContents.on('did-finish-load', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void run(), o.delayMs);
  });
  const run = async (): Promise<void> => {
    let page: unknown = null;
    let check: CheckResult | null = null;
    let screenshot = false;
    try {
      mkdirSync(outDir, { recursive: true });
      const seen: unknown = await w.webContents.executeJavaScript(
          `JSON.stringify({ url: location.href, bizzi: window.bizzi && { ...window.bizzi, connection: window.bizzi.connection && { url: window.bizzi.connection.url, token: window.bizzi.connection.token ? '<redacted>' : '' } }, keys: window.bizzi ? Object.keys(window.bizzi) : null, hasRequire: typeof require !== 'undefined', hasProcess: typeof process !== 'undefined', text: document.body.innerText.slice(0, 2000) })`,
      );
      page = JSON.parse(String(seen));
      log.log('info', 'smoke: page state', { seen: page });
      if (o.check) {
        try {
          const out: unknown = await w.webContents.executeJavaScript(`(async () => JSON.stringify((await (${o.check})) ?? null))()`);
          check = { value: JSON.parse(String(out)) };
        } catch (err) {
          check = { error: String(err) };
        }
        log.log('info', 'smoke: check', { check });
      }
      const png = await w.webContents.capturePage();
      if (!png.isEmpty()) {
        writeFileSync(join(outDir, 'smoke.png'), png.toPNG());
        screenshot = true;
        log.log('info', 'smoke: screenshot saved', { file: join(outDir, 'smoke.png') });
      } else log.log('error', 'smoke: screenshot was empty');
    } catch (err) {
      log.log('error', 'smoke: failed', { error: String(err) });
    }
    const ok = smokePassed({ screenshot, check });
    const status = manager.status;
    const report = {
      ok,
      presence,
      route: o.route,
      page,
      check,
      consoleErrors,
      core: { state: status.state, lastError: status.lastError ?? null },
      screenshot: screenshot ? join(outDir, 'smoke.png') : null,
    };
    try {
      writeFileSync(join(outDir, 'smoke.json'), JSON.stringify(report, null, 2) + '\n');
    } catch (err) {
      log.log('error', 'smoke: could not write smoke.json', { error: String(err) });
    }
    log.log(ok ? 'info' : 'error', ok ? 'smoke: passed' : 'smoke: failed', { report: join(outDir, 'smoke.json') });
    if (!ok) exitCode = 1;
    app.quit();
  };
}
