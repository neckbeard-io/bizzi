// Optional node extensions from @bizzi/services: provisioning (agent.plan/install), secrets,
// agent logins, the knowledge.* methods and widgets. Loaded like the adapter packages: skipped if missing.

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
    widgets?: { dir?: string } | false;
    updates?: { watch?: boolean; probeIntervalMs?: number; autoUpdateIntervalMs?: number };
  }) => Promise<{ extensions: unknown[] }>;
}

/** Re-probe agents this often (also retries watches on paths that didn't exist yet). */
export const PROBE_INTERVAL_MS = 30 * 60_000;

/**
 * Automatic agent updates (update policy `auto`, updates.md §6) are opt-in for now:
 * BIZZI_AUTO_UPDATE_HOURS=<n> checks for new versions every n hours.
 */
export function autoUpdateIntervalMs(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const hours = Number(env.BIZZI_AUTO_UPDATE_HOURS);
  return Number.isFinite(hours) && hours > 0 ? Math.max(hours, 0.25) * 3_600_000 : undefined;
}

export interface LoadServicesOptions {
  dataDir: string;
  logger: Logger;
  /** The node's shared knowledge store; without it the knowledge methods stay unimplemented. */
  knowledge?: KnowledgeRuntime;
  /** Run widgets (usage.md §4); `{}` uses the services' default dir ($BIZZI_WIDGETS_DIR, ~/.config/bizzi/widgets). Default off. */
  widgets?: { dir?: string } | false;
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
      widgets: opts.widgets ?? false,
      updates: {
        watch: true,
        probeIntervalMs: PROBE_INTERVAL_MS,
        ...(autoUpdateIntervalMs() ? { autoUpdateIntervalMs: autoUpdateIntervalMs() } : {}),
      },
    });
    return { extensions: services.extensions as NodeExtensions };
  } catch (err) {
    logger.log('warn', 'createServices threw; continuing without services', { package: name, err });
    return undefined;
  }
}
