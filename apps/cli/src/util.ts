import os from 'node:os';
import { join, resolve } from 'node:path';

/** A user error: printed without a stack trace, exit code 2. */
export class UsageError extends Error {
  override name = 'UsageError';
}

export function defaultDataDir(): string {
  return process.env.BIZZI_DATA_DIR || join(os.homedir(), '.bizzi');
}

export function resolveDir(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return join(os.homedir(), p.slice(2));
  return resolve(p);
}
