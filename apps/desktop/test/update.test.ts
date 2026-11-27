import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseUpdateAction, type UpdateState } from '../src/shared/update.ts';
import { UpdateController, type PrefsStore, type UpdatePrefs } from '../src/update/controller.ts';
import { downloadAsset } from '../src/update/download.ts';
import { latestFor, matchAsset, releaseNotes, type Fetch, type GitHubRelease } from '../src/update/github.ts';
import { detectInstall, macSwapScript, relaunchEnv, shq, windowsInstallCommand, type InstallTarget } from '../src/update/install.ts';
import { compareSemver } from '../src/update/semver.ts';

test('compareSemver follows SemVer 2.0 precedence', () => {
  const order = ['0.1.0', '0.1.1-dev.1', '0.1.1-dev.2', '0.1.1-dev.10', '0.1.1', 'v0.2.0', '1.0.0'];
  for (let i = 1; i < order.length; i++) assert.ok(compareSemver(order[i]!, order[i - 1]!) > 0, `${order[i]} > ${order[i - 1]}`);
  assert.equal(compareSemver('v1.2.3', '1.2.3+abc'), 0);
  assert.ok(compareSemver('1.0.0-alpha', '1.0.0-1') > 0, 'alphanumeric outranks numeric');
  assert.ok(compareSemver('garbage', '0.0.1') < 0);
});

function rel(tag: string, o: Partial<GitHubRelease> = {}): GitHubRelease {
  const v = tag.slice(1);
  return {
    tag_name: tag,
    name: `bizzi ${tag}`,
    body: `### Added\n- thing in ${tag}\n\n---\n\nInstall instructions`,
    html_url: `https://github.com/neckbeard-io/bizzi/releases/tag/${tag}`,
    published_at: '2026-11-26T00:00:00Z',
    prerelease: tag.includes('-dev.'),
    draft: false,
    assets: [
      { name: `bizzi-${v}-macos-arm64.zip`, size: 10, browser_download_url: `https://dl/${v}/mac-arm64.zip` },
      { name: `bizzi-${v}-macos-arm64.dmg`, size: 12, browser_download_url: `https://dl/${v}/mac-arm64.dmg` },
      { name: `bizzi-${v}-linux-x86_64.AppImage`, size: 10, browser_download_url: `https://dl/${v}/x.AppImage` },
      { name: `bizzi-${v}-linux-amd64.deb`, size: 10, browser_download_url: `https://dl/${v}/x.deb` },
      { name: `bizzi-${v}-windows-x64-setup.exe`, size: 10, browser_download_url: `https://dl/${v}/setup.exe` },
    ],
    ...o,
  };
}

const RELEASES = [rel('v0.2.0-dev.2'), rel('v0.1.1'), rel('v0.2.0-dev.1'), rel('v0.1.0'), rel('v0.3.0', { draft: true })];

test('latestFor: stable skips pre-releases and drafts, dev takes the newest of everything', () => {
  assert.equal(latestFor(RELEASES, 'stable', '0.1.0')?.release.tag_name, 'v0.1.1');
  assert.equal(latestFor(RELEASES, 'dev', '0.1.0')?.release.tag_name, 'v0.2.0-dev.2');
  assert.equal(latestFor([], 'dev', '0.1.0'), null);
});

