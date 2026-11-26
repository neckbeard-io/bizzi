// The application menu. Items that open a part of the UI send a hash route to the renderer
// (`MenuActions.navigate`, applied by the preload), so the menu needs no knowledge of the UI's state.

import type { MenuItemConstructorOptions } from 'electron';

export interface MenuActions {
  /** Show the window and open this UI route (`#/…`). */
  navigate(hash: string): void;
  back(): void;
  forward(): void;
  showCoreLog(): void;
  openDataDir(): void;
}

/** Hash routes the menu opens; the preload accepts only this shape (`isMenuRoute`, shared/ipc.ts). */
export const MENU_ROUTES = {
  ask: '#/ask',
  addWorkspace: '#/workspaces?add=1',
  devices: '#/settings/devices',
  settings: '#/settings',
  machines: '#/machines',
  inbox: '#/inbox',
  knowledge: '#/knowledge',
} as const;

export function appMenu(platform: NodeJS.Platform, a: MenuActions): MenuItemConstructorOptions[] {
  const mac = platform === 'darwin';
  const sep: MenuItemConstructorOptions = { type: 'separator' };
  const settings: MenuItemConstructorOptions = { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => a.navigate(MENU_ROUTES.settings) };
  return [
    ...(mac
      ? [
          {
            label: 'bizzi',
            submenu: [
              { role: 'about', label: 'About bizzi' },
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
        { label: 'New Prompt…', accelerator: 'CmdOrCtrl+N', click: () => a.navigate(MENU_ROUTES.ask) },
        { label: 'Add Workspace…', accelerator: 'CmdOrCtrl+Shift+N', click: () => a.navigate(MENU_ROUTES.addWorkspace) },
        { label: 'Pair a Device…', click: () => a.navigate(MENU_ROUTES.devices) },
        sep,
        ...(mac ? [] : [settings, sep]),
        { role: 'close' },
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
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Show Core Log', click: () => a.showCoreLog() },
        { label: 'Open Data Folder', click: () => a.openDataDir() },
        ...(mac ? [] : [sep, { role: 'about', label: 'About bizzi' } satisfies MenuItemConstructorOptions]),
      ],
    },
  ];
}
