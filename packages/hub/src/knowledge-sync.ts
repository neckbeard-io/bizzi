// Knowledge replication through the hub (knowledge.md §9.4). The hub drives it over each node link,
// as the client it already is there:
//   pull  `knowledge.sync.pull` from the node since the newest HLC taken from it, and keep each item
//         whose clock is newer than the hub's copy (last writer wins; tombstones are items too);
//   push  `knowledge.sync.push` the items other machines changed since the node's last `rseq`.
// A pull runs when a node links and on every `knowledge.changed` it emits; a push runs when it links
// and whenever a pull from another machine brought something new. Each pull also reports the node's
// store id; when it changes (the database was replaced) both directions start over. Every node gets every item: the
// store's visibility rules scope them at read time, and any node can show and edit any scope.
// Work is serialized per link, so a node never sees its own pull and push interleave.

import { BizziError, type KnowledgeRecord, type Logger } from '@bizzi/protocol';
import type { LinkHandle } from './relay.ts';
import type { HubStore } from './store.ts';

const HLC_RE = /^\d{15}-\d{6}-./;

export interface KnowledgeSyncOptions {
  store: HubStore;
  logger: Logger;
  /** Items per request (default 500). */
  pageSize?: number;
}

interface LinkState {
  link: LinkHandle;
  pull: boolean;
  push: boolean;
  running?: Promise<void>;
  /** Next push includes items that came from this machine (its store was replaced). */
  pushAll: boolean;
  /** The node doesn't have `knowledge.sync.*` (older bizzi, or started without knowledge). */
  unsupported: boolean;
}

export class KnowledgeSync {
  readonly #store: HubStore;
  readonly #log: Logger;
  readonly #page: number;
  readonly #links = new Map<string, LinkState>();

  constructor(o: KnowledgeSyncOptions) {
    this.#store = o.store;
    this.#log = o.logger.child({ component: 'knowledge-sync' });
    this.#page = o.pageSize ?? 500;
  }

  /** A node link finished its initial sync: pull what it changed, push what it missed. */
  attach(link: LinkHandle): void {
    const st: LinkState = { link, pull: true, push: true, pushAll: false, unsupported: false };
    this.#links.set(link.machineId, st);
    this.#kick(st);
  }

  detach(link: LinkHandle): void {
    if (this.#links.get(link.machineId)?.link === link) this.#links.delete(link.machineId);
  }

  /** The node emitted `knowledge.changed`. */
  nodeChanged(link: LinkHandle): void {
    const st = this.#links.get(link.machineId);
    if (!st || st.link !== link) return;
    st.pull = true;
    this.#kick(st);
  }

  /** Resolves when no link has replication work running or queued (tests). */
  async idle(): Promise<void> {
    for (;;) {
      const running = [...this.#links.values()].map((s) => s.running).filter((p): p is Promise<void> => p !== undefined);
      if (running.length === 0) return;
      await Promise.allSettled(running);
    }
  }

  #kick(st: LinkState): void {
    if (st.running || st.unsupported) return;
    st.running = this.#drain(st).finally(() => {
      st.running = undefined;
      if ((st.pull || st.push) && this.#links.get(st.link.machineId) === st) this.#kick(st);
    });
  }

  async #drain(st: LinkState): Promise<void> {
    try {
      while (st.pull || st.push) {
        if (st.pull) {
          st.pull = false;
          await this.#pull(st);
        } else {
          st.push = false;
          await this.#push(st);
        }
      }
    } catch (err) {
      st.pull = false;
      st.push = false;
      if (!this.#store.isOpen) return;
      const code = err instanceof BizziError ? err.code : undefined;
      if (code === 'unsupported') {
        st.unsupported = true;
        this.#log.log('info', 'node does not replicate knowledge', { machineId: st.link.machineId });
      } else if (code !== 'machine_offline') {
        // Retried on the node's next change or link.
        this.#log.log('warn', 'knowledge sync failed', { machineId: st.link.machineId, err });
      }
    }
  }

  async #pull(st: LinkState): Promise<void> {
    const machineId = st.link.machineId;
    for (;;) {
      const cursor = this.#store.knowledgeCursor(machineId);
      const since = cursor.pulledHlc;
      const res = (await st.link.request('knowledge.sync.pull', { machineId, ...(since ? { since } : {}), limit: this.#page })) as {
        items?: unknown;
        more?: unknown;
        storeId?: unknown;
      };
      if (!this.#store.isOpen || this.#links.get(machineId) !== st) return;
      if (!res || !Array.isArray(res.items) || typeof res.storeId !== 'string') {
        throw new BizziError('internal', 'knowledge.sync.pull returned an unexpected result');
      }
      if (cursor.storeId !== res.storeId) {
        if (cursor.storeId !== undefined) {
          // The node's knowledge database was replaced: take everything it has and give it everything
          // the hub has, its own old items included.
          this.#log.log('info', 'node knowledge store was replaced; syncing everything', { machineId });
          st.pushAll = true;
        }
        this.#store.setKnowledgeCursor(machineId, { storeId: res.storeId, pushedRseq: 0 });
        st.push = true;
        if (since !== undefined) continue;
      }
      let accepted = 0;
      let last: string | undefined;
      this.#store.tx(() => {
        for (const raw of res.items as unknown[]) {
          if (!isRecord(raw)) {
            this.#log.log('debug', 'dropping invalid knowledge record from node', { machineId });
            continue;
          }
          if (this.#store.putKnowledge(raw, machineId)) accepted++;
          if (!last || raw.hlc > last) last = raw.hlc;
        }
        if (last) this.#store.setKnowledgeCursor(machineId, { ...this.#store.knowledgeCursor(machineId), pulledHlc: last });
      });
      if (accepted > 0) {
        this.#log.log('debug', 'knowledge pulled', { machineId, accepted });
        for (const other of this.#links.values()) {
          if (other === st) continue;
          other.push = true;
          this.#kick(other);
        }
      }
      if (res.more !== true || !last) return;
    }
  }

  async #push(st: LinkState): Promise<void> {
    const machineId = st.link.machineId;
    for (;;) {
      const cursor = this.#store.knowledgeCursor(machineId);
      const rows = this.#store.knowledgeAfter(cursor.pushedRseq, this.#page);
      if (rows.length === 0) break;
      // The machine a version came from already has it (unless its store was replaced since).
      const items = rows.filter((r) => st.pushAll || r.fromMachine !== machineId).map((r) => r.record);
      if (items.length > 0) await st.link.request('knowledge.sync.push', { machineId, items });
      if (!this.#store.isOpen || this.#links.get(machineId) !== st) return;
      this.#store.setKnowledgeCursor(machineId, { ...this.#store.knowledgeCursor(machineId), pushedRseq: rows[rows.length - 1]!.rseq });
      if (rows.length < this.#page) break;
    }
    st.pushAll = false;
  }
}

/** Enough to store and order a record; the receiving node validates the rest. */
function isRecord(v: unknown): v is KnowledgeRecord {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const r = v as Partial<KnowledgeRecord>;
  return typeof r.id === 'string' && r.id.length > 0 && r.id.length <= 200 && typeof r.hlc === 'string' && HLC_RE.test(r.hlc);
}
