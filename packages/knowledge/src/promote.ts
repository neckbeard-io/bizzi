// "Add to AGENTS.md…" (knowledge.md §8): a one-time, explicit promotion of picked memories into a
// workspace's AGENTS.md. bizzi appends them under a heading you choose, shows the diff first, and
// never commits. Promoted items get the `promoted` tag so they aren't offered again.
//
// Only ever appends: the user's text in AGENTS.md is never rewritten, so the diff is one hunk at the
// end of the file. The preview carries a hash of the file it was computed from; writing with that
// hash fails with `conflict` if the file changed in between.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BizziError } from '@bizzi/protocol';
import { scopeMatches } from './scope.ts';
import type { KnowledgeStore } from './store.ts';
import type { KnowledgeContext, KnowledgeItem } from './types.ts';

/** Tag added to items written into an AGENTS.md; the picker doesn't offer them again. */
export const PROMOTED_TAG = 'promoted';

export const DEFAULT_PROMOTE_HEADING = 'Notes from bizzi memory';

export const AGENTS_FILE = 'AGENTS.md';

/** `baseHash` of a workspace that has no AGENTS.md yet. */
export const ABSENT_FILE_HASH = 'absent';

export type PromoteSkipReason = 'not_found' | 'inactive' | 'already_promoted' | 'not_visible';

export interface PromoteOptions {
  /** Absolute path of the workspace (AGENTS.md goes in its root). */
  workspacePath: string;
  ids: string[];
  /** Section heading (level 2). Default DEFAULT_PROMOTE_HEADING. */
  heading?: string;
  /** When given, items whose scope doesn't reach this workspace are skipped (`not_visible`). */
  context?: KnowledgeContext;
}

export interface PromotionPlan {
  /** Absolute path of the AGENTS.md. */
  path: string;
  /** AGENTS.md exists already (otherwise writing creates it). */
  exists: boolean;
  /** Hash of the file the plan was computed from (ABSENT_FILE_HASH when missing). */
  baseHash: string;
  heading: string;
  /** Items that will be written, in the order given. */
  items: KnowledgeItem[];
  skipped: { id: string; reason: PromoteSkipReason }[];
  /** The appended text. */
  appended: string;
  /** The whole file after writing. */
  content: string;
  /** Unified diff (a/AGENTS.md → b/AGENTS.md). */
  diff: string;
  /** E.g. a CLAUDE.md that keeps Claude from reading AGENTS.md (knowledge.md §4.2 rule 4). */
  warnings: string[];
}

export function fileHash(text: string | undefined): string {
  return text === undefined ? ABSENT_FILE_HASH : createHash('sha256').update(text).digest('hex');
}

