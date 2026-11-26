// Identity colour and icon (spec §11.1 "Identity colour"): the workspace tile, the machine chip and
// stripe, and the palette picker. Identity is shown as shapes state never uses (a square tile, a square
// dot, an edge stripe), on the left of a row; state marks stay round and on the right.
import type { CSSProperties, ReactNode } from 'react';
import type { LabelColor, MachineInfo, WorkspaceInfo } from '@bizzi/protocol';
import { useBizzi } from '../app/context.tsx';
import { LABEL_COLORS, LABEL_COLOR_NAME, labelVar, machineTagsLabel, workspaceColor, workspaceMonogram } from '../lib/labels.ts';
import { Icon } from './icons.tsx';
import { cx } from './ui.tsx';

/** An inset stripe on a container's left edge in `color`; undefined without one. */
export function stripeStyle(color: LabelColor | undefined, width = 3): CSSProperties | undefined {
  return color ? { boxShadow: `inset ${width}px 0 0 ${labelVar(color)}` } : undefined;
}

/** A small square in an identity colour. Nothing without one. */
export function LabelDot(props: { color: LabelColor | undefined; className?: string; title?: string }): ReactNode {
  if (!props.color) return null;
  return (
    <span
      className={cx('inline-block h-2 w-2 shrink-0 rounded-[2px]', props.className)}
      style={{ backgroundColor: labelVar(props.color) }}
      title={props.title ?? LABEL_COLOR_NAME[props.color]}
      aria-hidden="true"
    />
  );
}

/**
 * The workspace's tile: its icon or first letter, filled with its colour (a worktree borrows its repo's).
 * Worktrees show the branch glyph instead, in the colour.
 */
export function WorkspaceTile(props: { workspace: WorkspaceInfo; size?: 'sm' | 'md'; className?: string }): ReactNode {
  const w = props.workspace;
  const color = useBizzi((s) => workspaceColor(w, s.workspaces));
  const md = props.size === 'md';
  if (w.kind === 'worktree' && !w.icon) {
    return <Icon name="branch" size={md ? 16 : 13} className={cx('shrink-0', !color && 'text-muted', props.className)} {...(color ? { style: { color: labelVar(color) } } : {})} />;
  }
  return (
    <span
      className={cx(
        'flex shrink-0 items-center justify-center overflow-hidden rounded font-semibold leading-none',
        md ? 'h-6 w-6 text-xs' : 'h-4 w-4 text-[10px]',
        color ? '' : 'bg-panel-2 text-muted',
        props.className,
      )}
      style={color ? { backgroundColor: labelVar(color), color: 'var(--card)' } : undefined}
      aria-hidden="true"
    >
      {workspaceMonogram(w)}
    </span>
  );
}

/** "▪ mac-mini · gui · prod-access": which machine, in its colour, with its tags (headers). */
export function MachineChip(props: { machine: MachineInfo; tags?: boolean; className?: string }): ReactNode {
  const m = props.machine;
  const tags = props.tags !== false ? machineTagsLabel(m) : '';
  return (
    <span className={cx('inline-flex min-w-0 items-center gap-1', props.className)} title={`Runs on ${m.name}${m.tags.length ? ` (tags: ${m.tags.join(', ')})` : ''}`}>
      <LabelDot color={m.color} />
      <span className="truncate">{m.name}</span>
      {tags ? <span className="truncate text-muted/80">· {tags}</span> : null}
    </span>
  );
}

/**
 * The picker with a caption, laid out like `Field`. Not a `<label>`: a click on the caption would press
 * the first swatch.
 */
export function LabelColorField(props: { value: LabelColor | undefined; onChange: (c: LabelColor | undefined) => void; label: string; hint?: string; disabled?: boolean }): ReactNode {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted">Colour</span>
      <LabelColorPicker value={props.value} onChange={props.onChange} label={props.label} {...(props.disabled !== undefined ? { disabled: props.disabled } : {})} />
      {props.hint ? <span className="text-xs text-muted">{props.hint}</span> : null}
    </div>
  );
}

/** The palette as a radio group, plus "none". */
export function LabelColorPicker(props: { value: LabelColor | undefined; onChange: (c: LabelColor | undefined) => void; disabled?: boolean; label?: string }): ReactNode {
  const swatch = 'flex h-8 w-8 items-center justify-center rounded-full border outline-offset-2 disabled:opacity-40';
  return (
    <div role="radiogroup" aria-label={props.label ?? 'Colour'} className="flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        role="radio"
        aria-checked={!props.value}
        title="No colour"
        disabled={props.disabled}
        onClick={() => props.onChange(undefined)}
        className={cx(swatch, 'text-muted', !props.value ? 'border-fg' : 'border-border hover:border-muted')}
      >
        <Icon name="x" size={14} />
      </button>
      {LABEL_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={props.value === c}
          aria-label={LABEL_COLOR_NAME[c]}
          title={LABEL_COLOR_NAME[c]}
          disabled={props.disabled}
          onClick={() => props.onChange(c)}
          className={cx(swatch, props.value === c ? 'border-fg' : 'border-transparent')}
        >
          <span className="flex h-6 w-6 items-center justify-center rounded-full" style={{ backgroundColor: labelVar(c), color: 'var(--card)' }}>
            {props.value === c ? <Icon name="check" size={14} /> : null}
          </span>
        </button>
      ))}
    </div>
  );
}
