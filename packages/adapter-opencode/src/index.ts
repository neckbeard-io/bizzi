import type { AgentAdapter } from '@bizzi/protocol';
import { OpenCodeAdapter, type OpenCodeAdapterOptions } from './adapter.ts';

export {
  OPENCODE_CAPABILITIES,
  OPENCODE_EFFORTS,
  OPENCODE_PERMISSION_MODES,
  OpenCodeAdapter,
  type OpenCodeAdapterOptions,
} from './adapter.ts';
export { OpenCodeClient, OpenCodeHttpError, type ClientOptions } from './client.ts';
export { OpenCodeServer, type ServerListener, type ServerOptions } from './server.ts';
export { OpenCodeSession } from './session.ts';
export { probeOpenCode, type ProbeOptions } from './probe.ts';
export { parseModel, formatModel, toolKind, toolTitle } from './mapping.ts';
export type * from './types.ts';

/** Adapter discovery entry point used by the CLI. */
export function createAdapters(options?: OpenCodeAdapterOptions): AgentAdapter[] {
  return [new OpenCodeAdapter(options)];
}
