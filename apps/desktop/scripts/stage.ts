// Stages what electron-builder copies into the app's resources (see electron-builder.yml):
//
//   staging/ui/    packages/ui/dist (the production UI build), or a placeholder page
//   staging/core/  the core: root package files, packages/* (minus ui), apps/cli, production deps
//   staging/node/  the Node runtime that runs it (bin/node, or node.exe on Windows)
//   staging/core/core-id  a hash of core + node, so the app knows when a running core is out of date
//
// Builds for the host platform and arch only: the core's native addons (node-pty prebuilds) are
// installed for the machine running this, so each target is staged on its own runner (release.yml).
//
// Node: the official nodejs.org build of the exact version running this script, checked against
// SHASUMS256.txt and cached in .cache/node. The installed native addons then match its ABI.
//
//   BIZZI_VERSION=<version>      the version the staged core reports (release builds)
//   BIZZI_STAGE_NODE_DIR=<dir>   copy an extracted Node dist instead of downloading one
//   BIZZI_STAGE_NODE=0           skip the runtime (the app then needs a system Node >= 26)
//   BIZZI_STAGE_INSTALL=0        skip installing the core's dependencies
//   BIZZI_STAGE_CLAUDE_BINARY=1  keep the Claude Agent SDK's bundled `claude` (~300 MB per platform);
//                                by default the adapter runs the installed one bizzi provisions

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_ID_FILE } from '../src/core/copy.ts';

const appDir = fileURLToPath(new URL('..', import.meta.url));
const repo = join(appDir, '..', '..');
const staging = join(appDir, 'staging');
const cacheDir = join(appDir, '.cache', 'node');
const env = process.env;
const isWin = process.platform === 'win32';
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
for (const f of ['package.json', 'package-lock.json', 'tsconfig.base.json', 'LICENSE', 'NOTICE']) {
  if (existsSync(join(repo, f))) cpSync(join(repo, f), join(core, f));
}
for (const pkg of readdirSync(join(repo, 'packages'))) {
  if (pkg === 'ui') continue;
  cpSync(join(repo, 'packages', pkg), join(core, 'packages', pkg), { recursive: true, filter: skip });
}
cpSync(join(repo, 'apps', 'cli'), join(core, 'apps', 'cli'), { recursive: true, filter: skip });
log('core: copied sources');
// The core reports its CLI package's version (hello → serverVersion); releases stamp theirs in.
if (env['BIZZI_VERSION']) {
  const manifest = join(core, 'apps', 'cli', 'package.json');
  writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, 'utf8')), version: env['BIZZI_VERSION'] }, null, 2) + '\n');
  log(`core: version ${env['BIZZI_VERSION']}`);
}

// --- node runtime ---------------------------------------------------------------------------
const node = join(staging, 'node');
const nodeExe = join(node, isWin ? 'node.exe' : join('bin', 'node'));
if (env['BIZZI_STAGE_NODE_DIR']) {
  copyRuntime(env['BIZZI_STAGE_NODE_DIR']);
  log(`node: copied ${env['BIZZI_STAGE_NODE_DIR']}`);
} else if (env['BIZZI_STAGE_NODE'] === '0') {
  mkdirSync(node);
  writeFileSync(join(node, 'PLACEHOLDER.txt'), 'No Node runtime was staged; the app falls back to BIZZI_NODE or a system Node >= 26.\n');
  log('node: skipped (BIZZI_STAGE_NODE=0)');
} else {
  const dist = await officialNode(process.version, process.platform, process.arch);
  copyRuntime(dist);
  log(`node: ${process.version} (${process.platform}-${process.arch}) from nodejs.org`);
}

// --- core dependencies ----------------------------------------------------------------------
if (env['BIZZI_STAGE_INSTALL'] === '0') {
  log('core: dependencies not installed (BIZZI_STAGE_INSTALL=0)');
} else {
  log('core: npm ci --omit=dev --workspace @bizzi/cli');
  execFileSync(isWin ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', '--workspace', '@bizzi/cli'], {
    cwd: core,
    stdio: 'inherit',
    shell: isWin, // npm.cmd is a batch file
  });
  pruneCore();
}

// ---------------------------------------------------------------------------------------------

/** Keep only what runs: the node binary and its license (no npm, headers or docs). */
function copyRuntime(dist: string): void {
  mkdirSync(join(node, isWin ? '' : 'bin'), { recursive: true });
  cpSync(join(dist, isWin ? 'node.exe' : join('bin', 'node')), nodeExe);
  if (existsSync(join(dist, 'LICENSE'))) cpSync(join(dist, 'LICENSE'), join(node, 'LICENSE'));
}

