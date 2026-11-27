// `npm run dev -w @bizzi/desktop`: bundle main/preload, then launch Electron on this package.
// Env passes through: BIZZI_UI_URL (Vite dev server), BIZZI_NODE, BIZZI_DATA_DIR, BIZZI_CORE_ENTRY, ...
//
// macOS takes the menu bar's app name and the Dock icon from the app bundle, not from the running
// code, so plain dev runs would say "Electron". We launch a cached copy of Electron.app named
// "bizzi test" with the TEST-ribboned bee instead (.dev-app/, rebuilt when Electron or the icon
// changes), so it never passes for the installed app. BIZZI_DEV_PLAIN_ELECTRON=1 skips that.
// Headless runs (BIZZI_HEADLESS=1, smoke checks; src/main/presence.ts) launch a background-only copy
// instead (.dev-app/bizzi-headless.app), so macOS never gives them a Dock icon or the focus, even
// for the moment before the app's own code runs.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { presenceFor } from '../src/main/presence.ts';
import { buildDesktop } from './build.ts';

const appDir = fileURLToPath(new URL('..', import.meta.url));
await buildDesktop();

const require = createRequire(import.meta.url);
// The `electron` package's main export is the path of the downloaded binary.
const electronPath = require('electron') as string;
const headless = presenceFor(process.env) === 'headless';
const binary = process.platform === 'darwin' && process.env['BIZZI_DEV_PLAIN_ELECTRON'] !== '1' ? macDevBundle(electronPath, headless) : electronPath;
// A headless run's throwaway Electron profile: made here and removed once Electron (helpers and
// all) has exited, since Chromium keeps writing to it while it shuts down.
const scratch = headless && !process.env['BIZZI_USER_DATA_DIR'] ? mkdtempSync(join(tmpdir(), 'bizzi-headless-')) : null;
const env = scratch ? { ...process.env, BIZZI_USER_DATA_DIR: scratch } : process.env;
const child = spawn(binary, [appDir, ...process.argv.slice(2)], { stdio: 'inherit', env });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => child.kill(sig));
}
child.on('exit', (code, signal) => {
  if (scratch) setTimeout(() => finish(code, signal), 500);
  else finish(code, signal);
});

function finish(code: number | null, signal: NodeJS.Signals | null): never {
  if (scratch) rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  process.exit(code ?? (signal ? 1 : 0));
}

/**
 * .dev-app/bizzi.app: Electron.app named "bizzi test" with the test icon; or, headless,
 * .dev-app/bizzi-headless.app, the same marked background-only. Returns its executable.
 */
function macDevBundle(electronBinary: string, headless: boolean): string {
  const source = dirname(dirname(dirname(electronBinary))); // …/Electron.app/Contents/MacOS/Electron
  const icns = join(appDir, 'build-resources', 'icon-test.icns');
  const name = 'bizzi test';
  const bundle = headless ? 'bizzi-headless' : 'bizzi';
  const dest = join(appDir, '.dev-app', `${bundle}.app`);
  const exe = join(dest, 'Contents', 'MacOS', 'Electron');
  const electronVersion = (require('electron/package.json') as { version: string }).version;
  const stamp = `${electronVersion} ${name} ${headless} ${createHash('sha256').update(readFileSync(icns)).digest('hex')}`;
  const stampFile = join(appDir, '.dev-app', headless ? 'stamp-headless' : 'stamp');
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
      ['CFBundleName', name],
      ['CFBundleDisplayName', name],
      ['CFBundleIdentifier', headless ? 'dev.bizzi.desktop.dev.headless' : 'dev.bizzi.desktop.dev'],
    ];
    for (const [key, value] of fields) {
      execFileSync('plutil', ['-replace', key, '-string', value, plist]);
    }
    if (headless) execFileSync('plutil', ['-replace', 'LSBackgroundOnly', '-bool', 'YES', plist]);
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
