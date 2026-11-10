export * from './backoff.ts';
export * from './base64.ts';
export * from './client.ts';
export * from './hub.ts';
export * from './identity.ts';
export * from './native.ts';
export * from './scheduler.ts';
export * from './sidebar.ts';
export * from './store.ts';
export * from './terminal.ts';
export * from './timeline.ts';
export * from './usage.ts';

import { BizziClient } from './client.ts';
import type { BizziClientOptions } from './client.ts';
import { BizziStore } from './store.ts';
import type { BizziStoreOptions } from './store.ts';

/** Convenience: a client plus a store wired to it. */
export function createBizzi(options: { client?: BizziClientOptions; store?: BizziStoreOptions } = {}): { client: BizziClient; store: BizziStore } {
  const client = new BizziClient(options.client);
  const store = new BizziStore(client, options.store);
  return { client, store };
}
