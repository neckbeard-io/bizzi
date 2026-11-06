// Where the renderer's UI comes from, and the `app://bizzi/` protocol that serves the production
// build (so absolute asset paths and SPA routes work, and responses carry our CSP header).

import { existsSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { net, protocol } from 'electron';

export const APP_SCHEME = 'app';
export const APP_ORIGIN = 'app://bizzi';

export type UiSource = { kind: 'dev'; url: string } | { kind: 'dir'; dir: string };

export function resolveUiSource(env: NodeJS.ProcessEnv, isPackaged: boolean, resourcesPath: string, appDir: string): UiSource {
  if (env['BIZZI_UI_URL']) return { kind: 'dev', url: env['BIZZI_UI_URL'] };
  if (env['BIZZI_UI_DIR']) return { kind: 'dir', dir: env['BIZZI_UI_DIR'] };
  if (isPackaged) return { kind: 'dir', dir: join(resourcesPath, 'ui') };
  return { kind: 'dir', dir: join(appDir, '..', '..', 'packages', 'ui', 'dist') };
}

export function uiEntryUrl(src: UiSource): string {
  return src.kind === 'dev' ? src.url : `${APP_ORIGIN}/index.html`;
}

/** Must run before `app.whenReady()`. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
  ]);
}

const FALLBACK_HTML = (dir: string) => `<!doctype html><meta charset="utf-8"><title>bizzi</title>
<body style="font:14px system-ui;margin:2rem;color:#333">
<h1>bizzi UI not built</h1>
<p>No <code>index.html</code> in <code>${dir.replace(/[<>&]/g, '')}</code>.</p>
<p>Run <code>npm run build -w @bizzi/ui</code>, or start the Vite dev server and set <code>BIZZI_UI_URL</code>.</p>
</body>`;

/** Serves `dir` at app://bizzi/. Unknown extension-less paths fall back to index.html (SPA). */
export function handleAppProtocol(dir: string, csp: string): void {
  const root = normalize(dir + sep);
  protocol.handle(APP_SCHEME, async (req) => {
    const url = new URL(req.url);
    if (url.host !== 'bizzi') return new Response('not found', { status: 404 });
    let rel: string;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      return new Response('bad request', { status: 400 });
    }
    let file = normalize(join(root, rel));
    if (!file.startsWith(root)) return new Response('forbidden', { status: 403 });
    if (!isFile(file)) {
      if (extname(file) !== '') return new Response('not found', { status: 404 });
      file = join(root, 'index.html');
    }
    const headers = new Headers({ 'content-security-policy': csp, 'x-content-type-options': 'nosniff' });
    if (!existsSync(file)) {
      headers.set('content-type', 'text/html; charset=utf-8');
      return new Response(FALLBACK_HTML(dir), { status: 200, headers });
    }
    const res = await net.fetch(pathToFileURL(file).toString());
    const type = res.headers.get('content-type');
    if (type) headers.set('content-type', type);
    return new Response(res.body, { status: res.status, headers });
  });
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
