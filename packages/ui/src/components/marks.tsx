import type { ReactNode } from 'react';
import type { MarkState, MeterTone } from '@bizzi/client';
import type { AgentKind } from '@bizzi/protocol';
import { AGENT_GLYPH, AGENT_LABEL, MARK_DOT, MARK_LABEL, MARK_RING, MARK_SYMBOL, MARK_TEXT, TONE_FILL } from '../lib/states.ts';
import { cx } from './ui.tsx';

/**
 * One live session in the sidebar (spec §11.1): the agent-type glyph inside a ring in the state colour.
 * Waiting pulses, working spins; helpers show as a small number in the corner.
 */
export function AgentMark(props: { agent: AgentKind; state: MarkState; helpers?: number; size?: number; title?: string }): ReactNode {
  const size = props.size ?? 18;
  const { state } = props;
  return (
    <span
      className={cx('relative inline-flex shrink-0 items-center justify-center rounded-full', MARK_TEXT[state])}
      style={{ width: size, height: size }}
      title={props.title ?? `${AGENT_LABEL[props.agent]} · ${MARK_LABEL[state]}${props.helpers ? ` · ${props.helpers} helper${props.helpers === 1 ? '' : 's'}` : ''}`}
      aria-label={`${AGENT_LABEL[props.agent]} ${MARK_LABEL[state]}`}
    >
      <span
        className={cx(
          'absolute inset-0 rounded-full border-2',
          MARK_RING[state],
          state === 'working' && 'animate-spin border-t-transparent',
          state === 'waiting' && 'animate-pulse',
          state === 'idle' && 'border',
        )}
      />
      <span className={cx('font-mono leading-none font-semibold', state === 'idle' ? 'text-muted' : 'text-fg')} style={{ fontSize: Math.round(size * 0.5) }}>
        {AGENT_GLYPH[props.agent]}
      </span>
      {props.helpers ? (
        <span className="absolute -right-1.5 -bottom-1 min-w-3 rounded-full border border-panel bg-panel-2 px-0.5 text-center text-[9px] leading-3 font-semibold text-fg">{props.helpers}</span>
      ) : null}
    </span>
  );
}

/** The narrow-sidebar form of a mark: a plain dot in the state colour (idle is hollow). */
export function MarkDot(props: { state: MarkState; title?: string; size?: number }): ReactNode {
  const s = props.size ?? 8;
  return <span className={cx('inline-block shrink-0 rounded-full', MARK_DOT[props.state], props.state === 'waiting' && 'animate-pulse')} style={{ width: s, height: s }} title={props.title ?? MARK_LABEL[props.state]} />;
}

/** `⚠1` style count used when marks collapse on the phone. */
export function MarkCount(props: { state: MarkState; n: number }): ReactNode {
  return (
    <span className={cx('inline-flex items-center gap-0.5 text-xs font-medium tabular-nums', MARK_TEXT[props.state])} title={`${props.n} ${MARK_LABEL[props.state]}`}>
      <span aria-hidden="true">{MARK_SYMBOL[props.state]}</span>
      {props.n}
    </span>
  );
}

/** A thin horizontal meter; colour only when the tone says so. */
export function Meter(props: { value: number; tone: MeterTone; className?: string; marker?: number; title?: string }): ReactNode {
  const pct = Math.round(Math.min(1, Math.max(0, props.value)) * 100);
  return (
    <span className={cx('relative inline-block h-1.5 overflow-hidden rounded-full bg-panel-2', props.className)} role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} title={props.title}>
      <span className={cx('absolute inset-y-0 left-0 rounded-full', TONE_FILL[props.tone])} style={{ width: `${pct}%` }} />
      {props.marker !== undefined ? <span className="absolute inset-y-0 w-px bg-fg/50" style={{ left: `${Math.round(Math.min(1, props.marker) * 100)}%` }} /> : null}
    </span>
  );
}
