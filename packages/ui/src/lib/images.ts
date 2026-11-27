/**
 * Turning a pasted, dropped or picked image file into something every agent accepts: PNG, JPEG,
 * GIF or WebP, at most MAX_EDGE px on the long side and MAX_BYTES once decoded. Models downscale
 * larger images anyway, so sending them only costs upload time and event-log space.
 */
export const MAX_EDGE = 2000;
export const MAX_BYTES = 3_750_000;
const PASS_THROUGH = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export interface PreparedImage {
  mediaType: string;
  dataBase64: string;
  width: number;
  height: number;
}

export async function prepareImage(file: Blob): Promise<PreparedImage> {
  const img = await loadImage(file);
  const { naturalWidth: w, naturalHeight: h } = img;
  if (!w || !h) throw new Error('That image could not be read.');
  const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
  // Small enough in a format agents take: send the original bytes (keeps GIF animation, exact pixels).
  if (scale === 1 && PASS_THROUGH.has(file.type) && file.size <= MAX_BYTES) {
    return { mediaType: file.type, dataBase64: await blobToBase64(file), width: w, height: h };
  }
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This device cannot resize images.');
  ctx.drawImage(img, 0, 0, cw, ch);
  // PNG keeps screenshots crisp; fall back to JPEG when it is still too big.
  for (const [type, quality] of [['image/png', undefined], ['image/jpeg', 0.88], ['image/jpeg', 0.7]] as const) {
    const blob = await canvasBlob(canvas, type, quality);
    if (blob && blob.size <= MAX_BYTES) return { mediaType: type, dataBase64: await blobToBase64(blob), width: cw, height: ch };
  }
  throw new Error('That image is too large to send.');
}

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('That file is not an image this device can open.'));
    };
    img.src = url;
  });
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality: number | undefined): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result);
      resolve(s.slice(s.indexOf(',') + 1));
    };
    r.onerror = () => reject(r.error ?? new Error('Could not read the image.'));
    r.readAsDataURL(blob);
  });
}

export function dataUrl(mediaType: string, dataBase64: string): string {
  return `data:${mediaType};base64,${dataBase64}`;
}
