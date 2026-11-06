// Bundles the Electron main and preload scripts into out/*.cjs with esbuild.
// (Node packages run TS directly; Electron's main/preload need a bundle: the sandboxed preload
// can't import modules, and the main process runs on Electron's Node.)

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

export async function buildDesktop(opts: { minify?: boolean } = {}): Promise<void> {
  await build({
    absWorkingDir: root,
    entryPoints: { main: 'src/main/index.ts', preload: 'src/preload/index.ts' },
    outdir: 'out',
    outExtension: { '.js': '.cjs' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24', // Electron 45's Node
    external: ['electron'],
    sourcemap: true,
    minify: opts.minify ?? false,
    logLevel: 'info',
  });
}

if (import.meta.main) {
  await buildDesktop({ minify: process.argv.includes('--minify') });
}
