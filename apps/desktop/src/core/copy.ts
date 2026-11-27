// The core runs from a copy outside the app bundle: `<dataDir>/core/<coreId>/{core,node}`.
//
// A packaged core used to run straight from the app's resources, so replacing the app (self-update,
// `npm run install:local`) meant stopping the core first, and every session's agent with it. From a
// copy, the old core keeps running while the bundle is swapped. The relaunched app then compares
// ids: the same id (a UI-only change, or a release that only bumps the version) means it attaches to
// the running core and nothing is interrupted. A different id means the core really changed and is
// restarted (manager.ts).
//
// The id is a content hash written at build time (scripts/stage.ts). macOS copies with APFS clones
// (`cp -c`), so a copy costs neither time nor space. Elsewhere it's a real copy (~200 MB), and only
// the current id and the running core's are kept. On Linux the copy also outlives the AppImage
// mount, which goes away when the app quits.
//
// Electron-free, so it is testable under plain Node.

import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const CORE_ID_FILE = 'core-id';
const COMPLETE = '.complete';

/** The id stamped into a staged core (`<resources>/core/core-id`), or null (dev runs, older builds). */
export function readCoreId(resourcesPath: string): string | null {
  try {
    const id = readFileSync(join(resourcesPath, 'core', CORE_ID_FILE), 'utf8').trim();
    return /^[0-9a-f]{8,64}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function copiesDir(dataDir: string): string {
  return join(dataDir, 'core');
}

export interface CopyDeps {
  /** Copies a directory tree; default: APFS clone on macOS, else fs.cpSync. */
  copyTree?: (from: string, to: string) => Promise<void>;
  platform?: NodeJS.Platform;
}

/**
 * Makes sure `<dataDir>/core/<coreId>/` holds this bundle's core and Node runtime, and returns that
 * directory (laid out like the app's resources, so the usual resolvers work on it). Copies into a
 * temp dir and renames it into place, so a crash mid-copy never leaves a half copy that looks done.
 */
export async function ensureCoreCopy(resourcesPath: string, dataDir: string, coreId: string, deps: CopyDeps = {}): Promise<string> {
  const target = join(copiesDir(dataDir), coreId);
  if (existsSync(join(target, COMPLETE))) return target;
  const copy = deps.copyTree ?? defaultCopyTree(deps.platform ?? process.platform);
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  rmSync(tmp, { recursive: true, force: true });
  try {
    mkdirSync(tmp, { recursive: true });
    for (const part of ['core', 'node']) {
      if (existsSync(join(resourcesPath, part))) await copy(join(resourcesPath, part), join(tmp, part));
    }
    writeFileSync(join(tmp, COMPLETE), new Date().toISOString() + '\n');
    rmSync(target, { recursive: true, force: true });
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
  return target;
}

/** Removes copies other than `keep` (the current id and the running core's), and stale temp dirs. */
export function pruneCoreCopies(dataDir: string, keep: readonly (string | null | undefined)[]): string[] {
  const dir = copiesDir(dataDir);
  if (!existsSync(dir)) return [];
  const removed: string[] = [];
  for (const name of readdirSync(dir)) {
    if (keep.includes(name)) continue;
    rmSync(join(dir, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

function defaultCopyTree(platform: NodeJS.Platform): (from: string, to: string) => Promise<void> {
  return async (from, to) => {
    if (platform === 'darwin') {
      // -c: clonefile(2), copy-on-write on APFS. Falls back to a plain copy on other volumes.
      try {
        await run('/bin/cp', ['-cR', from, to]);
        return;
      } catch {
        rmSync(to, { recursive: true, force: true });
      }
    }
    cpSync(from, to, { recursive: true, verbatimSymlinks: true });
  };
}

function run(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => execFile(file, args, (err) => (err ? reject(err) : resolve())));
}
