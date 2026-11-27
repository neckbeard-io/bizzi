// Locate the user's installed `claude` binary and report version / auth without side effects.

import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, open, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { agentSearchDirs, type AgentAuthState, type AgentProbe } from '@bizzi/protocol';

export interface FindClaudeOptions {
  /** Explicit binary path; used as-is when it exists. */
  claudePath?: string;
  /** Directories to search instead of $PATH + the well-known install dirs (tests). */
  searchDirs?: string[];
  env?: NodeJS.ProcessEnv;
}

export interface FoundBinary {
  path: string;
  /** A shell-script wrapper (e.g. a terminal integration shim) rather than the real CLI. */
  wrapper: boolean;
}

export function defaultSearchDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = homedir();
  // A project's node_modules/.bin is not an install (agentSearchDirs).
  const fromPath = agentSearchDirs((env.PATH ?? '').split(delimiter).filter(Boolean));
  const wellKnown = [join(home, '.local', 'bin'), join(home, '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin'];
  return [...new Set([...fromPath, ...wellKnown])];
}

async function isExecutableFile(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    if (!s.isFile()) return false;
    await access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Shell wrappers (terminal integrations that inject `--settings` / `--session-id`) break the
 * SDK's own flags, so a native binary or a node script is preferred over them.
 */
async function isShellWrapper(p: string): Promise<boolean> {
  try {
    const fh = await open(p, 'r');
    try {
      const buf = Buffer.alloc(128);
      const { bytesRead } = await fh.read(buf, 0, 128, 0);
      const head = buf.subarray(0, bytesRead).toString('utf8');
      if (!head.startsWith('#!')) return false;
      const shebang = head.split('\n', 1)[0] ?? '';
      return !/\b(node|bun|deno)\b/.test(shebang);
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
}

export async function findClaudeBinary(opts: FindClaudeOptions = {}): Promise<FoundBinary | undefined> {
  const env = opts.env ?? process.env;
  const explicit = opts.claudePath ?? env.BIZZI_CLAUDE_PATH;
  if (explicit) {
    return (await isExecutableFile(explicit)) ? { path: explicit, wrapper: false } : undefined;
  }
  const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd', 'claude'] : ['claude'];
  let firstWrapper: FoundBinary | undefined;
  for (const dir of opts.searchDirs ?? defaultSearchDirs(env)) {
    for (const name of names) {
      const p = join(dir, name);
      if (!(await isExecutableFile(p))) continue;
      if (await isShellWrapper(p)) {
        firstWrapper ??= { path: p, wrapper: true };
        continue;
      }
      return { path: p, wrapper: false };
    }
  }
  return firstWrapper;
}

function run(file: string, args: string[], timeoutMs: number): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { timeout: timeoutMs, maxBuffer: 1 << 20, windowsHide: true }, (err, stdout) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : null) : 0;
        resolve({ stdout: String(stdout ?? ''), code });
      });
    } catch {
      resolve({ stdout: '', code: null });
    }
  });
}

export function parseVersion(out: string): string | undefined {
  return /(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/.exec(out)?.[1];
}

/** Parse `claude auth status --json`. */
export function parseAuthStatus(out: string): { auth: AgentAuthState; account?: string; notes: string[] } | undefined {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(out) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (typeof j.loggedIn !== 'boolean') return undefined;
  const notes: string[] = [];
  if (typeof j.authMethod === 'string') notes.push(`auth method: ${j.authMethod}`);
  if (typeof j.apiProvider === 'string') notes.push(`api provider: ${j.apiProvider}`);
  const account = [j.email, j.account, j.orgName, j.organization].find((v): v is string => typeof v === 'string' && !!v);
  return { auth: j.loggedIn ? 'ok' : 'missing', account, notes };
}

async function credentialsHint(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (env.ANTHROPIC_API_KEY) return 'ANTHROPIC_API_KEY is set';
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return 'CLAUDE_CODE_OAUTH_TOKEN is set';
  if (env.CLAUDE_CODE_USE_BEDROCK || env.CLAUDE_CODE_USE_VERTEX) return 'third-party provider configured';
  const dir = env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  try {
    await access(join(dir, '.credentials.json'));
    return 'credentials file present';
  } catch {
    return undefined;
  }
}

export interface ProbeOptions extends FindClaudeOptions {
  timeoutMs?: number;
}

export async function probeClaude(opts: ProbeOptions = {}): Promise<AgentProbe> {
  const env = opts.env ?? process.env;
  const timeout = opts.timeoutMs ?? 15_000;
  try {
    const found = await findClaudeBinary(opts);
    if (!found) {
      return {
        agent: 'claude',
        installed: false,
        auth: 'unknown',
        notes: ['claude binary not found on PATH or in ~/.local/bin, ~/.claude/local, /opt/homebrew/bin; the SDK-bundled binary would be used'],
      };
    }
    const notes: string[] = [];
    if (found.wrapper) notes.push(`${found.path} is a shell wrapper; no native binary was found`);
    const [ver, auth] = await Promise.all([
      run(found.path, ['--version'], timeout),
      run(found.path, ['auth', 'status', '--json'], timeout),
    ]);
    const version = parseVersion(ver.stdout);
    const parsed = parseAuthStatus(auth.stdout);
    if (parsed) {
      notes.push(...parsed.notes);
      return { agent: 'claude', installed: true, path: found.path, version, auth: parsed.auth, account: parsed.account, notes };
    }
    const hint = await credentialsHint(env);
    if (hint) notes.push(hint);
    return { agent: 'claude', installed: true, path: found.path, version, auth: hint ? 'ok' : 'unknown', notes };
  } catch (e) {
    return { agent: 'claude', installed: false, auth: 'unknown', notes: [`probe failed: ${(e as Error)?.message ?? String(e)}`] };
  }
}
