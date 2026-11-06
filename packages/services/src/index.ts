// @bizzi/services: NodeExtension implementations for the node role — provisioning (install,
// secrets), agent logins, and the knowledge methods.

import { join } from 'node:path';
import { KnowledgeStore } from '@bizzi/knowledge';
import type { Logger } from '@bizzi/protocol';
import type { RecipeSet } from '@bizzi/provision';
import { createKnowledgeExtension, type KnowledgeExtension, type KnowledgeStoreSource } from './knowledge.ts';
import { createLoginExtension, type LoginExtension, type LoginOptions } from './login.ts';
import { createProvisioningExtension, type ProvisioningExtension, type ProvisioningOptions } from './provisioning.ts';
import { createDefaultSecretBackend, type SecretBackend } from './secrets/backends.ts';
import { SecretStore } from './secrets/store.ts';
import type { NodeExtension } from './types.ts';

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
}

export interface Services {
  extensions: NodeExtension[];
  secrets: SecretStore;
  provisioning: ProvisioningExtension;
  login: LoginExtension;
  knowledge?: KnowledgeExtension;
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
  opts.logger?.log('info', 'services ready', { secrets: backend.name, knowledge: knowledge !== undefined });
  return {
    extensions: [provisioning, login, ...(knowledge ? [knowledge] : [])],
    secrets,
    provisioning,
    login,
    ...(knowledge ? { knowledge } : {}),
  };
}
