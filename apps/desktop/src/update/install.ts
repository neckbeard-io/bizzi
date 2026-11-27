// How this copy of bizzi replaces itself, per install method. Detection is pure (inputs injected);
// the installers spawn a detached helper that outlives the app, because a running app can't swap its
// own files on macOS or Windows. Quitting first lets the core drain (main's before-quit stops it).
//
//   mac-app   unzip the new .app, then after exit: move the old bundle aside, move the new one in
//             (restoring the old on failure), relaunch
//   appimage  write the new AppImage next to the running one, rename it over, relaunch after exit
//   nsis      after exit, run the NSIS installer silently; --force-run starts the new version
//   deb       open the package in the system installer (it needs root); nothing restarts

import { execFile, spawn } from 'node:child_process';
import { accessSync, chmodSync, constants, copyFileSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { InstallMethod } from '../shared/update.ts';

const run = promisify(execFile);

export interface InstallTarget {
  method: InstallMethod;
  label: string;
  /** What gets replaced: the .app bundle, the AppImage file; absent otherwise. */
  path?: string;
  hint?: string;
}

export interface DetectOptions {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  execPath: string;
  env: NodeJS.ProcessEnv;
  /** The checkout a test build runs from: it never updates itself (it would replace its own build). */
  testBuild?: string | null;
  writable?: (dir: string) => boolean;
}

export function detectInstall(o: DetectOptions): InstallTarget {
  const writable = o.writable ?? isWritable;
  if (!o.isPackaged) return { method: 'unsupported', label: 'source checkout', hint: 'Running from a source checkout: update it with git.' };
  if (o.testBuild) return { method: 'unsupported', label: 'test build', hint: `A test build from ${o.testBuild}: it never updates itself. Rebuild it instead.` };
  if (o.platform === 'darwin') {
    const i = o.execPath.indexOf('.app/');
    if (i === -1) return { method: 'unsupported', label: 'macOS', hint: 'bizzi is not running from an app bundle.' };
    const bundle = o.execPath.slice(0, i + 4);
    if (bundle.includes('/AppTranslocation/')) {
      return { method: 'unsupported', label: 'macOS app', hint: 'Move bizzi to the Applications folder and open it from there, so it can update itself.' };
    }
    if (!writable(dirname(bundle))) {
      return { method: 'unsupported', label: 'macOS app', hint: `bizzi can't write to ${dirname(bundle)}. Download new versions from the releases page.` };
    }
    return { method: 'mac-app', label: 'macOS app', path: bundle };
  }
  if (o.platform === 'linux') {
    const appImage = o.env['APPIMAGE'];
    if (appImage) {
      if (!writable(dirname(appImage))) {
        return { method: 'unsupported', label: 'AppImage', hint: `bizzi can't write to ${dirname(appImage)}. Download new versions from the releases page.` };
      }
      return { method: 'appimage', label: 'AppImage', path: appImage };
    }
    if (o.execPath.startsWith('/opt/')) {
      return { method: 'deb', label: '.deb package', hint: 'bizzi downloads the package and opens it in your software installer; or install it with sudo apt install <file>.' };
    }
    return { method: 'unsupported', label: 'Linux', hint: 'Unknown install layout. Download new versions from the releases page.' };
  }
  if (o.platform === 'win32') return { method: 'nsis', label: 'Windows installer' };
  return { method: 'unsupported', label: o.platform };
}

function isWritable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** POSIX shell single-quoting. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Launch overrides the new version must keep (where its data lives, which Node runs the core).
 * macOS relaunches through `open`, which starts from LaunchServices' environment, not ours.
 */
export const RELAUNCH_ENV = ['BIZZI_DATA_DIR', 'BIZZI_USER_DATA_DIR', 'BIZZI_NODE', 'BIZZI_CORE_RUNTIME', 'BIZZI_LOG_LEVEL'] as const;

export function relaunchEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of RELAUNCH_ENV) if (env[k]) out[k] = env[k]!;
  return out;
}

