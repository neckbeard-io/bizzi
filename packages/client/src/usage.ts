// Pure helpers for context bars, per-login usage meters and widgets (docs/usage.md). No UI dependencies.
import type { AccountUsage, AgentListing, ContextCategory, ContextUsage, SessionInfo, UsageWindow, WidgetValue } from '@bizzi/protocol';
import type { BizziState } from './store.ts';

/** Color carries state only: neutral, amber from 80%, red when limited / near compaction. */
export type MeterTone = 'neutral' | 'warn' | 'err';

// ---------------------------------------------------------------- context (usage.md §1.3)

export type ContextView =
  | { known: false }
  | {
      known: true;
      used: number;
      window: number;
      /** What warnings key off: `usable` when known, else the window. */
      usable: number;
      /** used / usable, 0..1 (the bar's fill). */
      fill: number;
      /** used / window, 0..1 (the label). */
      pct: number;
      /** Where the agent compacts, as a share of the window, when known. */
      compactPct?: number;
      /** neutral < 60% · elevated 60–80% (still neutral color) · warn ≥ 80% · err near compaction. */
      level: 'neutral' | 'elevated' | 'warn' | 'err';
      tone: MeterTone;
      /** "71% · compacts at 80%" */
      label: string;
    };

export function contextView(ctx: ContextUsage | null | undefined): ContextView {
  if (!ctx || !(ctx.window > 0)) return { known: false };
  const usable = ctx.usable && ctx.usable > 0 ? ctx.usable : ctx.window;
  const fill = clamp01(ctx.used / usable);
  const pct = clamp01(ctx.used / ctx.window);
  const compactAt = ctx.compactAt ?? ctx.usable;
  const compactPct = compactAt !== undefined ? clamp01(compactAt / ctx.window) : undefined;
  // "Near compaction": within 5% of the window from the compaction point, or 95% of usable.
  const near = compactAt !== undefined ? ctx.used >= compactAt - ctx.window * 0.05 : fill >= 0.95;
  const level = near ? 'err' : fill >= 0.8 ? 'warn' : fill >= 0.6 ? 'elevated' : 'neutral';
  const label = compactPct !== undefined ? `${percent(pct)} · compacts at ${percent(compactPct)}` : percent(pct);
  const v: ContextView = { known: true, used: ctx.used, window: ctx.window, usable, fill, pct, level, tone: level === 'err' ? 'err' : level === 'warn' ? 'warn' : 'neutral', label };
  if (compactPct !== undefined) v.compactPct = compactPct;
  return v;
}

export interface ContextSegment extends ContextCategory {
  /** Share of the window, 0..1. */
  share: number;
  /** bizzi's own injected overhead (knowledge rules, MCP tools), called out in the breakdown. */
  bizzi: boolean;
}

/**
 * The stacked bar under the context bar: used categories first (largest first, bizzi overhead last among
 * them so it stands out), then deferred, buffer and free. Without categories: used + free.
 */
export function contextBreakdown(ctx: ContextUsage): ContextSegment[] {
  const w = ctx.window > 0 ? ctx.window : 1;
  const cats: ContextCategory[] = ctx.categories?.length
    ? ctx.categories
    : [
        { id: 'used', label: 'Used', tokens: ctx.used, kind: 'used' },
        { id: 'free', label: 'Free', tokens: Math.max(0, ctx.window - ctx.used), kind: 'free' },
      ];
  const rank: Record<ContextCategory['kind'], number> = { used: 0, deferred: 1, buffer: 2, free: 3 };
  const isBizzi = (c: ContextCategory): boolean => c.id === 'bizzi' || /bizzi/i.test(c.label);
  return [...cats]
    .sort((a, b) => rank[a.kind] - rank[b.kind] || Number(isBizzi(a)) - Number(isBizzi(b)) || b.tokens - a.tokens)
    .map((c) => ({ ...c, share: clamp01(c.tokens / w), bizzi: isBizzi(c) }));
}

// ---------------------------------------------------------------- accounts (usage.md §3.4)

/** How constrained a login is, 0..100 (>100 when limited): its fullest window or its spend against the cap. */
export function accountConstraint(a: AccountUsage): number {
  let n = 0;
  for (const w of a.windows ?? []) n = Math.max(n, w.usedPercent);
  if (a.spend?.capUsd && a.spend.capUsd > 0) n = Math.max(n, (a.spend.usd / a.spend.capUsd) * 100);
  if (a.status === 'limited') n = Math.max(n, 101);
  return n;
}

export function accountTone(a: AccountUsage): MeterTone {
  if (a.status === 'limited') return 'err';
  if (a.status === 'warning' || accountConstraint(a) >= 80) return 'warn';
  return 'neutral';
}

export function windowTone(w: UsageWindow): MeterTone {
  return w.usedPercent >= 100 ? 'err' : w.usedPercent >= 80 ? 'warn' : 'neutral';
}

