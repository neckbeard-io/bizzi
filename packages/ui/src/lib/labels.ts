// Identity color and icon for machines and workspaces (spec §11.1 "Identity color"). Pure helpers; the
// components are in components/labels.tsx. Colors are palette names resolved per theme as `--label-<name>`.
import { LABEL_COLORS, isLabelIcon } from '@bizzi/protocol';
import type { LabelColor, MachineInfo, WorkspaceInfo } from '@bizzi/protocol';

export { LABEL_COLORS };

export const LABEL_COLOR_NAME: Record<LabelColor, string> = {
  red: 'Red',
  orange: 'Orange',
  yellow: 'Yellow',
  green: 'Green',
  teal: 'Teal',
  blue: 'Blue',
  purple: 'Purple',
  pink: 'Pink',
};

/** The CSS value of an identity color in the current theme. */
export function labelVar(color: LabelColor): string {
  return `var(--label-${color})`;
}

/** A workspace's color: its own, else (a worktree) its repo workspace's. */
export function workspaceColor(w: WorkspaceInfo, workspaces: Record<string, WorkspaceInfo> | null | undefined): LabelColor | undefined {
  if (w.color) return w.color;
  if (w.kind === 'worktree' && w.parentWorkspaceId) return workspaces?.[w.parentWorkspaceId]?.color;
  return undefined;
}

/** The workspace tile's text: its icon, else the first character of its name (uppercased). */
export function workspaceMonogram(w: Pick<WorkspaceInfo, 'name' | 'icon'>): string {
  if (w.icon) return w.icon;
  const first = firstGrapheme(w.name.trim());
  return first ? first.toUpperCase() : '?';
}

function firstGrapheme(s: string): string {
  if (!s) return '';
  if (typeof Intl.Segmenter === 'function') {
    for (const seg of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)) return seg.segment;
  }
  return [...s][0] ?? '';
}

/** Validate what the icon field holds: '' (none) or a valid icon after trimming. */
export function iconInputError(text: string): string | null {
  const t = text.trim();
  if (!t || isLabelIcon(t)) return null;
  return 'One or two characters or an emoji, no spaces.';
}

/** "prod-access · gui" for a machine's tags, '' when none. */
export function machineTagsLabel(m: Pick<MachineInfo, 'tags'>): string {
  return m.tags.join(' · ');
}
