// The environment `npm run` / `npx` give a script, and how to take it back out. No Node imports: the
// UI bundles this package too.
//
// A process started from an npm script (`npm run dev`, or an app reopened by one) inherits that
// script's environment: `npm_config_*` (including `npm_config_local_prefix`, which points npm at the
// package the script belongs to), `npm_package_*`, `npm_lifecycle_*`, `INIT_CWD`, and a PATH with the
// package's `node_modules/.bin` (and every parent's) in front. Passed on to agents, an `npm` or a
// binary run in some other workspace then acts on, or comes from, bizzi's checkout.

import { pathDelimiter } from './bin-path.ts';

/** True for a PATH entry npm adds for scripts: an absolute `…/node_modules/.bin` or its `node-gyp-bin`. */
export function isNpmScriptPathDir(dir: string): boolean {
  const d = dir.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!d.startsWith('/') && !/^[A-Za-z]:\//.test(d)) return false; // relative: the user's own (e.g. `./node_modules/.bin`)
  return /\/node_modules\/\.bin$/.test(d) || /\/@npmcli\/run-script\/lib\/node-gyp-bin$/.test(d);
}

/** Variables npm sets for scripts. npm's own are lowercase; `NPM_CONFIG_*` is what users set. */
export function isNpmScriptVar(name: string, env: Readonly<Record<string, string | undefined>> = {}): boolean {
  if (name.startsWith('npm_') || name === 'INIT_CWD') return true;
  // npm sets NODE to the node it runs, and COLOR, only for scripts; a user's own NODE/COLOR stay.
  if (name === 'NODE') return env.npm_node_execpath !== undefined && env.NODE === env.npm_node_execpath;
  if (name === 'COLOR') return env.npm_lifecycle_event !== undefined;
  return false;
}

export interface CleanedEnv {
  env: Record<string, string>;
  /** Variable names that were dropped. */
  removed: string[];
  /** PATH entries that were dropped (duplicates included). */
  removedPath: string[];
}

/**
 * A copy of `env` without npm's script variables, and with a PATH without the `node_modules/.bin`
 * dirs npm put in front (also deduplicated: nested scripts repeat them). Everything else, including
 * PATH order and relative PATH entries, is kept as it was.
 */
export function cleanNpmScriptEnv(
  env: Readonly<Record<string, string | undefined>>,
  delimiter: string = pathDelimiter(),
): CleanedEnv {
  const out: Record<string, string> = {};
  const removed: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (isNpmScriptVar(k, env)) removed.push(k);
    else out[k] = v;
  }
  const removedPath: string[] = [];
  if (out.PATH !== undefined) {
    const kept: string[] = [];
    for (const dir of out.PATH.split(delimiter)) {
      if (isNpmScriptPathDir(dir) || (dir && kept.includes(dir))) removedPath.push(dir);
      else kept.push(dir);
    }
    out.PATH = kept.join(delimiter);
  }
  return { env: out, removed, removedPath };
}
