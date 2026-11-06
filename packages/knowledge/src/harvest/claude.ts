// Claude Code auto-memory importer (§3.4, "mirror" mode). One-way: reads
// ~/.claude/projects/<cwd-slug>/memory/ (markdown files with frontmatter + a MEMORY.md index)
// and pushes each memory through the policy engine. Never writes into the native directory.
//
// Claude auto-memory is per repo per machine, so it maps to project scope by default, or to
// workspace / machine scope when the memory references local absolute paths.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { addKnowledge } from '../pipeline.ts';
import type { WriteOrigin, WriteOptions } from '../pipeline.ts';
import { contentHash } from '../store.ts';
import type { KnowledgeStore } from '../store.ts';
import type { KnowledgeItem, MemoryKind, SessionScopeLevel } from '../types.ts';
import { fmString, parseFrontmatter } from './frontmatter.ts';

export const CLAUDE_HARVEST_TAG = 'harvest:claude';

/** Claude's per-project directory name: the absolute cwd with `/` and `.` replaced by `-`. */
export function claudeProjectSlug(cwd: string): string {
  return resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
}

/** Where Claude keeps auto-memory for `cwd` (doesn't check that it exists). */
export function claudeMemoryDir(cwd: string, claudeHome: string = join(homedir(), '.claude')): string {
  return join(claudeHome, 'projects', claudeProjectSlug(cwd), 'memory');
}

/** Claude memory `type` → bizzi memory kind. */
export const CLAUDE_TYPE_TO_KIND: Readonly<Record<string, MemoryKind>> = {
  user: 'preference',
  feedback: 'preference',
  project: 'fact',
  reference: 'reference',
};

export interface ClaudeMemoryEntry {
  /** Absolute path of the source file. */
  path: string;
  /** Provenance key (stable per source). */
  ref: string;
  title: string;
  body: string;
  kind: MemoryKind;
  claudeType?: string;
  /** Claude session that wrote it, if recorded (not a bizzi session id). */
  originSessionId?: string;
}

interface IndexEntry {
  title: string;
  hook?: string;
  file?: string;
}

/** Parse MEMORY.md bullets: `- [Title](file.md) — hook` (links) or plain `- text` (inline memories). */
export function parseMemoryIndex(text: string): IndexEntry[] {
  const out: IndexEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (!bullet) continue;
    const rest = bullet[1] ?? '';
    const link = /^\[([^\]]+)\]\(([^)]+)\)\s*(?:[—–:-]+\s*(.*))?$/.exec(rest);
    if (link) {
      const hook = link[3]?.trim();
      out.push({ title: (link[1] ?? '').trim(), file: (link[2] ?? '').trim(), ...(hook ? { hook } : {}) });
    } else if (rest.trim()) {
      out.push({ title: rest.trim() });
    }
  }
  return out;
}

function humanize(slug: string): string {
  const s = slug.replace(/\.md$/i, '').replace(/[-_]+/g, ' ').trim();
  return s ? s[0]!.toUpperCase() + s.slice(1) : slug;
}

function firstLine(s: string, max = 120): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** Read a Claude memory directory into entries (no store access). Missing dir → []. */
export function readClaudeMemoryDir(dir: string): ClaudeMemoryEntry[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.md')).sort();
  } catch {
    return [];
  }
  const indexName = names.find((n) => n.toUpperCase() === 'MEMORY.MD');
  const index = indexName ? parseMemoryIndex(readFileSync(join(dir, indexName), 'utf8')) : [];
  const titleByFile = new Map<string, IndexEntry>();
  for (const e of index) if (e.file) titleByFile.set(basename(e.file), e);

  const entries: ClaudeMemoryEntry[] = [];
  for (const name of names) {
    if (name === indexName) continue;
    const path = join(dir, name);
    if (!statSync(path).isFile()) continue;
    const { data, content } = parseFrontmatter(readFileSync(path, 'utf8'));
    const claudeType = fmString(data, 'type') ?? fmString(data, 'metadata', 'type');
    const description = fmString(data, 'description');
    const idx = titleByFile.get(name);
    const title = firstLine(idx?.title ?? (fmString(data, 'name') ? humanize(fmString(data, 'name')!) : humanize(name)));
    const text = content.trim();
    const body = description && !text.includes(description) ? `${description}\n\n${text}`.trim() : text;
    if (!body && !description) continue;
    const originSessionId = fmString(data, 'originSessionId') ?? fmString(data, 'metadata', 'originSessionId');
    entries.push({
      path,
      ref: `claude:${path}`,
      title,
      body,
      kind: (claudeType && CLAUDE_TYPE_TO_KIND[claudeType]) || 'fact',
      ...(claudeType ? { claudeType } : {}),
      ...(originSessionId ? { originSessionId } : {}),
    });
  }
  // Inline bullets in MEMORY.md without a linked file are memories on their own.
  if (indexName) {
    const indexPath = join(dir, indexName);
    for (const e of index) {
      if (e.file) continue;
      entries.push({
        path: indexPath,
        ref: `claude:${indexPath}#${contentHash('memory', e.title, '').slice(0, 16)}`,
        title: firstLine(e.title),
        body: e.title.length > 120 ? e.title : '',
        kind: 'fact',
      });
    }
  }
  return entries;
}

