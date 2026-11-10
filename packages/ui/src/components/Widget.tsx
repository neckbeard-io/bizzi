import type { ReactNode } from 'react';
import { formatAge, selectWidgets, widgetStale, widgetText, widgetTone } from '@bizzi/client';
import type { WidgetPlacement } from '@bizzi/client';
import type { WidgetValue } from '@bizzi/protocol';
import { useBizzi } from '../app/context.tsx';
import { useNow } from '../app/hooks.ts';
import { TONE_TEXT } from '../lib/states.ts';
import { Meter } from './marks.tsx';
import { cx } from './ui.tsx';

/**
 * A node-run widget rendered natively by kind (usage.md §4.1): meter = value / max with thresholds,
 * text = one line, status = a dot plus a label. Stale or failing values show their age.
 */
export function WidgetChip(props: { widget: WidgetValue; now: number; className?: string; showMeter?: boolean }): ReactNode {
  const w = props.widget;
  const tone = widgetTone(w);
  const stale = widgetStale(w, props.now);
  const age = formatAge(w.observedAt, props.now);
  const title = [w.tooltip, w.error ? `last run failed: ${w.error}` : null, age ? `updated ${age}` : null].filter(Boolean).join('\n');
  const body = (
    <span className={cx('inline-flex min-w-0 items-center gap-1.5 text-xs whitespace-nowrap', props.className)} title={title || undefined}>
      {w.kind === 'status' ? <span className={cx('h-2 w-2 shrink-0 rounded-full', tone === 'err' ? 'bg-err' : tone === 'warn' ? 'bg-warn' : w.tone === 'ok' ? 'bg-ok' : 'bg-muted')} /> : null}
      <span className="text-muted">{w.label}</span>
      {w.kind === 'meter' && props.showMeter !== false && w.value !== undefined && w.max ? <Meter value={w.value / w.max} tone={tone} className="w-12" /> : null}
      <span className={cx('truncate tabular-nums', TONE_TEXT[tone])}>{widgetText(w)}</span>
      {stale ? <span className={cx('text-[10px]', w.error ? 'text-warn' : 'text-muted')}>{w.error ? `⚠ ${age}` : age}</span> : null}
    </span>
  );
  if (w.link) {
    return (
      <a href={w.link} target="_blank" rel="noreferrer" className="hover:underline">
        {body}
      </a>
    );
  }
  return body;
}

/** Widgets for one placement (optionally one machine's), in a wrapping row. Renders nothing when empty. */
export function WidgetRow(props: { placement: WidgetPlacement; machineId?: string | null; className?: string }): ReactNode {
  const widgets = useBizzi((s) => selectWidgets(s, props.placement, props.machineId), widgetsEqual);
  const now = useNow(30_000, widgets.length > 0);
  if (widgets.length === 0) return null;
  return (
    <div className={cx('flex flex-wrap items-center gap-x-4 gap-y-1', props.className)}>
      {widgets.map((w) => (
        <WidgetChip key={`${w.machineId}:${w.id}`} widget={w} now={now} />
      ))}
    </div>
  );
}

export function widgetsEqual(a: WidgetValue[], b: WidgetValue[]): boolean {
  return a.length === b.length && a.every((w, i) => w === b[i]);
}
