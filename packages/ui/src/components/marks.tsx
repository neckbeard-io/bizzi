import type { ReactNode } from 'react';
import type { MarkState, MeterTone } from '@bizzi/client';
import type { AgentKind } from '@bizzi/protocol';
import { AGENT_GLYPH, AGENT_LABEL, AGENT_TILE, MARK_LABEL, MARK_TEXT, TONE_FILL } from '../lib/states.ts';
import { cx } from './ui.tsx';

/**
 * A session's state as a drawn symbol in the state color (spec §11.1). The shape alone tells the states apart,
 * for colorblind users and with reduced motion: working is a spinning arc, background work a slowly turning
 * dotted ring, waiting a pulsing warning triangle, done a check, failed a cross, idle a dim hollow dot.
 */
export function StateSymbol(props: { state: MarkState; size?: number; className?: string; title?: string }): ReactNode {
  const { state } = props;
  const size = props.size ?? 12;
  const stroke = { fill: 'none', stroke: 'currentColor', strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
  let body: ReactNode;
  switch (state) {
    case 'working':
      body = (
        <>
          <circle cx="8" cy="8" r="5.6" {...stroke} strokeWidth="2.6" opacity="0.28" />
          <path d="M8 2.4 A5.6 5.6 0 0 1 8 13.6" {...stroke} strokeWidth="2.6" />
        </>
      );
      break;
    case 'background':
      body = <circle cx="8" cy="8" r="5.6" {...stroke} strokeWidth="2.8" strokeDasharray="0.01 4.39" />;
      break;
    case 'waiting':
      body = (
        <>
          <path d="M8 1.7 L15 14 H1 Z" fill="currentColor" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          <rect x="7.05" y="5.4" width="1.9" height="4.9" rx="0.95" fill="var(--state-waiting-foreground)" />
          <circle cx="8" cy="12.15" r="1.1" fill="var(--state-waiting-foreground)" />
        </>
      );
      break;
    case 'done':
      body = <path d="M3 8.7 L6.6 12.1 L13 4.4" {...stroke} strokeWidth="2.8" />;
      break;
    case 'failed':
      body = <path d="M4 4 L12 12 M12 4 L4 12" {...stroke} strokeWidth="2.8" />;
      break;
    case 'idle':
      body = <circle cx="8" cy="8" r="3.6" {...stroke} strokeWidth="1.7" />;
      break;
  }
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      className={cx('shrink-0', MARK_TEXT[state], state === 'working' && 'animate-mark-spin', state === 'background' && 'animate-mark-orbit', state === 'waiting' && 'animate-mark-pulse', props.className)}
      role="img"
      aria-label={props.title ?? MARK_LABEL[state]}
    >
      {props.title ? <title>{props.title}</title> : null}
      {body}
    </svg>
  );
}

/** The agent-type glyph on a tile in the agent's identity color, so a Claude and a Codex session look different. */
export function AgentTile(props: { agent: AgentKind; size?: number; className?: string }): ReactNode {
  const size = props.size ?? 16;
  const glyph = AGENT_GLYPH[props.agent];
  return (
    <span
      className={cx('inline-flex shrink-0 items-center justify-center font-mono leading-none font-bold ring-1 ring-inset', glyph.length > 1 && 'tracking-tighter', AGENT_TILE[props.agent], props.className)}
      style={{ width: size, height: size, borderRadius: Math.max(3, Math.round(size * 0.28)), fontSize: Math.round(size * (glyph.length > 1 ? 0.5 : 0.64)) }}
      aria-hidden="true"
    >
      {glyph}
    </span>
  );
}

function HelperCount(props: { n: number }): ReactNode {
  return <span className="absolute -top-1.5 -right-2 min-w-3 rounded-full border border-panel bg-panel-2 px-0.5 text-center text-[9px] leading-3 font-semibold text-fg">{props.n}</span>;
}