test('latestFor aggregates the notes of every newer release, newest first', () => {
  const c = latestFor(RELEASES, 'dev', '0.1.1')!;
  assert.match(c.notes, /^## v0\.2\.0-dev\.2\n### Added\n- thing in v0\.2\.0-dev\.2\n\n## v0\.2\.0-dev\.1\n/);
  assert.doesNotMatch(c.notes, /v0\.1\.1|Install instructions/);
  assert.equal(latestFor(RELEASES, 'dev', '0.2.0-dev.1')!.notes, '### Added\n- thing in v0.2.0-dev.2', 'one newer: its own notes');
});

test('releaseNotes cuts the standing footer', () => {
  assert.equal(releaseNotes('a\r\n\r\n---\r\n\r\nfooter'), 'a');
  assert.equal(releaseNotes(null), '');
});

test('matchAsset picks the file for the install method and arch', () => {
  const r = rel('v0.1.1');
  assert.equal(matchAsset(r, 'mac-app', 'arm64')?.name, 'bizzi-0.1.1-macos-arm64.zip');
  assert.equal(matchAsset(r, 'mac-app', 'x64'), null);
  assert.equal(matchAsset(r, 'appimage', 'x64')?.name, 'bizzi-0.1.1-linux-x86_64.AppImage');
  assert.equal(matchAsset(r, 'deb', 'x64')?.name, 'bizzi-0.1.1-linux-amd64.deb');
  assert.equal(matchAsset(r, 'nsis', 'x64')?.name, 'bizzi-0.1.1-windows-x64-setup.exe');
  assert.equal(matchAsset(r, 'unsupported', 'x64'), null);
});

test('detectInstall', () => {
  const base = { isPackaged: true, env: {}, writable: () => true };
  assert.equal(detectInstall({ ...base, isPackaged: false, platform: 'darwin', execPath: '/x' }).method, 'unsupported');
  const mac = detectInstall({ ...base, platform: 'darwin', execPath: '/Applications/bizzi.app/Contents/MacOS/bizzi' });
  assert.deepEqual([mac.method, mac.path], ['mac-app', '/Applications/bizzi.app']);
  const translocated = detectInstall({ ...base, platform: 'darwin', execPath: '/private/var/folders/x/AppTranslocation/y/d/bizzi.app/Contents/MacOS/bizzi' });
  assert.equal(translocated.method, 'unsupported');
  assert.match(translocated.hint ?? '', /Applications/);
  assert.equal(detectInstall({ ...base, writable: () => false, platform: 'darwin', execPath: '/Applications/bizzi.app/Contents/MacOS/bizzi' }).method, 'unsupported');
  const appImage = detectInstall({ ...base, platform: 'linux', env: { APPIMAGE: '/home/u/bizzi.AppImage' }, execPath: '/tmp/.mount_x/bizzi' });
  assert.deepEqual([appImage.method, appImage.path], ['appimage', '/home/u/bizzi.AppImage']);
  assert.equal(detectInstall({ ...base, platform: 'linux', execPath: '/opt/bizzi/bizzi' }).method, 'deb');
  assert.equal(detectInstall({ ...base, platform: 'win32', execPath: 'C:\\Users\\u\\AppData\\Local\\Programs\\bizzi\\bizzi.exe' }).method, 'nsis');
});

test('macSwapScript waits for the pid, keeps the old bundle until the new one is in, and quotes paths', () => {
  const s = macSwapScript({ pid: 42, staged: "/tmp/s/bizzi.app", target: "/Applications/it's bizzi.app", stageDir: '/tmp/s', logFile: '/l/update.log' });
  assert.match(s, /^PID=42$/m);
  assert.match(s, /TARGET='\/Applications\/it'\\''s bizzi\.app'/);
  assert.ok(s.indexOf('kill -0 "$PID"') < s.indexOf('mv "$TARGET" "$STAGE/previous.app"'));
  assert.match(s, /restoring the old one/);
  assert.match(s, /^open -n "\$TARGET"$/m, 'no overrides: a plain relaunch');
  const env = relaunchEnv({ BIZZI_DATA_DIR: "/d/it's", BIZZI_SMOKE_MS: '5', HOME: '/h' });
  assert.deepEqual(env, { BIZZI_DATA_DIR: "/d/it's" }, 'only launch overrides, never one-shot test switches');
  const withEnv = macSwapScript({ pid: 1, staged: '/s', target: '/t', stageDir: '/x', logFile: '/l', env });
  assert.match(withEnv, /^open -n --env 'BIZZI_DATA_DIR=\/d\/it'\\''s' "\$TARGET"$/m);
  assert.equal(shq("a'b"), `'a'\\''b'`);
  assert.equal(windowsInstallCommand(7, "C:\\t\\it's.exe"), "Wait-Process -Id 7 -Timeout 120 -ErrorAction SilentlyContinue; Start-Process -FilePath 'C:\\t\\it''s.exe' -ArgumentList '/S','--updated','--force-run'");
});

test('parseUpdateAction accepts only known actions', () => {
  assert.deepEqual(parseUpdateAction({ type: 'check' }), { type: 'check' });
  assert.deepEqual(parseUpdateAction({ type: 'channel', channel: 'dev' }), { type: 'channel', channel: 'dev' });
  assert.equal(parseUpdateAction({ type: 'channel', channel: 'nightly' }), null);
  assert.equal(parseUpdateAction({ type: 'autoCheck', enabled: 'yes' }), null);
  assert.equal(parseUpdateAction({ type: 'exec', cmd: 'rm' }), null);
  assert.equal(parseUpdateAction('check'), null);
});

// ---- downloads ---------------------------------------------------------------------------------

function body(bytes: Uint8Array): Response {
  return new Response(bytes, { headers: { 'content-length': String(bytes.byteLength) } });
}

test('downloadAsset writes the file and checks the sha256 digest', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bizzi-dl-'));
  const bytes = new TextEncoder().encode('new bizzi build');
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const fetchFn: Fetch = async () => body(bytes);
  const seen: number[] = [];
  const file = await downloadAsset({ fetch: fetchFn, asset: { name: 'a.zip', size: bytes.byteLength, browser_download_url: 'u', digest }, dir, onProgress: (r) => seen.push(r) });
  assert.equal(readFileSync(file, 'utf8'), 'new bizzi build');
  assert.equal(seen.at(-1), bytes.byteLength);
  await assert.rejects(
    downloadAsset({ fetch: fetchFn, asset: { name: 'b.zip', size: bytes.byteLength, browser_download_url: 'u', digest: 'sha256:00' }, dir }),
    /corrupt/,
  );
  await assert.rejects(downloadAsset({ fetch: async () => new Response('x', { status: 404 }), asset: { name: 'c', size: 1, browser_download_url: 'u' }, dir }), /HTTP 404/);
});

// ---- controller --------------------------------------------------------------------------------

function memoryPrefs(initial: Partial<UpdatePrefs> = {}): PrefsStore & { saved: UpdatePrefs[] } {
  const saved: UpdatePrefs[] = [];
  return { saved, load: () => initial, save: (p) => saved.push(p) };
}

function harness(o: { arch?: string; current?: string; releases?: () => Promise<GitHubRelease[]>; prefs?: PrefsStore; target?: InstallTarget; install?: (f: string) => Promise<'quit' | 'manual'> } = {}) {
  const states: UpdateState[] = [];
  const installs: string[] = [];
  let releases = o.releases ?? (async () => RELEASES);
  const fetchFn: Fetch = async () => Response.json(await releases());
  const c = new UpdateController({
    currentVersion: o.current ?? '0.1.0',
    arch: o.arch ?? 'arm64',
    target: o.target ?? { method: 'mac-app', label: 'macOS app', path: '/Applications/bizzi.app' },
    fetch: fetchFn,
    prefs: o.prefs ?? memoryPrefs(),
    downloadDir: mkdtempSync(join(tmpdir(), 'bizzi-upd-')),
    install: o.install ?? (async (f) => (installs.push(f), 'quit')),
    onState: (s) => states.push(s),
    log: () => {},
    download: async ({ asset }) => `/tmp/${asset.name}`,
    setTimer: () => ({ cancel() {} }),
  });
  return { c, states, installs, setReleases: (f: () => Promise<GitHubRelease[]>) => (releases = f) };
}

test('controller: check → available → download → ready → install', async () => {
  const h = harness();
  await h.c.check({ silent: false });
  assert.equal(h.states[0]?.stage, 'checking');
  assert.equal(h.c.state.stage, 'available');
  assert.equal(h.c.state.latest?.version, '0.1.1');
  assert.equal(h.c.state.asset?.name, 'bizzi-0.1.1-macos-arm64.zip');
  await h.c.act({ type: 'download' });
  assert.equal(h.c.state.stage, 'ready');
  await h.c.act({ type: 'install' });
  assert.equal(h.c.state.stage, 'installing');
  assert.deepEqual(h.installs, ['/tmp/bizzi-0.1.1-macos-arm64.zip']);
});

test('controller: up to date, and a pre-release build defaults to the dev channel', async () => {
  const h = harness({ current: '0.1.1' });
  await h.c.check({ silent: false });
  assert.equal(h.c.state.stage, 'up-to-date');
  assert.equal(h.c.state.channel, 'stable');
  const dev = harness({ current: '0.2.0-dev.1' });
  assert.equal(dev.c.state.channel, 'dev');
  await dev.c.check({ silent: false });
  assert.equal(dev.c.state.latest?.version, '0.2.0-dev.2');
});

test('controller: switching channel saves it and checks again', async () => {
  const prefs = memoryPrefs();
  const h = harness({ prefs, current: '0.1.1' });
  await h.c.act({ type: 'channel', channel: 'dev' });
  assert.deepEqual(prefs.saved.at(-1), { channel: 'dev', autoCheck: true });
  assert.equal(h.c.state.stage, 'available');
  assert.equal(h.c.state.latest?.version, '0.2.0-dev.2');
});

test('controller: a skipped version stays hidden from background checks only', async () => {
  const prefs = memoryPrefs();
  const h = harness({ prefs });
  await h.c.check({ silent: false });
  h.c.skip();
  assert.equal(prefs.saved.at(-1)?.skippedVersion, '0.1.1');
  await h.c.check({ silent: true });
  assert.equal(h.c.state.stage, 'idle');
  await h.c.check({ silent: false });
  assert.equal(h.c.state.stage, 'available');
});

test('controller: a failed background check changes nothing; a manual one reports it', async () => {
  const h = harness();
  await h.c.check({ silent: false });
  h.setReleases(async () => {
    throw new Error('fetch failed');
  });
  await h.c.check({ silent: true });
  assert.equal(h.c.state.stage, 'available');
  assert.equal(h.c.state.error, undefined);
  await h.c.check({ silent: false });
  assert.equal(h.c.state.stage, 'error');
  assert.match(h.c.state.error ?? '', /Couldn't reach GitHub/);
});

test('controller: no asset for this platform, and an unsupported install', async () => {
  const h = harness({ target: { method: 'unsupported', label: 'source checkout', hint: 'Running from a source checkout: update it with git.' } });
  await h.c.check({ silent: false });
  assert.equal(h.c.state.stage, 'available');
  assert.equal(h.c.state.asset, undefined);
  await h.c.act({ type: 'download' });
  assert.equal(h.c.state.stage, 'error');
  assert.match(h.c.state.error ?? '', /source checkout/);
});

test('controller: deb installs finish by hand, install failures are reported', async () => {
  const deb = harness({ arch: 'x64', target: { method: 'deb', label: '.deb package' }, install: async () => 'manual' });
  await deb.c.check({ silent: false });
  assert.equal(deb.c.state.asset?.name, 'bizzi-0.1.1-linux-amd64.deb');
  await deb.c.act({ type: 'download' });
  await deb.c.act({ type: 'install' });
  assert.equal(deb.c.state.stage, 'ready', 'the package installer takes over');
  const failing = harness({ install: async () => { throw new Error('codesign failed'); } });
  await failing.c.check({ silent: false });
  await failing.c.act({ type: 'download' });
  await failing.c.act({ type: 'install' });
  assert.equal(failing.c.state.stage, 'error');
  assert.match(failing.c.state.error ?? '', /Install failed: codesign failed/);
});
