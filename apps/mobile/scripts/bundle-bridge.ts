// Bundles src/bridge/install.ts into a single classic script (IIFE) for the staged web app.

import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const appDir = fileURLToPath(new URL('..', import.meta.url));

export interface BundleOptions {
  outfile: string;
  /** Compile in the push-registration stub (BIZZI_PUSH=1). */
  push?: boolean;
  minify?: boolean;
  sourcemap?: boolean;
}

export async function bundleBridge(opts: BundleOptions): Promise<void> {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  await build({
    absWorkingDir: appDir,
    entryPoints: ['src/bridge/install.ts'],
    outfile: opts.outfile,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    // Capacitor 8 minimums: iOS 15 (WKWebView = Safari 15), Android WebView = Chromium.
    target: ['safari15', 'chrome100'],
    define: {
      __BIZZI_PUSH__: opts.push ? 'true' : 'false',
      __BIZZI_BRIDGE_VERSION__: JSON.stringify(pkg.version),
    },
    minify: opts.minify ?? true,
    sourcemap: opts.sourcemap ?? false,
    legalComments: 'none',
    logLevel: 'warning',
  });
}
