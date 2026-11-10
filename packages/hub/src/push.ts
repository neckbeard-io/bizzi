// Push notifications via ntfy (docs/tech-choices.md D9): what needs you while you're away.
// approval.requested, question.asked, and turn.completed for turns longer than `minTurnMs`, debounced
// per session so a burst becomes one notification. Also per-login usage (docs/usage.md §3.4): a plan
// window crossing 80% and 95%, and a login becoming `limited`, each once per window reset.

import { GLOBAL_CHANNEL, type AccountUsage, type ChannelEvent, type Logger } from '@bizzi/protocol';

/** Plan-window thresholds (percent) that trigger a push. */
export const USAGE_PUSH_THRESHOLDS = [80, 95] as const;
/** Without a reset time, a window re-arms once it drops this far below the lowest threshold. */
const REARM_MARGIN = 5;

/** Where the usage dedupe state survives restarts (the hub's meta table). */
export interface PushStateStore {
  load(): string | undefined;
  save(json: string): void;
}

export interface PushOptions {
  /** ntfy topic URL, e.g. https://ntfy.sh/my-bizzi-topic. */
  url: string;
  /** Optional ntfy access token (sent as a Bearer token). */
  token?: string;
  /** Public UI base URL for click-through links (`<publicUrl>/#/s/<sessionId>`). */
  publicUrl?: string;
  /** Collect events per session for this long before sending (default 5 s). */
  debounceMs?: number;
  /** Only notify about turns that ran at least this long (default 20 s). */
  minTurnMs?: number;
  /** Ignore events older than this (outbox replays after a reconnect; default 5 min). */
  maxAgeMs?: number;
  logger: Logger;
  /** Human labels for a session: its title and machine name. */
  describe: (sessionId: string) => { session: string; machine?: string };
  fetch?: typeof fetch;
  now?: () => number;
  /** Persist usage dedupe state (default: memory only). */
  state?: PushStateStore;
}

/** Per window: the reset it belongs to and the highest threshold already pushed. Per login: limited. */
interface UsageMark {
  reset: string;
  level: number;
}

interface Note {
  rank: number;
  title: string;
  body: string;
  tags: string;
}

export class NtfyPusher {
  readonly #o: PushOptions;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #turnStarts = new Map<string, number>();
  readonly #queue = new Map<string, { notes: Note[]; timer: NodeJS.Timeout; sessionId?: string }>();
  readonly #inflight = new Set<Promise<void>>();
  readonly #marks: Map<string, UsageMark>;

  constructor(o: PushOptions) {
    this.#o = o;
    this.#fetch = o.fetch ?? fetch;
    this.#now = o.now ?? Date.now;
    this.#marks = new Map();
    try {
      const saved = o.state?.load();
      if (saved) for (const [k, v] of Object.entries(JSON.parse(saved) as Record<string, UsageMark>)) this.#marks.set(k, v);
    } catch {
      // Unreadable state: start fresh (at worst one repeated notification).
    }
  }

