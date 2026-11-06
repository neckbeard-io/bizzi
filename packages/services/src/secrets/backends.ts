// Secret value backends. Each stores opaque values under an account key `<agent>:<NAME>`.
// Values are never logged and never appear in error messages or on a command line.
//
//   keychain   macOS: generic passwords in the login keychain via /usr/bin/security (service "bizzi")
//   libsecret  Linux desktop: the Secret Service via `secret-tool` (attributes service=bizzi account=…)
//   file       headless Linux / fallback: AES-256-GCM encrypted JSON in the data dir, keyed by a
//              random 32-byte key file (both 0600)
//   memory     tests

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { BizziError } from '@bizzi/protocol';
import { runCommand, type CommandRunner, type RunResult } from './run.ts';

export const SECRET_SERVICE = 'bizzi';

export interface SecretBackend {
  readonly name: string;
  get(account: string): Promise<string | undefined>;
  set(account: string, value: string): Promise<void>;
  /** Resolves false when nothing was stored under the account (where the backend can tell). */
  delete(account: string): Promise<boolean>;
}

function backendError(backend: string, op: string, r: RunResult): BizziError {
  const why = r.error ?? (r.timedOut ? 'timed out' : (r.stderr.trim().split('\n')[0] ?? '') || `exit ${r.code}`);
  return new BizziError('internal', `${backend}: ${op} failed: ${why}`);
}

// ---- memory (tests) ------------------------------------------------------------------------

export class MemorySecretBackend implements SecretBackend {
  readonly name = 'memory';
  readonly values = new Map<string, string>();
  async get(account: string): Promise<string | undefined> {
    return this.values.get(account);
  }
  async set(account: string, value: string): Promise<void> {
    this.values.set(account, value);
  }
  async delete(account: string): Promise<boolean> {
    return this.values.delete(account);
  }
}

// ---- macOS Keychain --------------------------------------------------------------------------

/** `security` exits 44 (errSecItemNotFound) when there is no such item. */
const SEC_NOT_FOUND = 44;
/** `security -i` reads commands with a ~4 KiB line buffer and runs any overflow as further commands. */
const SECURITY_MAX_LINE = 3900;

