// Sandboxed preload: exposes exactly `window.bizzi = { connection, coreStarting, platform, versions,
// accentColor, titleBar, setChrome, updates }`, applies menu navigation (a hash route) to the page's location
// and passes menu commands on as `bizzi:command` window events.
// Nothing else from Electron or Node reaches the page.

import { contextBridge, ipcRenderer } from 'electron';
import { IPC_BOOTSTRAP, IPC_CHROME, IPC_COMMAND, IPC_NAVIGATE, isMenuCommand, isMenuRoute, type Bootstrap } from '../shared/ipc.ts';
import { IPC_UPDATE_ACTION, IPC_UPDATE_STATE, type UpdateAction, type UpdateState } from '../shared/update.ts';

const boot = (ipcRenderer.sendSync(IPC_BOOTSTRAP) as Bootstrap | null) ?? { connection: null, appVersion: '0.0.0' };

contextBridge.exposeInMainWorld('bizzi', {
  connection: boot.connection ? { url: boot.connection.url, token: boot.connection.token } : undefined,
  coreStarting: boot.coreStarting === true,
  platform: process.platform,
  accentColor: boot.accentColor ?? undefined,
  titleBar: boot.titleBar && boot.titleBar.style !== 'native' ? { style: boot.titleBar.style, height: boot.titleBar.height } : undefined,
  // Only the color fields go over IPC; main validates them again.
  setChrome: (c: { background?: unknown; card?: unknown; sidebar?: unknown; foreground?: unknown; dark?: unknown }) =>
    ipcRenderer.send(IPC_CHROME, { background: c?.background, card: c?.card, sidebar: c?.sidebar, foreground: c?.foreground, dark: c?.dark }),
  // Self-updater (src/update/): main validates every action and returns the new state.
  updates: {
    get: (): Promise<UpdateState | null> => ipcRenderer.invoke(IPC_UPDATE_ACTION, 'get'),
    act: (a: UpdateAction): Promise<UpdateState | null> => ipcRenderer.invoke(IPC_UPDATE_ACTION, a),
    subscribe: (cb: (s: UpdateState) => void): (() => void) => {
      const listener = (_e: unknown, s: UpdateState) => cb(s);
      ipcRenderer.on(IPC_UPDATE_STATE, listener);
      return () => ipcRenderer.removeListener(IPC_UPDATE_STATE, listener);
    },
  },
  versions: {
    app: boot.appVersion,
    electron: process.versions['electron'],
    chrome: process.versions['chrome'],
    node: process.versions['node'],
  },
});

// Application menu → UI route. Only `#/…` hashes: the page can't be sent anywhere else this way.
ipcRenderer.on(IPC_NAVIGATE, (_e, hash: unknown) => {
  // No DOM lib in this tsconfig; the page's location is shared with the isolated world.
  if (isMenuRoute(hash)) (globalThis as unknown as { location: { hash: string } }).location.hash = hash;
});

// Application menu → UI command (New Workspace, New Session): the UI runs it for the page it shows.
ipcRenderer.on(IPC_COMMAND, (_e, command: unknown) => {
  if (!isMenuCommand(command)) return;
  const g = globalThis as unknown as { dispatchEvent(e: unknown): boolean; CustomEvent: new (type: string, init: { detail: string }) => unknown };
  g.dispatchEvent(new g.CustomEvent('bizzi:command', { detail: command }));
});
