import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeStore } from '../src/index.ts';
import type { KnowledgeContext, KnowledgeStoreOptions } from '../src/index.ts';

export const M1 = 'm_ONE';
export const M2 = 'm_TWO';
export const P1 = 'p_ALPHA';
export const P2 = 'p_BETA';
export const W1 = 'w_ALPHA_MAIN';
export const W2 = 'w_ALPHA_OTHER';
export const S1 = 's_FIRST';
export const S2 = 's_SECOND';

export const CTX: KnowledgeContext = { agent: 'claude', machineId: M1, projectId: P1, workspaceId: W1, sessionId: S1 };

export interface TestClock {
  now: () => number;
  advance(ms: number): void;
  set(ms: number): void;
}

export function testClock(start = Date.parse('2026-11-01T00:00:00Z')): TestClock {
  let t = start;
  return {
    now: () => t,
    advance(ms) {
      t += ms;
    },
    set(ms) {
      t = ms;
    },
  };
}

export function memStore(opts: Partial<KnowledgeStoreOptions> & { clock?: TestClock } = {}): { store: KnowledgeStore; clock: TestClock } {
  const clock = opts.clock ?? testClock();
  const store = new KnowledgeStore({ path: ':memory:', machineId: M1, now: clock.now, ...opts });
  return { store, clock };
}

export function tempDir(prefix = 'bizzi-knowledge-'): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export const DAY = 86_400_000;
