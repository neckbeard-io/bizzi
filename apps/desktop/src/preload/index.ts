// Sandboxed preload: exposes exactly `window.bizzi = { connection, platform, versions, accentColor }`.
// Nothing else from Electron or Node reaches the page.

import { contextBridge, ipcRenderer } from 'electron';
import { IPC_BOOTSTRAP, type Bootstrap } from '../shared/ipc.ts';

const boot = (ipcRenderer.sendSync(IPC_BOOTSTRAP) as Bootstrap | null) ?? { connection: null, appVersion: '0.0.0' };

contextBridge.exposeInMainWorld('bizzi', {
  connection: boot.connection ? { url: boot.connection.url, token: boot.connection.token } : undefined,
  platform: process.platform,
  accentColor: boot.accentColor ?? undefined,
  versions: {
    app: boot.appVersion,
    electron: process.versions['electron'],
    chrome: process.versions['chrome'],
    node: process.versions['node'],
  },
});
