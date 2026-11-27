// Pure helpers for the sidebar's file-tree layout (MachineTree.tsx): workspaces with their worktrees as
// children, and which workspaces are folded.
import type { SessionBreakdownLine, WorkspaceTreeRow } from '@bizzi/client';
import type { WorkspaceInfo } from '@bizzi/protocol';

export interface WorkspaceGroup {
  workspace: WorkspaceInfo;
  /** Worktrees made from this repo, shown after its sessions under a "Worktrees" heading when they have sessions of their own. */
  worktrees: WorkspaceInfo[];
}

/** `selectMachineWorkspaces` rows (worktrees at depth 1 after their repo) as parent → children groups. */
export function groupWorkspaces(rows: readonly WorkspaceTreeRow[]): WorkspaceGroup[] {
  const out: WorkspaceGroup[] = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (r.depth > 0 && last) last.worktrees.push(r.workspace);
    else out.push({ workspace: r.workspace, worktrees: [] });
  }
  return out;
}

/** Workspaces whose children are folded away, per device. Everything starts open. */
export function readCollapsed(raw: unknown): Record<string, boolean> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (v === true) out[k] = true;
  return out;
}

/** Deepest indent for nested helpers; deeper ones line up at this level. */
export const MAX_NEST_INDENT = 3;

export type SessionTreeItem =
  | {
      kind: 'session';
      line: SessionBreakdownLine;
      /** Indent level (depth, capped at MAX_NEST_INDENT). */
      indent: number;
      /** Has live helpers under it: shows a caret and their count. */
      expandable: boolean;
      /** Its helpers are folded away. */
      folded: boolean;
    }
  | {
      /** "n ended" at the end of an open nest: helpers of `parentId` that have ended (listed on its page). */
      kind: 'ended';
      parentId: string;
      n: number;
      indent: number;
    };

/**
 * The sidebar's session rows from `selectWorkspaceBreakdown` lines: helpers under a folded parent are left out
 * (unless the open session is among them, which unfolds its parents), and an open nest ends with a muted
 * "n ended" line when some of the parent's helpers have ended.
 */
export function layoutSessionTree(lines: readonly SessionBreakdownLine[], folded: Readonly<Record<string, boolean>>, activeSessionId: string | null): SessionTreeItem[] {
  // Parents of the open session stay unfolded, so its row is visible.
  const forcedOpen = new Set<string>();
  const byId = new Map(lines.map((l) => [l.sessionId, l]));
  for (let l = activeSessionId ? byId.get(activeSessionId) : undefined, hops = 0; l?.parentId && hops < 64; l = byId.get(l.parentId), hops++) forcedOpen.add(l.parentId);

  const out: SessionTreeItem[] = [];
  // Open nests waiting for their "n ended" line, innermost last.
  const pending: { parentId: string; depth: number; n: number }[] = [];
  let hiddenBelow: number | null = null;
  const flush = (depth: number): void => {
    while (pending.length > 0 && pending[pending.length - 1]!.depth >= depth) {
      const p = pending.pop()!;
      out.push({ kind: 'ended', parentId: p.parentId, n: p.n, indent: Math.min(p.depth + 1, MAX_NEST_INDENT) });
    }
  };
  for (const line of lines) {
    if (hiddenBelow !== null) {
      if (line.depth > hiddenBelow) continue;
      hiddenBelow = null;
    }
    flush(line.depth);
    const expandable = (line.helpers ?? 0) > 0;
    const isFolded = expandable && folded[line.sessionId] === true && !forcedOpen.has(line.sessionId);
    out.push({ kind: 'session', line, indent: Math.min(line.depth, MAX_NEST_INDENT), expandable, folded: isFolded });
    if (isFolded) hiddenBelow = line.depth;
    else if (expandable && line.endedHelpers) pending.push({ parentId: line.sessionId, depth: line.depth, n: line.endedHelpers });
  }
  flush(0);
  return out;
}

// ---- "By state" view

/** How the sidebar lists sessions: the machine › workspace tree (default) or one list grouped by state. */
export type SidebarGroupBy = 'workspace' | 'state';

export function readGroupBy(raw: unknown): SidebarGroupBy {
  return raw === 'state' ? 'state' : 'workspace';
}

/** Idle starts folded once it holds more sessions than this. */
export const IDLE_FOLD_AT = 5;

/** Sections folded or unfolded by hand, per device: true = folded, false = opened (beats the default). */
export function readSectionFolds(raw: unknown): Record<string, boolean> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === 'boolean') out[k] = v;
  return out;
}

/**
 * Whether a "By state" section is folded: what you chose last, else only a long Idle starts folded. A section
 * holding the open session stays open, so its row is visible.
 */
export function sectionFolded(key: string, count: number, folds: Readonly<Record<string, boolean>>, holdsActive: boolean): boolean {
  if (holdsActive) return false;
  return folds[key] ?? (key === 'idle' && count > IDLE_FOLD_AT);
}
