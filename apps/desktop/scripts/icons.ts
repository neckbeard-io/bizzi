// `npm run icons -w @bizzi/desktop`: render the app and tray icons from assets/*.svg. The outputs are
// committed, so this only runs after an SVG changes. Needs rsvg-convert (librsvg) and, for icon.icns,
// macOS iconutil.
//
//   assets/icon.svg  -> assets/icon.png (1024, window/dock icon at runtime)
//                       build-resources/icon.png, icon.icns, icon.ico (electron-builder)
//   assets/tray.svg  -> assets/trayTemplate.png, trayTemplate@2x.png (macOS menu bar, template image)
//   assets/icon.svg  -> assets/tray.png, tray@2x.png (Windows / Linux tray, in color)
//
// Test builds (anything run from a checkout) wear the same bee with a red TEST ribbon across the
// corner, so they never pass for the installed app: assets/icon-test.png, tray-test.png,
// tray-test@2x.png (runtime) and build-resources/icon-test.icns (the macOS dev bundle, scripts/dev.ts).
// The ribbon is drawn here (testSvg), on top of icon.svg.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = fileURLToPath(new URL('..', import.meta.url));
const assets = join(appDir, 'assets');
const buildRes = join(appDir, 'build-resources');
mkdirSync(buildRes, { recursive: true });

const tmp = mkdtempSync(join(tmpdir(), 'bizzi-icons-'));
const testIcon = join(tmp, 'icon-test.svg');
writeFileSync(testIcon, testSvg(readFileSync(join(assets, 'icon.svg'), 'utf8')));

/** `svg` is a file in assets/ or an absolute path. */
function render(svg: string, size: number, out: string): void {
  execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), '-o', out, svg.startsWith('/') ? svg : join(assets, svg)]);
}

/** icon.svg with a red TEST ribbon across the tile's bottom-left corner, clipped to the tile. */
function testSvg(icon: string): string {
  const ribbon = `
  <clipPath id="testTile"><rect x="100" y="100" width="824" height="824" rx="186"/></clipPath>
  <g clip-path="url(#testTile)">
    <g transform="translate(236 788) rotate(45)">
      <rect x="-460" y="-78" width="920" height="156" fill="#dc2626"/>
      <rect x="-460" y="-78" width="920" height="12" fill="#fecaca" fill-opacity="0.7"/>
      <rect x="-460" y="66" width="920" height="12" fill="#7f1d1d" fill-opacity="0.7"/>
      <text x="0" y="37" text-anchor="middle" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-weight="800" font-size="104" letter-spacing="12" fill="#ffffff">TEST</text>
    </g>
  </g>
`;
  return icon.replace(/<\/svg>\s*$/, `${ribbon}</svg>\n`);
}

/** macOS .icns from an SVG, via an iconset and iconutil. */
function icns(svg: string, out: string): void {
  const set = join(tmp, `${Math.random().toString(36).slice(2)}.iconset`);
  mkdirSync(set);
  for (const s of [16, 32, 128, 256, 512]) {
    render(svg, s, join(set, `icon_${s}x${s}.png`));
    render(svg, s * 2, join(set, `icon_${s}x${s}@2x.png`));
  }
  execFileSync('iconutil', ['-c', 'icns', '-o', out, set]);
}

render('icon.svg', 1024, join(assets, 'icon.png'));
render('icon.svg', 1024, join(buildRes, 'icon.png'));
render('tray.svg', 16, join(assets, 'trayTemplate.png'));
render('tray.svg', 32, join(assets, 'trayTemplate@2x.png'));
render('icon.svg', 16, join(assets, 'tray.png'));
render('icon.svg', 32, join(assets, 'tray@2x.png'));
render(testIcon, 1024, join(assets, 'icon-test.png'));
render(testIcon, 16, join(assets, 'tray-test.png'));
render(testIcon, 32, join(assets, 'tray-test@2x.png'));

try {
  // .ico: PNG-compressed entries (Windows Vista and later read these).
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = sizes.map((s) => {
    const p = join(tmp, `ico-${s}.png`);
    render('icon.svg', s, p);
    return readFileSync(p);
  });
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((s, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(s >= 256 ? 0 : s, e);
    header.writeUInt8(s >= 256 ? 0 : s, e + 1);
    header.writeUInt16LE(1, e + 4); // color planes
    header.writeUInt16LE(32, e + 6); // bits per pixel
    header.writeUInt32LE(pngs[i]!.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += pngs[i]!.length;
  });
  writeFileSync(join(buildRes, 'icon.ico'), Buffer.concat([header, ...pngs]));

  if (process.platform === 'darwin') {
    icns('icon.svg', join(buildRes, 'icon.icns'));
    icns(testIcon, join(buildRes, 'icon-test.icns'));
  } else {
    process.stderr.write('icon.icns and icon-test.icns not rebuilt: iconutil needs macOS\n');
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
process.stdout.write('icons written to assets/ and build-resources/\n');
