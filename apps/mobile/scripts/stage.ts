// Stages the web app for Capacitor (webDir = www/):
//   1. copy packages/ui/dist → www/ (source maps left out unless --sourcemaps)
//   2. bundle src/bridge → www/native-bridge.js
//   3. inject <script src="./native-bridge.js"> into www/index.html before the UI's scripts
// packages/ui itself is never modified.
//
// Usage: node scripts/stage.ts [--sourcemaps]   (env BIZZI_PUSH=1 compiles in the push stub)

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleBridge } from './bundle-bridge.ts';
import { BRIDGE_FILE, injectBridgeScript } from './inject.ts';

export const appDir = fileURLToPath(new URL('..', import.meta.url));
export const repoDir = join(appDir, '..', '..');
export const uiDist = join(repoDir, 'packages', 'ui', 'dist');
export const webDir = join(appDir, 'www');

export interface StageOptions {
  from?: string;
  to?: string;
  sourcemaps?: boolean;
  push?: boolean;
}

export async function stage(opts: StageOptions = {}): Promise<{ webDir: string; indexHtml: string }> {
  const from = opts.from ?? uiDist;
  const to = opts.to ?? webDir;
  const index = join(from, 'index.html');
  if (!existsSync(index)) {
    throw new Error(`${index} not found. Build the UI first: npm run build:ui -w @bizzi/mobile`);
  }

  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  cpSync(from, to, {
    recursive: true,
    filter: (src) => opts.sourcemaps === true || !src.endsWith('.map'),
  });

  if (existsSync(join(to, BRIDGE_FILE))) throw new Error(`the UI build already contains ${BRIDGE_FILE}; refusing to overwrite it`);
  await bundleBridge({ outfile: join(to, BRIDGE_FILE), push: opts.push ?? false, sourcemap: opts.sourcemaps ?? false });

  const indexOut = join(to, 'index.html');
  const html = injectBridgeScript(readFileSync(indexOut, 'utf8'));
  writeFileSync(indexOut, html);
  return { webDir: to, indexHtml: html };
}

if (import.meta.main) {
  const push = process.env['BIZZI_PUSH'] === '1';
  const { webDir: out } = await stage({ sourcemaps: process.argv.includes('--sourcemaps'), push });
  console.log(`staged ${uiDist} -> ${out} (native bridge injected${push ? ', push stub ON' : ''})`);
}
