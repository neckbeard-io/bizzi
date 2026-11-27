// Builds the desktop app from this checkout, working tree as it is, and installs it over the bizzi you
// use day to day (/Applications/bizzi.app), skipping CI and the self-updater. macOS only.
//
//   npm run install:local                  build, then swap and relaunch
//   npm run install:local -- --skip-ui     reuse packages/ui/dist
//   npm run install:local -- --rollback    put back the bundle the last install replaced
//
// Options: --target <path/to/bizzi.app>, --delay <seconds> (before quitting, default 5), --no-launch.
//
// It installs your real app. Test builds (`npm run dev -w @bizzi/desktop`, apps/desktop/release) are
// still kept apart; this is the one deliberate way to put checkout code into the installed app.
//
// The swap runs in a detached script, like the updater's: the app quits (its core gives running
// turns up to 30 s to finish), the bundle is replaced, and the app is reopened. Run this from an
// agent inside that bizzi and the agent's tool call returns before the app quits. The session
// resumes after the relaunch.
//
// The version is <next release>-local.<UTC timestamp>, e.g. 0.1.2-local.202611261530. That sorts
// above 0.1.2-dev.N, so the Dev channel doesn't replace it with an older CI build, and below 0.1.2,
// so the next stable release is still offered. To go back to CI builds: `bash scripts/install.sh --dev`.
//
// The replaced bundle is kept in ~/.bizzi/local-install/previous.app (one level; with --target, in
// <target>.local-install/) and the swap is logged to ~/.bizzi/logs/local-install.log.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { bumpPatch, closedVersion } from './release/changelog.ts';

const repo = fileURLToPath(new URL('../', import.meta.url));
const home = homedir();
const logFile = join(home, '.bizzi', 'logs', 'local-install.log');
const log = (msg: string) => process.stderr.write(`install-local: ${msg}\n`);
function die(msg: string): never {
  log(msg);
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    target: { type: 'string' },
    delay: { type: 'string', default: '5' },
    'skip-ui': { type: 'boolean' },
    'no-launch': { type: 'boolean' },
    rollback: { type: 'boolean' },
  },
});

if (process.platform !== 'darwin') die('macOS only for now');

const target = values.target ?? ['/Applications/bizzi.app', join(home, 'Applications', 'bizzi.app')].find((p) => existsSync(p));
if (!target) die('no installed bizzi.app found; pass --target, or install one first with scripts/install.sh');
if (target.startsWith(repo)) die(`${target} is inside the checkout; that's a test build, not the installed app`);
// A --target gets its own backup next to it, so trying this on a scratch copy leaves yours alone.
const backupDir = values.target ? `${target}.local-install` : join(home, '.bizzi', 'local-install');
const backup = join(backupDir, 'previous.app');
const delay = Number(values.delay);
if (!Number.isFinite(delay) || delay < 0) die('--delay must be a non-negative number of seconds');

const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { cwd: repo, encoding: 'utf8' }).trim();
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

let staged: string;
let stageDir: string;
let label: string;

