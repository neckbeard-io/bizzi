import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DRAFT_TTL_MS, draftKey, loadDraft, pruneDrafts, saveDraft } from '../src/lib/drafts.ts';

class MemStorage implements Storage {
  private readonly m = new Map<string, string>();
  get length(): number {
    return this.m.size;
  }
  clear(): void {
    this.m.clear();
  }
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
}

const storage = new MemStorage();
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });

test('drafts: saved per session, cleared when empty, survive a "restart"', () => {
  storage.clear();
  saveDraft('s_1', 'half-written prompt', 1000);
  saveDraft('s_2', 'other session', 1000);
  assert.equal(loadDraft('s_1', 2000), 'half-written prompt');
  assert.equal(loadDraft('s_2', 2000), 'other session');
  assert.equal(loadDraft('s_3', 2000), '');
  // Whitespace-only counts as empty: the key is removed.
  saveDraft('s_1', '  \n', 3000);
  assert.equal(storage.getItem(draftKey('s_1')), null);
});

test('drafts: expired ones are dropped on load and by prune; junk is ignored', () => {
  storage.clear();
  saveDraft('old', 'stale', 0);
  saveDraft('new', 'fresh', DRAFT_TTL_MS);
  storage.setItem(draftKey('junk'), '{not json');
  storage.setItem('bizzi.theme', 'dark');
  pruneDrafts(storage, DRAFT_TTL_MS + 1);
  assert.equal(storage.getItem(draftKey('old')), null);
  assert.equal(loadDraft('new', DRAFT_TTL_MS + 1), 'fresh');
  assert.equal(loadDraft('junk'), '');
  assert.equal(storage.getItem('bizzi.theme'), 'dark', 'other keys are left alone');
});
