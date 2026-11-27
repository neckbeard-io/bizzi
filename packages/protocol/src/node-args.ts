// Node flags a child Node process must inherit to load bizzi's sources the way its parent did.
// Packaged desktop builds start the core with `--import <hook>` (apps/cli/src/workspaces-hook.ts),
// which resolves `@bizzi/*` without node_modules symlinks; the PTY supervisor and the knowledge MCP
// server are Node children that import the same packages, so they need the same hook.

/** The `--import` flags in `execArgv` (pass `process.execArgv`), in order, as argv entries. */
export function inheritedImportArgs(execArgv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < execArgv.length; i++) {
    const arg = execArgv[i]!;
    if (arg === '--import' && i + 1 < execArgv.length) {
      out.push(arg, execArgv[i + 1]!);
      i++;
    } else if (arg.startsWith('--import=')) {
      out.push(arg);
    }
  }
  return out;
}
