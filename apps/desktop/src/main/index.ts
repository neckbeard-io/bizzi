// Electron main process. Deliberately thin: window, tray/menu bar, menus, single-instance lock,
// `bizzi://` deep links, and the core supervisor (which runs the core as a separate process).
// No product logic lives here; the renderer talks to the core directly over WebSocket.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
import { IPC_BOOTSTRAP, IPC_CHROME, IPC_NAVIGATE, isMenuRoute, type Bootstrap } from '../shared/ipc.ts';
import { initialBounds, parseWindowState, type WindowState } from '../shared/window-state.ts';
import { IPC_UPDATE_ACTION, IPC_UPDATE_STATE, parseUpdateAction } from '../shared/update.ts';
import { filePrefs, UpdateController } from '../update/controller.ts';
import { detectInstall, installUpdate, relaunchEnv } from '../update/install.ts';
import { buildCsp } from './csp.ts';
import { appMenu } from './menu.ts';
import { trayIcon } from './tray.ts';
import { APP_ORIGIN, handleAppProtocol, registerAppScheme, resolveUiSource, uiEntryUrl } from './ui.ts';

const DEEP_LINK_SCHEME = 'bizzi';
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'notifications', 'fullscreen']);
const isMac = process.platform === 'darwin';
const env = process.env;

// A build run from a bizzi checkout keeps apart from the installed app (runtime.ts, TestBuild).
const testBuild = testBuildFor(app.getAppPath(), env);
if (env['BIZZI_USER_DATA_DIR']) app.setPath('userData', env['BIZZI_USER_DATA_DIR']);
else if (testBuild) app.setPath('userData', testBuild.userDataDir);
const appName = testBuild ? 'bizzi (test build)' : 'bizzi';

const appDir = app.getAppPath();
/** The bee icons (scripts/icons.ts); inside app.asar when packaged. */
const assetsDir = join(appDir, 'assets');
const appIcon = join(assetsDir, 'icon.png');
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
/** The connection the current page was loaded with; a different one triggers a reload. */
let loadedConn: ServeReady | null = null;

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
        setImmediate(() => app.quit());
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
  if (isMac && !app.isPackaged) app.dock?.setIcon(appIcon);
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      appMenu(process.platform, {
        navigate: (hash) => openRoute(hash),
        back: () => win?.webContents.navigationHistory.goBack(),
        forward: () => win?.webContents.navigationHistory.goForward(),
        showCoreLog: () => shell.showItemInFolder(logFile),
        openDataDir: () => void shell.openPath(dataDir),
        checkForUpdates: () => checkForUpdates(),
      }),
    ),
  );
  tray = new Tray(trayIcon(process.platform, assetsDir));
  tray.setToolTip(appName);
  if (!isMac) tray.on('click', () => showWindow());
  updateTray(manager.status);

  const conn = await manager.start();
  if (bundledCoreId) {
    try {
      const removed = pruneCoreCopies(dataDir, [bundledCoreId, manager.runningCoreId]);
      if (removed.length) log.log('info', 'removed old core copies', { removed });
    } catch (err) {
      log.log('warn', 'could not prune old core copies', { error: String(err) });
    }
  }
  if (!conn) {
    void dialog.showMessageBox({
      type: 'warning',
      message: 'bizzi could not start its core',
      detail: `${manager.status.lastError ?? 'unknown error'}\n\nRetrying in the background. Log: ${logFile}`,
    });
  }
  createWindow();
  if (updateTarget.method !== 'unsupported') updates.start();
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
  const c = manager.status.connection;
  loadedConn = c;
  return { connection: c ? { url: c.url, token: c.token } : null, appVersion: app.getVersion(), accentColor: accentColor(), titleBar };
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
  if (loadedConn && loadedConn.url === c.url && loadedConn.token === c.token) return;
  log.log('info', 'core connection changed; reloading window', { url: c.url });
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
  if (!win || win.isDestroyed()) return;
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
  const saved = loadWindowState();
  const primary = screen.getPrimaryDisplay();
  const workAreas = [primary, ...screen.getAllDisplays().filter((d) => d.id !== primary.id)].map((d) => d.workArea);
  const min = { width: 720, height: 480 };
  win = new BrowserWindow({
    ...initialBounds(saved, workAreas, { width: 1280, height: 820 }, min),
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
    },
  });
  win.once('ready-to-show', () => {
    if (!win) return;
    if (saved?.maximized) win.maximize();
    win.show();
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
  if (env['BIZZI_SMOKE_MS']) smokeTest(win, Number(env['BIZZI_SMOKE_MS']));
  void win.loadURL(uiEntryUrl(ui));
}

function showWindow(): void {
  if (!app.isReady()) return;
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

/** Dev check (BIZZI_SMOKE_MS=n): log what the page sees, save a screenshot, then quit. */
function smokeTest(w: BrowserWindow, delayMs: number): void {
  w.webContents.on('console-message', (e) => log.log('info', 'renderer console', { level: e.level, message: e.message }));
  w.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      try {
        const seen: unknown = await w.webContents.executeJavaScript(
          `JSON.stringify({ url: location.href, bizzi: window.bizzi && { ...window.bizzi, connection: window.bizzi.connection && { url: window.bizzi.connection.url, token: window.bizzi.connection.token ? '<redacted>' : '' } }, keys: window.bizzi ? Object.keys(window.bizzi) : null, hasRequire: typeof require !== 'undefined', hasProcess: typeof process !== 'undefined', text: document.body.innerText.slice(0, 400) })`,
        );
        log.log('info', 'smoke: page state', { seen: JSON.parse(String(seen)) });
        const png = await w.webContents.capturePage();
        const { writeFile } = await import('node:fs/promises');
        await writeFile(join(dataDir, 'smoke.png'), png.toPNG());
        log.log('info', 'smoke: screenshot saved', { file: join(dataDir, 'smoke.png') });
      } catch (err) {
        log.log('error', 'smoke: failed', { error: String(err) });
      }
      app.quit();
    }, delayMs);
  });
}