if (values.rollback) {
  if (!existsSync(backup)) die(`nothing to roll back to (${backup} doesn't exist)`);
  stageDir = mkdtempSync(join(tmpdir(), 'bizzi-local-'));
  staged = join(stageDir, 'bizzi.app');
  execFileSync('ditto', [backup, staged]);
  label = `rollback to ${appVersion(backup)}`;
} else {
  const closed = closedVersion(readFileSync(join(repo, 'CHANGELOG.md'), 'utf8'));
  const base = closed ? bumpPatch(closed) : '0.1.0';
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 12);
  const version = `${base}-local.${stamp}`;
  const commit = sh('git', ['rev-parse', '--short', 'HEAD']);
  const dirty = sh('git', ['status', '--porcelain']) !== '';
  label = `${version} (${commit}${dirty ? ' + uncommitted changes' : ''}, ${sh('git', ['branch', '--show-current']) || 'detached'})`;
  log(`building ${label}`);
  execFileSync('node', ['scripts/release/build-desktop.ts', '--version', version, '--app-only', ...(values['skip-ui'] ? ['--skip-ui'] : [])], {
    cwd: repo,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const release = join(repo, 'apps', 'desktop', 'release');
  const dir = readdirSync(release).find((d) => d.startsWith('mac') && existsSync(join(release, d, 'bizzi.app')));
  if (!dir) die('the build produced no bizzi.app');
  // Copy it out: the next build wipes apps/desktop/release, and the swap may still be waiting.
  stageDir = mkdtempSync(join(tmpdir(), 'bizzi-local-'));
  staged = join(stageDir, 'bizzi.app');
  execFileSync('ditto', [join(release, dir, 'bizzi.app'), staged]);
}

execFileSync('xattr', ['-cr', staged]);
execFileSync('codesign', ['--verify', '--deep', '--strict', staged]);
mkdirSync(backupDir, { recursive: true });
mkdirSync(join(home, '.bizzi', 'logs'), { recursive: true });

// Only this bundle's main process, not a test build or the helpers in Contents/Frameworks.
const mainExe = `${target}/Contents/MacOS/bizzi`;
const script = `#!/bin/bash
exec >>${shq(logFile)} 2>&1
echo "--- $(date): installing ${label.replace(/[`$"\\]/g, '')}"
TARGET=${shq(target)}
STAGED=${shq(staged)}
STAGE=${shq(stageDir)}
BACKUP=${shq(backup)}
sleep ${delay}
WAS_RUNNING=0
if pgrep -f ${shq(mainExe)} >/dev/null; then
  WAS_RUNNING=1
  echo "quitting bizzi"
  pkill -TERM -f ${shq(mainExe)} || true
  for _ in $(seq 1 900); do pgrep -f ${shq(mainExe)} >/dev/null || break; sleep 0.1; done
  if pgrep -f ${shq(mainExe)} >/dev/null; then echo "bizzi did not quit within 90 s; install abandoned"; rm -rf "$STAGE"; exit 1; fi
  sleep 0.5
fi
rm -rf "$BACKUP.old"
[ -e "$BACKUP" ] && mv "$BACKUP" "$BACKUP.old"
if ! mv "$TARGET" "$BACKUP"; then
  echo "could not move the old bundle aside"
  [ -e "$BACKUP.old" ] && mv "$BACKUP.old" "$BACKUP"
  rm -rf "$STAGE"
  [ "$WAS_RUNNING" = 1 ] && open "$TARGET"
  exit 1
fi
if ! mv "$STAGED" "$TARGET" 2>/dev/null && ! ditto "$STAGED" "$TARGET"; then
  echo "could not install the new bundle; restoring the old one"
  rm -rf "$TARGET"
  mv "$BACKUP" "$TARGET"
  [ -e "$BACKUP.old" ] && mv "$BACKUP.old" "$BACKUP"
  rm -rf "$STAGE"
  [ "$WAS_RUNNING" = 1 ] && open "$TARGET"
  exit 1
fi
rm -rf "$BACKUP.old" "$STAGE"
echo "installed; previous bundle kept in $BACKUP"
${values['no-launch'] ? '' : 'open "$TARGET"\n'}echo "done"
`;
const scriptPath = join(backupDir, 'swap.sh');
writeFileSync(scriptPath, script, { mode: 0o755 });
spawn('/bin/bash', [scriptPath], { detached: true, stdio: 'ignore' }).unref();

log(`staged ${label}`);
log(`in ${delay} s bizzi quits (running turns get up to 30 s), ${target} is replaced${values['no-launch'] ? '' : ' and reopened'}`);
log(`log: ${logFile}  ·  undo: npm run install:local -- --rollback`);

function appVersion(app: string): string {
  try {
    return sh('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(app, 'Contents', 'Info.plist')]);
  } catch {
    return 'the previous bundle';
  }
}
