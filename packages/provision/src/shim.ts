// See through symlinks and wrapper shims to the binary that actually runs (spec §7 "Install method
// and migration"). Terminal apps put tiny shell scripts named after an agent first on PATH (e.g. a
// `claude` shim that execs the app's wrapper, which in turn execs the next `claude` on PATH). The
// install method is a property of that final binary, not of the shim.

import { closeSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { isExecutable } from './path.ts';

export interface ResolveOptions {
  /** PATH-order directories used when a shim execs a bare command (`exec claude "$@"`) or can't be parsed. */
  searchDirs?: string[];
  /** Used to expand `$HOME` in shim scripts (default process.env.HOME). */
  home?: string;
  /** Stop at the first real path for which this returns true (e.g. it matches a recipe pathHint). */
  stopAt?: (realPath: string) => boolean;
  /** Maximum number of hops (default 8). */
  maxDepth?: number;
}

export interface ResolvedExecutable {
  /** The path we started from. */
  path: string;
  /** Final executable after symlinks and shims. */
  realPath: string;
  /** Every real path visited, in order (the start's real path first). */
  chain: string[];
  /** At least one wrapper script was seen through. */
  viaShim: boolean;
  /** The final path is itself a wrapper script whose target could not be determined. */
  unresolved?: boolean;
}

const MAX_SCRIPT_BYTES = 256 * 1024;
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'mksh']);
const INTERPRETERS = new Set([...SHELLS, 'env', 'node', 'python', 'python3', 'perl', 'ruby', 'bun', 'deno', 'osascript']);

