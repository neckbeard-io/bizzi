// Stages what electron-builder copies into the app's resources (see electron-builder.yml):
//
//   staging/ui/    packages/ui/dist (the production UI build), or a placeholder page
//   staging/core/  the core sources: root package files, packages/* (minus ui), apps/cli
//   staging/node/  a Node >= 26 runtime for the target platform/arch (bin/node, or node.exe)
//
// Status: ui + core sources are real. Two steps are still stubs, by design for now:
//   1. Node runtime: copied from BIZZI_STAGE_NODE_DIR (an extracted nodejs.org dist, e.g.
//      node-v26.x-darwin-arm64/) when set; otherwise a placeholder. The plan is to download the
//      official tarball per target (darwin arm64/x64, linux x64/arm64, win x64), verify it against
//      SHASUMS256.txt, and extract it here, once per electron-builder target arch.
//   2. Core dependencies: `npm ci --omit=dev` inside staging/core with that *target* Node, so native
//      addons (node-pty, ...) match Node 26's ABI and the target arch. Enabled with
//      BIZZI_STAGE_INSTALL=1 (host platform only; cross-arch needs a per-arch CI runner).
// Signing/notarization of the bundled node binary comes with app signing (tech-choices: Packaging).

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = fileURLToPath(new URL('..', import.meta.url));
const repo = join(appDir, '..', '..');
const staging = join(appDir, 'staging');
const log = (msg: string) => process.stderr.write(`stage: ${msg}\n`);

rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

// --- ui -------------------------------------------------------------------------------------
const uiDist = join(repo, 'packages', 'ui', 'dist');
if (existsSync(join(uiDist, 'index.html'))) {
  cpSync(uiDist, join(staging, 'ui'), { recursive: true });
  log(`ui: copied ${uiDist}`);
} else {
  mkdirSync(join(staging, 'ui'));
  writeFileSync(
    join(staging, 'ui', 'index.html'),
    '<!doctype html><meta charset="utf-8"><title>bizzi</title><p style="font:14px system-ui;margin:2rem">bizzi UI was not built when this app was packaged.</p>\n',
  );
  log('ui: packages/ui/dist missing, wrote a placeholder (run `npm run build -w @bizzi/ui` first)');
}

// --- core sources ---------------------------------------------------------------------------
const core = join(staging, 'core');
const skip = (src: string) => !/[\\/](node_modules|test|dist|out|coverage)([\\/]|$)/.test(src.slice(repo.length));
for (const f of ['package.json', 'package-lock.json', 'tsconfig.base.json']) {
  if (existsSync(join(repo, f))) cpSync(join(repo, f), join(core, f));
}
for (const pkg of readdirSync(join(repo, 'packages'))) {
  if (pkg === 'ui') continue;
  cpSync(join(repo, 'packages', pkg), join(core, 'packages', pkg), { recursive: true, filter: skip });
}
if (existsSync(join(repo, 'apps', 'cli'))) {
  cpSync(join(repo, 'apps', 'cli'), join(core, 'apps', 'cli'), { recursive: true, filter: skip });
  log('core: copied sources');
} else {
  log('core: apps/cli missing in this checkout; staged packages only (the packaged app cannot start a core)');
}

// --- node runtime ---------------------------------------------------------------------------
const node = join(staging, 'node');
const nodeSrc = process.env['BIZZI_STAGE_NODE_DIR'];
if (nodeSrc) {
  cpSync(nodeSrc, node, { recursive: true, filter: (s) => !/[\\/](include|share)([\\/]|$)/.test(s.slice(nodeSrc.length)) });
  log(`node: copied ${nodeSrc}`);
} else {
  mkdirSync(node);
  writeFileSync(
    join(node, 'PLACEHOLDER.txt'),
    'Node >= 26 runtime goes here (bin/node or node.exe). Set BIZZI_STAGE_NODE_DIR to an extracted nodejs.org dist.\n' +
      'Without it the packaged app falls back to BIZZI_NODE or a system Node >= 26.\n',
  );
  log('node: no BIZZI_STAGE_NODE_DIR, wrote a placeholder (packaged app will need a system Node >= 26)');
}

// --- core dependencies ----------------------------------------------------------------------
if (process.env['BIZZI_STAGE_INSTALL'] === '1') {
  const npmNode = nodeSrc ? join(node, process.platform === 'win32' ? 'node.exe' : join('bin', 'node')) : process.execPath;
  log(`core: npm ci --omit=dev with ${npmNode}`);
  // NOTE: the root lockfile also lists workspaces that aren't staged (ui, desktop); expect to
  // need a pruned lockfile here once the core's dependency set settles.
  execFileSync('npm', ['ci', '--omit=dev', '--workspace', '@bizzi/cli'], {
    cwd: core,
    stdio: 'inherit',
    env: { ...process.env, PATH: `${join(npmNode, '..')}${process.platform === 'win32' ? ';' : ':'}${process.env['PATH']}` },
  });
} else {
  log('core: dependencies not installed (set BIZZI_STAGE_INSTALL=1)');
}