/**
 * One live session (spec §11.1): who (the agent glyph on its identity-colored tile) and what it's doing (the
 * state symbol, in the state color), each readable without the other's color. Side by side by default;
 * `compact` puts the state symbol as a badge on the tile's corner, for rows of several marks. Helpers show as a
 * small number on the tile's top corner. `backdrop` is the surface under the badge (default the sidebar).
 */
export function AgentMark(props: { agent: AgentKind; state: MarkState; helpers?: number; size?: number; title?: string; compact?: boolean; backdrop?: string }): ReactNode {
  const size = props.size ?? 18;
  const { state } = props;
  const label = `${AGENT_LABEL[props.agent]} · ${MARK_LABEL[state]}${props.helpers ? ` · ${props.helpers} helper${props.helpers === 1 ? '' : 's'}` : ''}`;
  const helpers = props.helpers ? <HelperCount n={props.helpers} /> : null;
  if (props.compact) {
    const badge = Math.max(9, Math.round(size * 0.66));
    return (
      <span className="relative inline-flex shrink-0" style={{ width: size, height: size }} title={props.title ?? label} aria-label={`${AGENT_LABEL[props.agent]} ${MARK_LABEL[state]}`}>
        <AgentTile agent={props.agent} size={size} />
        <span className={cx('absolute inline-flex items-center justify-center rounded-full', props.backdrop ?? 'bg-sidebar')} style={{ right: -Math.round(badge * 0.7), bottom: -Math.round(badge * 0.5), width: badge + 2, height: badge + 2 }}>
          <StateSymbol state={state} size={badge} />
        </span>
        {helpers}
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-[3px]" title={props.title ?? label} aria-label={`${AGENT_LABEL[props.agent]} ${MARK_LABEL[state]}`}>
      <span className="relative inline-flex">
        <AgentTile agent={props.agent} size={size} />
        {helpers}
      </span>
      <StateSymbol state={state} size={size} />
    </span>
  );
}

/** Width of a side-by-side AgentMark of `size`, to line a second row up with the title after it. */
export function agentMarkWidth(size: number): number {
  return size * 2 + 3;
}

/** The narrow-sidebar form of a mark: just the state symbol (its shape and color). */
export function MarkDot(props: { state: MarkState; title?: string; size?: number }): ReactNode {
  return <StateSymbol state={props.state} size={props.size ?? 11} title={props.title ?? MARK_LABEL[props.state]} />;
}

/** `⚠1` style count used when marks collapse on the phone. */
export function MarkCount(props: { state: MarkState; n: number }): ReactNode {
  return (
    <span className={cx('inline-flex items-center gap-0.5 text-xs font-medium tabular-nums', MARK_TEXT[props.state])} title={`${props.n} ${MARK_LABEL[props.state]}`}>
      <StateSymbol state={props.state} size={12} />
      {props.n}
    </span>
  );
}

/** A solid "Needs you" pill in the waiting color, on rows whose session is waiting for the user. */
export function NeedsYouBadge(props: { className?: string }): ReactNode {
  return <span className={cx('shrink-0 rounded-full bg-state-waiting px-1.5 text-[10px] leading-4 font-semibold whitespace-nowrap text-state-waiting-foreground', props.className)}>Needs you</span>;
}

/** A thin horizontal meter; color only when the tone says so. */
export function Meter(props: { value: number; tone: MeterTone; className?: string; marker?: number; title?: string }): ReactNode {
  const pct = Math.round(Math.min(1, Math.max(0, props.value)) * 100);
  return (
    <span className={cx('relative inline-block h-1.5 overflow-hidden rounded-full bg-panel-2', props.className)} role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} title={props.title}>
      <span className={cx('absolute inset-y-0 left-0 rounded-full', TONE_FILL[props.tone])} style={{ width: `${pct}%` }} />
      {props.marker !== undefined ? <span className="absolute inset-y-0 w-px bg-fg/50" style={{ left: `${Math.round(Math.min(1, props.marker) * 100)}%` }} /> : null}
    </span>
  );
}
