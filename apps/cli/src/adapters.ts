import type { AgentAdapter, Logger } from '@bizzi/protocol';

/** Adapter packages probed at startup, in priority order (first match wins per agent + mode). */
export const ADAPTER_PACKAGES = ['@bizzi/adapter-claude', '@bizzi/adapter-codex', '@bizzi/adapter-opencode', '@bizzi/pty'];

/**
 * Passed to every adapter package's `createAdapters()`. Packages take what they know and ignore the
 * rest (e.g. @bizzi/pty reads `<dataDir>/detectors.json` for its detector override).
 */
export interface AdapterLoadOptions {
  /** The node's data dir (`--data-dir`). */
  dataDir?: string;
}

interface AdapterModule {
  createAdapters?: (options?: AdapterLoadOptions) => AgentAdapter[] | Promise<AgentAdapter[]>;
}

export function isMissing(err: unknown, name: string): boolean {
  const e = err as NodeJS.ErrnoException;
  return (e?.code === 'ERR_MODULE_NOT_FOUND' || e?.code === 'MODULE_NOT_FOUND') && String(e.message).includes(name);
}

/** Import each package and collect its adapters. Missing packages are skipped; broken ones are logged. */
export async function loadAdapters(
  logger: Logger,
  names: readonly string[] = ADAPTER_PACKAGES,
  options: AdapterLoadOptions = {},
): Promise<AgentAdapter[]> {
  const out: AgentAdapter[] = [];
  for (const name of names) {
    let mod: AdapterModule;
    try {
      mod = (await import(name)) as AdapterModule;
    } catch (err) {
      if (isMissing(err, name)) logger.log('debug', 'adapter package not installed', { package: name });
      else logger.log('warn', 'failed to load adapter package', { package: name, err });
      continue;
    }
    if (typeof mod.createAdapters !== 'function') {
      logger.log('warn', 'adapter package has no createAdapters export', { package: name });
      continue;
    }
    try {
      const adapters = await mod.createAdapters({ ...options });
      for (const a of adapters) out.push(a);
      logger.log('info', 'loaded adapters', { package: name, agents: adapters.map((a) => a.agent) });
    } catch (err) {
      logger.log('warn', 'createAdapters threw', { package: name, err });
    }
  }
  return out;
}
