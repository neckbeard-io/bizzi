// Sandboxed preload: exposes exactly `window.bizzi = { connection, platform, versions, accentColor,
// titleBar, setChrome }`, and applies menu navigation (a hash route) to the page's location.
// Nothing else from Electron or Node reaches the page.

import { contextBridge, ipcRenderer } from 'electron';
import { IPC_BOOTSTRAP, IPC_CHROME, IPC_NAVIGATE, isMenuRoute, type Bootstrap } from '../shared/ipc.ts';

const boot = (ipcRenderer.sendSync(IPC_BOOTSTRAP) as Bootstrap | null) ?? { connection: null, appVersion: '0.0.0' };

contextBridge.exposeInMainWorld('bizzi', {
  connection: boot.connection ? { url: boot.connection.url, token: boot.connection.token } : undefined,
  platform: process.platform,
  accentColor: boot.accentColor ?? undefined,
  titleBar: boot.titleBar && boot.titleBar.style !== 'native' ? { style: boot.titleBar.style, height: boot.titleBar.height } : undefined,
  // Only the color fields go over IPC; main validates them again.
  setChrome: (c: { background?: unknown; card?: unknown; sidebar?: unknown; foreground?: unknown; dark?: unknown }) =>
    ipcRenderer.send(IPC_CHROME, { background: c?.background, card: c?.card, sidebar: c?.sidebar, foreground: c?.foreground, dark: c?.dark }),
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
