import { useState } from 'react';
import type { ReactNode } from 'react';
import { contextBreakdown, contextView, versionChip } from '@bizzi/client';
import type { ContextSegment } from '@bizzi/client';
import type { ContextUsage, SessionInfo } from '@bizzi/protocol';
import { useBizzi, useStore } from '../../app/context.tsx';
import { useAction, useLongPress } from '../../app/hooks.ts';
import { useMachineOnline } from '../../app/machine.ts';
import { Meter } from '../../components/marks.tsx';
import { Badge, Button, ErrorText, Modal, cx } from '../../components/ui.tsx';
import { WidgetRow } from '../../components/Widget.tsx';
import { formatCost, formatTokens } from '../../lib/format.ts';
import { routeHref } from '../../lib/router.ts';
import { BILLING_HINT, BILLING_LABEL, TONE_TEXT } from '../../lib/states.ts';

/**
 * The strip under a session's title: context bar, agent version (with restart when stale), billing and
 * budget tags, the parent of a helper, and `session-header` widgets.
 */
export function SessionHeaderBar(props: { session: SessionInfo }): ReactNode {
  const s = props.session;
  const parent = useBizzi((st) => (s.spawnedBy ? (st.sessions[s.spawnedBy] ?? null) : null));
  const spent = useBizzi((st) => st.timelines[s.id]?.usage?.costUsd);
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-panel px-3 py-1.5 text-xs md:px-5">
      <ContextBar sessionId={s.id} />
      <VersionChip session={s} />
      {s.billing ? (
        <Badge tone={s.billing === 'budgetless' ? 'info' : 'neutral'} title={BILLING_HINT[s.billing]}>
          {BILLING_LABEL[s.billing]}
        </Badge>
      ) : null}
      {s.budget ? <BudgetTag budget={s.budget} spent={s.billing === 'metered' ? spent : undefined} /> : null}
      {s.spawnedBy ? (
        <span className="truncate text-muted">
          helper{s.scope === 'detached' ? ' (detached)' : ''} of{' '}
          <a className="text-fg hover:underline" href={routeHref({ name: 'session', sessionId: s.spawnedBy, tab: 'chat' })}>
            {parent?.title || s.spawnedBy}
          </a>
        </span>
      ) : null}
      <WidgetRow placement="session-header" machineId={s.machineId} className="ml-auto" />
    </div>
  );
}

function BudgetTag(props: { budget: NonNullable<SessionInfo['budget']>; spent: number | undefined }): ReactNode {
  const b = props.budget;
  const parts: string[] = [];
  if (b.usd !== undefined) parts.push(props.spent !== undefined ? `${formatCost(props.spent)} / ${formatCost(b.usd)}` : formatCost(b.usd));
  if (b.tokens !== undefined) parts.push(`${formatTokens(b.tokens)} tokens`);
  if (b.turns !== undefined) parts.push(`${b.turns} turns`);
  const over = b.usd !== undefined && props.spent !== undefined && props.spent >= b.usd;
  return (
    <Badge tone={over ? 'warn' : 'neutral'} title="Budget for this session and its helpers; only metered spend counts toward dollars">
      budget {parts.join(' · ')}
    </Badge>
  );
}

