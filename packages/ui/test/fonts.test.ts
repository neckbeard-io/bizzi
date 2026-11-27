import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUNDLED_MONO, cleanFontName, codeFontStack, fontVars, uiFontStack } from '../src/lib/fonts.ts';
import { mergePrefs, reconcilePrefs } from '../src/lib/prefs.ts';

test('code font defaults to the bundled JetBrains Mono, with no CSS-only keywords (xterm)', () => {
  for (const v of [undefined, '', '  ', 'JetBrains Mono', 'jetbrains mono', BUNDLED_MONO]) {
    const s = codeFontStack(v);
    assert.ok(s.startsWith(`'${BUNDLED_MONO}', 'JetBrains Mono', `), `${v} → ${s}`);
    assert.ok(s.endsWith('monospace'));
    assert.ok(!s.includes('ui-monospace'));
  }
  assert.ok(codeFontStack('system').startsWith("'SF Mono'"));
  assert.ok(codeFontStack('Fira Code').startsWith("'Fira Code', 'SF Mono'"));
});

test('interface font defaults to the platform font; JetBrains Mono and other names come first', () => {
  assert.equal(uiFontStack(undefined), uiFontStack('system'));
  assert.ok(uiFontStack('').startsWith('system-ui'));
  assert.ok(uiFontStack('JetBrains Mono').startsWith(`'${BUNDLED_MONO}'`));
  assert.ok(uiFontStack('Inter').startsWith("'Inter', system-ui"));
});

test('font names are cleaned so they cannot break out of the declaration', () => {
  assert.equal(cleanFontName("  Fira   Code'; } body { color: red "), 'Fira Code body color red');
  assert.equal(cleanFontName('"Cascadia Code"'), 'Cascadia Code');
  assert.equal(cleanFontName('M+ 1m & Co.'), 'M+ 1m & Co.');
  assert.equal(cleanFontName('x'.repeat(100)).length, 80);
  assert.ok(!codeFontStack("a'b").includes("a'b"));
  assert.deepEqual(Object.keys(fontVars('', '')), ['--bizzi-font-mono', '--bizzi-font-sans']);
});

test('font prefs sync like the theme: server wins, pending local changes go up, "" resets', () => {
  assert.deepEqual(mergePrefs({ codeFont: 'Hack' }, { codeFont: '' }), { codeFont: '' });
  const r = reconcilePrefs({ codeFont: 'Hack', uiFont: 'Inter' }, { codeFont: 'Iosevka' }, { uiFont: '' });
  assert.deepEqual(r.apply, { codeFont: 'Iosevka', uiFont: '' });
  assert.deepEqual(r.push, { uiFont: '' });
});
