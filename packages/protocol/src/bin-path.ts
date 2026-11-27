// Which PATH entries count when bizzi looks for an agent's binary. No Node imports: the UI bundles
// this package too.
//
// A project's `node_modules/.bin` is not an install. npm and npx put the one for the current package
// (and every parent dir) at the front of PATH for scripts, and a process started from such a script
// (`npm run …`, or an app reopened by one) passes it on to everything it spawns. A repo with an
// agent CLI as a dev dependency then shadows the real install, and which one wins depends on where
// bizzi was started from. Relative entries resolve against whatever cwd a lookup happens to run in.
// Neither is used to find agents; both stay on the PATH the agents themselves get.

/** The separator between PATH entries on the current platform. */
export function pathDelimiter(platform: string = typeof process !== 'undefined' ? process.platform : ''): string {
  return platform === 'win32' ? ';' : ':';
}

/**
 * True for PATH entries that are not a place agents are installed: a package's `node_modules/.bin`,
 * npm's script-only `node-gyp-bin`, or a relative directory.
 */
export function isProjectBinDir(dir: string): boolean {
  const d = dir.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!d) return true;
  if (!d.startsWith('/') && !/^[A-Za-z]:\//.test(d)) return true;
  const parts = d.split('/');
  for (let i = 1; i < parts.length; i++) {
    if (parts[i] === '.bin' && parts[i - 1] === 'node_modules') return true;
  }
  return /\/@npmcli\/run-script\/lib\/node-gyp-bin$/.test(d);
}

/** PATH entries without project-local ones (see isProjectBinDir), in order. */
export function agentSearchDirs(dirs: readonly string[]): string[] {
  return dirs.filter((d) => !isProjectBinDir(d));
}

/** A PATH string without project-local entries. */
export function agentSearchPath(path: string | undefined, delimiter: string = pathDelimiter()): string {
  return agentSearchDirs((path ?? '').split(delimiter)).join(delimiter);
}
