// Which Node runs the core, and where the core's entry point is.
//
// Finding (Electron 45.2.3): the bundled Node is 24.22.2. Under ELECTRON_RUN_AS_NODE=1 it does run
// the core's .ts sources (type stripping is on by default) and `node:sqlite` works, but:
//   - it is Node 24, not >= 26 (our engines floor), and
//   - its native-module ABI is 150 (Electron) vs 147 (Node 26), so native addons in node_modules
//     built for the system Node (node-pty, ...) will not load, and vice versa.
// So the default is a real Node >= 26: BIZZI_NODE, a runtime bundled in the app resources
// (packaged builds), or one found on PATH / well-known install dirs (dev). Electron-as-Node stays
// available as an explicit opt-in (BIZZI_CORE_RUNTIME=electron) for when Electron ships Node >= 26
// and the staged core's native addons are rebuilt for Electron's ABI (tech-choices D0b).
//
// This is the single place to change that policy.

import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MIN_NODE_MAJOR = 26;

export type CoreRuntimeKind = 'env' | 'electron' | 'bundled' | 'system';

export interface CoreRuntime {
  kind: CoreRuntimeKind;
  /** Executable to spawn. */
  command: string;
  /** Extra environment for the child (e.g. ELECTRON_RUN_AS_NODE). */
  env: Record<string, string>;
  /** Node version the runtime reports, when known. */
  nodeVersion?: string;
}

export interface ResolveRuntimeOptions {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  isPackaged: boolean;
  /** Electron's `process.resourcesPath` (packaged builds). */
  resourcesPath?: string;
  /** Electron's executable (`process.execPath` in the main process). */
  execPath: string;
  /** Node version bundled in Electron (`process.versions.node` in the main process). */
  electronNodeVersion?: string;
  /** Returns the Node version an executable reports, or null. Injected by tests. */
  probe?: (command: string, env: Record<string, string>) => Promise<string | null>;
  isExecutable?: (file: string) => boolean;
}

export function nodeMajor(version: string | undefined | null): number {
  const m = /^v?(\d+)\./.exec(version ?? '');
  return m ? Number(m[1]) : 0;
}

export async function resolveCoreRuntime(o: ResolveRuntimeOptions): Promise<CoreRuntime> {
  const probe = o.probe ?? probeNodeVersion;
  const isExec = o.isExecutable ?? isExecutable;
  const tried: string[] = [];

  // 1. Explicit override.
  const explicit = o.env['BIZZI_NODE'];
  if (explicit) {
    const v = await probe(explicit, {});
    if (nodeMajor(v) < MIN_NODE_MAJOR) {
      throw new Error(`BIZZI_NODE=${explicit} reports Node ${v ?? '(no answer)'}; the core needs Node >= ${MIN_NODE_MAJOR}`);
    }
    return { kind: 'env', command: explicit, env: {}, nodeVersion: v ?? undefined };
  }

  // 2. Opt-in: Electron's own Node. Works for .ts + node:sqlite, but see the note above.
  if (o.env['BIZZI_CORE_RUNTIME'] === 'electron') {
    return {
      kind: 'electron',
      command: o.execPath,
      env: { ELECTRON_RUN_AS_NODE: '1' },
      nodeVersion: o.electronNodeVersion,
    };
  }

  // 3. Packaged builds: the Node runtime bundled in the app resources (see scripts/stage.ts).
  if (o.isPackaged && o.resourcesPath) {
    const bundled = o.platform === 'win32'
      ? join(o.resourcesPath, 'node', 'node.exe')
      : join(o.resourcesPath, 'node', 'bin', 'node');
    tried.push(bundled);
    if (isExec(bundled)) {
      const v = await probe(bundled, {});
      if (nodeMajor(v) >= MIN_NODE_MAJOR) return { kind: 'bundled', command: bundled, env: {}, nodeVersion: v ?? undefined };
    }
  }

  // 4. A system Node >= 26. GUI-launched macOS apps get a minimal PATH, hence the extra dirs.
  for (const candidate of systemNodeCandidates(o.env, o.platform)) {
    if (tried.includes(candidate) || !isExec(candidate)) continue;
    tried.push(candidate);
    const v = await probe(candidate, {});
    if (nodeMajor(v) >= MIN_NODE_MAJOR) return { kind: 'system', command: candidate, env: {}, nodeVersion: v ?? undefined };
  }

  throw new Error(
    `no Node >= ${MIN_NODE_MAJOR} found to run the bizzi core (tried: ${tried.join(', ') || 'nothing'}). ` +
      'Install Node 26+ or set BIZZI_NODE to its path.',
  );
}

export function systemNodeCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const exe = platform === 'win32' ? 'node.exe' : 'node';
  const dirs = (env['PATH'] ?? '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean);
  const home = env['HOME'] ?? homedir();
  if (platform !== 'win32') {
    dirs.push(
      '/opt/homebrew/bin',
      '/usr/local/bin',
      join(home, '.volta', 'bin'),
      join(home, '.local', 'share', 'mise', 'shims'),
      join(home, '.local', 'bin'),
    );
  }
  return [...new Set(dirs.map((d) => join(d, exe)))];
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function probeNodeVersion(command: string, env: Record<string, string>): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      command,
      ['-p', 'process.versions.node'],
      { timeout: 5000, env: { ...process.env, ...env }, windowsHide: true },
      (err, stdout) => resolve(err ? null : stdout.trim() || null),
    );
  });
}

// ---------------------------------------------------------------------------------------------

export interface CoreEntryOptions {
  env: NodeJS.ProcessEnv;
  isPackaged: boolean;
  resourcesPath?: string;
  /** Directory of the desktop app package (apps/desktop in dev). */
  appDir: string;
}

/** Path of the CLI entry (`apps/cli/src/main.ts`) that implements `bizzi serve`. */
export function resolveCoreEntry(o: CoreEntryOptions): string {
  const override = o.env['BIZZI_CORE_ENTRY'];
  if (override) return override;
  if (o.isPackaged && o.resourcesPath) return join(o.resourcesPath, 'core', 'apps', 'cli', 'src', 'main.ts');
  return join(o.appDir, '..', 'cli', 'src', 'main.ts');
}

/**
 * Node flags for the core. Packaged builds load apps/cli/src/workspaces-hook.ts first: the staged core
 * has no node_modules/@bizzi links (scripts/stage.ts), and the hook resolves those imports instead.
 */
export function coreNodeArgs(entry: string, exists: (file: string) => boolean = existsSync): string[] {
  const hook = join(dirname(entry), 'workspaces-hook.ts');
  return exists(hook) && !exists(join(dirname(entry), '..', '..', '..', 'node_modules', '@bizzi')) ? ['--import', pathToFileURL(hook).href] : [];
}

/** The data dir shared with a launchd `bizzi serve` on the same laptop. */
export function resolveDataDir(env: NodeJS.ProcessEnv): string {
  return env['BIZZI_DATA_DIR'] || join(env['HOME'] ?? homedir(), '.bizzi');
}
