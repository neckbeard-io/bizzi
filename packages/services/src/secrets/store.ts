// Per-agent secrets (API keys, tokens) stored on this machine and injected into the agent's
// environment. Values live in a SecretBackend; a small metadata index (agent, name, setAt — no
// values) makes listing cheap and backend independent.

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { BizziError, type AgentKind, type Logger, type SecretInfo } from '@bizzi/protocol';
import { writePrivateFile, type SecretBackend } from './backends.ts';

export const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export const MAX_SECRET_LENGTH = 2048;

/** Variables a secret must not override: they'd change how the agent process itself runs. */
const RESERVED = new Set(['PATH', 'HOME', 'SHELL', 'USER', 'LOGNAME', 'TMPDIR', 'PWD', 'TERM', 'NODE_OPTIONS', 'NODE_PATH']);
const RESERVED_PREFIXES = ['LD_', 'DYLD_', 'BIZZI_'];

export function validateSecretName(name: string): void {
  if (!SECRET_NAME_RE.test(name)) {
    throw new BizziError('bad_request', 'secret name must be an environment variable name (letters, digits, _; not starting with a digit)');
  }
  if (RESERVED.has(name) || RESERVED_PREFIXES.some((p) => name.startsWith(p))) {
    throw new BizziError('bad_request', `${name} is reserved and can't be stored as a secret`);
  }
}

export function validateSecretValue(value: string): void {
  if (value.length === 0) throw new BizziError('bad_request', 'secret value is empty');
  if (value.length > MAX_SECRET_LENGTH) throw new BizziError('bad_request', `secret value is longer than ${MAX_SECRET_LENGTH} characters`);
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new BizziError('bad_request', 'secret value contains control characters (newlines?)');
}

export function secretAccount(agent: AgentKind, name: string): string {
  return `${agent}:${name}`;
}

interface IndexFile {
  version: 1;
  /** Backend that holds the values (switching backends orphans them; listed entries are then skipped). */
  backend: string;
  secrets: SecretInfo[];
}

export interface SecretStoreOptions {
  backend: SecretBackend;
  /** JSON metadata index (0600). Omit for an in-memory index (tests). */
  indexPath?: string;
  logger?: Logger;
  now?: () => Date;
}

export class SecretStore {
  readonly backend: SecretBackend;
  readonly #indexPath: string | undefined;
  readonly #logger: Logger | undefined;
  readonly #now: () => Date;
  #index: SecretInfo[];
  /** Values read for env injection, so each session start doesn't spawn a keychain lookup per secret. */
  readonly #cache = new Map<string, string>();
  /** Serializes writes (index + backend) so concurrent set/delete calls don't interleave. */
  #lock: Promise<unknown> = Promise.resolve();

  constructor(opts: SecretStoreOptions) {
    this.backend = opts.backend;
    this.#indexPath = opts.indexPath;
    this.#logger = opts.logger;
    this.#now = opts.now ?? (() => new Date());
    this.#index = this.#readIndex();
  }

  #readIndex(): SecretInfo[] {
    if (!this.#indexPath || !existsSync(this.#indexPath)) return [];
    try {
      const f = JSON.parse(readFileSync(this.#indexPath, 'utf8')) as IndexFile;
      if (f.backend !== this.backend.name) {
        this.#logger?.log('warn', 'secrets index belongs to another backend; starting empty', { index: f.backend, backend: this.backend.name });
        return [];
      }
      return Array.isArray(f.secrets) ? f.secrets.filter((s) => s && typeof s.name === 'string' && typeof s.agent === 'string') : [];
    } catch (err) {
      this.#logger?.log('warn', 'unreadable secrets index; starting empty', { path: this.#indexPath, err: String(err) });
      return [];
    }
  }

  #writeIndex(): void {
    if (!this.#indexPath) return;
    mkdirSync(dirname(this.#indexPath), { recursive: true, mode: 0o700 });
    const f: IndexFile = { version: 1, backend: this.backend.name, secrets: this.#index };
    writePrivateFile(this.#indexPath, JSON.stringify(f, null, 1) + '\n');
  }

  #locked<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#lock.then(fn, fn);
    this.#lock = next.catch(() => {});
    return next;
  }

  /** Metadata only, sorted by agent then name. */
  list(agent?: AgentKind): SecretInfo[] {
    return this.#index
      .filter((s) => agent === undefined || s.agent === agent)
      .map((s) => ({ ...s }))
      .sort((a, b) => (a.agent === b.agent ? a.name.localeCompare(b.name) : a.agent.localeCompare(b.agent)));
  }

  has(agent: AgentKind, name: string): boolean {
    return this.#index.some((s) => s.agent === agent && s.name === name);
  }

  async set(agent: AgentKind, name: string, value: string): Promise<SecretInfo> {
    validateSecretName(name);
    validateSecretValue(value);
    return this.#locked(async () => {
      const account = secretAccount(agent, name);
      await this.backend.set(account, value);
      const info: SecretInfo = { agent, name, setAt: this.#now().toISOString() };
      this.#index = [...this.#index.filter((s) => !(s.agent === agent && s.name === name)), info];
      this.#writeIndex();
      this.#cache.set(account, value);
      this.#logger?.log('info', 'secret stored', { agent, name, backend: this.backend.name });
      return { ...info };
    });
  }

  /** Idempotent: resolves false when there was nothing to delete. */
  async delete(agent: AgentKind, name: string): Promise<boolean> {
    validateSecretName(name);
    return this.#locked(async () => {
      const account = secretAccount(agent, name);
      const listed = this.has(agent, name);
      const removed = await this.backend.delete(account);
      this.#index = this.#index.filter((s) => !(s.agent === agent && s.name === name));
      this.#writeIndex();
      this.#cache.delete(account);
      if (listed || removed) this.#logger?.log('info', 'secret deleted', { agent, name, backend: this.backend.name });
      return listed || removed;
    });
  }

  /** One secret's value (for node-side templating such as widgets' `${secret:…}`); never logged. */
  async get(agent: AgentKind, name: string): Promise<string | undefined> {
    if (!this.has(agent, name)) return undefined;
    const account = secretAccount(agent, name);
    const cached = this.#cache.get(account);
    if (cached !== undefined) return cached;
    const value = await this.backend.get(account);
    if (value !== undefined) this.#cache.set(account, value);
    return value;
  }

  /** The agent's secrets as environment variables. Missing values (e.g. removed outside bizzi) are skipped. */
  async env(agent: AgentKind): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const s of this.list(agent)) {
      const account = secretAccount(agent, s.name);
      let value = this.#cache.get(account);
      if (value === undefined) {
        try {
          value = await this.backend.get(account);
        } catch (err) {
          this.#logger?.log('warn', 'could not read secret', { agent, name: s.name, err: String(err) });
          continue;
        }
        if (value === undefined) {
          this.#logger?.log('warn', 'listed secret has no value in the backend', { agent, name: s.name, backend: this.backend.name });
          continue;
        }
        this.#cache.set(account, value);
      }
      out[s.name] = value;
    }
    return out;
  }
}
