// Local copy of the core NodeExtension API (packages/core is adding it in parallel). The shapes
// match `@bizzi/core` exactly, so these extensions can be passed to `createNode({ extensions })`
// unchanged once it lands; switch these to re-exports from '@bizzi/core' then.

import type { BizziNode, DispatchMethod } from '@bizzi/core';
import type { AgentKind, GlobalEventBody, Logger, SessionEventBody } from '@bizzi/protocol';

export type AgentEnvProvider = (agent: AgentKind) => Record<string, string> | Promise<Record<string, string>>;

export interface ExtensionContext {
  /** node.call('session.create', …), node.subscribe(ch, since, listener), node.machine */
  node: BizziNode;
  logger: Logger;
  emitGlobal(body: GlobalEventBody): void;
  emitSession(sessionId: string, body: SessionEventBody): void;
  /** Environment added to every agent process the node starts (merged per session start). */
  setAgentEnvProvider(fn: AgentEnvProvider): void;
}

export type ExtensionMethod = (params: any, ctx: ExtensionContext) => unknown | Promise<unknown>;

export interface NodeExtension {
  methods: Partial<Record<DispatchMethod, ExtensionMethod>>;
  start?(ctx: ExtensionContext): void | Promise<void>;
  stop?(): void | Promise<void>;
}
