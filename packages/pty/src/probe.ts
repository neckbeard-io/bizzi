// Binary lookup and version probing. Never throws.

import { execFile } from 'node:child_process';
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

/** Directories searched after $PATH (agents often install here without touching PATH). */
export function commonBinDirs(): string[] {
  const home = homedir();
  return [join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
}

function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find `name` on PATH, then in `extraDirs` (default: ~/.local/bin, /opt/homebrew/bin,
 * /usr/local/bin). Absolute paths are checked as-is.
 */
export function findBinary(
  name: string,
  opts: { path?: string; extraDirs?: string[] } = {},
): string | undefined {
  if (isAbsolute(name)) return isExecutableFile(name) ? name : undefined;
  const dirs = [...(opts.path ?? process.env.PATH ?? '').split(delimiter), ...(opts.extraDirs ?? commonBinDirs())];
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    const candidate = join(dir, name);
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

export interface VersionResult {
  version?: string;
  /** First output line, verbatim (trimmed). */
  raw?: string;
  error?: string;
  /** Exit code when the command failed (127: a wrapper/shim that cannot find the real binary). */
  exitCode?: number;
}

/** Run `<bin> --version` (or `args`) with a short timeout; extract a version number. */
export function readVersion(bin: string, args: string[] = ['--version'], timeoutMs = 5000): Promise<VersionResult> {
  return new Promise((resolve) => {
    try {
      execFile(
        bin,
        args,
        { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 256 * 1024, env: { ...process.env, NO_COLOR: '1' } },
        (err, stdout, stderr) => {
          const text = `${stdout ?? ''}\n${stderr ?? ''}`;
          const raw = text
            .split('\n')
            .map((l) => l.trim())
            .find((l) => l !== '');
          const m = /\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?/.exec(raw ?? '');
          if (err && !m) {
            const code = (err as NodeJS.ErrnoException).code;
            resolve({
              raw,
              error: raw ?? (err as Error).message.split('\n')[0],
              exitCode: typeof code === 'number' ? code : undefined,
            });
            return;
          }
          resolve({ version: m?.[0] ?? raw, raw });
        },
      );
    } catch (e) {
      resolve({ error: String(e) });
    }
  });
}
