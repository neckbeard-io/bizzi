import type { KeepAwakeState, SessionStatus, Usage } from '@bizzi/protocol';

export function formatTokens(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '–';
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatCost(usd: number | undefined): string {
  if (usd === undefined || !Number.isFinite(usd)) return '–';
  if (usd === 0) return '$0';
  if (usd < 0.01) return '<$0.01';
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd)}`;
}

export function formatBytes(n: number | undefined): string {
  if (n === undefined) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s % 60);
  if (m < 60) return rest ? `${m}m ${rest}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** "just now", "5 min ago", "3 h ago", "2 d ago", else a date. */
export function formatRelative(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const diff = Math.max(0, now - t);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} d ago`;
  return new Date(t).toISOString().slice(0, 10);
}

/** A compact age for tight rows: "now", "4m", "2h", "3d", "5w", "1y". '' when unknown. */
export function formatAgeShort(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const min = Math.floor(Math.max(0, now - t) / 60_000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  if (d < 365) return `${Math.floor(d / 7)}w`;
  return `${Math.floor(d / 365)}y`;
}

export function usageSummary(u: Usage | null | undefined): string {
  if (!u) return '';
  const parts: string[] = [];
  if (u.inputTokens !== undefined || u.outputTokens !== undefined) {
    parts.push(`${formatTokens(u.inputTokens)} in · ${formatTokens(u.outputTokens)} out`);
  }
  if (u.cacheReadTokens) parts.push(`${formatTokens(u.cacheReadTokens)} cached`);
  if (u.costUsd !== undefined) parts.push(formatCost(u.costUsd));
  return parts.join(' · ');
}

/** Share of the context window used, 0..1, when known. */
export function contextUse(u: Usage | null | undefined): number | null {
  if (!u?.contextWindow || u.inputTokens === undefined) return null;
  const used = u.inputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0);
  return Math.min(1, used / u.contextWindow);
}

export type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'err' | 'info';

export const STATUS_LABEL: Record<SessionStatus, string> = {
  starting: 'starting',
  running: 'running',
  waiting_input: 'waiting for input',
  waiting_approval: 'needs approval',
  idle: 'idle',
  paused: 'paused',
  ended: 'ended',
  failed: 'failed',
};

export const STATUS_TONE: Record<SessionStatus, Tone> = {
  starting: 'info',
  running: 'accent',
  waiting_input: 'warn',
  waiting_approval: 'warn',
  idle: 'neutral',
  paused: 'neutral',
  ended: 'neutral',
  failed: 'err',
};

export function isBusy(status: SessionStatus | null | undefined): boolean {
  return status === 'running' || status === 'starting' || status === 'waiting_approval' || status === 'waiting_input';
}

/** Pretty JSON for tool inputs; strings are shown as-is. */
export function prettyJson(v: unknown): string {
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    return String(v);
  }
}

/** Keep the tail of very long output (the interesting part of build logs). */
export function tail(text: string, maxChars: number): { text: string; truncated: number } {
  if (text.length <= maxChars) return { text, truncated: 0 };
  const cut = text.length - maxChars;
  const nl = text.indexOf('\n', cut);
  const from = nl >= 0 && nl - cut < 200 ? nl + 1 : cut;
  return { text: text.slice(from), truncated: from };
}

export function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export function joinPath(dir: string, name: string): string {
  if (!dir || dir === '.') return name;
  return `${dir.replace(/\/+$/, '')}/${name}`;
}

export function parentPath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

/** Message of any thrown value, and whether it means the target machine is offline. */
export function errorInfo(e: unknown): { message: string; code: string | null; offline: boolean } {
  const code = typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : null;
  const message = e instanceof Error ? e.message : typeof e === 'object' && e !== null && typeof (e as { message?: unknown }).message === 'string' ? (e as { message: string }).message : String(e);
  return { message, code, offline: code === 'machine_offline' };
}

/** "online", "last seen 5 min ago", or "offline". */
export function machinePresence(m: { online: boolean; lastSeenAt?: string }, now: number = Date.now()): string {
  if (m.online) return 'online';
  return m.lastSeenAt ? `last seen ${formatRelative(m.lastSeenAt, now)}` : 'offline';
}

/**
 * Why bizzi is (or would be) keeping the machine awake (spec §8.1), e.g. "Keeping awake: 2 turns running".
 * Undefined when it isn't holding anything and nothing is paused.
 */
export function keepAwakeSummary(k: KeepAwakeState | undefined): string | undefined {
  if (!k?.supported) return undefined;
  const why: string[] = [];
  if (k.turns) why.push(`${k.turns} ${k.turns === 1 ? 'turn' : 'turns'} running`);
  if (k.background) why.push(`${k.background} ${k.background === 1 ? 'session' : 'sessions'} with background work`);
  if (k.pausedOnBattery) return `Not keeping awake on battery (${why.join(', ')})`;
  if (!k.active) return undefined;
  if (why.length === 0) return 'Keeping awake a little longer after the last work ended';
  return `Keeping awake: ${why.join(', ')}`;
}

/** "m:ss" for countdowns (pairing code expiry). */
export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}
