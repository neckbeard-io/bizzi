// Resolving the `opencode` binary the same way for the probe and for `opencode serve`.

import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { agentSearchDirs } from '@bizzi/protocol';

function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * A bare name (no slash) resolved on `env.PATH` without project-local entries (a package's
 * `node_modules/.bin`, relative dirs: agentSearchDirs), so the probe and the server run the same
 * install whatever directory bizzi was started from. Paths, and names not found, come back as given.
 */
export function locateBinary(name: string, env: Record<string, string | undefined> = process.env): string {
  if (!name || name.includes('/') || name.includes('\\')) return name;
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
  for (const dir of agentSearchDirs((env.PATH ?? '').split(delimiter).filter(Boolean))) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return name;
}
