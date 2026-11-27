// How a desktop run shows itself, and the smoke check's options. Pure: no Electron imports, so the
// rules are testable.
//
// - foreground: the normal app (a test build still opens its window behind the app you're in).
// - background (BIZZI_BACKGROUND=1): the window shows behind the app you're in, with no Dock icon
//   and no change of the active app; the tray brings it forward.
// - headless (BIZZI_HEADLESS=1, or any smoke run unless BIZZI_HEADLESS=0): nothing on screen at all.
//   The page renders offscreen, so a smoke check can still screenshot it.

export type Presence = 'foreground' | 'background' | 'headless';

export function presenceFor(env: NodeJS.ProcessEnv): Presence {
  const headless = env['BIZZI_HEADLESS'];
  if (headless === '1' || (headless !== '0' && env['BIZZI_SMOKE_MS'])) return 'headless';
  if (env['BIZZI_BACKGROUND'] === '1') return 'background';
  return 'foreground';
}

export interface SmokeOptions {
  /** How long the page settles after its last load before the check runs. */
  delayMs: number;
  /** A UI route to open, `#/…`. */
  route: string | null;
  /** A JavaScript expression run in the page (awaited); a throw or `false` fails the check. */
  check: string | null;
  /** Where smoke.png and smoke.json go; the data dir when unset. */
  outDir: string | null;
  size: { width: number; height: number } | null;
}

/** The smoke check BIZZI_SMOKE_* asks for, or null when this isn't a smoke run. */
export function smokeOptions(env: NodeJS.ProcessEnv): SmokeOptions | null {
  const raw = env['BIZZI_SMOKE_MS'];
  if (!raw) return null;
  const delayMs = Number(raw);
  return {
    delayMs: Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : 1500,
    route: smokeRoute(env['BIZZI_SMOKE_ROUTE']),
    check: env['BIZZI_SMOKE_EVAL']?.trim() || null,
    outDir: env['BIZZI_SMOKE_OUT'] || null,
    size: parseSize(env['BIZZI_SMOKE_SIZE']),
  };
}

/** `#/settings`, `/settings` or `settings` → `#/settings`; anything else → null. */
export function smokeRoute(v: string | undefined): string | null {
  if (!v) return null;
  const route = v.startsWith('#/') ? v : v.startsWith('/') ? `#${v}` : `#/${v}`;
  return /^#\/[A-Za-z0-9/_.?=&%~:-]*$/.test(route) ? route : null;
}

function parseSize(v: string | undefined): { width: number; height: number } | null {
  const m = /^(\d{3,5})x(\d{3,5})$/.exec(v?.trim() ?? '');
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

/** The URL to load: the UI entry, opened at the route when there is one. */
export function withRoute(entry: string, route: string | null): string {
  if (!route) return entry;
  const u = new URL(entry);
  u.hash = route.slice(1);
  return u.toString();
}

export type CheckResult = { value: unknown } | { error: string };

/** Whether the smoke check passed: a screenshot was taken and the check (if any) neither threw nor returned false. */
export function smokePassed(o: { screenshot: boolean; check: CheckResult | null }): boolean {
  if (!o.screenshot) return false;
  if (!o.check) return true;
  return !('error' in o.check) && o.check.value !== false;
}
