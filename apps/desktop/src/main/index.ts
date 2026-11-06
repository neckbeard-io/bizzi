// Electron main process. Deliberately thin: window, tray/menu bar, menus, single-instance lock,
// `bizzi://` deep links, and the core supervisor (which runs the core as a separate process).
// No product logic lives here; the renderer talks to the core directly over WebSocket.

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  powerMonitor,
  session,
  shell,
  Tray,
  type MenuItemConstructorOptions,
} from 'electron';
import type { LogLevel, ServeReady } from '@bizzi/protocol';
import { createLogger, fileSink, stderrSink } from '../core/log.ts';
import { CoreManager, type CoreStatus } from '../core/manager.ts';
import { resolveCoreEntry, resolveCoreRuntime, resolveDataDir } from '../core/runtime.ts';
import { IPC_BOOTSTRAP, type Bootstrap } from '../shared/ipc.ts';
import { buildCsp } from './csp.ts';
import { trayIcon } from './tray.ts';
import { APP_ORIGIN, handleAppProtocol, registerAppScheme, resolveUiSource, uiEntryUrl } from './ui.ts';

const DEEP_LINK_SCHEME = 'bizzi';
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'notifications', 'fullscreen']);
const isMac = process.platform === 'darwin';
const env = process.env;

if (env['BIZZI_USER_DATA_DIR']) app.setPath('userData', env['BIZZI_USER_DATA_DIR']);

const appDir = app.getAppPath();
const dataDir = resolveDataDir(env);
const logFile = join(dataDir, 'logs', 'core.log');
// Desktop log lines go to our stderr and into the core's log file (its stderr channel).
const log = createLogger([stderrSink, fileSink(logFile)], { proc: 'desktop' }, (env['BIZZI_LOG_LEVEL'] as LogLevel) || 'info');

const ui = resolveUiSource(env, app.isPackaged, process.resourcesPath, appDir);
const uiOrigin = ui.kind === 'dev' ? new URL(ui.url).origin : APP_ORIGIN;
const csp = buildCsp(ui.kind === 'dev' ? { devOrigin: uiOrigin } : {});

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let stopped = false;
/** The connection the current page was loaded with; a different one triggers a reload. */
let loadedConn: ServeReady | null = null;

const manager = new CoreManager({
  dataDir,
  logFile,
  logger: log,
  resolveLaunch: async () => {
    const runtime = await resolveCoreRuntime({
      env,
      platform: process.platform,
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      execPath: process.execPath,
      electronNodeVersion: process.versions.node,
    });
    const entry = resolveCoreEntry({ env, isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appDir });
    if (!existsSync(entry)) throw new Error(`core entry not found: ${entry}`);
    log.log('info', 'core runtime', { kind: runtime.kind, command: runtime.command, nodeVersion: runtime.nodeVersion, entry });
    return { command: runtime.command, args: [entry], env: runtime.env };
  },
  onStatus: (status) => onCoreStatus(status),
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
    log.log('info', 'quitting');
    manager
      .stop()
      .catch((err: unknown) => log.log('error', 'core stop failed', { error: String(err) }))
      .finally(() => {
        stopped = true;
        tray?.destroy();
        app.quit();
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

  ipcMain.on(IPC_BOOTSTRAP, (e) => {
    const trusted = win !== null && e.sender === win.webContents && originOf(e.senderFrame?.url ?? '') === uiOrigin;
    if (!trusted) log.log('warn', 'refused bootstrap to untrusted frame', { url: e.senderFrame?.url });
    e.returnValue = trusted ? bootstrap() : null;
  });

  powerMonitor.on('suspend', () => log.log('info', 'system suspend', { component: 'power' }));
  powerMonitor.on('resume', () => log.log('info', 'system resume', { component: 'power' }));

  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenu()));
  tray = new Tray(trayIcon(process.platform));
  tray.setToolTip('bizzi');
  if (!isMac) tray.on('click', () => showWindow());
  updateTray(manager.status);

  const conn = await manager.start();
  if (!conn) {
    void dialog.showMessageBox({
      type: 'warning',
      message: 'bizzi could not start its core',
      detail: `${manager.status.lastError ?? 'unknown error'}\n\nRetrying in the background. Log: ${logFile}`,
    });
  }
  createWindow();
}

function bootstrap(): Bootstrap {
  const c = manager.status.connection;
  loadedConn = c;
  return { connection: c ? { url: c.url, token: c.token } : null, appVersion: app.getVersion() };
}

function onCoreStatus(status: CoreStatus): void {
  updateTray(status);
  const c = status.connection;
  if (!c || !win || quitting) return;
  if (loadedConn && loadedConn.url === c.url && loadedConn.token === c.token) return;
  log.log('info', 'core connection changed; reloading window', { url: c.url });
  win.webContents.reload();
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'bizzi',
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
  win.once('ready-to-show', () => win?.show());
  win.on('close', (e) => {
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

function appMenu(): MenuItemConstructorOptions[] {
  return [
    ...(isMac ? [{ role: 'appMenu' } as const] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    { role: 'help', submenu: [{ label: 'Show Core Log', click: () => shell.showItemInFolder(logFile) }] },
  ];
}

function updateTray(status: CoreStatus): void {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show bizzi', click: () => showWindow() },
      { type: 'separator' },
      { label: coreLabel(status), enabled: false },
      { label: 'Show Core Log', click: () => shell.showItemInFolder(logFile) },
      { type: 'separator' },
      { label: 'Quit bizzi', accelerator: isMac ? 'Command+Q' : undefined, click: () => app.quit() },
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
  // In dev, registration would point the OS at the bare Electron binary, so it's opt-in.
  if (app.isPackaged) app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
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