function safeRealpath(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

/** The script text when `p` is a POSIX shell script (`#!/bin/sh`, `#!/usr/bin/env bash`, …). */
export function readShellScript(p: string): string | undefined {
  let fd: number | undefined;
  try {
    const st = statSync(p);
    if (!st.isFile() || st.size > MAX_SCRIPT_BYTES || st.size < 3) return undefined;
    fd = openSync(p, 'r');
    const buf = Buffer.alloc(st.size);
    readSync(fd, buf, 0, st.size, 0);
    if (buf[0] !== 0x23 || buf[1] !== 0x21) return undefined; // "#!"
    const text = buf.toString('utf8');
    const shebang = text.slice(2, text.indexOf('\n') >>> 0).trim().split(/\s+/);
    let interp = basename(shebang[0] ?? '');
    if (interp === 'env') interp = basename(shebang.find((a, i) => i > 0 && !a.startsWith('-')) ?? '');
    return SHELLS.has(interp) ? text : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Literal `name=value` / `name="value"` / `export name='value'` assignments (no command substitution). */
function assignments(script: string): Map<string, string> {
  const vars = new Map<string, string>();
  const re = /^[ \t]*(?:export[ \t]+|local[ \t]+|readonly[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"`\\]*)"|'([^']*)'|([^\s;&|`'"()<>]+))[ \t]*(?:#.*)?$/gm;
  for (const m of script.matchAll(re)) {
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    // First assignment wins: later ones are usually conditional fallbacks.
    if (!vars.has(m[1] as string)) vars.set(m[1] as string, value);
  }
  return vars;
}

/** Expand `$NAME` / `${NAME}`; undefined when any variable is unknown. */
function expand(word: string, vars: Map<string, string>, home: string): string | undefined {
  let unknown = false;
  const out = word.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, a: string | undefined, b: string | undefined) => {
    const name = (a ?? b) as string;
    if (name === 'HOME') return home;
    const v = vars.get(name);
    if (v === undefined) {
      unknown = true;
      return '';
    }
    return v.replace(/\$\{?HOME\}?/g, home);
  });
  if (unknown || /[`$*?[]/.test(out)) return undefined;
  return out.startsWith('~/') ? join(home, out.slice(2)) : out;
}

/** The program word of each `exec` command in the script, in order (`exec env X` → X). */
export function execTargets(script: string): string[] {
  const out: string[] = [];
  const re = /(?:^|[;&|{(]|\bthen|\belse|\bdo)[ \t]*exec[ \t]+((?:-[a-z]+[ \t]+)*)("[^"]*"|'[^']*'|[^\s;&|()<>]+)((?:[ \t]+("[^"]*"|'[^']*'|[^\s;&|()<>]+))*)/gm;
  for (const m of script.matchAll(re)) {
    let word = unquote(m[2] as string);
    if (basename(word) === 'env') {
      // exec env [-i] [VAR=x …] prog args
      const rest = (m[3] ?? '').trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
      const prog = rest.map(unquote).find((a) => !a.startsWith('-') && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(a));
      if (!prog) continue;
      word = prog;
    }
    out.push(word);
  }
  return out;
}

function unquote(w: string): string {
  if ((w.startsWith('"') && w.endsWith('"')) || (w.startsWith("'") && w.endsWith("'"))) return w.slice(1, -1);
  return w;
}

/** Next executable named `name` on searchDirs whose real path hasn't been visited yet. */
function nextOnPath(name: string, dirs: string[], visited: Set<string>): string | undefined {
  for (const d of dirs) {
    const candidate = join(d, name);
    if (!isExecutable(candidate)) continue;
    const real = safeRealpath(candidate) ?? candidate;
    if (!visited.has(real) && !visited.has(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Resolve `path` through symlinks and simple wrapper shims:
 * - symlinks: `realpath`;
 * - shell scripts whose `exec` target is a literal path (or `$HOME`/literal-variable path): follow it;
 * - shell scripts that `exec <same name>` (re-exec the next one on PATH) or whose targets can't be
 *   determined: the next executable with the original name on `searchDirs`.
 * Non-shell scripts (node, python) and binaries are final. Never throws.
 */
export function resolveExecutable(path: string, opts: ResolveOptions = {}): ResolvedExecutable {
  const home = opts.home ?? process.env.HOME ?? '';
  const name = basename(path);
  const maxDepth = opts.maxDepth ?? 8;
  const chain: string[] = [];
  const visited = new Set<string>([path]);
  let current = path;
  let viaShim = false;
  for (let depth = 0; depth < maxDepth; depth++) {
    const real = safeRealpath(current) ?? current;
    chain.push(real);
    visited.add(real);
    visited.add(current);
    const done = (extra: Partial<ResolvedExecutable> = {}): ResolvedExecutable => ({ path, realPath: real, chain, viaShim, ...extra });
    if (opts.stopAt?.(real)) return done();
    const script = readShellScript(real);
    if (script === undefined) return done();

    const targets = execTargets(script);
    // A script that never execs anything is the program itself, not a wrapper.
    if (targets.length === 0) return done();
    const vars = assignments(script);
    let next: string | undefined;
    for (const word of targets) {
      if (!word.includes('/') && !word.includes('$')) {
        // `exec claude "$@"`: the shim strips itself from PATH and runs the next one.
        if (word === name) {
          next = nextOnPath(name, opts.searchDirs ?? [], visited);
          if (next) break;
        }
        continue; // some other command (an interpreter, a helper)
      }
      const target = expand(word, vars, home);
      if (!target) continue;
      const abs = isAbsolute(target) ? target : join(dirname(real), target);
      if (INTERPRETERS.has(basename(abs)) && basename(abs) !== name) continue;
      if (!isExecutable(abs)) continue;
      const absReal = safeRealpath(abs) ?? abs;
      if (visited.has(absReal)) continue;
      next = abs;
      break;
    }
    // A wrapper we can't read: assume it hands over to the next `name` on PATH.
    next ??= nextOnPath(name, opts.searchDirs ?? [], visited);
    if (!next) return done({ unresolved: true });
    viaShim = true;
    current = next;
  }
  return { path, realPath: chain.at(-1) ?? path, chain, viaShim, unresolved: true };
}
