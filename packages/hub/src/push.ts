// Push notifications via ntfy (docs/tech-choices.md D9): what needs you while you're away.
// approval.requested, question.asked, and turn.completed for turns longer than `minTurnMs`, debounced
// per session so a burst becomes one notification.

import type { ChannelEvent, Logger } from '@bizzi/protocol';

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
  readonly #queue = new Map<string, { notes: Note[]; timer: NodeJS.Timeout }>();
  readonly #inflight = new Set<Promise<void>>();

  constructor(o: PushOptions) {
    this.#o = o;
    this.#fetch = o.fetch ?? fetch;
    this.#now = o.now ?? Date.now;
  }

  handle(ev: ChannelEvent): void {
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
    if (note) this.#enqueue(sessionId, note);
  }

  #enqueue(sessionId: string, note: Note): void {
    const q = this.#queue.get(sessionId);
    if (q) {
      q.notes.push(note);
      return;
    }
    const timer = setTimeout(() => this.#flush(sessionId), this.#o.debounceMs ?? 5000);
    timer.unref();
    this.#queue.set(sessionId, { notes: [note], timer });
  }

  #flush(sessionId: string): void {
    const q = this.#queue.get(sessionId);
    if (!q) return;
    this.#queue.delete(sessionId);
    const top = q.notes.reduce((a, b) => (b.rank > a.rank ? b : a));
    const { machine } = this.#o.describe(sessionId);
    const lines = q.notes.length === 1 ? [top.body] : q.notes.slice(-5).map((n) => `${n.title}: ${n.body}`);
    if (machine) lines.push(`on ${machine}`);
    const headers: Record<string, string> = {
      Title: asciiHeader(q.notes.length === 1 ? top.title : `${top.title} (+${q.notes.length - 1} more)`),
      Tags: top.tags,
      Priority: top.rank >= 2 ? 'high' : 'default',
      'Content-Type': 'text/plain; charset=utf-8',
    };
    if (this.#o.publicUrl) headers.Click = `${this.#o.publicUrl.replace(/\/+$/, '')}/#/s/${encodeURIComponent(sessionId)}`;
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
    for (const [sessionId, q] of [...this.#queue]) {
      clearTimeout(q.timer);
      this.#flush(sessionId);
    }
    await Promise.allSettled([...this.#inflight]);
  }
}

/** HTTP header values must be Latin-1; strip what isn't (ntfy also accepts RFC 2047, not worth it here). */
function asciiHeader(s: string): string {
  return s.replace(/[^\x20-\x7e]/g, '?').slice(0, 200);
}
