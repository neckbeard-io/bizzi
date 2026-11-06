// The NodeExtension API comes from @bizzi/core; these aliases keep the services' own names short.

import type { ExtensionContext } from '@bizzi/core';
import type { AgentKind } from '@bizzi/protocol';

export type { ExtensionContext, NodeExtension } from '@bizzi/core';

export type AgentEnvProvider = (agent: AgentKind) => Record<string, string> | Promise<Record<string, string>>;

export type ExtensionMethod = (params: any, ctx: ExtensionContext) => unknown | Promise<unknown>;