/** The detached macOS swap script: waits for bizzi to exit (the core drains for up to 30 s). */
export function macSwapScript(o: { pid: number; staged: string; target: string; stageDir: string; logFile: string; env?: Record<string, string> }): string {
  const envArgs = Object.entries(o.env ?? {}).map(([k, v]) => ` --env ${shq(`${k}=${v}`)}`).join('');
  return `#!/bin/bash
exec >>${shq(o.logFile)} 2>&1
echo "bizzi update: $(date)"
PID=${o.pid}
STAGED=${shq(o.staged)}
TARGET=${shq(o.target)}
STAGE=${shq(o.stageDir)}
for _ in $(seq 1 1200); do kill -0 "$PID" 2>/dev/null || break; sleep 0.1; done
if kill -0 "$PID" 2>/dev/null; then echo "bizzi (pid $PID) did not exit; update abandoned"; exit 1; fi
sleep 0.3
mv "$TARGET" "$STAGE/previous.app" || { echo "could not move the old bundle aside"; open "$TARGET"; exit 1; }
if ! mv "$STAGED" "$TARGET" 2>/dev/null && ! ditto "$STAGED" "$TARGET"; then
  echo "could not install the new bundle; restoring the old one"
  rm -rf "$TARGET"
  mv "$STAGE/previous.app" "$TARGET"
  open "$TARGET"
  exit 1
fi
xattr -cr "$TARGET" 2>/dev/null || true
open -n${envArgs} "$TARGET"
rm -rf "$STAGE"
rm -f "$0"
echo "bizzi update: done"
`;
}

/** PowerShell for Windows: wait for bizzi to exit, then run the installer silently and restart. */
export function windowsInstallCommand(pid: number, installer: string): string {
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  return `Wait-Process -Id ${pid} -Timeout 120 -ErrorAction SilentlyContinue; Start-Process -FilePath ${q(installer)} -ArgumentList '/S','--updated','--force-run'`;
}

export interface InstallOptions {
  target: InstallTarget;
  /** The downloaded asset. */
  file: string;
  pid: number;
  quit: () => void;
  openPath: (file: string) => Promise<string>;
  logFile: string;
  /** Environment the relaunched version needs (`relaunchEnv`); AppImage and Windows inherit ours. */
  env?: Record<string, string>;
}

/** Starts installing; returns 'quit' when bizzi is about to exit for it, 'manual' when the user finishes. */
export async function installUpdate(o: InstallOptions): Promise<'quit' | 'manual'> {
  switch (o.target.method) {
    case 'mac-app':
      await installMac(o);
      return 'quit';
    case 'appimage':
      installAppImage(o);
      return 'quit';
    case 'nsis':
      detached('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', windowsInstallCommand(o.pid, o.file)]);
      o.quit();
      return 'quit';
    case 'deb': {
      const err = await o.openPath(o.file);
      if (err) throw new Error(`Could not open the package (${err}). Install it with: sudo apt install ${o.file}`);
      return 'manual';
    }
    case 'unsupported':
      throw new Error(o.target.hint ?? 'This install of bizzi cannot update itself.');
  }
}

async function installMac(o: InstallOptions): Promise<void> {
  const target = o.target.path!;
  const stageDir = mkdtempSync(join(tmpdir(), 'bizzi-update-'));
  try {
    await run('ditto', ['-x', '-k', o.file, stageDir]);
    const app = readdirSync(stageDir).find((n) => n.endsWith('.app'));
    if (!app) throw new Error('The update archive has no .app bundle.');
    const staged = join(stageDir, app);
    await run('xattr', ['-cr', staged]).catch(() => {});
    // Refuse a bundle macOS would refuse to launch, before the old one is touched.
    await run('codesign', ['--verify', '--deep', staged]);
    const script = join(stageDir, 'swap.sh');
    writeFileSync(script, macSwapScript({ pid: o.pid, staged, target, stageDir, logFile: o.logFile, ...(o.env ? { env: o.env } : {}) }), { mode: 0o755 });
    detached('/bin/bash', [script]);
  } catch (err) {
    rmSync(stageDir, { recursive: true, force: true });
    throw err;
  }
  o.quit();
}

function installAppImage(o: InstallOptions): void {
  const target = o.target.path!;
  const next = `${target}.update`;
  copyFileSync(o.file, next);
  chmodSync(next, 0o755);
  // Replacing the file is safe while it runs: the running copy keeps the old inode.
  renameSync(next, target);
  detached('/bin/sh', ['-c', `while kill -0 ${o.pid} 2>/dev/null; do sleep 0.2; done; exec ${shq(target)}`]);
  o.quit();
}

function detached(command: string, args: string[]): void {
  spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}
