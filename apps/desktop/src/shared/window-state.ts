// The main window's size, position and maximized/full-screen state, kept across launches. Pure
// helpers shared by main and tests; no Electron imports.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowState {
  /** The normal (un-maximized, windowed) bounds, so un-maximizing after a restore lands where it was. */
  bounds: Rect;
  maximized: boolean;
  fullScreen: boolean;
}

export interface Size {
  width: number;
  height: number;
}

/** How much of the window must overlap a display for its saved position to be kept. */
const MIN_VISIBLE = 64;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function parseWindowState(raw: unknown): WindowState | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const b = r['bounds'] as Record<string, unknown> | null | undefined;
  if (typeof b !== 'object' || b === null) return null;
  const { x, y, width, height } = b;
  if (!isNum(x) || !isNum(y) || !isNum(width) || !isNum(height) || width <= 0 || height <= 0) return null;
  return {
    bounds: { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) },
    maximized: r['maximized'] === true,
    fullScreen: r['fullScreen'] === true,
  };
}

function overlap(a: Rect, b: Rect): { w: number; h: number } {
  return {
    w: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    h: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(v, hi));
}

/**
 * Where to open the window: the saved bounds when they still land on a display (shrunk and nudged
 * to fit its work area), otherwise the saved size centered on the primary display (no x/y), e.g.
 * after the monitor it was on was unplugged. `workAreas[0]` is the primary display.
 */
export function initialBounds(saved: WindowState | null, workAreas: Rect[], fallback: Size, min: Size): Size & Partial<Pick<Rect, 'x' | 'y'>> {
  const primary = workAreas[0];
  const want = saved?.bounds ?? fallback;
  const fit = (area: Rect | undefined): Size => ({
    width: area ? clamp(want.width, Math.min(min.width, area.width), area.width) : Math.max(want.width, min.width),
    height: area ? clamp(want.height, Math.min(min.height, area.height), area.height) : Math.max(want.height, min.height),
  });
  if (!saved) return fit(primary);
  let best: Rect | undefined;
  let bestArea = 0;
  for (const area of workAreas) {
    const o = overlap(saved.bounds, area);
    if (o.w >= MIN_VISIBLE && o.h >= MIN_VISIBLE && o.w * o.h > bestArea) {
      best = area;
      bestArea = o.w * o.h;
    }
  }
  if (!best) return fit(primary);
  const size = fit(best);
  return {
    ...size,
    x: clamp(saved.bounds.x, best.x, best.x + best.width - size.width),
    y: clamp(saved.bounds.y, best.y, best.y + best.height - size.height),
  };
}
