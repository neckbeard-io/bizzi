import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { injectBridgeScript } from '../scripts/inject.ts';
import { stage } from '../scripts/stage.ts';

const VITE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>bizzi</title>
    <script src="./theme-init.js"></script>
    <script type="module" crossorigin src="./assets/index-abc.js"></script>
    <link rel="stylesheet" crossorigin href="./assets/index-abc.css">
  </head>
  <body><div id="root"></div></body>
</html>
`;

const TAG = '<script src="./native-bridge.js" data-bizzi-native-bridge></script>';

test('inserts the bridge before the first script, keeping indentation', () => {
  const out = injectBridgeScript(VITE_HTML);
  assert.ok(out.includes(`    ${TAG}\n    <script src="./theme-init.js"></script>`), out);
  assert.ok(out.indexOf('native-bridge.js') < out.indexOf('theme-init.js'));
  assert.ok(out.indexOf('native-bridge.js') < out.indexOf('type="module"'));
  // nothing else changed
  assert.equal(out.replace(`${TAG}\n    `, ''), VITE_HTML);
});

test('is idempotent', () => {
  const once = injectBridgeScript(VITE_HTML);
  assert.equal(injectBridgeScript(once), once);
});

test('falls back to the end of <head> when there are no scripts', () => {
  const html = '<html><head><title>x</title></head><body></body></html>';
  const out = injectBridgeScript(html);
  assert.ok(out.includes(`${TAG}\n</head>`), out);
});

test('uppercase tags are recognised', () => {
  const out = injectBridgeScript('<HTML><HEAD><SCRIPT SRC="a.js"></SCRIPT></HEAD></HTML>');
  assert.ok(out.indexOf('native-bridge.js') < out.indexOf('a.js'));
});

test('throws on HTML without <script> or </head>', () => {
  assert.throws(() => injectBridgeScript('<p>hello</p>'), /no <script> tag/);
});

test('escapes the src attribute', () => {
  assert.ok(injectBridgeScript(VITE_HTML, './a"b.js').includes('src="./a&quot;b.js"'));
});

test('stage: copies the UI build, drops source maps, bundles and injects the bridge', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'bizzi-mobile-stage-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const from = join(tmp, 'dist');
  const to = join(tmp, 'www');
  mkdirSync(join(from, 'assets'), { recursive: true });
  writeFileSync(join(from, 'index.html'), VITE_HTML);
  writeFileSync(join(from, 'theme-init.js'), '/* theme */');
  writeFileSync(join(from, 'assets', 'index-abc.js'), 'console.log(1)');
  writeFileSync(join(from, 'assets', 'index-abc.js.map'), '{}');
  mkdirSync(to);
  writeFileSync(join(to, 'stale.txt'), 'old');

  const { indexHtml } = await stage({ from, to });
  assert.ok(indexHtml.includes(TAG));
  assert.equal(readFileSync(join(to, 'index.html'), 'utf8'), indexHtml);
  assert.ok(existsSync(join(to, 'assets', 'index-abc.js')));
  assert.ok(!existsSync(join(to, 'assets', 'index-abc.js.map')), 'source maps are not shipped by default');
  assert.ok(!existsSync(join(to, 'stale.txt')), 'www is recreated');
  const bundle = readFileSync(join(to, 'native-bridge.js'), 'utf8');
  assert.ok(bundle.length > 1000);
  assert.ok(!/^\s*(import|export)\s/m.test(bundle), 'classic script, not a module');
  assert.ok(!bundle.includes('html5-qrcode'), 'scanner web fallback is not bundled');
  // packages/ui-style input is untouched
  assert.equal(readFileSync(join(from, 'index.html'), 'utf8'), VITE_HTML);

  await stage({ from, to, sourcemaps: true });
  assert.ok(existsSync(join(to, 'assets', 'index-abc.js.map')));
});

test('stage: fails with a helpful message when the UI was not built', async () => {
  await assert.rejects(stage({ from: join(tmpdir(), 'bizzi-no-such-dist'), to: join(tmpdir(), 'bizzi-unused') }), /Build the UI first/);
});
