// Optional node extensions from @bizzi/services: provisioning (agent.plan/install), secrets,
// agent logins and the knowledge.* methods. Loaded like the adapter packages: skipped if missing.

import type { NodeOptions } from '@bizzi/core';
import type { Logger } from '@bizzi/protocol';
import { isMissing } from './adapters.ts';
import type { KnowledgeRuntime } from './knowledge.ts';

export const SERVICES_PACKAGE = '@bizzi/services';

/** The core's extension list type once `createNode({ extensions })` exists; unknown[] before that. */
export type NodeExtensions = NodeOptions extends { extensions?: infer E } ? NonNullable<E> : unknown[];

interface ServicesModule {
  createServices?: (opts: {
    dataDir: string;
    logger?: Logger;
    knowledge?: ((machineId: string) => unknown) | false;
  }) => Promise<{ extensions: unknown[] }>;
}

export interface LoadServicesOptions {
  dataDir: string;
  logger: Logger;
  /** The node's shared knowledge store; without it the knowledge methods stay unimplemented. */
  knowledge?: KnowledgeRuntime;
}

export async function loadServices(opts: LoadServicesOptions, name = SERVICES_PACKAGE): Promise<{ extensions: NodeExtensions } | undefined> {
  const { logger } = opts;
  let mod: ServicesModule;
  try {
    mod = (await import(name)) as ServicesModule;
  } catch (err) {
    if (isMissing(err, name)) logger.log('debug', 'services package not installed', { package: name });
    else logger.log('warn', 'failed to load services package', { package: name, err });
    return undefined;
  }
  if (typeof mod.createServices !== 'function') {
    logger.log('warn', 'services package has no createServices export', { package: name });
    return undefined;
  }
  try {
    const knowledge = opts.knowledge;
    const services = await mod.createServices({
      dataDir: opts.dataDir,
      logger,
      knowledge: knowledge ? (machineId) => knowledge.store(machineId) : false,
    });
    return { extensions: services.extensions as NodeExtensions };
  } catch (err) {
    logger.log('warn', 'createServices threw; continuing without services', { package: name, err });
    return undefined;
  }
}
