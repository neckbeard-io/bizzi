import { useState } from 'react';
import type { ReactNode } from 'react';
import { accountConstraint, accountTone, formatAge, formatResetIn, primaryWindow, selectAccounts, selectWidgets, windowShortLabel, windowTone } from '@bizzi/client';
import type { AccountUsage } from '@bizzi/protocol';
import { useBizzi, useStore } from '../../app/context.tsx';
import { useAction, useMediaQuery, useNow } from '../../app/hooks.ts';
import { Icon } from '../../components/icons.tsx';
import { Meter } from '../../components/marks.tsx';
import { Badge, IconButton, Modal, cx } from '../../components/ui.tsx';
import { WidgetChip, widgetsEqual } from '../../components/Widget.tsx';
import { formatCost } from '../../lib/format.ts';
import { AGENT_GLYPH, BILLING_HINT, BILLING_LABEL, TONE_TEXT } from '../../lib/states.ts';

function accountsEqual(a: AccountUsage[], b: AccountUsage[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** "max", "pro", "api key": the plan word from a label like "claude · max · mc@…". */
function planWord(a: AccountUsage): string {
  const parts = a.label.split('·').map((p) => p.trim());
  return parts[1] ?? BILLING_LABEL[a.billing];
}

/**
 * Desktop bottom bar (usage.md §3.4): one compact meter per login, most constrained first, plus `bar`
 * widgets. Narrow windows show the most constrained login and `+n`. Click opens the usage panel.
 */
export function UsageBar(): ReactNode {
  const accounts = useBizzi(selectAccounts, accountsEqual);
  const widgets = useBizzi((s) => selectWidgets(s, 'bar'), widgetsEqual);
  const roomy = useMediaQuery('(min-width: 1280px)');
  const now = useNow(30_000, accounts.length + widgets.length > 0);
  const [open, setOpen] = useState(false);
  if (accounts.length === 0 && widgets.length === 0) return null;
  const shown = roomy ? accounts : accounts.slice(0, 1);
  const more = accounts.length - shown.length + (roomy ? 0 : widgets.length);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-7 w-full shrink-0 items-center gap-5 overflow-hidden border-t border-border bg-panel px-3 text-left hover:bg-panel-2"
        title="Usage per login and widgets"
      >
        {shown.map((a) => (
          <AccountMeter key={`${a.agent}:${a.accountId}`} account={a} now={now} />
        ))}
        {roomy ? widgets.map((w) => <WidgetChip key={`${w.machineId}:${w.id}`} widget={w} now={now} />) : null}
        {more > 0 ? <span className="text-xs text-muted">+{more}</span> : null}
        <span className="flex-1" />
        <Icon name="gauge" size={14} className="shrink-0 text-muted" />
      </button>
      {open ? <UsagePanel onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/** `[C] max 5h ▓▓▓░ 62% ↻1h20  7d 31%` or `[L] api key $12.40`. */
function AccountMeter(props: { account: AccountUsage; now: number }): ReactNode {
  const a = props.account;
  const tone = accountTone(a);
  const main = primaryWindow(a);
  const others = (a.windows ?? []).filter((w) => w !== main).slice(0, 1);
  const age = formatAge(a.observedAt, props.now);
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-xs whitespace-nowrap" title={`${a.label}${age ? ` · ${age}` : ''}`}>
      <span className="flex h-4 w-4 items-center justify-center rounded bg-panel-2 font-mono text-[10px] font-semibold text-muted">{AGENT_GLYPH[a.agent]}</span>
      <span className="text-muted">{planWord(a)}</span>
      {main ? (
        <>
          <span className="text-muted">{windowShortLabel(main)}</span>
          <Meter value={main.usedPercent / 100} tone={windowTone(main)} className="w-14" />
          <span className={cx('tabular-nums', TONE_TEXT[tone])}>{Math.round(main.usedPercent)}%</span>
          {main.resetsAt ? <span className="text-muted">↻{formatResetIn(main.resetsAt, props.now)}</span> : null}
          {others.map((w) => (
            <span key={w.id} className={cx('tabular-nums', TONE_TEXT[windowTone(w)] === 'text-fg' ? 'text-muted' : TONE_TEXT[windowTone(w)])}>
              {windowShortLabel(w)} {Math.round(w.usedPercent)}%
            </span>
          ))}
        </>
      ) : a.spend ? (
        <span className={cx('tabular-nums', TONE_TEXT[tone])}>
          {formatCost(a.spend.usd)}
          {a.spend.capUsd ? ` / ${formatCost(a.spend.capUsd)}` : ''}
        </span>
      ) : (
        <span className="text-muted">no data</span>
      )}
      {a.status === 'limited' ? <span className="text-err">limited</span> : null}
    </span>
  );
}

/** Phone: the most constrained login as a chip in the Machines and Inbox headers; opens the panel as a sheet. */
export function UsageChip(): ReactNode {
  const top = useBizzi((s) => selectAccounts(s)[0] ?? null);
  const hasWidgets = useBizzi((s) => Object.keys(s.widgets).length > 0);
  const [open, setOpen] = useState(false);
  if (!top && !hasWidgets) return null;
  const main = top ? primaryWindow(top) : null;
  const tone = top ? accountTone(top) : 'neutral';
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border px-2.5 text-xs" aria-label="Usage">
        <Icon name="gauge" size={14} className="text-muted" />
        {top ? (
          <>
            <span className="font-mono text-[10px] font-semibold text-muted">{AGENT_GLYPH[top.agent]}</span>
            <span className={cx('tabular-nums', TONE_TEXT[tone])}>{main ? `${Math.round(main.usedPercent)}%` : top.spend ? formatCost(top.spend.usd) : '–'}</span>
          </>
        ) : (
          <span className="text-muted">usage</span>
        )}
      </button>
      {open ? <UsagePanel onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/** Every login with each window, reset times and machines; then every widget with a refresh button. */
export function UsagePanel(props: { onClose: () => void }): ReactNode {
  const accounts = useBizzi(selectAccounts, accountsEqual);
  const widgets = useBizzi((s) => Object.values(s.widgets), widgetsEqual);
  const machines = useBizzi((s) => s.machines);
  const usageState = useBizzi((s) => s.usageState);
  const now = useNow(30_000);
  return (
    <Modal title="Usage" onClose={props.onClose} wide>
      {accounts.length === 0 ? <div className="py-4 text-sm text-muted">{usageState === 'unsupported' ? 'This server does not report per-login usage yet.' : 'No usage reported yet.'}</div> : null}
      <div className="flex flex-col gap-4">
        {accounts.map((a) => (
          <section key={`${a.agent}:${a.accountId}`} className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{a.label}</span>
              <Badge title={BILLING_HINT[a.billing]}>{BILLING_LABEL[a.billing]}</Badge>
              {a.status === 'limited' ? <Badge tone="err">limited</Badge> : a.status === 'warning' || accountConstraint(a) >= 80 ? <Badge tone="warn">near limit</Badge> : null}
              <span className="ml-auto text-xs text-muted">{formatAge(a.observedAt, now)}</span>
            </div>
            {(a.windows ?? []).map((w) => (
              <div key={w.id} className="grid grid-cols-[7rem_1fr_3rem] items-center gap-2 text-sm sm:grid-cols-[8rem_1fr_3rem_9rem]">
                <span className="truncate text-muted">{w.label}</span>
                <Meter value={w.usedPercent / 100} tone={windowTone(w)} className="w-full" />
                <span className={cx('text-right tabular-nums', TONE_TEXT[windowTone(w)])}>{Math.round(w.usedPercent)}%</span>
                <span className="col-span-3 text-xs text-muted sm:col-span-1">{w.resetsAt ? `resets in ${formatResetIn(w.resetsAt, now) || 'now'}` : ''}</span>
              </div>
            ))}
            {a.spend ? (
              <div className="text-sm">
                <span className="text-muted">Spend{a.spend.period ? ` (${a.spend.period})` : ''}: </span>
                <span className="tabular-nums">{formatCost(a.spend.usd)}</span>
                {a.spend.capUsd ? <span className="text-muted"> of {formatCost(a.spend.capUsd)}</span> : null}
              </div>
            ) : null}
            <div className="text-xs text-muted">Machines: {a.machines.map((id) => machines[id]?.name ?? id).join(', ') || '–'}</div>
          </section>
        ))}
      </div>
      {widgets.length > 0 ? (
        <>
          <div className="mt-5 mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Widgets</div>
          <ul className="flex flex-col gap-1.5">
            {widgets.map((w) => (
              <li key={`${w.machineId}:${w.id}`} className="flex items-center gap-2">
                <WidgetChip widget={w} now={now} className="min-w-0 flex-1" />
                <span className="text-xs text-muted">{machines[w.machineId]?.name ?? w.machineId}</span>
                <RefreshWidget machineId={w.machineId} widgetId={w.id} />
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Modal>
  );
}

function RefreshWidget(props: { machineId: string; widgetId: string }): ReactNode {
  const store = useStore();
  const online = useBizzi((s) => (s.role === 'hub' ? (s.machines[props.machineId]?.online ?? false) : s.connection.state === 'open'));
  const refresh = useAction(() => store.refreshWidget(props.machineId, props.widgetId));
  return <IconButton icon="refresh" label={refresh.error ? 'Refresh failed; retry' : 'Refresh'} disabled={!online || refresh.busy} onClick={() => void refresh.run()} className={cx('h-7 w-7', refresh.error ? 'text-err' : '')} size={14} />;
}
