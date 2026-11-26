// `npm run dev -w @bizzi/desktop`: bundle main/preload, then launch Electron on this package.
// Env passes through: BIZZI_UI_URL (Vite dev server), BIZZI_NODE, BIZZI_DATA_DIR, BIZZI_CORE_ENTRY, ...
//
// macOS takes the menu bar's app name and the Dock icon from the app bundle, not from the running
// code, so plain dev runs would say "Electron". We launch a cached copy of Electron.app named bizzi
// with the bee icon instead (.dev-app/, rebuilt when Electron or the icon changes).
// BIZZI_DEV_PLAIN_ELECTRON=1 skips that.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDesktop } from './build.ts';

const appDir = fileURLToPath(new URL('..', import.meta.url));
await buildDesktop();

const require = createRequire(import.meta.url);
// The `electron` package's main export is the path of the downloaded binary.
const electronPath = require('electron') as string;
const binary = process.platform === 'darwin' && process.env['BIZZI_DEV_PLAIN_ELECTRON'] !== '1' ? macDevBundle(electronPath) : electronPath;
const child = spawn(binary, [appDir, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => child.kill(sig));
}
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});

/** .dev-app/bizzi.app: Electron.app with CFBundleName bizzi and the bee icon. Returns its executable. */
function macDevBundle(electronBinary: string): string {
  const source = dirname(dirname(dirname(electronBinary))); // …/Electron.app/Contents/MacOS/Electron
  const icns = join(appDir, 'build-resources', 'icon.icns');
  const dest = join(appDir, '.dev-app', 'bizzi.app');
  const exe = join(dest, 'Contents', 'MacOS', 'Electron');
  const electronVersion = (require('electron/package.json') as { version: string }).version;
  const stamp = `${electronVersion} ${createHash('sha256').update(readFileSync(icns)).digest('hex')}`;
  const stampFile = join(appDir, '.dev-app', 'stamp');
  if (existsSync(exe) && existsSync(stampFile) && readFileSync(stampFile, 'utf8') === stamp) return exe;

  try {
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dirname(dest), { recursive: true });
    try {
      execFileSync('cp', ['-cR', source, dest]); // APFS clone: instant, no extra space
    } catch {
      cpSync(source, dest, { recursive: true, verbatimSymlinks: true });
    }
    const plist = join(dest, 'Contents', 'Info.plist');
    const fields: [string, string][] = [
      ['CFBundleName', 'bizzi'],
      ['CFBundleDisplayName', 'bizzi'],
      ['CFBundleIdentifier', 'dev.bizzi.desktop.dev'],
    ];
    for (const [key, value] of fields) {
      execFileSync('plutil', ['-replace', key, '-string', value, plist]);
    }
    cpSync(icns, join(dest, 'Contents', 'Resources', 'electron.icns'));
    // Editing Info.plist breaks the bundle's seal; sign it again ad hoc so macOS keeps launching it.
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', dest], { stdio: 'ignore' });
    writeFileSync(stampFile, stamp);
    return exe;
  } catch (err) {
    process.stderr.write(`dev: could not prepare bizzi.app (${(err as Error).message}); launching plain Electron\n`);
    return electronBinary;
  }
}
