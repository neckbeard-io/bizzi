// Regenerates src/generated/ from the locally installed `codex` (the @openai/codex devDependency):
//
//   node scripts/generate-types.ts [path/to/codex]
//
// `codex app-server generate-ts` emits extensionless relative imports ("./Foo"), which Node's type
// stripping and our `nodenext` tsconfig reject, so every relative specifier is rewritten to end in
// `.ts` (directories become `/index.ts`). The Codex version is recorded in src/generated/VERSION.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(pkgDir, 'src', 'generated');
const codex = process.argv[2] ?? resolve(pkgDir, '..', '..', 'node_modules', '.bin', 'codex');

const version = execFileSync(codex, ['--version'], { encoding: 'utf8' }).trim();
const tmp = mkdtempSync(join(tmpdir(), 'bizzi-codex-gen-'));
try {
  execFileSync(codex, ['app-server', 'generate-ts', '--out', tmp], { stdio: 'inherit' });
  rmSync(outDir, { recursive: true, force: true });
  copyRewritten(tmp, outDir);
  writeFileSync(join(outDir, 'VERSION'), `${version}\n`);
  process.stdout.write(`generated types from ${version} into ${outDir}\n`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

function copyRewritten(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src)) {
    const from = join(src, name);
    const to = join(dst, name);
    if (statSync(from).isDirectory()) {
      copyRewritten(from, to);
      continue;
    }
    if (!name.endsWith('.ts')) continue;
    const text = readFileSync(from, 'utf8').replace(/from "(\.{1,2}\/[^"]*)"/g, (_m, spec: string) => {
      const target = join(dirname(from), spec);
      const fixed = existsSync(target) && statSync(target).isDirectory() ? `${spec}/index.ts` : `${spec}.ts`;
      return `from "${fixed}"`;
    });
    writeFileSync(to, text);
  }
}
