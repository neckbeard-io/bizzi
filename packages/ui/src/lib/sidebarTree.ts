// Pure helpers for the sidebar's file-tree layout (MachineTree.tsx): workspaces with their worktrees as
// children, and which workspaces are folded.
import type { WorkspaceTreeRow } from '@bizzi/client';
import type { WorkspaceInfo } from '@bizzi/protocol';

export interface WorkspaceGroup {
  workspace: WorkspaceInfo;
  /** Worktrees made from this repo, shown as children after its sessions. */
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