/** `used / usable` as a thin bar: neutral below 60%, amber from 80%, red near compaction; click for the breakdown. */
export function ContextBar(props: { sessionId: string }): ReactNode {
  const ctx = useBizzi((s) => s.timelines[props.sessionId]?.context ?? null);
  const [open, setOpen] = useState(false);
  const longPress = useLongPress(() => setOpen(true));
  const v = contextView(ctx);
  if (!v.known || !ctx) return <span className="text-muted">context unknown</span>;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        {...longPress}
        className="inline-flex items-center gap-1.5 rounded px-1 py-0.5 hover:bg-panel-2"
        title={`${formatTokens(v.used)} / ${formatTokens(v.usable)} usable · ${formatTokens(v.window)} window. Click for the breakdown.`}
      >
        <span className="text-muted">context</span>
        <Meter value={v.fill} tone={v.tone} className={cx('w-20 sm:w-28', v.level === 'elevated' && '[&>span:first-child]:bg-fg/60')} />
        <span className={cx('tabular-nums', TONE_TEXT[v.tone] === 'text-fg' ? 'text-muted' : TONE_TEXT[v.tone])}>{v.label}</span>
      </button>
      {open ? <ContextBreakdownModal ctx={ctx} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

const USED_SHADES = ['bg-fg/70', 'bg-fg/55', 'bg-fg/40', 'bg-fg/30', 'bg-fg/22', 'bg-fg/16'];

function segmentClass(seg: ContextSegment, usedIndex: number): string {
  if (seg.bizzi) return 'bg-accent';
  if (seg.kind === 'used') return USED_SHADES[usedIndex % USED_SHADES.length] ?? 'bg-fg/40';
  if (seg.kind === 'deferred') return 'bg-fg/12';
  if (seg.kind === 'buffer') return 'bg-fg/8';
  return 'bg-transparent';
}

/** Stacked bar by category, like Claude's `/context`, with bizzi's own overhead called out. */
function ContextBreakdownModal(props: { ctx: ContextUsage; onClose: () => void }): ReactNode {
  const segs = contextBreakdown(props.ctx);
  const v = contextView(props.ctx);
  let used = 0;
  const classes = segs.map((s) => segmentClass(s, s.kind === 'used' && !s.bizzi ? used++ : 0));
  const bizzi = segs.find((s) => s.bizzi);
  return (
    <Modal title="Context" onClose={props.onClose}>
      {v.known ? (
        <div className="mb-3 text-sm">
          <span className="font-medium tabular-nums">{formatTokens(v.used)}</span>
          <span className="text-muted">
            {' '}
            / {formatTokens(v.usable)} usable · {formatTokens(v.window)} window
          </span>
          <div className={cx('text-xs', TONE_TEXT[v.tone] === 'text-fg' ? 'text-muted' : TONE_TEXT[v.tone])}>{v.label}</div>
        </div>
      ) : null}
      <div className="flex h-4 w-full overflow-hidden rounded border border-border bg-panel-2" role="img" aria-label="Context by category">
        {segs.map((s, i) => (
          <span key={s.id} className={cx('h-full', classes[i])} style={{ width: `${s.share * 100}%` }} title={`${s.label}: ${formatTokens(s.tokens)}`} />
        ))}
      </div>
      <ul className="mt-3 flex flex-col gap-1 text-sm">
        {segs.map((s, i) => (
          <li key={s.id} className={cx('flex items-center gap-2', s.bizzi && 'font-medium')}>
            <span className={cx('h-3 w-3 shrink-0 rounded-sm border border-border', classes[i])} />
            <span className="min-w-0 flex-1 truncate">{s.label}</span>
            <span className="tabular-nums text-muted">{formatTokens(s.tokens)}</span>
            <span className="w-10 text-right text-xs tabular-nums text-muted">{Math.round(s.share * 100)}%</span>
          </li>
        ))}
      </ul>
      {bizzi ? (
        <p className="mt-3 rounded-md bg-accent-soft px-3 py-2 text-xs text-accent">
          bizzi overhead: {formatTokens(bizzi.tokens)} for the knowledge rules and the knowledge and agent-to-agent MCP tools bizzi injects (estimated from what it sends).
        </p>
      ) : null}
    </Modal>
  );
}

/** "2.1.311 · 2.1.322 installed" plus a restart button when the process is older than the install. */
function VersionChip(props: { session: SessionInfo }): ReactNode {
  const s = props.session;
  const store = useStore();
  const online = useMachineOnline(s.machineId);
  const listing = useBizzi((st) => st.agents[s.machineId]?.find((a) => a.agent === s.agent) ?? null);
  const status = useBizzi((st) => st.timelines[s.id]?.status ?? s.status);
  const restarting = useBizzi((st) => st.timelines[s.id]?.restartItemId != null);
  const restart = useAction(() => store.restartSession(s.id));
  const chip = versionChip(s, listing);
  if (!chip) return null;
  const live = status !== 'ended' && status !== 'failed';
  return (
    <span className="inline-flex items-center gap-1">
      <Badge tone={chip.stale ? 'info' : 'neutral'} title={chip.stale ? 'This session runs an older agent process than the one installed on the machine' : 'Agent version of this session'}>
        {chip.text}
      </Badge>
      {chip.stale && live ? (
        <Button
          size="sm"
          variant="ghost"
          icon="refresh"
          busy={restart.busy || restarting}
          disabled={!online}
          onClick={() => {
            if (window.confirm(`Restart this session on ${listing?.version ?? 'the installed version'}? It restarts at the next safe point and resumes; the timeline carries on.`)) void restart.run();
          }}
        >
          {restarting ? 'Restarting' : 'Restart'}
        </Button>
      ) : null}
      {restart.error ? <ErrorText error={restart.error} className="py-0.5 text-xs" /> : null}
    </span>
  );
}
