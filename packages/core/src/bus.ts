// Event bus: assigns seq/ts, persists, then fans out to live listeners.
//
// Everything here is synchronous: `append` writes to SQLite and calls listeners before returning,
// so a caller that replays up to `lastSeq(ch)` and attaches a listener in the same tick sees every
// event exactly once.

import type { ChannelEvent, GlobalEventBody, Logger, SessionEventBody } from '@bizzi/protocol';
import type { Store } from './store.ts';

export type EventBody = SessionEventBody | GlobalEventBody;
export type EventListener = (ev: ChannelEvent) => void;

export const REPLAY_PAGE = 500;

export class EventBus {
  readonly #store: Store;
  readonly #logger: Logger;
  readonly #seqs = new Map<string, number>();
  readonly #listeners = new Map<string, Set<EventListener>>();
  readonly #taps = new Set<EventListener>();

  constructor(store: Store, logger: Logger) {
    this.#store = store;
    this.#logger = logger;
  }

  lastSeq(ch: string): number {
    let seq = this.#seqs.get(ch);
    if (seq === undefined) {
      seq = this.#store.maxSeq(ch);
      this.#seqs.set(ch, seq);
    }
    return seq;
  }

  append(ch: string, body: EventBody): ChannelEvent {
    const seq = this.lastSeq(ch) + 1;
    const ev = { ch, seq, ts: new Date().toISOString(), type: body.type, data: body.data } as ChannelEvent;
    this.#store.insertEvent(ev);
    this.#seqs.set(ch, seq);
    const set = this.#listeners.get(ch);
    if (set || this.#taps.size > 0) {
      for (const fn of [...(set ?? []), ...this.#taps]) {
        try {
          fn(ev);
        } catch (err) {
          this.#logger.log('error', 'event listener threw', { ch, seq, err });
        }
      }
    }
    return ev;
  }

  /** Drop cached state for a channel whose events were deleted (live listeners are kept). */
  forget(ch: string): void {
    this.#seqs.delete(ch);
  }

  /** Persisted events with seq > since, oldest first (at most `limit`). */
  replay(ch: string, since = 0, limit = Number.MAX_SAFE_INTEGER): ChannelEvent[] {
    return this.#store.replay(ch, since, limit);
  }

  /** Live events only. Returns an unsubscribe function. */
  on(ch: string, fn: EventListener): () => void {
    let set = this.#listeners.get(ch);
    if (!set) {
      set = new Set();
      this.#listeners.set(ch, set);
    }
    set.add(fn);
    return () => {
      const s = this.#listeners.get(ch);
      if (!s) return;
      s.delete(fn);
      if (s.size === 0) this.#listeners.delete(ch);
    };
  }

  /** Live events on every channel, after the channel's own listeners. Returns an unsubscribe function. */
  tap(fn: EventListener): () => void {
    this.#taps.add(fn);
    return () => {
      this.#taps.delete(fn);
    };
  }

  /** Synchronous replay (seq > since) followed by live events, with no gaps or duplicates. */
  subscribe(ch: string, since: number, fn: EventListener): { lastSeq: number; unsubscribe: () => void } {
    let cursor = since;
    for (;;) {
      const page = this.replay(ch, cursor, REPLAY_PAGE);
      for (const ev of page) {
        fn(ev);
        cursor = ev.seq;
      }
      if (page.length < REPLAY_PAGE) break;
    }
    const lastSeq = Math.max(cursor, this.lastSeq(ch));
    const unsubscribe = this.on(ch, (ev) => {
      if (ev.seq > cursor) {
        cursor = ev.seq;
        fn(ev);
      }
    });
    return { lastSeq, unsubscribe };
  }
}
