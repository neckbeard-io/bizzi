// Placeholder app icon: a white "b" on a violet square, drawn in code so no image tooling is needed.
// Writes resources/icon.png (1024, the source for `npx @capacitor/assets generate` once there is a
// real design), the iOS AppIcon and the Android launcher mipmaps. Re-run after `cap add`:
//   node scripts/icons.ts

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

const appDir = fileURLToPath(new URL('..', import.meta.url));

export const ICON_BACKGROUND = [0x5b, 0x3d, 0xf5] as const; // #5B3DF5
const FG = [0xff, 0xff, 0xff] as const;

/** Coverage (0..1) of the "b" glyph at normalized point (x, y) in a unit square. */
function glyph(x: number, y: number): number {
  const stem = x >= 0.33 && x <= 0.43 && y >= 0.2 && y <= 0.8 ? 1 : 0;
  const dx = x - 0.53;
  const dy = y - 0.6;
  const d = Math.sqrt(dx * dx + dy * dy);
  const ring = d <= 0.2 && d >= 0.1 ? 1 : 0;
  return Math.max(stem, ring);
}

type Shape = 'square' | 'circle' | 'foreground';

/** Render an RGBA (or RGB when opaque) image with 4x4 supersampling. */
export function renderIcon(size: number, shape: Shape, opaque = false): Buffer {
  const channels = opaque ? 3 : 4;
  const out = Buffer.alloc(size * size * channels);
  const ss = 4;
  // Adaptive-icon foregrounds are cropped to the middle ~61-66%; shrink the glyph into that zone.
  const scale = shape === 'foreground' ? 0.62 : 1;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let fg = 0;
      let inside = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) / size;
          const y = (py + (sy + 0.5) / ss) / size;
          const inShape = shape === 'circle' ? Math.hypot(x - 0.5, y - 0.5) <= 0.5 : true;
          if (!inShape) continue;
          inside++;
          fg += glyph((x - 0.5) / scale + 0.5, (y - 0.5) / scale + 0.5);
        }
      }
      const n = ss * ss;
      const fgA = fg / n;
      const i = (py * size + px) * channels;
      if (shape === 'foreground') {
        // Transparent background; the launcher draws ic_launcher_background behind it.
        out[i] = FG[0];
        out[i + 1] = FG[1];
        out[i + 2] = FG[2];
        out[i + 3] = Math.round(fgA * 255);
        continue;
      }
      const t = inside === 0 ? 0 : fg / inside;
      for (let c = 0; c < 3; c++) out[i + c] = Math.round(ICON_BACKGROUND[c]! * (1 - t) + FG[c]! * t);
      if (!opaque) out[i + 3] = Math.round((inside / n) * 255);
    }
  }
  return out;
}

/** Minimal PNG encoder (8-bit RGB or RGBA, no interlace). */
export function encodePng(width: number, height: number, pixels: Buffer, channels: 3 | 4): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function write(rel: string, size: number, shape: Shape, opaque = false): void {
  const file = join(appDir, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, encodePng(size, size, renderIcon(size, shape, opaque), opaque ? 3 : 4));
}

const ANDROID_DENSITIES: Array<[string, number]> = [
  ['mdpi', 48],
  ['hdpi', 72],
  ['xhdpi', 96],
  ['xxhdpi', 144],
  ['xxxhdpi', 192],
];

if (import.meta.main) {
  write('resources/icon.png', 1024, 'square', true);
  // iOS: single 1024 icon, must be opaque.
  write('ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png', 1024, 'square', true);
  const res = 'android/app/src/main/res';
  for (const [density, size] of ANDROID_DENSITIES) {
    write(`${res}/mipmap-${density}/ic_launcher.png`, size, 'square');
    write(`${res}/mipmap-${density}/ic_launcher_round.png`, size, 'circle');
    write(`${res}/mipmap-${density}/ic_launcher_foreground.png`, Math.round((size * 108) / 48), 'foreground');
  }
  const hex = `#${ICON_BACKGROUND.map((c) => c.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
  writeFileSync(
    join(appDir, res, 'values/ic_launcher_background.xml'),
    `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${hex}</color>\n</resources>\n`,
  );
  console.log('icons written (placeholder)');
}
