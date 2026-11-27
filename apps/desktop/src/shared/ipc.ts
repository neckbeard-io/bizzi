// IPC between renderer (preload) and main: a one-shot synchronous read of the bootstrap data the
// preload exposes as `window.bizzi`, the theme's chrome colors after each theme change, and menu
// navigation. The renderer talks to the core directly over ws.

import type { TitleBar } from './chrome.ts';

export const IPC_BOOTSTRAP = 'bizzi:bootstrap';
/** Renderer → main, fire and forget: `ChromeColors` (validated in main with `parseChrome`). */
export const IPC_CHROME = 'bizzi:chrome';
/** Main → renderer: a UI hash route (`#/inbox`) picked from the application menu; the preload sets it. */
export const IPC_NAVIGATE = 'bizzi:navigate';

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
