// IPC between renderer (preload) and main: a one-shot synchronous read of the bootstrap data the
// preload exposes as `window.bizzi`, the theme's chrome colors after each theme change, and menu
// navigation. The renderer talks to the core directly over ws.

import type { TitleBar } from './chrome.ts';

export const IPC_BOOTSTRAP = 'bizzi:bootstrap';
/** Renderer → main, fire and forget: `ChromeColors` (validated in main with `parseChrome`). */
export const IPC_CHROME = 'bizzi:chrome';
/** Main → renderer: a UI hash route (`#/inbox`) picked from the application menu; the preload sets it. */
export const IPC_NAVIGATE = 'bizzi:navigate';
/**
 * Main → renderer: a menu command the UI runs where it is (`MENU_COMMANDS`); the preload re-dispatches it
 * as a `bizzi:command` window event. Same actions as the UI's hotkeys (Settings › Hotkeys).
 */
export const IPC_COMMAND = 'bizzi:command';

export const MENU_COMMANDS = ['new-workspace', 'new-session', 'close-session', 'group-by-state'] as const;
export type MenuCommand = (typeof MENU_COMMANDS)[number];

export function isMenuCommand(v: unknown): v is MenuCommand {
  return typeof v === 'string' && (MENU_COMMANDS as readonly string[]).includes(v);
}

/** A route the renderer may be sent to from the menu: a UI hash route (`#/…`), no scheme or host. */
export function isMenuRoute(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 200 && /^#\/[A-Za-z0-9/_.?=&%-]*$/.test(v);
}

export interface BizziConnection {
  url: string;
  token: string;
}

export interface Bootstrap {
  connection: BizziConnection | null;
  /** No connection yet, but the core is starting (or being replaced): the main process reloads the page once it's up. */
  coreStarting?: boolean;
  appVersion: string;
  /** System accent color as `rrggbbaa` (macOS, Windows), for the UI's Device theme; null elsewhere. */
  accentColor?: string | null;
  /** How the window draws its title bar, so the UI can reserve its themed strip. */
  titleBar?: TitleBar;
}