  handle(ev: ChannelEvent): void {
    if (ev.ch === GLOBAL_CHANNEL && ev.type === 'account.usage') {
      this.#usage((ev.data as { usage?: AccountUsage }).usage);
      return;
    }
    if (!ev.ch.startsWith('session:')) return;
    const sessionId = ev.ch.slice('session:'.length);
    const ts = Date.parse(ev.ts);
    if (ev.type === 'turn.started') {
      this.#turnStarts.set(`${sessionId}:${ev.data.turnId}`, ts);
      return;
    }
    if (ev.type !== 'approval.requested' && ev.type !== 'question.asked' && ev.type !== 'turn.completed') return;
    const fresh = Number.isFinite(ts) && this.#now() - ts <= (this.#o.maxAgeMs ?? 5 * 60_000);
    const label = () => this.#o.describe(sessionId);
    let note: Note | undefined;
    if (ev.type === 'approval.requested') {
      if (fresh) note = { rank: 3, title: `Approval needed: ${label().session}`, body: ev.data.title, tags: 'warning' };
    } else if (ev.type === 'question.asked') {
      if (fresh) note = { rank: 2, title: `Question: ${label().session}`, body: ev.data.text, tags: 'question' };
    } else {
      const key = `${sessionId}:${ev.data.turnId}`;
      const started = this.#turnStarts.get(key);
      this.#turnStarts.delete(key);
      if (fresh && started !== undefined && ts - started >= (this.#o.minTurnMs ?? 20_000)) {
        const secs = Math.round((ts - started) / 1000);
        const how = ev.data.stopReason === 'end_turn' ? 'finished' : ev.data.stopReason === 'error' ? 'failed' : `ended (${ev.data.stopReason})`;
        note = {
          rank: 1,
          title: `Turn ${how}: ${label().session}`,
          body: ev.data.error ? `${ev.data.error} (after ${secs}s)` : `after ${secs}s`,
          tags: ev.data.stopReason === 'end_turn' ? 'white_check_mark' : 'x',
        };
      }
    }
    if (note) this.#enqueue(`session:${sessionId}`, note, sessionId);
  }

  /** Plan windows crossing a threshold and logins becoming limited, once per window reset. */
  #usage(u: AccountUsage | undefined): void {
    if (!u || typeof u.agent !== 'string' || typeof u.accountId !== 'string') return;
    const observed = Date.parse(u.observedAt);
    // Old snapshots (replays) only update the marks, so a restart doesn't re-announce them.
    const fresh = Number.isFinite(observed) && this.#now() - observed <= (this.#o.maxAgeMs ?? 5 * 60_000);
    const base = `${u.agent}\u0000${u.accountId}`;
    const notes: Note[] = [];
    let changed = false;
    const lowest = Math.min(...USAGE_PUSH_THRESHOLDS);

    for (const w of u.windows ?? []) {
      if (typeof w?.id !== 'string' || typeof w.usedPercent !== 'number') continue;
      const key = `${base}\u0000w:${w.id}`;
      const reset = w.resetsAt ?? '';
      const level = Math.max(0, ...USAGE_PUSH_THRESHOLDS.filter((t) => w.usedPercent >= t));
      const prev = this.#marks.get(key);
      let mark: UsageMark;
      if (!prev || prev.reset !== reset) mark = { reset, level };
      else if (level > prev.level) mark = { reset, level };
      else if (!reset && w.usedPercent < lowest - REARM_MARGIN) mark = { reset, level: 0 };
      else mark = prev;
      if (mark !== prev) {
        this.#marks.set(key, mark);
        changed = true;
      }
      const announced = prev && prev.reset === reset ? prev.level : 0;
      if (fresh && mark.level > announced) {
        notes.push({
          rank: mark.level >= 95 ? 3 : 2,
          title: `${u.label}: ${w.label} at ${Math.round(w.usedPercent)}%`,
          body: w.resetsAt ? `resets ${this.#until(w.resetsAt)}` : 'plan window',
          tags: mark.level >= 95 ? 'rotating_light' : 'warning',
        });
      }
    }

    const limitedKey = `${base}\u0000limited`;
    const prevLimited = this.#marks.get(limitedKey);
    if (u.status === 'limited') {
      const reset = limitedReset(u);
      if (!prevLimited || prevLimited.reset !== reset || prevLimited.level === 0) {
        this.#marks.set(limitedKey, { reset, level: 1 });
        changed = true;
        if (fresh) {
          notes.push({
            rank: 4,
            title: `${u.label} is rate limited`,
            body: reset ? `resets ${this.#until(reset)}` : 'switch login or model to keep helpers running',
            tags: 'no_entry',
          });
        }
      }
    } else if (prevLimited && prevLimited.level !== 0 && !prevLimited.reset) {
      // No reset time to dedupe on: re-arm once the login is no longer limited.
      this.#marks.set(limitedKey, { reset: '', level: 0 });
      changed = true;
    }

    if (changed) this.#saveMarks();
    for (const n of notes) this.#enqueue(`usage:${base}`, n);
  }

