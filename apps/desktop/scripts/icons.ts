// `npm run icons -w @bizzi/desktop`: render the app and tray icons from assets/*.svg. The outputs are
// committed, so this only runs after an SVG changes. Needs rsvg-convert (librsvg) and, for icon.icns,
// macOS iconutil.
//
//   assets/icon.svg  -> assets/icon.png (1024, window/dock icon at runtime)
//                       build-resources/icon.png, icon.icns, icon.ico (electron-builder)
//   assets/tray.svg  -> assets/trayTemplate.png, trayTemplate@2x.png (macOS menu bar, template image)
//   assets/icon.svg  -> assets/tray.png, tray@2x.png (Windows / Linux tray, in color)

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = fileURLToPath(new URL('..', import.meta.url));
const assets = join(appDir, 'assets');
const buildRes = join(appDir, 'build-resources');
mkdirSync(buildRes, { recursive: true });

function render(svg: string, size: number, out: string): void {
  execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), '-o', out, join(assets, svg)]);
}

render('icon.svg', 1024, join(assets, 'icon.png'));
render('icon.svg', 1024, join(buildRes, 'icon.png'));
render('tray.svg', 16, join(assets, 'trayTemplate.png'));
render('tray.svg', 32, join(assets, 'trayTemplate@2x.png'));
render('icon.svg', 16, join(assets, 'tray.png'));
render('icon.svg', 32, join(assets, 'tray@2x.png'));

const tmp = mkdtempSync(join(tmpdir(), 'bizzi-icons-'));
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
    const set = join(tmp, 'icon.iconset');
    mkdirSync(set);
    for (const s of [16, 32, 128, 256, 512]) {
      render('icon.svg', s, join(set, `icon_${s}x${s}.png`));
      render('icon.svg', s * 2, join(set, `icon_${s}x${s}@2x.png`));
    }
    execFileSync('iconutil', ['-c', 'icns', '-o', join(buildRes, 'icon.icns'), set]);
  } else {
    process.stderr.write('icon.icns not rebuilt: iconutil needs macOS\n');
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
process.stdout.write('icons written to assets/ and build-resources/\n');
