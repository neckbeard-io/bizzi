// Apply the theme before first paint (no flash): mode from `bizzi.theme`, the last applied theme's
// tokens from `bizzi.theme.paint` (written by src/lib/theme/apply.ts via src/app/theme.ts), and the fonts.
try {
  var t = localStorage.getItem('bizzi.theme');
  var dark = t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  var root = document.documentElement;
  var cache = null;
  try {
    cache = JSON.parse(localStorage.getItem('bizzi.theme.paint') || 'null');
  } catch (e) {
    cache = null;
  }
  var entry = cache && cache[dark ? 'dark' : 'light'];
  if (entry && entry.vars) {
    for (var k in entry.vars) if (k.indexOf('--') === 0 && k.indexOf('--safety') !== 0) root.style.setProperty(k, entry.vars[k]);
    dark = !!entry.dark;
  }
  root.dataset.theme = dark ? 'dark' : 'light';
  if (cache && cache.density) root.dataset.density = cache.density;
  // Fonts from `bizzi.fonts.paint` (src/lib/fonts.ts).
  try {
    var fonts = JSON.parse(localStorage.getItem('bizzi.fonts.paint') || 'null');
    if (fonts) for (var f in fonts) if (f.indexOf('--bizzi-font-') === 0) root.style.setProperty(f, fonts[f]);
  } catch (e) {}
} catch (e) {
  document.documentElement.dataset.theme = 'light';
}
