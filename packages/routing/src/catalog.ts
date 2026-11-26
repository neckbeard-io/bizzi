// The numbered list a classifier picks from (spec §11.2): one target per workspace on an online machine,
// described with what the machine is for (tags, description, GUI, always-on) and where the workspace is.

import type { MachineInfo, SessionInfo, WorkspaceInfo } from '@bizzi/protocol';

export interface RouteTarget {
  machine: MachineInfo;
  workspace: WorkspaceInfo;
  /** "laptop · acme-shop" */
  label: string;
  /** One line for the classifier prompt. */
  detail: string;
  /** Last session activity in the workspace, else its creation time (ISO). */
  lastActive: string;
}

export interface CatalogInput {
  machines: MachineInfo[];
  workspaces: WorkspaceInfo[];
  /** For recency: the most recently active workspaces are kept when there are too many. */
  sessions?: SessionInfo[];
}

const MAX_DESCRIPTION = 200;
const RECENT_TITLES = 3;
const MAX_TITLE = 60;

/**
 * Every workspace on an online machine, most recently active first. Worktrees are left out: they are
 * helpers' and fan-out runs' copies of a repo, not places you'd send a new prompt. `includeOffline`
 * keeps offline machines' workspaces too, so explicit tokens can say "that machine is offline".
 */
export function buildTargets(input: CatalogInput, o: { includeOffline?: boolean } = {}): RouteTarget[] {
  const online = new Map(input.machines.filter((m) => o.includeOffline || m.online).map((m) => [m.id, m]));
  const last = new Map<string, string>();
  const titled = new Map<string, SessionInfo[]>();
  for (const s of input.sessions ?? []) {
    const cur = last.get(s.workspaceId);
    if (!cur || s.updatedAt > cur) last.set(s.workspaceId, s.updatedAt);
    // What was worked on there lately is the best hint of what a workspace is for. Helpers' titles are the parent's task.
    if (s.title?.trim() && !s.spawnedBy) titled.set(s.workspaceId, [...(titled.get(s.workspaceId) ?? []), s]);
  }
  const out: RouteTarget[] = [];
  for (const w of input.workspaces) {
    const m = online.get(w.machineId);
    if (!m || w.kind === 'worktree') continue;
    const recent = (titled.get(w.id) ?? [])
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .slice(0, RECENT_TITLES)
      .map((s) => clip(s.title!.replace(/\s+/g, ' ').trim(), MAX_TITLE));
    out.push({ machine: m, workspace: w, label: `${m.name} · ${w.name}`, detail: describe(m, w, recent), lastActive: last.get(w.id) ?? w.createdAt });
  }
  out.sort((a, b) => (a.lastActive < b.lastActive ? 1 : a.lastActive > b.lastActive ? -1 : a.label.localeCompare(b.label)));
  return out;
}

function describe(m: MachineInfo, w: WorkspaceInfo, recent: string[]): string {
  const facts: string[] = [];
  if (m.tags.length > 0) facts.push(`tags ${m.tags.join(', ')}`);
  if (m.headful) facts.push('has a GUI');
  if (m.alwaysOn) facts.push('always on');
  const desc = m.description?.replace(/\s+/g, ' ').trim();
  if (desc) facts.push(clip(desc, MAX_DESCRIPTION));
  facts.push(`folder ${w.path}${w.branch ? ` (branch ${w.branch})` : ''}`);
  if (recent.length > 0) facts.push(`recent work: ${recent.map((t) => `"${t}"`).join(', ')}`);
  return `${m.name} · ${w.name}: ${facts.join('; ')}`;
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
