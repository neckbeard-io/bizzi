// Resolves `@bizzi/*` to the workspace sources without node_modules symlinks:
//   node --import <this file> apps/cli/src/main.ts serve
//
// Packaged desktop builds need it. Node strips TypeScript types only outside node_modules, and in a
// dev checkout `node_modules/@bizzi/core` is a symlink whose real path is `packages/core`. Installers
// don't keep symlinks reliably (Windows NSIS copies their contents), and a copy under node_modules
// can't run. This hook maps each workspace package's name and `exports` onto its directory, so the
// staged core needs no links at all (apps/desktop/scripts/stage.ts). Child Node processes get the
// flag through `inheritedImportArgs` (@bizzi/protocol).

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

type Exports = string | Record<string, string> | undefined;

/** Workspace root: the directory holding packages/ and apps/ (two levels above apps/cli/src). */
const root = fileURLToPath(new URL('../../../', import.meta.url));

/** `@bizzi/core` → its package directory and exports map, for every workspace package present. */
export function workspacePackages(dir: string): Map<string, { dir: string; exports: Exports }> {
  const map = new Map<string, { dir: string; exports: Exports }>();
  for (const group of ['packages', 'apps']) {
    const base = join(dir, group);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      const manifest = join(base, name, 'package.json');
      if (!existsSync(manifest)) continue;
      const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string; exports?: Exports };
      if (pkg.name?.startsWith('@bizzi/')) map.set(pkg.name, { dir: join(base, name), exports: pkg.exports });
    }
  }
  return map;
}

/** The file a `@bizzi/...` specifier names, or null when it isn't a workspace package's export. */
export function resolveWorkspaceSpecifier(specifier: string, packages: Map<string, { dir: string; exports: Exports }>): string | null {
  const m = /^(@bizzi\/[^/]+)(\/.*)?$/.exec(specifier);
  if (!m) return null;
  const pkg = packages.get(m[1]!);
  if (!pkg) return null;
  const subpath = `.${m[2] ?? ''}`;
  const target = typeof pkg.exports === 'string' ? (subpath === '.' ? pkg.exports : undefined) : pkg.exports?.[subpath];
  return target ? join(pkg.dir, target) : null;
}

const packages = workspacePackages(root);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const file = resolveWorkspaceSpecifier(specifier, packages);
    if (file) return { url: pathToFileURL(file).href, format: 'module-typescript', shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
