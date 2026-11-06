import type { AgentAdapter } from '@bizzi/protocol';
import { FakeAdapter } from './fake-adapter.ts';

export {
  FakeAdapter,
  FakeSession,
  defaultScript,
  textOf,
  type FakeAdapterOptions,
  type FakeScript,
  type FakeStep,
  type FakeTurnContext,
} from './fake-adapter.ts';

/** Same shape as real adapter packages: a structured fake Claude plus a terminal-mode fake shell. */
export function createAdapters(): AgentAdapter[] {
  return [new FakeAdapter({ agent: 'claude' }), new FakeAdapter({ agent: 'shell', modes: ['terminal'] })];
}
