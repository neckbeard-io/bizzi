// The application menu. Items that open a part of the UI send a hash route to the renderer
// (`MenuActions.navigate`, applied by the preload), so the menu needs no knowledge of the UI's state.

import type { MenuItemConstructorOptions } from 'electron';
import type { MenuCommand } from '../shared/ipc.ts';

export interface MenuActions {
  /** Show the window and open this UI route (`#/…`). */
  navigate(hash: string): void;
  /** Show the window and run a UI command where the page is (`bizzi:command`). */
  command(name: MenuCommand): void;
  back(): void;
  forward(): void;
  showCoreLog(): void;
  openDataDir(): void;
  /** Open Settings › Updates and check GitHub Releases now. */
  checkForUpdates(): void;
}

/** Hash routes the menu opens; the preload accepts only this shape (`isMenuRoute`, shared/ipc.ts). */
export const MENU_ROUTES = {
  ask: '#/ask',
  addWorkspace: '#/workspaces?add=1',
  devices: '#/settings/devices',
  settings: '#/settings',
  updates: '#/settings/updates',
  machines: '#/machines',
  inbox: '#/inbox',
  knowledge: '#/knowledge',
} as const;

export function appMenu(platform: NodeJS.Platform, a: MenuActions): MenuItemConstructorOptions[] {
  const mac = platform === 'darwin';
  const sep: MenuItemConstructorOptions = { type: 'separator' };
  const settings: MenuItemConstructorOptions = { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => a.navigate(MENU_ROUTES.settings) };
  const updates: MenuItemConstructorOptions = { label: 'Check for Updates…', click: () => a.checkForUpdates() };
  return [
    ...(mac
      ? [
          {
            label: 'bizzi',
            submenu: [
              { role: 'about', label: 'About bizzi' },
              updates,
              sep,
              settings,
              sep,
              { role: 'services' },
              sep,
              { role: 'hide', label: 'Hide bizzi' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              sep,
              { role: 'quit', label: 'Quit bizzi' },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: 'File',
      submenu: [
        // ⌘N / ⌘T / ⌘W are the UI's hotkeys (Settings › Hotkeys, switchable per device): shown here, not
        // registered, so the keys reach the page and the UI decides; a click runs the command regardless.
        { label: 'New Workspace…', accelerator: 'CmdOrCtrl+N', registerAccelerator: false, click: () => a.command('new-workspace') },
        { label: 'New Session', accelerator: 'CmdOrCtrl+T', registerAccelerator: false, click: () => a.command('new-session') },
        { label: 'New Prompt…', accelerator: 'CmdOrCtrl+Shift+N', click: () => a.navigate(MENU_ROUTES.ask) },
        { label: 'Pair a Device…', click: () => a.navigate(MENU_ROUTES.devices) },
        sep,
        ...(mac ? [] : [settings, sep]),
        // ⌘W ends the open session (reopenable from the sidebar's Ended group) and closes the window on
        // other pages; the window itself closes with ⇧⌘W.
        { label: 'Close Session', accelerator: 'CmdOrCtrl+W', registerAccelerator: false, click: () => a.command('close-session') },
        { role: 'close', label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W' },
        ...(mac ? [] : [{ role: 'quit', label: 'Quit bizzi' } satisfies MenuItemConstructorOptions]),
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Machines', accelerator: 'CmdOrCtrl+1', click: () => a.navigate(MENU_ROUTES.machines) },
        { label: 'Inbox', accelerator: 'CmdOrCtrl+2', click: () => a.navigate(MENU_ROUTES.inbox) },
        { label: 'Knowledge', accelerator: 'CmdOrCtrl+3', click: () => a.navigate(MENU_ROUTES.knowledge) },
        sep,
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        sep,
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        sep,
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Go',
      submenu: [
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => a.back() },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => a.forward() },
      ],
    },
    // Spelled out: the stock Window menu has Close (⌘W / Ctrl+W) on Windows and Linux, which would take ⌘W.
    {
      role: 'windowMenu',
      submenu: mac ? [{ role: 'minimize' }, { role: 'zoom' }, sep, { role: 'front' }] : [{ role: 'minimize' }],
    },
    {
      role: 'help',
      submenu: [
        { label: 'Show Core Log', click: () => a.showCoreLog() },
        { label: 'Open Data Folder', click: () => a.openDataDir() },
        ...(mac ? [] : [sep, updates, { role: 'about', label: 'About bizzi' } satisfies MenuItemConstructorOptions]),
      ],
    },
  ];
}
