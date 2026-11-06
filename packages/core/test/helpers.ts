import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import type { AgentAdapter, ChannelEvent } from '@bizzi/protocol';
import { createNode, type BizziNode } from '../src/index.ts';
import { FakeAdapter } from '../src/testing/index.ts';

export function tempDir(prefix = 'bizzi-core-'): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(os.tmpdir(), prefix));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

export async function makeNode(dataDir: string, adapters: AgentAdapter[] = [new FakeAdapter()]): Promise<BizziNode> {
  return createNode({ dataDir, adapters, version: '0.0.0-test', machineName: 'test-machine', interruptGraceMs: 200 });
}

export async function waitFor<T>(fn: () => T | undefined | false, timeoutMs = 5000, what = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Collects every event on a channel (replay + live). */
export function record(node: BizziNode, ch: string, since = 0) {
  const events: ChannelEvent[] = [];
  const sub = node.subscribe(ch, since, (ev) => events.push(ev));
  return {
    events,
    types: () => events.map((e) => e.type),
    find: <T extends ChannelEvent['type']>(type: T) =>
      events.find((e) => e.type === type) as Extract<ChannelEvent, { type: T }> | undefined,
    waitFor: <T extends ChannelEvent['type']>(type: T, pred: (ev: Extract<ChannelEvent, { type: T }>) => boolean = () => true) =>
      waitFor(() => events.find((e) => e.type === type && pred(e as Extract<ChannelEvent, { type: T }>)) as Extract<ChannelEvent, { type: T }> | undefined, 5000, type),
    stop: sub.unsubscribe,
  };
}
