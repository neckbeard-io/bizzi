// Color maths for themes: parsing, mixing, WCAG contrast, perceptual distance. Pure functions.

export type Rgba = { r: number; g: number; b: number; a: number };

const HEX_RE = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB_RE = /^rgba?\(\s*([^)]*)\)$/i;

/** Parse `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb(…)` / `rgba(…)` (comma or space separated). Null otherwise. */
export function parseColor(value: string): Rgba | null {
  const v = value.trim();
  const hex = HEX_RE.exec(v);
  if (hex) {
    let h = hex[1]!;
    if (h.length <= 4) h = [...h].map((c) => c + c).join('');
    const n = (i: number) => Number.parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
  }
  const rgb = RGB_RE.exec(v);
  if (rgb) {
    const parts = rgb[1]!
      .split(/[\s,/]+/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length !== 3 && parts.length !== 4) return null;
    const chan = (p: string) => (p.endsWith('%') ? (Number.parseFloat(p) / 100) * 255 : Number.parseFloat(p));
    const [r, g, b] = parts.slice(0, 3).map(chan) as [number, number, number];
    const a = parts[3] === undefined ? 1 : parts[3].endsWith('%') ? Number.parseFloat(parts[3]) / 100 : Number.parseFloat(parts[3]);
    if (![r, g, b, a].every(Number.isFinite)) return null;
    const clamp = (x: number, max: number) => Math.min(max, Math.max(0, x));
    return { r: clamp(r, 255), g: clamp(g, 255), b: clamp(b, 255), a: clamp(a, 1) };
  }
  return null;
}

export function isColor(value: unknown): value is string {
  return typeof value === 'string' && parseColor(value) !== null;
}

export function toHex(c: Rgba): string {
  const h = (x: number) => Math.round(x).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

function must(value: string): Rgba {
  return parseColor(value) ?? { r: 0, g: 0, b: 0, a: 1 };
}

/** Composite a possibly translucent color over an opaque backdrop. */
export function flatten(value: string, over: string): Rgba {
  const c = must(value);
  if (c.a >= 1) return c;
  const b = must(over);
  return { r: c.r * c.a + b.r * (1 - c.a), g: c.g * c.a + b.g * (1 - c.a), b: c.b * c.a + b.b * (1 - c.a), a: 1 };
}

/** Mix `a` toward `b` by `weight` (0 = a, 1 = b). Translucent inputs are flattened over `a` first. Returns hex. */
export function mix(a: string, b: string, weight: number): string {
  const ca = must(a);
  const cb = flatten(b, a);
  const w = Math.min(1, Math.max(0, weight));
  return toHex({ r: ca.r + (cb.r - ca.r) * w, g: ca.g + (cb.g - ca.g) * w, b: ca.b + (cb.b - ca.b) * w, a: 1 });
}

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance (0–1). Translucent colors count as composited over white. */
export function luminance(value: string): number {
  const c = flatten(value, '#ffffff');
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

/** WCAG contrast ratio of `fg` on `bg` (fg is composited over bg when translucent). */
export function contrast(fg: string, bg: string): number {
  const back = toHex(flatten(bg, '#808080'));
  const front = toHex(flatten(fg, back));
  const la = luminance(front);
  const lb = luminance(back);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function isDark(bg: string): boolean {
  return luminance(bg) < 0.25;
}

/** Near-black or white, whichever reads better on `bg` (text on an accent). */
export function textOn(bg: string, dark = '#111111', light = '#ffffff'): string {
  return contrast(dark, bg) >= contrast(light, bg) ? dark : light;
}

/**
 * Walk `color` toward `toward` until it clears `min` against `bg`. Returns the first step that does,
 * else `toward` itself (the far end), else the better of black and white.
 */
export function ensureContrast(color: string, bg: string, min: number, toward?: string): string {
  if (contrast(color, bg) >= min) return color;
  const target = toward ?? textOn(bg, '#000000', '#ffffff');
  for (let w = 0.1; w <= 1.0001; w += 0.1) {
    const c = mix(color, target, w);
    if (contrast(c, bg) >= min) return c;
  }
  const bw = textOn(bg, '#000000', '#ffffff');
  return contrast(target, bg) >= contrast(bw, bg) ? target : bw;
}

// --- perceptual distance (CIE76 ΔE in Lab, D65) ---------------------------------------------

function toLab(value: string): [number, number, number] {
  const c = flatten(value, '#ffffff');
  const [r, g, b] = [channel(c.r), channel(c.g), channel(c.b)];
  // sRGB → XYZ (D65), normalized to the white point
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIE76 color difference; ~2 is just noticeable, 20+ reads as a different color at a glance. */
export function deltaE(a: string, b: string): number {
  const [l1, a1, b1] = toLab(a);
  const [l2, a2, b2] = toLab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

// --- color vision deficiency (Machado, Oliveira & Fernandes 2009, severity 1.0, linear RGB) -----

export type ColorVision = 'protanopia' | 'deuteranopia' | 'tritanopia';

const CVD: Record<ColorVision, readonly (readonly [number, number, number])[]> = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
};

/** How `value` looks to someone with full `vision` deficiency (for checking that a palette survives it). */
export function simulateCvd(value: string, vision: ColorVision): string {
  const c = flatten(value, '#ffffff');
  const lin = [channel(c.r), channel(c.g), channel(c.b)] as const;
  const enc = (v: number) => {
    const x = Math.min(1, Math.max(0, v));
    return (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055) * 255;
  };
  const [r, g, b] = CVD[vision].map((row) => enc(row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2])) as [number, number, number];
  return toHex({ r, g, b, a: 1 });
}
