// Hub event bus: persists replicated session events (node seq kept) and the hub's own re-sequenced
// global log, then fans out to live listeners synchronously (same contract as the core's EventBus:
// a caller that replays up to `lastSeq(ch)` and attaches a listener in the same tick sees every event
// exactly once).

import { GLOBAL_CHANNEL, type ChannelEvent, type GlobalEvent, type GlobalEventBody, type Logger } from '@bizzi/protocol';
import type { HubStore } from './store.ts';

export type HubEventListener = (ev: ChannelEvent) => void;

export const REPLAY_PAGE = 500;

export class HubBus {
  readonly #store: HubStore;
  readonly #logger: Logger;
  readonly #seqs = new Map<string, number>();
  readonly #listeners = new Map<string, Set<HubEventListener>>();
  readonly #taps = new Set<HubEventListener>();

  constructor(store: HubStore, logger: Logger) {
    this.#store = store;
    this.#logger = logger;
  }

  lastSeq(ch: string): number {
    let seq = this.#seqs.get(ch);
    if (seq === undefined) {
      seq = ch === GLOBAL_CHANNEL ? this.#store.maxGlobalSeq() : this.#store.maxSeq(ch);
      this.#seqs.set(ch, seq);
    }
    return seq;
  }

  /**
   * Store a replicated session-channel event and fan it out. Returns false (and does nothing) for
   * events at or below the stored cursor, so replays after a reconnect never duplicate.
   */
  appendReplica(ev: ChannelEvent): boolean {
    const last = this.lastSeq(ev.ch);
    if (ev.seq <= last) return false;
    if (ev.seq !== last + 1) this.#logger.log('warn', 'gap in replicated channel', { ch: ev.ch, last, seq: ev.seq });
    if (!this.#store.insertEvent(ev)) return false;
    this.#seqs.set(ev.ch, ev.seq);
    this.#emit(ev);
    return true;
  }

  /**
   * Append to the hub's global log with the next hub seq. `inTx` runs in the same transaction (used to
   * advance a node's global cursor atomically with the re-sequenced copy).
   */
  appendGlobal(body: GlobalEventBody, opts: { ts?: string; machineId?: string; inTx?: () => void } = {}): GlobalEvent {
    const seq = this.lastSeq(GLOBAL_CHANNEL) + 1;
    const ev = this.#store.tx(() => {
      const e = this.#store.insertGlobal(seq, opts.ts ?? new Date().toISOString(), body, opts.machineId);
      opts.inTx?.();
      return e;
    });
    this.#seqs.set(GLOBAL_CHANNEL, seq);
    this.#emit(ev);
    return ev;
  }

  /** Forget a channel's cached seq (its events were deleted). */
  dropChannel(ch: string): void {
    this.#seqs.delete(ch);
  }

  replay(ch: string, since: number, limit = REPLAY_PAGE): ChannelEvent[] {
    return ch === GLOBAL_CHANNEL ? this.#store.replayGlobal(since, limit) : this.#store.replay(ch, since, limit);
  }

  /** Live events on one channel. Returns an unsubscribe function. */
  on(ch: string, fn: HubEventListener): () => void {
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

  /** Live events on every channel (push notifications). */
  tap(fn: HubEventListener): () => void {
    this.#taps.add(fn);
    return () => this.#taps.delete(fn);
  }

  #emit(ev: ChannelEvent): void {
    const set = this.#listeners.get(ev.ch);
    const fns = [...(set ?? []), ...this.#taps];
    for (const fn of fns) {
      try {
        fn(ev);
      } catch (err) {
        this.#logger.log('error', 'event listener threw', { ch: ev.ch, seq: ev.seq, err });
      }
    }
  }
}
