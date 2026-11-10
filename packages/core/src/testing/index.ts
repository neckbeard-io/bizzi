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

/**
 * Same shape as real adapter packages: a structured fake Claude plus a terminal-mode fake shell.
 * They report `support: 'ok'` so the supported-version check (spec §7) doesn't judge their
 * `0.0.0-fake` version against Claude's real ranges and refuse fake structured sessions.
 */
export function createAdapters(): AgentAdapter[] {
  const probe = { support: 'ok' } as const;
  return [new FakeAdapter({ agent: 'claude', probe }), new FakeAdapter({ agent: 'shell', modes: ['terminal'], probe })];
}
