// @bizzi/services: NodeExtension implementations for the node role — provisioning (install,
// secrets), agent logins, the knowledge methods and widgets.

import { join } from 'node:path';
import { KnowledgeStore } from '@bizzi/knowledge';
import { AGENT_KINDS, type AgentKind, type Logger } from '@bizzi/protocol';
import type { RecipeSet } from '@bizzi/provision';
import { createKnowledgeExtension, type KnowledgeExtension, type KnowledgeStoreSource } from './knowledge.ts';
import { createLoginExtension, type LoginExtension, type LoginOptions } from './login.ts';
import { createProvisioningExtension, type ProvisioningExtension, type ProvisioningOptions } from './provisioning.ts';
import { createDefaultSecretBackend, type SecretBackend } from './secrets/backends.ts';
import { SecretStore } from './secrets/store.ts';
import type { NodeExtension } from './types.ts';
import { createWidgetsExtension, type WidgetsExtension, type WidgetsOptions } from './widgets/runtime.ts';

export type { AgentEnvProvider, ExtensionContext, ExtensionMethod, NodeExtension } from './types.ts';
export {
  createKnowledgeExtension,
  toItemInfo,
  toWireScope,
  toWireSettings,
  type KnowledgeExtension,
  type KnowledgeExtensionOptions,
  type KnowledgeStoreSource,
} from './knowledge.ts';
export { createLoginExtension, loginCommand, type LoginCommand, type LoginExtension, type LoginOptions } from './login.ts';
export { createProvisioningExtension, toWirePlan, type ProvisioningExtension, type ProvisioningOptions } from './provisioning.ts';
export {
  EncryptedFileBackend,
  KeychainSecretBackend,
  LibsecretBackend,
  MemorySecretBackend,
  SECRET_SERVICE,
  SECRETS_DATA_FILE,
  SECRETS_KEY_FILE,
  createDefaultSecretBackend,
  securityQuote,
  type DefaultBackendOptions,
  type KeychainOptions,
  type LibsecretOptions,
  type SecretBackend,
  type SecretBackendName,
} from './secrets/backends.ts';
export { runCommand, type CommandRunner, type RunOptions as CommandRunOptions, type RunResult as CommandRunResult } from './secrets/run.ts';
export {
  MAX_SECRET_LENGTH,
  SECRET_NAME_RE,
  SecretStore,
  secretAccount,
  validateSecretName,
  validateSecretValue,
  type SecretStoreOptions,
} from './secrets/store.ts';

export {
  MAX_COMMAND_OUTPUT,
  MAX_HTTP_BYTES,
  WIDGET_REPUBLISH_MS,
  createWidgetsExtension,
  defaultWidgetsDir,
  parseCommandOutput,
  thresholdTone,
  type WidgetsExtension,
  type WidgetsOptions,
} from './widgets/runtime.ts';
export {
  AGENTS_FILE as WIDGETS_AGENTS_FILE,
  SCHEMA_FILE as WIDGET_SCHEMA_FILE,
  WIDGET_JSON_SCHEMA,
  parseDuration,
  parseWidget,
  type WidgetDef,
} from './widgets/schema.ts';
export { expand, jsonPath, parsePath, scrub, type TemplateContext } from './widgets/expr.ts';

export const SECRETS_INDEX_FILE = 'secrets.json';

export interface ServicesOptions {
  /** The node's data dir: secrets index (and the encrypted-file backend) live here. */
  dataDir: string;
  logger?: Logger;
  /** Default: Keychain (macOS), libsecret or an encrypted file (Linux); see createDefaultSecretBackend. */
  secretBackend?: SecretBackend;
  recipes?: RecipeSet;
  /**
   * The knowledge store shared with the session-start injection hook (or a function opening it
   * for the node's machine id). Default: `<dataDir>/knowledge.db`, opened on first use.
   * `false` leaves the knowledge methods unimplemented.
   */
  knowledge?: KnowledgeStoreSource | false;
  /** Claude config dir for auto-memory harvest (default ~/.claude). */
  claudeHome?: string;
  provisioning?: Partial<Omit<ProvisioningOptions, 'secrets'>>;
  login?: LoginOptions;
  /** Widgets (usage.md §4); `false` leaves widgets.* unimplemented. `${secret:…}` uses the secret store. */
  widgets?: Omit<WidgetsOptions, 'secret'> | false;
}

export interface Services {
  extensions: NodeExtension[];
  secrets: SecretStore;
  provisioning: ProvisioningExtension;
  login: LoginExtension;
  knowledge?: KnowledgeExtension;
  widgets?: WidgetsExtension;
}

/**
 * `${secret:NAME}` → the first agent's stored secret called NAME (claude, codex, … order), or
 * `${secret:agent:NAME}` for one agent's.
 */
export function secretLookup(secrets: SecretStore): (name: string) => Promise<string | undefined> {
  return async (ref) => {
    const i = ref.indexOf(':');
    if (i > 0) {
      const agent = ref.slice(0, i) as AgentKind;
      return AGENT_KINDS.includes(agent) ? secrets.get(agent, ref.slice(i + 1)) : undefined;
    }
    for (const agent of AGENT_KINDS) if (secrets.has(agent, ref)) return secrets.get(agent, ref);
    return undefined;
  };
}

/** Build every extension, sharing one secret store (and the given knowledge store). */
export async function createServices(opts: ServicesOptions): Promise<Services> {
  const backend = opts.secretBackend ?? (await createDefaultSecretBackend({ dataDir: opts.dataDir }));
  const secrets = new SecretStore({
    backend,
    indexPath: join(opts.dataDir, SECRETS_INDEX_FILE),
    ...(opts.logger ? { logger: opts.logger.child({ component: 'secrets' }) } : {}),
  });
  const recipes = opts.recipes ? { recipes: opts.recipes } : {};
  const provisioning = createProvisioningExtension({ ...recipes, ...opts.provisioning, secrets });
  const login = createLoginExtension({ ...recipes, ...opts.login });
  const store: KnowledgeStoreSource | false =
    opts.knowledge ??
    ((machineId: string) =>
      new KnowledgeStore({
        path: join(opts.dataDir, 'knowledge.db'),
        machineId,
        ...(opts.logger ? { logger: opts.logger.child({ component: 'knowledge' }) } : {}),
      }));
  const knowledge =
    store === false ? undefined : createKnowledgeExtension({ store, ...(opts.claudeHome ? { claudeHome: opts.claudeHome } : {}) });
  const widgets = opts.widgets === false ? undefined : createWidgetsExtension({ ...opts.widgets, secret: secretLookup(secrets) });
  opts.logger?.log('info', 'services ready', { secrets: backend.name, knowledge: knowledge !== undefined, widgets: widgets?.dir ?? false });
  return {
    extensions: [provisioning, login, ...(knowledge ? [knowledge] : []), ...(widgets ? [widgets] : [])],
    secrets,
    provisioning,
    login,
    ...(knowledge ? { knowledge } : {}),
    ...(widgets ? { widgets } : {}),
  };
}