/** Every login, most constrained first (ties: by label). */
export function selectAccounts(s: BizziState): AccountUsage[] {
  return Object.values(s.accounts).sort((a, b) => accountConstraint(b) - accountConstraint(a) || a.label.localeCompare(b.label));
}

/** The window that constrains a login most, for the compact meter. */
export function primaryWindow(a: AccountUsage): UsageWindow | null {
  let best: UsageWindow | null = null;
  for (const w of a.windows ?? []) if (!best || w.usedPercent > best.usedPercent) best = w;
  return best;
}

/** Short label for a usage window id: five_hour → 5h, seven_day → 7d; others keep their label. */
export function windowShortLabel(w: UsageWindow): string {
  if (w.windowMins) {
    if (w.windowMins % 1440 === 0) return `${w.windowMins / 1440}d`;
    if (w.windowMins % 60 === 0) return `${w.windowMins / 60}h`;
  }
  const known: Record<string, string> = { five_hour: '5h', seven_day: '7d', seven_day_opus: '7d opus', seven_day_sonnet: '7d sonnet' };
  return known[w.id] ?? w.label;
}

/** "1h20", "35m", "2d4h" until `iso` from `now`; '' when unknown or past. */
export function formatResetIn(iso: string | undefined, now: number): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t) || t <= now) return '';
  const min = Math.round((t - now) / 60_000);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${h}h${String(min % 60).padStart(2, '0')}` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d${h % 24}h` : `${d}d`;
}

/** "40m ago", "3h ago", "just now": the age of a snapshot. */
export function formatAge(iso: string | undefined, now: number): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const min = Math.floor(Math.max(0, now - t) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ---------------------------------------------------------------- widgets (usage.md §4)

export type WidgetPlacement = WidgetValue['placement'][number];

/** Widgets shown in one place, optionally only one machine's, stable order (machine, label). */
export function selectWidgets(s: BizziState, placement: WidgetPlacement, machineId?: string | null): WidgetValue[] {
  return Object.values(s.widgets)
    .filter((w) => w.placement.includes(placement) && (machineId == null || w.machineId === machineId))
    .sort((a, b) => a.machineId.localeCompare(b.machineId) || a.label.localeCompare(b.label));
}

export function formatWidgetNumber(n: number, format: WidgetValue['format']): string {
  switch (format) {
    case 'usd':
      return n >= 100 ? `$${Math.round(n).toLocaleString('en-US')}` : `$${n.toFixed(2)}`;
    case 'percent':
      return `${Math.round(n)}%`;
    case 'tokens':
      return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
    default:
      return Number.isInteger(n) ? String(n) : n.toFixed(1);
  }
}

/** "$554 / $2,474 (22%)", "3 / 8", the text of a text/status widget, or '–' without a value. */
export function widgetText(w: WidgetValue): string {
  if (w.kind === 'meter' && w.value !== undefined) {
    const v = formatWidgetNumber(w.value, w.format);
    if (w.max === undefined || w.max <= 0) return v;
    const share = w.format === 'usd' ? ` (${percent(w.value / w.max)})` : '';
    return `${v} / ${formatWidgetNumber(w.max, w.format)}${share}`;
  }
  if (w.text !== undefined) return w.text;
  if (w.value !== undefined) return formatWidgetNumber(w.value, w.format);
  return '–';
}

/** The widget's own tone, else meter thresholds (80% warn, 95% error), else neutral. */
export function widgetTone(w: WidgetValue): MeterTone {
  if (w.tone === 'error') return 'err';
  if (w.tone === 'warn') return 'warn';
  if (w.tone === 'ok' || w.tone === 'neutral') return 'neutral';
  if (w.kind === 'meter' && w.value !== undefined && w.max) {
    const r = w.value / w.max;
    return r >= 0.95 ? 'err' : r >= 0.8 ? 'warn' : 'neutral';
  }
  return 'neutral';
}

/** A widget value older than three refresh-ish minutes (or failing) shows its age. */
export function widgetStale(w: WidgetValue, now: number, maxAgeMs = 5 * 60_000): boolean {
  if (w.error) return true;
  if (!w.observedAt) return false;
  const t = Date.parse(w.observedAt);
  return !Number.isNaN(t) && now - t > maxAgeMs;
}

// ---------------------------------------------------------------- versions (updates.md §6)

/** "2.1.311 · 2.1.322 installed" when the session runs an older process than what's installed. */
export function versionChip(session: Pick<SessionInfo, 'agentVersion'>, listing: Pick<AgentListing, 'version'> | null | undefined): { text: string; stale: boolean } | null {
  const running = session.agentVersion;
  if (!running) return null;
  const installed = listing?.version;
  if (installed && installed !== running) return { text: `${running} · ${installed} installed`, stale: true };
  return { text: running, stale: false };
}

// ---------------------------------------------------------------- helpers

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
}

function percent(x: number): string {
  return `${Math.round(x * 100)}%`;
}
