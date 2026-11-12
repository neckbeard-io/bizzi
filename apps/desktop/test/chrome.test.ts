import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CHROME, MAC_TITLEBAR_HEIGHT, OVERLAY_TITLEBAR_HEIGHT, parseChrome, titleBarFor, windowChromeOptions } from '../src/shared/chrome.ts';

const tokyo = { background: '#1a1b26', card: '#1f2030', sidebar: '#1f2030', foreground: '#c0caf5', dark: true };

test('title bar style per platform, with a native opt-out', () => {
  assert.deepEqual(titleBarFor('darwin', {}), { style: 'inset', height: MAC_TITLEBAR_HEIGHT });
  assert.deepEqual(titleBarFor('win32', {}), { style: 'overlay', height: OVERLAY_TITLEBAR_HEIGHT });
  assert.deepEqual(titleBarFor('linux', {}), { style: 'overlay', height: OVERLAY_TITLEBAR_HEIGHT });
  assert.deepEqual(titleBarFor('freebsd', {}), { style: 'native', height: 0 });
  assert.deepEqual(titleBarFor('darwin', { BIZZI_NATIVE_TITLEBAR: '1' }), { style: 'native', height: 0 });
});

test('window options: hidden title bar themed from the last colours', () => {
  assert.deepEqual(windowChromeOptions(titleBarFor('darwin', {}), tokyo), { backgroundColor: '#1a1b26', titleBarStyle: 'hidden' });
  assert.deepEqual(windowChromeOptions(titleBarFor('win32', {}), tokyo), {
    backgroundColor: '#1a1b26',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#1f2030', symbolColor: '#c0caf5', height: OVERLAY_TITLEBAR_HEIGHT },
  });
  assert.deepEqual(windowChromeOptions({ style: 'native', height: 0 }, DEFAULT_CHROME), { backgroundColor: DEFAULT_CHROME.background });
});

test('chrome colours from the renderer: exactly four #rrggbb colours and a boolean', () => {
  assert.deepEqual(parseChrome({ ...tokyo, background: '#1A1B26', extra: 'dropped' }), tokyo);
  assert.equal(parseChrome(null), null);
  assert.equal(parseChrome('#1a1b26'), null);
  assert.equal(parseChrome({ ...tokyo, dark: 'yes' }), null);
  assert.equal(parseChrome({ ...tokyo, card: undefined }), null);
  for (const bad of ['rgba(0,0,0,0.5)', '#fff', 'red', '#1a1b26; background: url(x)', '#1a1b2']) {
    assert.equal(parseChrome({ ...tokyo, sidebar: bad }), null, bad);
  }
});
