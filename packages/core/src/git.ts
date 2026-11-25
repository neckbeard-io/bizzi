import { execFile } from 'node:child_process';
import type { GitFileStatus } from '@bizzi/protocol';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

const GIT_ENV = { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };

/** Run git in `cwd`. Never throws for a non-zero exit; throws only if git can't be spawned. */
export function runGit(cwd: string, args: string[], maxBuffer = 64 * 1024 * 1024): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=off', '-c', 'color.ui=false', ...args],
      { cwd, env: { ...process.env, ...GIT_ENV }, maxBuffer, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err && typeof (err as NodeJS.ErrnoException).code === 'string') {
          // ENOENT (git missing), ERR_CHILD_PROCESS_STDIO_MAXBUFFER, …
          reject(err);
          return;
        }
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

/** runGit with extra environment (GIT_INDEX_FILE, GIT_DIR…) and optional stdin. Same error rules. */
export function runGitWith(
  cwd: string,
  args: string[],
  opts: { env?: Record<string, string>; input?: string; maxBuffer?: number } = {},
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['-c', 'core.quotepath=off', '-c', 'color.ui=false', ...args],
      { cwd, env: { ...process.env, ...GIT_ENV, ...opts.env }, maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err && typeof (err as NodeJS.ErrnoException).code === 'string') {
          reject(err);
          return;
        }
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(opts.input ?? '');
  });
}

export async function isInsideGitRepo(dir: string): Promise<boolean> {
  try {
    const r = await runGit(dir, ['rev-parse', '--is-inside-work-tree']);
    return r.code === 0 && r.stdout.trim() === 'true';
  } catch {
    return false;
  }
}

// --- worktrees ---------------------------------------------------------------------------------

/** Top-level directory of the work tree containing `dir`, or undefined outside a repo. */
export async function gitToplevel(dir: string): Promise<string | undefined> {
  const r = await runGit(dir, ['rev-parse', '--show-toplevel']).catch(() => undefined);
  return r && r.code === 0 ? r.stdout.trim() || undefined : undefined;
}

/** `git check-ref-format --branch`: true when `name` is a valid branch name. */
export async function isValidBranchName(cwd: string, name: string): Promise<boolean> {
  if (!name || name.startsWith('-')) return false;
  const r = await runGit(cwd, ['check-ref-format', '--branch', name]);
  return r.code === 0;
}

export async function branchExists(cwd: string, branch: string): Promise<boolean> {
  const r = await runGit(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  return r.code === 0;
}

/** Paths with uncommitted changes or untracked files, empty when clean. */
export async function dirtyPaths(cwd: string): Promise<string[]> {
  const r = await runGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `git status exited with ${r.code}`);
  return parsePorcelainZ(r.stdout).files.map((f) => f.path);
}

export interface ParsedStatus {
  branch?: string;
  ahead?: number;
  behind?: number;
  files: GitFileStatus[];
}

/** Parse `git status --porcelain=v1 -b -z` output. */
export function parsePorcelainZ(out: string): ParsedStatus {
  const parts = out.split('\0');
  const result: ParsedStatus = { files: [] };
  let i = 0;
  if (parts[0]?.startsWith('## ')) {
    Object.assign(result, parseBranchLine(parts[0].slice(3)));
    i = 1;
  }
  for (; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry || entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    result.files.push({ path, status });
    // Renames/copies are followed by the original path as a separate NUL-terminated field.
    if (status[0] === 'R' || status[0] === 'C' || status[1] === 'R' || status[1] === 'C') i++;
  }
  return result;
}

/** Parse the text after "## " in a porcelain branch header. */
export function parseBranchLine(line: string): Omit<ParsedStatus, 'files'> {
  const out: Omit<ParsedStatus, 'files'> = {};
  let rest = line;
  const bracket = /\s\[(.*)\]$/.exec(rest);
  if (bracket) {
    rest = rest.slice(0, bracket.index);
    for (const part of (bracket[1] ?? '').split(',')) {
      const m = /^\s*(ahead|behind)\s+(\d+)\s*$/.exec(part);
      if (m) out[m[1] as 'ahead' | 'behind'] = Number(m[2]);
    }
  }
  if (rest.startsWith('No commits yet on ')) rest = rest.slice('No commits yet on '.length);
  else if (rest.startsWith('Initial commit on ')) rest = rest.slice('Initial commit on '.length);
  if (rest.startsWith('HEAD (no branch)')) return out;
  const dots = rest.indexOf('...');
  const branch = dots >= 0 ? rest.slice(0, dots) : rest;
  if (branch) out.branch = branch;
  if (dots >= 0) {
    out.ahead ??= 0;
    out.behind ??= 0;
  }
  return out;
}

// --- remotes (project identity, spec §4) ------------------------------------------------------------

/** The `origin` URL of the repository at `cwd`, or undefined (no repo, no origin). */
export async function originUrl(cwd: string): Promise<string | undefined> {
  const r = await runGit(cwd, ['remote', 'get-url', 'origin']).catch(() => undefined);
  const url = r && r.code === 0 ? r.stdout.trim() : '';
  return url || undefined;
}

/**
 * A git remote URL reduced to `host/path` so the same repository matches however it was cloned:
 * `git@github.com:Acme/App.git`, `https://user@github.com/acme/app` and `ssh://git@github.com/acme/app.git`
 * all become `github.com/acme/app`. Local paths are kept as given (minus a trailing `.git` and slashes).
 */
export function normalizeRemoteUrl(url: string): string {
  let u = url.trim();
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(u);
  const scp = hasScheme ? null : /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(u);
  if (scp) u = `${scp[1]}/${scp[2]}`;
  else if (hasScheme) u = u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^[^@/]+@/, '');
  else return u.replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  u = u.replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  const slash = u.indexOf('/');
  const host = (slash < 0 ? u : u.slice(0, slash)).replace(/:\d+$/, '');
  return (slash < 0 ? host : host + u.slice(slash)).toLowerCase();
}
