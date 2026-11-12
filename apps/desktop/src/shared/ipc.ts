// IPC between renderer (preload) and main: a one-shot synchronous read of the bootstrap data the
// preload exposes as `window.bizzi`, and the theme's chrome colours after each theme change. The
// renderer talks to the core directly over ws.

import type { TitleBar } from './chrome.ts';

export const IPC_BOOTSTRAP = 'bizzi:bootstrap';
/** Renderer → main, fire and forget: `ChromeColors` (validated in main with `parseChrome`). */
export const IPC_CHROME = 'bizzi:chrome';

export interface BizziConnection {
  url: string;
  token: string;
}

export interface Bootstrap {
  connection: BizziConnection | null;
  appVersion: string;
  /** System accent colour as `rrggbbaa` (macOS, Windows), for the UI's Device theme; null elsewhere. */
  accentColor?: string | null;
  /** How the window draws its title bar, so the UI can reserve its themed strip. */
  titleBar?: TitleBar;
}
