import { encode } from 'uqr';

/** QR modules of `text` as a boolean matrix (true = dark), with a quiet-zone border. */
export function qrMatrix(text: string, border = 2): boolean[][] {
  return encode(text, { ecc: 'M', border }).data;
}

/**
 * One SVG path for all dark modules (one `M x y h1 v1 h-1 z` square each, merged per horizontal run),
 * so the whole code is a single DOM node.
 */
export function qrPath(matrix: readonly (readonly boolean[])[]): string {
  let d = '';
  for (let y = 0; y < matrix.length; y++) {
    const row = matrix[y] ?? [];
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < row.length && row[x]) x++;
      d += `M${start} ${y}h${x - start}v1h${start - x}z`;
    }
  }
  return d;
}

/** Group a pairing code for reading aloud / typing: "K7Q2M9XD" → "K7Q2-M9XD". */
export function formatPairingCode(code: string): string {
  const c = code.replace(/[\s-]/g, '').toUpperCase();
  return c.length > 4 ? (c.match(/.{1,4}/g) ?? [c]).join('-') : c;
}
