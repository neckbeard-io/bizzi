// Menu bar / tray icon: the bee from assets/ (rendered by scripts/icons.ts). macOS gets the black
// template image, which the system tints for light and dark menu bars; elsewhere the color icon,
// with the TEST ribbon for a test build.

import { join } from 'node:path';
import { nativeImage, type NativeImage } from 'electron';

export function trayIcon(platform: NodeJS.Platform, assetsDir: string, testBuild = false): NativeImage {
  // createFromPath picks up the @2x file next to it on high-density displays.
  const file = platform === 'darwin' ? 'trayTemplate.png' : testBuild ? 'tray-test.png' : 'tray.png';
  const img = nativeImage.createFromPath(join(assetsDir, file));
  if (platform === 'darwin') img.setTemplateImage(true);
  return img;
}