/** One line, no leading `#`s; empty → the default heading. */
export function normalizeHeading(heading: string | undefined): string {
  const h = (heading ?? '').replace(/\s+/g, ' ').trim().replace(/^#+\s*/, '').trim();
  return h || DEFAULT_PROMOTE_HEADING;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** `- **Title**: body` (multi-line bodies continue indented under the bullet). */
export function renderPromotedItem(item: Pick<KnowledgeItem, 'title' | 'body'>): string {
  const title = oneLine(item.title);
  const body = item.body.trim();
  if (!body) return `- ${title}`;
  const lines = body.split(/\r?\n/);
  const head = `- **${title}**: ${lines[0]!.trim()}`;
  if (lines.length === 1) return head;
  return [head, ...lines.slice(1).map((l) => (l.trim() ? `  ${l.trimEnd()}` : ''))].join('\n');
}

function lastHeading(text: string): string | undefined {
  let last: string | undefined;
  for (const m of text.matchAll(/^(#{1,6})[ \t]+(.+?)[ \t#]*$/gm)) last = `${m[1]} ${m[2]}`;
  return last;
}

/**
 * The text appended to `before`: a `## heading` section with one bullet per item. When the file
 * already ends with that section (e.g. an earlier promotion), the bullets join it instead.
 */
export function appendSection(before: string, heading: string, items: Pick<KnowledgeItem, 'title' | 'body'>[]): string {
  const bullets = items.map(renderPromotedItem).join('\n');
  const sep = before === '' ? '' : before.endsWith('\n') ? '' : '\n';
  const trimmed = before.trimEnd();
  if (trimmed && lastHeading(trimmed) === `## ${heading}`) {
    const lastLine = trimmed.split('\n').at(-1) ?? '';
    const joinList = /^\s*[-*]\s/.test(lastLine) || /^\s{2,}\S/.test(lastLine);
    return `${sep}${joinList ? '' : '\n'}${bullets}\n`;
  }
  const gap = trimmed ? '\n' : '';
  return `${sep}${gap}## ${heading}\n\n${bullets}\n`;
}

/** Unified diff for appending `appended` to `before` (the only change promotion makes). */
export function appendDiff(before: string | undefined, appended: string, name = AGENTS_FILE): string {
  const old = before ?? '';
  const oldLines = old === '' ? [] : old.replace(/\n$/, '').split('\n');
  const noFinalNewline = old !== '' && !old.endsWith('\n');
  const added = appended.replace(/\n$/, '').split('\n');
  const out = [before === undefined ? '--- /dev/null' : `--- a/${name}`, `+++ b/${name}`];
  const ctx = oldLines.slice(-3);
  const start = oldLines.length - ctx.length + 1;
  const body: string[] = [];
  if (noFinalNewline) {
    // The last line gains a newline: it shows as removed and re-added.
    const last = ctx.pop()!;
    for (const l of ctx) body.push(` ${l}`);
    body.push(`-${last}`, '\\ No newline at end of file', `+${last}${added[0] ?? ''}`, ...added.slice(1).map((l) => `+${l}`));
    // appendSection starts with the missing newline, so added[0] is '' and the line is unchanged.
  } else {
    for (const l of ctx) body.push(` ${l}`);
    for (const l of added) body.push(`+${l}`);
  }
  const oldCount = ctx.length + (noFinalNewline ? 1 : 0);
  const newCount = body.filter((l) => l.startsWith(' ') || l.startsWith('+')).length;
  const oldStart = oldCount === 0 ? 0 : start;
  const newStart = newCount === 0 ? 0 : oldCount === 0 ? oldLines.length + 1 : start;
  out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...body);
  return `${out.join('\n')}\n`;
}

function readIfExists(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

/** Claude reads AGENTS.md only when there's no CLAUDE.md (unless it imports `@AGENTS.md`). */
function claudeWarnings(workspacePath: string): string[] {
  for (const rel of ['CLAUDE.md', join('.claude', 'CLAUDE.md')]) {
    const p = join(workspacePath, rel);
    if (!existsSync(p)) continue;
    const text = readIfExists(p) ?? '';
    if (/(^|\s)@(\.\/)?AGENTS\.md\b/.test(text)) return [];
    return [
      `This workspace has ${rel}, so Claude Code won't read AGENTS.md. Add a line \`@AGENTS.md\` to ${rel} if Claude should see these notes.`,
    ];
  }
  return [];
}

/** What "Add to AGENTS.md" would write (reads the file; writes nothing). */
export function planPromotion(store: KnowledgeStore, opts: PromoteOptions): PromotionPlan {
  if (!Array.isArray(opts.ids) || opts.ids.length === 0) throw new BizziError('bad_request', 'pick at least one item to add to AGENTS.md');
  const heading = normalizeHeading(opts.heading);
  const items: KnowledgeItem[] = [];
  const skipped: PromotionPlan['skipped'] = [];
  const seen = new Set<string>();
  for (const id of opts.ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const item = store.get(id);
    if (!item) skipped.push({ id, reason: 'not_found' });
    else if (item.status !== 'active') skipped.push({ id, reason: 'inactive' });
    else if (item.tags.includes(PROMOTED_TAG)) skipped.push({ id, reason: 'already_promoted' });
    else if (opts.context && !scopeMatches(item.scope, opts.context)) skipped.push({ id, reason: 'not_visible' });
    else items.push(item);
  }
  if (items.length === 0) throw new BizziError('bad_request', 'none of the picked items can be added to AGENTS.md', { skipped });
  const path = join(opts.workspacePath, AGENTS_FILE);
  const before = readIfExists(path);
  const appended = appendSection(before ?? '', heading, items);
  return {
    path,
    exists: before !== undefined,
    baseHash: fileHash(before),
    heading,
    items,
    skipped,
    appended,
    content: (before ?? '') + appended,
    diff: appendDiff(before, appended),
    warnings: claudeWarnings(opts.workspacePath),
  };
}

export interface PromotionResult {
  path: string;
  created: boolean;
  /** The items as tagged `promoted`. */
  promoted: KnowledgeItem[];
  skipped: PromotionPlan['skipped'];
}

/**
 * Append the picked items to AGENTS.md and tag them `promoted`. With `baseHash` (from the preview),
 * fails with `conflict` when the file changed since. Never commits.
 */
export function applyPromotion(store: KnowledgeStore, opts: PromoteOptions & { baseHash?: string }): PromotionResult {
  const plan = planPromotion(store, opts);
  if (opts.baseHash !== undefined && opts.baseHash !== plan.baseHash) {
    throw new BizziError('conflict', `${plan.path} changed since the preview; preview again`);
  }
  writeFileSync(plan.path, plan.content, 'utf8');
  const promoted = store.transaction(() => plan.items.map((i) => store.patch(i.id, { tags: [...i.tags, PROMOTED_TAG] })));
  return { path: plan.path, created: !plan.exists, promoted, skipped: plan.skipped };
}
