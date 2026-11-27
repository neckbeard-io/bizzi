// Finding the `codex` binary and reading its version.

import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { agentSearchDirs } from '@bizzi/protocol';

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function run(command: string, args: string[], timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<string | undefined> {
  return new Promise((resolvePromise) => {
    try {
      execFile(command, args, { timeout: timeoutMs, encoding: 'utf8', env }, (err, stdout) => {
        resolvePromise(err ? undefined : stdout);
      });
    } catch {
      resolvePromise(undefined);
    }
  });
}

async function npmGlobalBin(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const prefix = (await run('npm', ['prefix', '-g'], 5000, env))?.trim();
  if (!prefix) return undefined;
  return process.platform === 'win32' ? prefix : join(prefix, 'bin');
}

/**
 * Candidate locations, in order: explicit path, PATH (without project-local `node_modules/.bin`
 * entries, see agentSearchDirs), common install dirs, npm's global bin. Returns the first
 * executable match.
 */
export async function findCodex(opts: { codexPath?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string | undefined> {
  const env = opts.env ?? process.env;
  const exe = process.platform === 'win32' ? 'codex.cmd' : 'codex';
  if (opts.codexPath) {
    const p = isAbsolute(opts.codexPath) ? opts.codexPath : resolve(opts.codexPath);
    return (await isExecutable(p)) ? p : undefined;
  }
  const dirs = agentSearchDirs((env.PATH ?? '').split(delimiter).filter(Boolean));
  const home = homedir();
  dirs.push('/opt/homebrew/bin', '/usr/local/bin', join(home, '.local', 'bin'), join(home, '.npm-global', 'bin'));
  const seen = new Set<string>();
  for (const dir of dirs) {
    const p = join(dir, exe);
    if (seen.has(p)) continue;
    seen.add(p);
    if (await isExecutable(p)) return p;
  }
  const npmBin = await npmGlobalBin(env);
  if (npmBin) {
    const p = join(npmBin, exe);
    if (!seen.has(p) && (await isExecutable(p))) return p;
  }
  return undefined;
}

/** `codex --version` prints e.g. "codex-cli 0.167.0". */
export async function codexVersion(path: string, env?: NodeJS.ProcessEnv, argsPrefix: string[] = []): Promise<string | undefined> {
  const out = await run(path, [...argsPrefix, '--version'], 10_000, env);
  if (!out) return undefined;
  const m = /(\d+\.\d+\.\d+[^\s]*)/.exec(out);
  return m?.[1] ?? (out.trim() || undefined);
}