  #until(isoTime: string): string {
    const ms = Date.parse(isoTime) - this.#now();
    if (!Number.isFinite(ms)) return isoTime;
    if (ms <= 0) return 'now';
    const mins = Math.round(ms / 60_000);
    if (mins < 60) return `in ${mins}m`;
    const h = Math.floor(mins / 60);
    if (h < 48) return `in ${h}h${String(mins % 60).padStart(2, '0')}`;
    return `in ${Math.round(h / 24)}d`;
  }

  #saveMarks(): void {
    if (!this.#o.state) return;
    try {
      this.#o.state.save(JSON.stringify(Object.fromEntries(this.#marks)));
    } catch (err) {
      this.#o.logger.log('warn', 'could not persist push state', { err: String(err) });
    }
  }

  #enqueue(key: string, note: Note, sessionId?: string): void {
    const q = this.#queue.get(key);
    if (q) {
      q.notes.push(note);
      return;
    }
    const timer = setTimeout(() => this.#flush(key), this.#o.debounceMs ?? 5000);
    timer.unref();
    this.#queue.set(key, { notes: [note], timer, ...(sessionId !== undefined ? { sessionId } : {}) });
  }

  #flush(key: string): void {
    const q = this.#queue.get(key);
    if (!q) return;
    this.#queue.delete(key);
    const sessionId = q.sessionId;
    const top = q.notes.reduce((a, b) => (b.rank > a.rank ? b : a));
    const machine = sessionId !== undefined ? this.#o.describe(sessionId).machine : undefined;
    const lines = q.notes.length === 1 ? [top.body] : q.notes.slice(-5).map((n) => `${n.title}: ${n.body}`);
    if (machine) lines.push(`on ${machine}`);
    const headers: Record<string, string> = {
      Title: asciiHeader(q.notes.length === 1 ? top.title : `${top.title} (+${q.notes.length - 1} more)`),
      Tags: top.tags,
      Priority: top.rank >= 2 ? 'high' : 'default',
      'Content-Type': 'text/plain; charset=utf-8',
    };
    if (this.#o.publicUrl) {
      const base = this.#o.publicUrl.replace(/\/+$/, '');
      headers.Click = sessionId !== undefined ? `${base}/#/s/${encodeURIComponent(sessionId)}` : `${base}/`;
    }
    if (this.#o.token) headers.Authorization = `Bearer ${this.#o.token}`;
    const p = this.#fetch(this.#o.url, { method: 'POST', headers, body: lines.join('\n') })
      .then((res) => {
        if (!res.ok) this.#o.logger.log('warn', 'ntfy push rejected', { status: res.status });
      })
      .catch((err: unknown) => this.#o.logger.log('warn', 'ntfy push failed', { err: String(err) }))
      .finally(() => this.#inflight.delete(p));
    this.#inflight.add(p);
  }

  /** Send anything still queued and wait for in-flight requests. */
  async close(): Promise<void> {
    for (const [key, q] of [...this.#queue]) {
      clearTimeout(q.timer);
      this.#flush(key);
    }
    await Promise.allSettled([...this.#inflight]);
  }
}

/** HTTP header values must be Latin-1; strip what isn't (ntfy also accepts RFC 2047, not worth it here). */
function asciiHeader(s: string): string {
  return s.replace(/[^\x20-\x7e]/g, '?').slice(0, 200);
}

/** The reset a `limited` state belongs to: the exhausted window's reset, else the latest known one. */
function limitedReset(u: AccountUsage): string {
  const windows = (u.windows ?? []).filter((w) => w.resetsAt);
  const exhausted = windows.filter((w) => w.usedPercent >= 100);
  const pick = (ws: typeof windows) => ws.map((w) => w.resetsAt!).sort().at(-1);
  return pick(exhausted) ?? pick(windows) ?? u.spend?.resetsAt ?? '';
}
