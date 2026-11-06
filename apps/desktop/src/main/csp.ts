// Content-Security-Policy for the renderer. Electron-free so it can be unit-tested.
//
// Production: only the app's own origin for code, plus the local core over ws/http on 127.0.0.1.
// Dev (Vite): additionally the dev server origin and its HMR websocket, and inline scripts for the
// React Refresh preamble Vite injects.

export interface CspOptions {
  /** Origin of the Vite dev server when loading BIZZI_UI_URL, e.g. http://localhost:5173. */
  devOrigin?: string;
  /** Extra connect-src entries (e.g. a hub URL for connected mode, later). */
  connect?: string[];
}

export function buildCsp(opts: CspOptions = {}): string {
  const dev = opts.devOrigin ? [opts.devOrigin] : [];
  const devWs = opts.devOrigin ? [opts.devOrigin.replace(/^http/, 'ws')] : [];
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': ["'self'", "'wasm-unsafe-eval'", ...dev, ...(opts.devOrigin ? ["'unsafe-inline'"] : [])],
    // Inline styles: CSS-in-JS from CodeMirror/xterm and React style props.
    'style-src': ["'self'", "'unsafe-inline'", ...dev],
    'img-src': ["'self'", 'data:', 'blob:', ...dev],
    'font-src': ["'self'", 'data:', ...dev],
    'connect-src': ["'self'", 'ws://127.0.0.1:*', 'http://127.0.0.1:*', ...dev, ...devWs, ...(opts.connect ?? [])],
    'worker-src': ["'self'", 'blob:', ...dev],
    'media-src': ["'self'", 'blob:'],
    'object-src': ["'none'"],
    'frame-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
    'frame-ancestors': ["'none'"],
  };
  return Object.entries(directives)
    .map(([k, v]) => `${k} ${v.join(' ')}`)
    .join('; ');
}
