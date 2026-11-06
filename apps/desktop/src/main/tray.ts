// Menu bar / tray icon, drawn in code so the app ships no binary assets yet.

import { nativeImage, type NativeImage } from 'electron';

/** A ring with a dot (an "agent orbiting a node"). Template image on macOS, indigo elsewhere. */
export function trayIcon(platform: NodeJS.Platform): NativeImage {
  const size = 32; // rendered at scale factor 2 -> 16pt
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const [b, g, r] = platform === 'darwin' ? [0, 0, 0] : [0xf1, 0x66, 0x63];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      // coverage of ring 10..14 and dot 0..4.5, with a 1px soft edge
      const ring = Math.min(clamp(d - 9.5), clamp(14.5 - d));
      const dot = clamp(5 - d);
      const a = Math.round(255 * Math.max(ring, dot));
      const i = (y * size + x) * 4;
      buf[i] = b;
      buf[i + 1] = g;
      buf[i + 2] = r;
      buf[i + 3] = a;
    }
  }
  const img = nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 2 });
  if (platform === 'darwin') img.setTemplateImage(true);
  return img;
}

function clamp(v: number): number {
  return Math.max(0, Math.min(1, v));
}
