// Optional node extension from @bizzi/orchestration: the bizzi-agents MCP tools (spec §12.1), served
// on a loopback port and injected into structured sessions. Skipped if the package is missing.

import type { NodeExtension } from '@bizzi/core';
import type { Logger } from '@bizzi/protocol';
import { isMissing } from './adapters.ts';

export const ORCHESTRATION_PACKAGE = '@bizzi/orchestration';

interface OrchestrationModule {
  createOrchestrationExtension?: (opts?: { host?: string; port?: number }) => NodeExtension;
}

export async function loadOrchestration(logger: Logger, name = ORCHESTRATION_PACKAGE): Promise<NodeExtension | undefined> {
  let mod: OrchestrationModule;
  try {
    mod = (await import(name)) as OrchestrationModule;
  } catch (err) {
    if (isMissing(err, name)) logger.log('debug', 'orchestration package not installed', { package: name });
    else logger.log('warn', 'failed to load orchestration package', { package: name, err });
    return undefined;
  }
  if (typeof mod.createOrchestrationExtension !== 'function') {
    logger.log('warn', 'orchestration package has no createOrchestrationExtension export', { package: name });
    return undefined;
  }
  const port = process.env.BIZZI_AGENTS_MCP_PORT ? Number(process.env.BIZZI_AGENTS_MCP_PORT) : undefined;
  return mod.createOrchestrationExtension(port !== undefined && Number.isInteger(port) ? { port } : {});
}
