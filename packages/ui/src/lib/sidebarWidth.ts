// Desktop sidebar width (spec §11.1): auto (fits the widest workspace row) or manual (dragged), per device.

/** Hard limits for a dragged width. */
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 480;
/** A dragged sidebar never takes more than this share of the window. */
export const SIDEBAR_MAX_SHARE = 0.4;
/** Auto mode fits content into this range. */
export const AUTO_MIN = 220;
export const AUTO_MAX = 360;
/** Auto mode shrinks (down to SIDEBAR_MIN) so the main pane keeps at least this much. */
export const MAIN_MIN = 640;
/** Arrow-key step on the resize handle (Shift: ×3). */
export const KEY_STEP = 16;

export type SidebarMode = 'auto' | 'manual';
export type SidebarPref = { mode: SidebarMode; width: number };

export const DEFAULT_SIDEBAR: SidebarPref = { mode: 'auto', width: 260 };

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Largest width a dragged sidebar may have in a window this wide. */
export function manualMax(windowWidth: number): number {
  return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.floor(windowWidth * SIDEBAR_MAX_SHARE)));
}

/** A dragged or stored width, clamped to [min, min(max, 40% of the window)]. */
export function clampManual(width: number, windowWidth: number): number {
  return Math.round(clamp(width, SIDEBAR_MIN, manualMax(windowWidth)));
}

/**
 * Auto width: the content's natural width (widest row plus padding) clamped to [AUTO_MIN, AUTO_MAX], then
 * shrunk on narrow windows so the main pane keeps MAIN_MIN, but never below SIDEBAR_MIN.
 */
export function autoWidth(contentWidth: number, windowWidth: number): number {
  const fit = clamp(Math.ceil(contentWidth), AUTO_MIN, AUTO_MAX);
  const room = windowWidth - MAIN_MIN;
  return Math.round(Math.max(SIDEBAR_MIN, Math.min(fit, room)));
}

/** The width to render for a preference. */
export function sidebarWidth(pref: SidebarPref, contentWidth: number | null, windowWidth: number): number {
  if (pref.mode === 'manual') return clampManual(pref.width, windowWidth);
  return autoWidth(contentWidth ?? DEFAULT_SIDEBAR.width, windowWidth);
}

/** The width a key press on the resize handle moves to, or null for keys it doesn't handle. */
export function keyWidth(key: string, shift: boolean, width: number, windowWidth: number): number | null {
  const step = shift ? KEY_STEP * 3 : KEY_STEP;
  switch (key) {
    case 'ArrowLeft':
      return clampManual(width - step, windowWidth);
    case 'ArrowRight':
      return clampManual(width + step, windowWidth);
    case 'Home':
      return SIDEBAR_MIN;
    case 'End':
      return manualMax(windowWidth);
    default:
      return null;
  }
}

/** Parse a stored preference; anything unreadable is the default (auto). */
export function readSidebarPref(raw: unknown): SidebarPref {
  if (!raw || typeof raw !== 'object') return DEFAULT_SIDEBAR;
  const r = raw as Record<string, unknown>;
  const mode: SidebarMode = r.mode === 'manual' ? 'manual' : 'auto';
  const width = typeof r.width === 'number' && Number.isFinite(r.width) ? Math.round(clamp(r.width, SIDEBAR_MIN, SIDEBAR_MAX)) : DEFAULT_SIDEBAR.width;
  return { mode, width };
}

/**
 * Natural width of one row: its offset from the tree's edge, horizontal padding, the gaps between its
 * rendered children, and each child's content width. Children that flex-grow (spacers) count for their gap
 * but not their width, so the result doesn't depend on how wide the row currently is.
 */
export type RowParts = { offset: number; padding: number; gap: number; children: { width: number; grows: boolean }[] };

export function rowNaturalWidth(row: RowParts): number {
  const gaps = Math.max(0, row.children.length - 1) * row.gap;
  return row.offset + row.padding + gaps + row.children.reduce((sum, c) => sum + (c.grows ? 0 : c.width), 0);
}
