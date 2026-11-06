// Capacitor config and the committed native projects agree on ids, scheme, permissions and
// "secure by default" networking.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const appDir = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(`${appDir}/${rel}`, 'utf8');

async function loadConfig(env: Record<string, string | undefined> = {}) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
  try {
    // Cache-bust so the env is re-read.
    const mod = (await import(`../capacitor.config.ts?${Math.random()}`)) as { default: import('@capacitor/cli').CapacitorConfig };
    return mod.default;
  } finally {
    process.env = saved;
  }
}

test('capacitor.config.ts: ids, webDir, schemes', async () => {
  const c = await loadConfig({ BIZZI_DEV_CLEARTEXT: undefined });
  assert.equal(c.appId, 'dev.bizzi.app');
  assert.equal(c.appName, 'bizzi');
  assert.equal(c.webDir, 'www');
  assert.equal(c.server?.androidScheme, 'https');
  assert.equal(c.server?.iosScheme, 'capacitor');
  assert.equal(c.server?.url, undefined, 'the app loads its bundled UI, never a remote URL');
  assert.equal(c.ios?.contentInset, 'never');
});

test('capacitor.config.ts: cleartext and mixed content are off unless BIZZI_DEV_CLEARTEXT=1', async () => {
  const prod = await loadConfig({ BIZZI_DEV_CLEARTEXT: undefined });
  assert.equal(prod.server?.cleartext, undefined);
  assert.equal(prod.android?.allowMixedContent, false);
  const dev = await loadConfig({ BIZZI_DEV_CLEARTEXT: '1' });
  assert.equal(dev.server?.cleartext, true);
  assert.equal(dev.android?.allowMixedContent, true);
});

test('package.json: workspace conventions and Capacitor 8', () => {
  const pkg = JSON.parse(read('package.json')) as {
    name: string;
    type: string;
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  assert.equal(pkg.name, '@bizzi/mobile');
  assert.equal(pkg.type, 'module');
  for (const s of ['typecheck', 'test', 'build:ui', 'stage', 'sync', 'build', 'build:ios:sim', 'build:android']) assert.ok(pkg.scripts[s], s);
  for (const d of ['@capacitor/core', '@capacitor/ios', '@capacitor/android']) assert.match(pkg.dependencies[d] ?? '', /^\^8\./, d);
  assert.match(pkg.devDependencies['@capacitor/cli'] ?? '', /^\^8\./);
});

test('iOS Info.plist: camera + local network strings, bizzi:// scheme, no ATS exceptions', () => {
  const plist = read('ios/App/App/Info.plist');
  assert.match(plist, /<key>NSCameraUsageDescription<\/key>\s*<string>[^<]{10,}<\/string>/);
  assert.match(plist, /<key>NSLocalNetworkUsageDescription<\/key>\s*<string>[^<]{10,}<\/string>/);
  assert.match(plist, /<key>CFBundleURLSchemes<\/key>\s*<array>\s*<string>bizzi<\/string>/);
  assert.doesNotMatch(plist, /NSAppTransportSecurity|NSAllowsArbitraryLoads/, 'ATS stays on by default');
});

test('iOS project: bundle id and push token forwarding', () => {
  assert.match(read('ios/App/App.xcodeproj/project.pbxproj'), /PRODUCT_BUNDLE_IDENTIFIER = dev\.bizzi\.app;/);
  const delegate = read('ios/App/App/AppDelegate.swift');
  assert.match(delegate, /capacitorDidRegisterForRemoteNotifications/);
  assert.match(delegate, /capacitorDidFailToRegisterForRemoteNotifications/);
});

test('AndroidManifest: camera, deep link, no cleartext, no backup', () => {
  const m = read('android/app/src/main/AndroidManifest.xml');
  assert.match(m, /<uses-permission android:name="android\.permission\.CAMERA" \/>/);
  assert.match(m, /<uses-feature android:name="android\.hardware\.camera" android:required="false" \/>/);
  assert.match(m, /<action android:name="android\.intent\.action\.VIEW" \/>[\s\S]*?<category android:name="android\.intent\.category\.BROWSABLE" \/>[\s\S]*?<data android:scheme="bizzi" android:host="pair" \/>/);
  assert.doesNotMatch(m, /usesCleartextTraffic="true"/);
  assert.match(m, /android:allowBackup="false"/);
});

test('Android gradle: application id and minSdk for the scanner', () => {
  assert.match(read('android/app/build.gradle'), /applicationId "dev\.bizzi\.app"/);
  const minSdk = Number(/minSdkVersion = (\d+)/.exec(read('android/variables.gradle'))?.[1]);
  assert.ok(minSdk >= 26, `minSdk ${minSdk}`);
});