/** Downloads (once) and verifies the official Node build; returns its extracted directory. */
async function officialNode(version: string, platform: NodeJS.Platform, arch: string): Promise<string> {
  const os = platform === 'win32' ? 'win' : platform;
  const base = `node-${version}-${os}-${arch}`;
  const file = `${base}.${platform === 'win32' ? 'zip' : 'tar.gz'}`;
  const dir = join(cacheDir, base);
  if (existsSync(join(dir, platform === 'win32' ? 'node.exe' : join('bin', 'node')))) return dir;

  mkdirSync(cacheDir, { recursive: true });
  const url = `https://nodejs.org/dist/${version}`;
  const sums = await (await fetchOk(`${url}/SHASUMS256.txt`)).text();
  const expected = sums.split('\n').find((l) => l.endsWith(`  ${file}`))?.split(' ')[0];
  if (!expected) throw new Error(`stage: ${file} is not listed in ${url}/SHASUMS256.txt`);
  const archive = Buffer.from(await (await fetchOk(`${url}/${file}`)).arrayBuffer());
  const actual = createHash('sha256').update(archive).digest('hex');
  if (actual !== expected) throw new Error(`stage: checksum mismatch for ${file}: ${actual} != ${expected}`);
  const archivePath = join(cacheDir, file);
  writeFileSync(archivePath, archive);
  // bsdtar (macOS, Windows 10+) and GNU tar both read .tar.gz. On Windows use System32's bsdtar,
  // which reads .zip; Git for Windows puts a GNU tar earlier on PATH that doesn't.
  const tar = platform === 'win32' ? join(env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  execFileSync(tar, ['-xf', archivePath, '-C', cacheDir], { stdio: 'inherit' });
  rmSync(archivePath);
  return dir;
}

async function fetchOk(url: string): Promise<Response> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`stage: GET ${url}: HTTP ${res.status}`);
  return res;
}

/**
 * Leaves no links in the staged tree. The workspace links in node_modules/@bizzi are replaced by
 * apps/cli/src/workspaces-hook.ts (installers copy links as real directories, and Node won't strip
 * types under node_modules), and .bin shims aren't needed.
 */
function pruneCore(): void {
  const modules = join(core, 'node_modules');
  rmSync(join(modules, '@bizzi'), { recursive: true, force: true });
  rmSync(join(modules, '.bin'), { recursive: true, force: true });
  for (const pkg of readdirSync(join(core, 'packages'))) rmSync(join(core, 'packages', pkg, 'node_modules', '.bin'), { recursive: true, force: true });
  if (env['BIZZI_STAGE_CLAUDE_BINARY'] !== '1') {
    const scope = join(modules, '@anthropic-ai');
    for (const name of existsSync(scope) ? readdirSync(scope) : []) {
      if (!name.startsWith('claude-agent-sdk-')) continue;
      rmSync(join(scope, name), { recursive: true, force: true });
      log(`core: dropped @anthropic-ai/${name} (the installed claude runs instead)`);
    }
  }
  log('core: dependencies installed');
}

// --- core id --------------------------------------------------------------------------------
// A content hash of what the core process runs (core sources, dependencies, the Node runtime). The
// app restarts a running core only when this changes, so a UI-only build or a release that only
// bumps the version leaves running sessions alone. The stamped version is left out of the hash.
const coreId = hashCore();
writeFileSync(join(core, CORE_ID_FILE), coreId + '\n');
log(`core: id ${coreId}`);

function hashCore(): string {
  const h = createHash('sha256');
  // Both places the stamped version lands: the CLI manifest and npm's hidden lockfile entry for it.
  const versionFile = join(core, 'apps', 'cli', 'package.json');
  const hiddenLock = join(core, 'node_modules', '.package-lock.json');
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && p !== join(core, CORE_ID_FILE)) {
        let data = readFileSync(p);
        if (p === versionFile) data = Buffer.from(JSON.stringify({ ...JSON.parse(data.toString('utf8')), version: '' }));
        if (p === hiddenLock) {
          const lock = JSON.parse(data.toString('utf8')) as { packages?: Record<string, { version?: string }> };
          if (lock.packages?.['apps/cli']) lock.packages['apps/cli'].version = '';
          data = Buffer.from(JSON.stringify(lock));
        }
        h.update(p.slice(staging.length).replaceAll('\\', '/')).update('\0').update(data).update('\0');
      }
    }
  };
  walk(core);
  walk(node);
  return h.digest('hex').slice(0, 16);
}
