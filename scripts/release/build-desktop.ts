// Builds the desktop app for this machine's platform and arch into dist/, named the way the
// updater and the release page expect (assetSuffix in apps/desktop/src/update/github.ts):
//
//   bizzi-<v>-macos-<arm64|x64>.dmg      drag-to-install image
//   bizzi-<v>-macos-<arm64|x64>.zip      what installed copies update from
//   bizzi-<v>-linux-<x86_64|arm64>.AppImage
//   bizzi-<v>-linux-<amd64|arm64>.deb
//   bizzi-<v>-windows-x64-setup.exe
//
//   node scripts/release/build-desktop.ts --version 0.1.0 [--skip-ui]
//
// Run `npm ci` first. The core's native addons are installed for the host, so each target builds on
// its own machine (release.yml has one runner per platform/arch).

import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const desktop = join(repo, 'apps', 'desktop');
const release = join(desktop, 'release');
const dist = join(repo, 'dist');
const isWin = process.platform === 'win32';

const { values } = parseArgs({ options: { version: { type: 'string' }, 'skip-ui': { type: 'boolean' } } });
const version = values.version ?? '0.0.0-local';
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const log = (msg: string) => process.stderr.write(`build-desktop: ${msg}\n`);

function run(cmd: string, args: string[], cwd = repo, env: NodeJS.ProcessEnv = {}): void {
  log(`$ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: isWin, env: { ...process.env, ...env } });
}

const npm = isWin ? 'npm.cmd' : 'npm';
const npx = isWin ? 'npx.cmd' : 'npx';

mkdirSync(dist, { recursive: true });
rmSync(release, { recursive: true, force: true });
if (!values['skip-ui']) run(npm, ['run', 'build', '-w', '@bizzi/ui']);
run('node', ['scripts/build.ts', '--minify'], desktop);
run('node', ['scripts/stage.ts'], desktop, { BIZZI_VERSION: version });

const builder = [npx, 'electron-builder', '--publish', 'never', `-c.extraMetadata.version=${version}`, `--${arch}`] as const;
const base = `bizzi-${version}`;

if (process.platform === 'darwin') {
  // Unpacked app only: signing and the archives happen here, where the ad-hoc signature is checked.
  run(builder[0], [...builder.slice(1), '--mac', '--dir'], desktop, { CSC_IDENTITY_AUTO_DISCOVERY: 'false' });
  const dir = readdirSync(release).find((d) => d.startsWith('mac') && existsSync(join(release, d, 'bizzi.app')));
  if (!dir) throw new Error('build-desktop: electron-builder produced no bizzi.app');
  const app = join(release, dir, 'bizzi.app');
  // Ad-hoc signature: Apple Silicon refuses to run unsigned code, and the updater checks it
  // (codesign --verify) before swapping bundles. A Developer ID + notarization replaces this later.
  run('codesign', ['--force', '--deep', '--sign', '-', app]);
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  const zip = join(dist, `${base}-macos-${arch}.zip`);
  rmSync(zip, { force: true });
  run('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip]);
  const staging = mkdtempSync(join(tmpdir(), 'bizzi-dmg-'));
  run('ditto', [app, join(staging, 'bizzi.app')]);
  symlinkSync('/Applications', join(staging, 'Applications'));
  const dmg = join(dist, `${base}-macos-${arch}.dmg`);
  rmSync(dmg, { force: true });
  run('hdiutil', ['create', '-volname', 'bizzi', '-srcfolder', staging, '-ov', '-format', 'UDZO', dmg]);
  rmSync(staging, { recursive: true, force: true });
} else if (process.platform === 'linux') {
  run(builder[0], [...builder.slice(1), '--linux', 'AppImage', 'deb'], desktop);
  collect('.AppImage', `${base}-linux-${arch === 'arm64' ? 'arm64' : 'x86_64'}.AppImage`);
  collect('.deb', `${base}-linux-${arch === 'arm64' ? 'arm64' : 'amd64'}.deb`);
} else if (isWin) {
  run(builder[0], [...builder.slice(1), '--win', 'nsis'], desktop);
  collect('.exe', `${base}-windows-x64-setup.exe`);
} else {
  throw new Error(`build-desktop: no desktop build for ${process.platform}`);
}

await verifyPackagedCore();

log(`artifacts in ${dist}:`);
for (const f of readdirSync(dist)) log(`  ${f}`);

/** Copies the one electron-builder output with this extension to dist/ under its release name. */
function collect(ext: string, name: string): void {
  const found = readdirSync(release).filter((f) => f.endsWith(ext) && !f.includes('__uninstaller'));
  if (found.length !== 1) throw new Error(`build-desktop: expected one ${ext} in ${release}, found ${found.join(', ') || 'none'}`);
  copyFileSync(join(release, found[0]!), join(dist, name));
}

/**
 * Starts the core exactly as the packaged app would, from a copy outside the checkout: inside it,
 * Node would quietly fall back to the repo's node_modules and hide a dependency the app is missing.
 */
async function verifyPackagedCore(): Promise<void> {
  const resources = findResources(release);
  if (!resources) throw new Error(`build-desktop: no unpacked app with resources/core under ${release}`);
  const tmp = mkdtempSync(join(tmpdir(), 'bizzi-verify-'));
  try {
    cpSync(join(resources, 'core'), join(tmp, 'core'), { recursive: true });
    cpSync(join(resources, 'node'), join(tmp, 'node'), { recursive: true });
    const nodeBin = join(tmp, 'node', isWin ? 'node.exe' : join('bin', 'node'));
    const cli = join(tmp, 'core', 'apps', 'cli', 'src');
    const args = ['--import', pathToFileURL(join(cli, 'workspaces-hook.ts')).href, join(cli, 'main.ts'), 'serve', '--host', '127.0.0.1', '--port', '0', '--data-dir', join(tmp, 'data')];
    const ready = await new Promise<string>((resolve, reject) => {
      const child = spawn(nodeBin, args, { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`build-desktop: packaged core did not start in 60 s\n${err.slice(-2000)}`));
      }, 60_000);
      child.stderr.on('data', (d: Buffer) => (err += d));
      child.stdout.on('data', (d: Buffer) => {
        out += d;
        const line = out.split('\n').find((l) => l.includes('"event":"ready"'));
        if (line) {
          clearTimeout(timer);
          child.kill();
          resolve(line);
        }
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`build-desktop: packaged core exited (${code}) before its ready line\n${err.slice(-2000)}`));
      });
    });
    const parsed = JSON.parse(ready) as { url?: string };
    log(`packaged core starts on its own (${parsed.url})`);
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
  }
}

/** The unpacked app's resources directory (…/bizzi.app/Contents/Resources, …-unpacked/resources). */
function findResources(dir: string): string | null {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const base = join(dir, entry.name);
    for (const sub of ['resources', join('bizzi.app', 'Contents', 'Resources')]) {
      if (existsSync(join(base, sub, 'core', 'apps', 'cli'))) return join(base, sub);
    }
  }
  return null;
}