const ABS_PATH = /(?:^|[\s`'"(=:])((?:\/(?:Users|home|opt|srv|data|var|tmp|mnt|Volumes|private)\/)[^\s`'")]*|~\/[^\s`'")]*|[A-Za-z]:\\[^\s`'")]*)/g;

/** Local absolute paths mentioned in a text. */
export function localPaths(text: string): string[] {
  return [...text.matchAll(ABS_PATH)].map((m) => (m[1] ?? '').replace(/[.,;:!?]+$/, '')).filter(Boolean);
}

export interface ClaudeHarvestOptions extends WriteOptions {
  /** The auto-memory directory (see `claudeMemoryDir`). */
  dir: string;
  machineId: string;
  /** Project the repo belongs to: memories default to project scope. */
  projectId?: string;
  /** Workspace (and its absolute path) the memory dir belongs to. */
  workspaceId?: string;
  workspacePath?: string;
  /** Map memories that mention local absolute paths to workspace/machine scope. Default true. */
  localPathScoping?: boolean;
}

export interface HarvestSkip {
  ref: string;
  reason: 'unchanged' | 'duplicate';
  itemId?: string;
}

export interface HarvestResult {
  imported: KnowledgeItem[];
  /** New versions of previously harvested files (supersede the earlier import). */
  updated: KnowledgeItem[];
  skipped: HarvestSkip[];
}

function scopeFor(entry: ClaudeMemoryEntry, opts: ClaudeHarvestOptions): SessionScopeLevel {
  const fallback: SessionScopeLevel = opts.projectId ? 'project' : opts.workspaceId ? 'workspace' : 'machine';
  if (opts.localPathScoping === false) return fallback;
  const paths = localPaths(`${entry.title}\n${entry.body}`);
  if (paths.length === 0) return fallback;
  const ws = opts.workspacePath ? resolve(opts.workspacePath) : undefined;
  const inWorkspace = ws !== undefined && paths.every((p) => p === ws || p.startsWith(ws + sep) || p.startsWith(ws + '/'));
  if (inWorkspace && opts.workspaceId) return 'workspace';
  return 'machine';
}

/**
 * Import Claude auto-memory into the store. Idempotent: unchanged files are skipped; content
 * already in the store (any status, so forgotten items stay forgotten) is skipped as a duplicate;
 * edited files produce a new item that supersedes the earlier import.
 */
export function harvestClaudeMemory(store: KnowledgeStore, opts: ClaudeHarvestOptions): HarvestResult {
  const result: HarvestResult = { imported: [], updated: [], skipped: [] };
  for (const entry of readClaudeMemoryDir(opts.dir)) {
    const hash = contentHash('memory', entry.title, entry.body);
    const prev = store.getHarvestRecord(entry.ref);
    if (prev && prev.contentHash === hash) {
      result.skipped.push({ ref: entry.ref, reason: 'unchanged', itemId: prev.itemId });
      continue;
    }
    const existing = store.findByContentHash(hash)[0];
    if (existing) {
      store.putHarvestRecord({ sourceKey: entry.ref, contentHash: hash, itemId: existing.id, harvestedAt: store.nowIso() });
      result.skipped.push({ ref: entry.ref, reason: 'duplicate', itemId: existing.id });
      continue;
    }
    const origin: WriteOrigin = {
      via: 'harvest',
      agent: 'claude',
      machineId: opts.machineId,
      ref: entry.ref,
      ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
      ...(opts.workspaceId !== undefined ? { workspaceId: opts.workspaceId } : {}),
    };
    const prevItem = prev ? store.get(prev.itemId) : undefined;
    const supersede = prevItem && (prevItem.status === 'active' || prevItem.status === 'suggested');
    const tags = [CLAUDE_HARVEST_TAG, ...(entry.claudeType ? [`claude:${entry.claudeType}`] : [])];
    const res = addKnowledge(
      store,
      {
        type: 'memory',
        title: entry.title,
        body: entry.body,
        kind: entry.kind,
        tags,
        scope: scopeFor(entry, opts),
        ...(supersede ? { supersedes: [prevItem.id] } : {}),
      },
      origin,
      opts,
    );
    store.putHarvestRecord({ sourceKey: entry.ref, contentHash: hash, itemId: res.item.id, harvestedAt: store.nowIso() });
    (supersede ? result.updated : result.imported).push(res.item);
  }
  return result;
}
