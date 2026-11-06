// Workspace tools: fs.list / fs.read confined to the workspace root, git.status / git.diff.

import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { BizziError, type FsEntry, type MethodResult, type WorkspaceInfo } from '@bizzi/protocol';
import { parsePorcelainZ, runGit } from './git.ts';

export const DEFAULT_MAX_BYTES = 1024 * 1024;
export const MAX_READ_BYTES = 32 * 1024 * 1024;

function isInside(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
}

/**
 * Resolve `p` (relative to the workspace root, or absolute inside it) and make sure neither the
 * lexical path nor its symlink-resolved target escapes the root. Returns the real path.
 */
export async function resolveInWorkspace(ws: WorkspaceInfo, p: string | undefined): Promise<string> {
  const root = await realpath(ws.path).catch(() => {
    throw new BizziError('not_found', `workspace directory ${ws.path} is missing`);
  });
  if (p !== undefined && p.includes('\0')) throw new BizziError('bad_request', 'invalid path');
  const target = resolve(root, p ?? '.');
  if (!isInside(root, target)) throw new BizziError('bad_request', 'path escapes the workspace');
  let real: string;
  try {
    real = await realpath(target);
  } catch {
    // A dangling symlink inside the workspace still must not point outside it.
    const st = await lstat(target).catch(() => undefined);
    if (st?.isSymbolicLink()) throw new BizziError('not_found', `${p} is a dangling symlink`);
    throw new BizziError('not_found', `${p ?? '.'} not found`);
  }
  if (!isInside(root, real)) throw new BizziError('bad_request', 'path escapes the workspace (symlink)');
  return real;
}

export async function fsList(ws: WorkspaceInfo, p?: string): Promise<MethodResult<'fs.list'>> {
  const dir = await resolveInWorkspace(ws, p);
  const st = await stat(dir);
  if (!st.isDirectory()) throw new BizziError('bad_request', `${p} is not a directory`);
  const dirents = await readdir(dir, { withFileTypes: true });
  const entries: FsEntry[] = [];
  for (const d of dirents) {
    const type: FsEntry['type'] = d.isDirectory() ? 'dir' : d.isFile() ? 'file' : d.isSymbolicLink() ? 'symlink' : 'other';
    const entry: FsEntry = { name: d.name, type };
    if (type === 'file') {
      const s = await lstat(resolve(dir, d.name)).catch(() => undefined);
      if (s) entry.size = s.size;
    }
    entries.push(entry);
  }
  entries.sort((a, b) => (a.type === 'dir') !== (b.type === 'dir') ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name));
  return { entries };
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

function decodeText(buf: Uint8Array, truncated: boolean): string | undefined {
  if (buf.includes(0)) return undefined;
  // When truncated, the cut may land inside a multi-byte sequence: drop up to 3 trailing bytes.
  const attempts = truncated ? 4 : 1;
  for (let drop = 0; drop < attempts && drop <= buf.length; drop++) {
    try {
      return utf8.decode(buf.subarray(0, buf.length - drop));
    } catch {
      // try again with one byte fewer
    }
  }
  return undefined;
}

export async function fsRead(ws: WorkspaceInfo, p: string, maxBytes = DEFAULT_MAX_BYTES): Promise<MethodResult<'fs.read'>> {
  const file = await resolveInWorkspace(ws, p);
  const limit = Math.min(Math.max(0, maxBytes), MAX_READ_BYTES);
  const fh = await open(file, 'r');
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new BizziError('bad_request', `${p} is not a regular file`);
    const want = Math.min(st.size, limit);
    const buf = Buffer.alloc(want);
    let off = 0;
    while (off < want) {
      const { bytesRead } = await fh.read(buf, off, want - off, off);
      if (bytesRead === 0) break;
      off += bytesRead;
    }
    const data = new Uint8Array(buf.buffer, buf.byteOffset, off);
    const truncated = st.size > off;
    const text = decodeText(data, truncated);
    if (text !== undefined) return { content: text, encoding: 'utf8', truncated };
    return { content: Buffer.from(data).toString('base64'), encoding: 'base64', truncated };
  } finally {
    await fh.close();
  }
}

async function gitOrThrow(cwd: string, args: string[]) {
  try {
    return await runGit(cwd, args);
  } catch (err) {
    throw new BizziError('internal', `git failed: ${(err as Error).message}`);
  }
}

export async function gitStatus(ws: WorkspaceInfo): Promise<MethodResult<'git.status'>> {
  const root = await resolveInWorkspace(ws, undefined);
  const r = await gitOrThrow(root, ['status', '--porcelain=v1', '-b', '-z']);
  if (r.code !== 0) {
    if (/not a git repository/i.test(r.stderr)) return { isRepo: false, files: [] };
    throw new BizziError('internal', `git status failed: ${r.stderr.trim()}`);
  }
  return { isRepo: true, ...parsePorcelainZ(r.stdout) };
}

export async function gitDiff(ws: WorkspaceInfo, opts: { path?: string; staged?: boolean }): Promise<MethodResult<'git.diff'>> {
  const root = await resolveInWorkspace(ws, undefined);
  const args = ['diff', '--no-ext-diff', '--no-color'];
  if (opts.staged) args.push('--cached');
  if (opts.path !== undefined) {
    // Validate lexically (the file may be deleted, so it need not exist).
    const target = resolve(root, opts.path);
    if (!isInside(root, target)) throw new BizziError('bad_request', 'path escapes the workspace');
    args.push('--', relative(root, target) || '.');
  }
  const r = await gitOrThrow(root, args);
  if (r.code !== 0) {
    if (/not a git repository/i.test(r.stderr)) throw new BizziError('bad_request', 'workspace is not a git repository');
    throw new BizziError('internal', `git diff failed: ${r.stderr.trim()}`);
  }
  return { diff: r.stdout };
}