/** Quote an argument for `security -i`: double quotes, with `\` and `"` backslash-escaped. */
export function securityQuote(s: string): string {
  return `"${s.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

export interface KeychainOptions {
  run?: CommandRunner;
  /** Default /usr/bin/security. */
  securityPath?: string;
  service?: string;
}

export class KeychainSecretBackend implements SecretBackend {
  readonly name = 'keychain';
  readonly #run: CommandRunner;
  readonly #bin: string;
  readonly #service: string;

  constructor(opts: KeychainOptions = {}) {
    this.#run = opts.run ?? runCommand;
    this.#bin = opts.securityPath ?? '/usr/bin/security';
    this.#service = opts.service ?? SECRET_SERVICE;
  }

  async get(account: string): Promise<string | undefined> {
    const r = await this.#run(this.#bin, ['find-generic-password', '-s', this.#service, '-a', account, '-w']);
    if (r.code === SEC_NOT_FOUND) return undefined;
    if (r.code !== 0) throw backendError('keychain', 'read', r);
    return r.stdout.replace(/\r?\n$/, '');
  }

  async set(account: string, value: string): Promise<void> {
    // printable ASCII only: `security -w` prints anything else hex-encoded, and -i is line based.
    if (!/^[\x20-\x7e]+$/.test(value)) {
      throw new BizziError('bad_request', 'the keychain backend stores printable ASCII values only');
    }
    // The value goes through `security -i` on stdin so it never shows up in the process list.
    const line =
      ['add-generic-password', '-U', '-s', securityQuote(this.#service), '-a', securityQuote(account)].join(' ') +
      ` -l ${securityQuote(`bizzi ${account}`)} -w ${securityQuote(value)}`;
    if (line.length > SECURITY_MAX_LINE) throw new BizziError('bad_request', 'secret value is too long for the keychain backend');
    const r = await this.#run(this.#bin, ['-i'], { input: `${line}\n` });
    if (r.code !== 0) throw backendError('keychain', 'write', r);
  }

  async delete(account: string): Promise<boolean> {
    const r = await this.#run(this.#bin, ['delete-generic-password', '-s', this.#service, '-a', account]);
    if (r.code === SEC_NOT_FOUND) return false;
    if (r.code !== 0) throw backendError('keychain', 'delete', r);
    return true;
  }
}

// ---- libsecret (secret-tool) -------------------------------------------------------------------

export interface LibsecretOptions {
  run?: CommandRunner;
  /** Path to secret-tool (default: looked up on PATH). */
  secretToolPath?: string;
  service?: string;
}

export class LibsecretBackend implements SecretBackend {
  readonly name = 'libsecret';
  readonly #run: CommandRunner;
  readonly #bin: string;
  readonly #service: string;

  constructor(opts: LibsecretOptions = {}) {
    this.#run = opts.run ?? runCommand;
    this.#bin = opts.secretToolPath ?? 'secret-tool';
    this.#service = opts.service ?? SECRET_SERVICE;
  }

  /** secret-tool exists and a Secret Service answers (headless boxes usually have no D-Bus session). */
  static async available(opts: LibsecretOptions = {}): Promise<boolean> {
    const run = opts.run ?? runCommand;
    const r = await run(opts.secretToolPath ?? 'secret-tool', ['lookup', 'service', opts.service ?? SECRET_SERVICE, 'account', '__bizzi_probe__'], {
      timeoutMs: 5000,
    });
    // exit 0 (found) or 1 with no complaint (not found) means the service works.
    return !r.error && !r.timedOut && (r.code === 0 || (r.code === 1 && r.stderr.trim() === ''));
  }

  async get(account: string): Promise<string | undefined> {
    const r = await this.#run(this.#bin, ['lookup', 'service', this.#service, 'account', account]);
    if (r.code === 1 && r.stderr.trim() === '') return undefined;
    if (r.code !== 0) throw backendError('libsecret', 'read', r);
    return r.stdout.replace(/\r?\n$/, '');
  }

  async set(account: string, value: string): Promise<void> {
    // secret-tool reads the secret from stdin when it isn't a terminal.
    const r = await this.#run(this.#bin, ['store', '--label', `bizzi ${account}`, 'service', this.#service, 'account', account], {
      input: value,
    });
    if (r.code !== 0) throw backendError('libsecret', 'write', r);
  }

  async delete(account: string): Promise<boolean> {
    const existed = (await this.get(account)) !== undefined;
    const r = await this.#run(this.#bin, ['clear', 'service', this.#service, 'account', account]);
    if (r.code !== 0 && !(r.code === 1 && r.stderr.trim() === '')) throw backendError('libsecret', 'delete', r);
    return existed;
  }
}

// ---- encrypted file ------------------------------------------------------------------------------

interface EncryptedEntry {
  iv: string;
  tag: string;
  data: string;
}

interface EncryptedFile {
  version: 1;
  entries: Record<string, EncryptedEntry>;
}

export const SECRETS_KEY_FILE = 'secrets.key';
export const SECRETS_DATA_FILE = 'secrets.enc.json';

/** Write a file atomically with mode 0600. */
export function writePrivateFile(path: string, data: string | Buffer): void {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

/**
 * AES-256-GCM encrypted JSON file. The key is 32 random bytes in `secrets.key` (0600) next to the
 * data; each value has its own IV, and the account name is bound as additional authenticated data.
 * Protects against casual reads and leaked backups of the data file, not against the same user.
 */
export class EncryptedFileBackend implements SecretBackend {
  readonly name = 'file';
  readonly dir: string;
  #key: Buffer | undefined;

  constructor(dir: string) {
    this.dir = dir;
  }

  get keyPath(): string {
    return join(this.dir, SECRETS_KEY_FILE);
  }

  get dataPath(): string {
    return join(this.dir, SECRETS_DATA_FILE);
  }

  #loadKey(): Buffer {
    if (this.#key) return this.#key;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    let key: Buffer;
    try {
      writeFileSync(this.keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    if ((statSync(this.keyPath).mode & 0o077) !== 0) chmodSync(this.keyPath, 0o600);
    key = readFileSync(this.keyPath);
    if (key.length !== 32) throw new BizziError('internal', `${this.keyPath} is not a 32-byte key`);
    this.#key = key;
    return key;
  }

  #read(): EncryptedFile {
    if (!existsSync(this.dataPath)) return { version: 1, entries: {} };
    const parsed = JSON.parse(readFileSync(this.dataPath, 'utf8')) as EncryptedFile;
    if (parsed?.version !== 1 || typeof parsed.entries !== 'object') throw new BizziError('internal', `${this.dataPath}: unknown format`);
    return parsed;
  }

  #write(file: EncryptedFile): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writePrivateFile(this.dataPath, JSON.stringify(file, null, 1) + '\n');
  }

  async get(account: string): Promise<string | undefined> {
    const entry = this.#read().entries[account];
    if (!entry) return undefined;
    const decipher = createDecipheriv('aes-256-gcm', this.#loadKey(), Buffer.from(entry.iv, 'base64'));
    decipher.setAAD(Buffer.from(account, 'utf8'));
    decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
    try {
      return Buffer.concat([decipher.update(Buffer.from(entry.data, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      throw new BizziError('internal', `cannot decrypt the secret for ${account} (wrong key?)`);
    }
  }

  async set(account: string, value: string): Promise<void> {
    const key = this.#loadKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(account, 'utf8'));
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const file = this.#read();
    file.entries[account] = { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
    this.#write(file);
  }

  async delete(account: string): Promise<boolean> {
    const file = this.#read();
    if (!(account in file.entries)) return false;
    delete file.entries[account];
    this.#write(file);
    return true;
  }
}

// ---- selection ---------------------------------------------------------------------------------

export type SecretBackendName = 'keychain' | 'libsecret' | 'file';

export interface DefaultBackendOptions {
  /** Where the encrypted-file backend keeps its files. */
  dataDir: string;
  platform?: NodeJS.Platform;
  /** Force a backend (also: $BIZZI_SECRETS_BACKEND). */
  prefer?: SecretBackendName;
  run?: CommandRunner;
  env?: NodeJS.ProcessEnv;
}

function onPath(name: string, env: NodeJS.ProcessEnv): boolean {
  return (env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .some((d) => existsSync(join(d, name)));
}

/**
 * macOS → Keychain; Linux → libsecret when `secret-tool` and a Secret Service are available,
 * else the encrypted file; anything else → the encrypted file.
 */
export async function createDefaultSecretBackend(opts: DefaultBackendOptions): Promise<SecretBackend> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const forced = opts.prefer ?? (env.BIZZI_SECRETS_BACKEND as SecretBackendName | undefined);
  const run = opts.run ?? runCommand;
  const fileDir = join(opts.dataDir, 'secrets');
  if (forced === 'file') return new EncryptedFileBackend(fileDir);
  if (forced === 'keychain') return new KeychainSecretBackend({ run });
  if (forced === 'libsecret') return new LibsecretBackend({ run });
  if (forced !== undefined && forced !== ('' as string)) {
    throw new BizziError('bad_request', `unknown secrets backend "${String(forced)}" (keychain, libsecret or file)`);
  }
  if (platform === 'darwin' && existsSync('/usr/bin/security')) return new KeychainSecretBackend({ run });
  if (platform === 'linux' && onPath('secret-tool', env) && (await LibsecretBackend.available({ run }))) {
    return new LibsecretBackend({ run });
  }
  return new EncryptedFileBackend(fileDir);
}
