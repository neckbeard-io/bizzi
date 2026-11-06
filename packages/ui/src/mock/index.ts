// Lazy entry for the mock server (kept out of the main bundle).
import type { StoreSnapshot } from '@bizzi/client';
import { SERVER, SERVER_AGENTS, SESSIONS, WORKSPACES } from './fixtures.ts';
import { MockCore, createMockHubFetch, createMockSocketFactory } from './mockServer.ts';
import type { MockOptions } from './mockServer.ts';

export { MockCore, createMockHubFetch, createMockSocketFactory };

let shared: MockCore | null = null;

/** One mock hub per page, shared by the pairing screen and the connection that follows. */
export function sharedMockHub(opts: MockOptions = {}): MockCore {
  shared ??= new MockCore({ role: 'hub', ...opts });
  return shared;
}

/**
 * What this device remembered from its last visit: server-a (offline in the demo) with its agents,
 * workspaces and sessions, so the offline machine shows cached, read-only data.
 */
export function mockSnapshot(): StoreSnapshot {
  return {
    v: 1,
    machines: { [SERVER.id]: { ...SERVER } },
    agents: { [SERVER.id]: SERVER_AGENTS },
    workspaces: Object.fromEntries(WORKSPACES.filter((w) => w.machineId === SERVER.id).map((w) => [w.id, w])),
    sessions: Object.fromEntries(SESSIONS.filter((x) => x.machineId === SERVER.id).map((x) => [x.id, x])),
    selectedMachineId: null,
  };
}
