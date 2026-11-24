import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { BizziError, type KnowledgeRecord, type Logger } from '@bizzi/protocol';
import { HubStore, KnowledgeSync } from '../src/index.ts';
import type { LinkHandle } from '../src/relay.ts';
import { tempDir } from './helpers.ts';

const logger: Logger = { log() {}, child: () => logger };

/** A node's knowledge store reduced to what replication sees: records by id, last writer by HLC. */
class FakeNode {
  readonly machineId: string;
  storeId = randomUUID();
  items = new Map<string, KnowledgeRecord>();
  #tick = 0;
  constructor(machineId: string) {
    this.machineId = machineId;
  }
  hlc(): string {
    return `${String(1_000_000 + ++this.#tick).padStart(15, '0')}-000000-${this.machineId}`;
  }
  write(id: string, title: string, hlc = this.hlc()): KnowledgeRecord {
    const rec: KnowledgeRecord = {
      id,
      type: 'rule',
      scope: { level: 'global' },
      title,
      body: '',
      tags: [],
      source: { machineId: this.machineId, via: 'ui' },
      status: 'active',
      contentHash: title,
      createdAt: '2026-11-11T00:00:00.000Z',
      updatedAt: '2026-11-11T00:00:00.000Z',
      hlc,
    };
    this.items.set(id, rec);
    return rec;
  }
  title(id: string): string | undefined {
    return this.items.get(id)?.title;
  }
}

/** A link to a FakeNode that answers knowledge.sync.* the way the services extension does. */
class FakeLink implements LinkHandle {
  readonly node: FakeNode;
  readonly deviceId = 'd_X';
  readonly calls: { method: string; ids: string[] }[] = [];
  unsupported = false;
  constructor(node: FakeNode) {
    this.node = node;
  }
  get machineId(): string {
    return this.node.machineId;
  }
  async request(method: string, params: unknown): Promise<unknown> {
    await new Promise((r) => setImmediate(r));
    if (this.unsupported) throw new BizziError('unsupported', `unknown method ${method}`);
    const p = params as { since?: string; limit: number; items?: KnowledgeRecord[] };
    if (method === 'knowledge.sync.pull') {
      const all = [...this.node.items.values()].filter((r) => p.since === undefined || r.hlc > p.since).sort((a, b) => (a.hlc < b.hlc ? -1 : 1));
      const items = all.slice(0, p.limit);
      this.calls.push({ method, ids: items.map((i) => i.id) });
      return { items, more: all.length > p.limit, storeId: this.node.storeId };
    }
    if (method === 'knowledge.sync.push') {
      this.calls.push({ method, ids: p.items!.map((i) => i.id) });
      let applied = 0;
      for (const r of p.items!) {
        const cur = this.node.items.get(r.id);
        if (cur && cur.hlc >= r.hlc) continue;
        this.node.items.set(r.id, r);
        applied++;
      }
      return { applied };
    }
    throw new BizziError('unsupported', method);
  }
  watch(): void {}
  forget(): void {}
  close(): void {}
}

function setup(t: { after(fn: () => void): void }, pageSize = 2) {
  const dir = tempDir();
  const store = new HubStore(dir.path);
  t.after(() => {
    store.close();
    dir.cleanup();
  });
  return { store, sync: new KnowledgeSync({ store, logger, pageSize }) };
}

test('two nodes converge: pages, last writer wins, nothing echoes back to its origin', async (t) => {
  const { store, sync } = setup(t);
  const a = new FakeNode('m_A');
  const b = new FakeNode('m_B');
  a.write('k_1', 'one');
  a.write('k_2', 'two');
  a.write('k_3', 'three');
  b.write('k_9', 'nine');
  const la = new FakeLink(a);
  const lb = new FakeLink(b);
  sync.attach(la);
  sync.attach(lb);
  await sync.idle();

  for (const n of [a, b]) assert.deepEqual([...n.items.keys()].sort(), ['k_1', 'k_2', 'k_3', 'k_9'], n.machineId);
  assert.equal(store.countKnowledge(), 4);
  const pushedTo = (l: FakeLink) => l.calls.filter((c) => c.method === 'knowledge.sync.push').flatMap((c) => c.ids);
  assert.deepEqual(pushedTo(la), ['k_9'], 'A is never sent its own items');
  assert.deepEqual(pushedTo(lb).sort(), ['k_1', 'k_2', 'k_3']);

  // Concurrent edits of one item: the newer clock wins on both sides, whichever arrives first.
  b.write('k_1', 'one (B, newer)', '000000002000000-000000-m_B');
  a.write('k_1', 'one (A, older)');
  sync.nodeChanged(lb);
  sync.nodeChanged(la);
  await sync.idle();
  assert.equal(a.title('k_1'), 'one (B, newer)');
  assert.equal(b.title('k_1'), 'one (B, newer)');
  assert.equal(store.getKnowledge('k_1')?.title, 'one (B, newer)');
});

test('a node that was offline gets what it missed; a replaced store syncs both ways again', async (t) => {
  const { sync } = setup(t);
  const a = new FakeNode('m_A');
  const b = new FakeNode('m_B');
  a.write('k_1', 'one');
  const la = new FakeLink(a);
  let lb = new FakeLink(b);
  sync.attach(la);
  sync.attach(lb);
  await sync.idle();
  assert.equal(b.title('k_1'), 'one');

  // B goes offline; A changes things; B edits locally while offline.
  sync.detach(lb);
  a.write('k_2', 'two');
  a.write('k_1', 'one, edited');
  sync.nodeChanged(la);
  b.write('k_8', 'written offline on B');
  sync.nodeChanged(lb); // stale link: ignored
  await sync.idle();
  assert.equal(b.title('k_2'), undefined);

  lb = new FakeLink(b);
  sync.attach(lb);
  await sync.idle();
  assert.deepEqual([b.title('k_1'), b.title('k_2')], ['one, edited', 'two']);
  assert.equal(a.title('k_8'), 'written offline on B');

  // A's database is replaced (new store id, empty): it gets everything back, its own items included.
  a.items.clear();
  a.storeId = randomUUID();
  a.write('k_7', 'fresh on new A');
  const la2 = new FakeLink(a);
  sync.detach(la);
  sync.attach(la2);
  await sync.idle();
  assert.deepEqual([...a.items.keys()].sort(), ['k_1', 'k_2', 'k_7', 'k_8']);
  assert.equal(b.title('k_7'), 'fresh on new A');
});

test('a node without knowledge.sync is left alone', async (t) => {
  const { store, sync } = setup(t);
  const a = new FakeNode('m_A');
  a.write('k_1', 'one');
  const la = new FakeLink(a);
  la.unsupported = true;
  sync.attach(la);
  await sync.idle();
  sync.nodeChanged(la);
  await sync.idle();
  assert.equal(store.countKnowledge(), 0);
});
