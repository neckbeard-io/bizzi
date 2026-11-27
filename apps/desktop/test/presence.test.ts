import assert from 'node:assert/strict';
import { test } from 'node:test';
import { presenceFor, smokeOptions, smokePassed, smokeRoute, withRoute } from '../src/main/presence.ts';

test('presenceFor: smoke runs are headless unless asked otherwise', () => {
  assert.equal(presenceFor({}), 'foreground');
  assert.equal(presenceFor({ BIZZI_BACKGROUND: '1' }), 'background');
  assert.equal(presenceFor({ BIZZI_HEADLESS: '1' }), 'headless');
  assert.equal(presenceFor({ BIZZI_HEADLESS: '1', BIZZI_BACKGROUND: '1' }), 'headless');
  assert.equal(presenceFor({ BIZZI_SMOKE_MS: '1500' }), 'headless');
  assert.equal(presenceFor({ BIZZI_SMOKE_MS: '1500', BIZZI_HEADLESS: '0' }), 'foreground');
  assert.equal(presenceFor({ BIZZI_SMOKE_MS: '1500', BIZZI_HEADLESS: '0', BIZZI_BACKGROUND: '1' }), 'background');
});

test('smokeOptions reads the BIZZI_SMOKE_* switches', () => {
  assert.equal(smokeOptions({}), null);
  assert.deepEqual(smokeOptions({ BIZZI_SMOKE_MS: '800' }), { delayMs: 800, route: null, check: null, outDir: null, size: null });
  assert.deepEqual(
    smokeOptions({
      BIZZI_SMOKE_MS: 'soon',
      BIZZI_SMOKE_ROUTE: '/settings/appearance',
      BIZZI_SMOKE_EVAL: '  document.title  ',
      BIZZI_SMOKE_OUT: '/tmp/out',
      BIZZI_SMOKE_SIZE: '1440x900',
    }),
    { delayMs: 1500, route: '#/settings/appearance', check: 'document.title', outDir: '/tmp/out', size: { width: 1440, height: 900 } },
  );
  assert.equal(smokeOptions({ BIZZI_SMOKE_MS: '5', BIZZI_SMOKE_SIZE: 'big' })?.size, null);
});

test('smokeRoute normalizes routes and refuses anything else', () => {
  assert.equal(smokeRoute('#/s/abc'), '#/s/abc');
  assert.equal(smokeRoute('/s/abc'), '#/s/abc');
  assert.equal(smokeRoute('settings'), '#/settings');
  assert.equal(smokeRoute('javascript:alert(1)'), null);
  assert.equal(smokeRoute('#/a b'), null);
  assert.equal(smokeRoute(undefined), null);
});

test('withRoute puts the route in the hash', () => {
  assert.equal(withRoute('app://bizzi/index.html', null), 'app://bizzi/index.html');
  assert.equal(withRoute('app://bizzi/index.html', '#/settings'), 'app://bizzi/index.html#/settings');
  assert.equal(withRoute('http://localhost:5173/?mock=1', '#/s/x'), 'http://localhost:5173/?mock=1#/s/x');
});

test('smokePassed: needs a screenshot, and a check that neither threw nor returned false', () => {
  assert.equal(smokePassed({ screenshot: true, check: null }), true);
  assert.equal(smokePassed({ screenshot: false, check: null }), false);
  assert.equal(smokePassed({ screenshot: true, check: { value: 'bizzi' } }), true);
  assert.equal(smokePassed({ screenshot: true, check: { value: null } }), true);
  assert.equal(smokePassed({ screenshot: true, check: { value: false } }), false);
  assert.equal(smokePassed({ screenshot: true, check: { error: 'ReferenceError: x' } }), false);
});
