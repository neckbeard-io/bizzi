import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  collapsedCounts,
  machineSummaryEqual,
  machineTotalsLabel,
  selectMachineList,
  selectMachineSummary,
  selectMachineWorkspaces,
  selectWorkspaceBreakdown,
  selectWorkspaceRow,
  shallowEqual,
  workspaceRowEqual,
  workspaceTreeEqual,
} from '@bizzi/client';
import type { SessionBreakdownLine, WorkspaceRowModel } from '@bizzi/client';
import type { MachineInfo, WorkspaceInfo } from '@bizzi/protocol';
import { useBizzi, useStore } from '../../app/context.tsx';
import { navigate, useLongPress, useMediaQuery } from '../../app/hooks.ts';
import { Icon } from '../../components/icons.tsx';
import { AgentMark, MarkCount, MarkDot } from '../../components/marks.tsx';
import { Modal, cx } from '../../components/ui.tsx';
import { formatRelative } from '../../lib/format.ts';
import { routeHref } from '../../lib/router.ts';
import { AGENT_LABEL, MARK_LABEL, MARK_SYMBOL, MARK_TEXT, aheadBehind, pendingUpdatesLabel, visibleMarks } from '../../lib/states.ts';
import { loadJson, saveJson } from '../../lib/storage.ts';

type Variant = 'desktop' | 'phone';

const COLLAPSED_KEY = 'bizzi.sidebar.collapsed';

/**
 * Machines first, workspaces under each (spec §11.1). A quiet workspace is one line; a row grows only when
 * something needs you (row 2) or the repo isn't in sync (row 3, desktop only). Machine sections collapse and
 * remember their state.
 */
export function MachineTree(props: { variant: Variant; activeWorkspaceId?: string | null; className?: string }): ReactNode {
  const machines = useBizzi(selectMachineList, shallowEqual);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => loadJson<Record<string, boolean>>(COLLAPSED_KEY) ?? {});
  const toggle = useCallback((id: string) => {
    setCollapsed((c) => {
      const next = { ...c, [id]: !c[id] };
      saveJson(COLLAPSED_KEY, next);
      return next;
    });
  }, []);
  if (machines.length === 0) return <div className="px-2 text-xs text-muted">No machines yet</div>;
  return (
    <div className={cx('flex flex-col gap-1', props.className)}>
      {machines.map((m) => (
        <MachineSection key={m.id} machine={m} variant={props.variant} collapsed={collapsed[m.id] ?? false} onToggle={toggle} activeWorkspaceId={props.activeWorkspaceId ?? null} />
      ))}
    </div>
  );
}

function MachineSection(props: { machine: MachineInfo; variant: Variant; collapsed: boolean; onToggle: (id: string) => void; activeWorkspaceId: string | null }): ReactNode {
  const { machine: m, variant, collapsed } = props;
  const store = useStore();
  const summary = useBizzi((s) => selectMachineSummary(s, m.id), machineSummaryEqual);
  const rows = useBizzi((s) => selectMachineWorkspaces(s, m.id), workspaceTreeEqual);
  const phone = variant === 'phone';
  const totals = machineTotalsLabel(summary);
  const unsupported = summary.unsupported.map((a) => AGENT_LABEL[a]).join(', ');
  return (
    <section className={cx(!summary.online && 'opacity-60')}>
      <div className={cx('flex items-center gap-1 rounded-md pr-2', phone ? 'min-h-11' : 'h-7')}>
        <button
          type="button"
          onClick={() => props.onToggle(m.id)}
          className={cx('flex shrink-0 items-center justify-center text-muted hover:text-fg', phone ? 'h-11 w-9' : 'h-7 w-6')}
          aria-expanded={!collapsed}
          aria-label={collapsed ? `Expand ${m.name}` : `Collapse ${m.name}`}
        >
          <Icon name={collapsed ? 'chevronRight' : 'chevronDown'} size={14} />
        </button>
        <a
          href={routeHref({ name: 'machine', machineId: m.id })}
          onClick={() => store.selectMachine(m.id)}
          className={cx('min-w-0 flex-1 truncate font-semibold hover:underline', phone ? 'text-sm' : 'text-xs')}
          title={`${m.hostname}${summary.online ? '' : ' · offline'}`}
        >
          {m.name}
          {summary.online ? null : <span className="font-normal text-muted"> (offline)</span>}
        </a>
        {summary.unsupported.length > 0 ? (
          <span className="text-warn" title={`Not supported here: ${unsupported}. Open the machine for remedies.`}>
            <Icon name="alert" size={13} />
          </span>
        ) : null}
        {totals ? <span className={cx('shrink-0 text-[11px] tabular-nums', summary.waiting > 0 ? 'text-warn' : 'text-muted')}>{totals}</span> : null}
      </div>
      {!collapsed && summary.staleSessions > 0 && !phone ? <div className="truncate pl-7 text-[11px] text-muted">{pendingUpdatesLabel(summary.staleSessions)}</div> : null}
      {!collapsed ? (
        <div className="flex flex-col">
          {rows.map((r) => (
            <WorkspaceRow key={r.workspace.id} workspace={r.workspace} depth={r.depth} variant={variant} online={summary.online} active={props.activeWorkspaceId === r.workspace.id} />
          ))}
          {rows.length === 0 ? <div className="py-1 pl-7 text-[11px] text-muted">No workspaces</div> : null}
        </div>
      ) : null}
    </section>
  );
}

function WorkspaceRow(props: { workspace: WorkspaceInfo; depth: number; variant: Variant; online: boolean; active: boolean }): ReactNode {
  const { workspace: w, variant, online } = props;
  const store = useStore();
  const row = useBizzi((s) => selectWorkspaceRow(s, w.id), workspaceRowEqual);
  const git = useBizzi((s) => s.gitStatus[w.id] ?? null);
  const iconsFit = useMediaQuery('(min-width: 1024px)');
  const phone = variant === 'phone';
  const [hover, setHover] = useState<DOMRect | null>(null);
  const [sheet, setSheet] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const longPress = useLongPress(() => setSheet(true));

  // Repo state for row 1 (branch, dirty) and row 3 (ahead/behind); refreshed while the row is mounted.
  useEffect(() => {
    if (!online || w.kind === 'dir') return;
    const load = (): void => void store.loadGitStatus(w.id).catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [store, online, w.id, w.kind]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const branch = git?.branch ?? w.branch;
  const ab = git ? aheadBehind(git.ahead, git.behind) : '';
  const onEnter = (): void => {
    if (phone || row.marks.length === 0) return;
    timer.current = setTimeout(() => setHover(ref.current?.getBoundingClientRect() ?? null), 450);
  };
  const onLeave = (): void => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setHover(null);
  };

  return (
    <div ref={ref} onMouseEnter={onEnter} onMouseLeave={onLeave} className={cx('rounded-md', props.active && (phone ? 'bg-panel-2' : 'bg-sidebar-accent'))} style={{ paddingLeft: props.depth * 14 }}>
      <a
        href={routeHref({ name: 'workspace', workspaceId: w.id })}
        className={cx('flex items-center gap-2 rounded-md pr-2 pl-2', phone ? 'hover:bg-panel-2' : 'hover:bg-sidebar-accent', phone ? 'min-h-11 text-sm' : 'h-7 text-[13px]', props.active ? 'font-medium text-fg' : 'text-fg/90')}
        title={w.path}
        {...(phone ? longPress : {})}
      >
        <WorkspaceIcon workspace={w} />
        <span className="min-w-[4.5rem] truncate">{w.kind === 'worktree' && w.branch ? w.branch : w.name}</span>
        {branch && w.kind !== 'worktree' ? (
          <span className="min-w-0 shrink-[4] truncate font-mono text-[11px] text-muted">
            {branch}
            {git?.dirty ? '*' : ''}
          </span>
        ) : w.kind === 'worktree' && git?.dirty ? (
          <span className="font-mono text-[11px] text-muted">*</span>
        ) : null}
        <span className="flex-1" />
        <Marks row={row} variant={variant} dots={!phone && !iconsFit} />
      </a>
      {row.urgent ? (
        <a
          href={routeHref({ name: 'session', sessionId: row.urgent.sessionId, tab: 'chat' })}
          className={cx('flex items-center gap-1.5 truncate rounded-md pr-2 pl-8 text-xs text-muted hover:text-fg', phone ? 'hover:bg-panel-2' : 'hover:bg-sidebar-accent', phone ? 'min-h-11' : 'h-6')}
          title={`${AGENT_LABEL[row.urgent.agent]}: ${row.urgent.text}`}
        >
          <span className={cx('shrink-0', MARK_TEXT[row.urgent.state])} aria-label={MARK_LABEL[row.urgent.state]}>
            {MARK_SYMBOL[row.urgent.state]}
          </span>
          <span className="min-w-0 truncate">
            {AGENT_LABEL[row.urgent.agent]}: {row.urgent.text}
          </span>
        </a>
      ) : null}
      {!phone && ab ? <div className="h-5 truncate pl-8 font-mono text-[11px] leading-5 text-muted">{ab}</div> : null}
      {hover ? <BreakdownPopover workspaceId={w.id} rect={hover} /> : null}
      {sheet ? (
        <Modal title={w.name} onClose={() => setSheet(false)}>
          <Breakdown workspaceId={w.id} phone />
        </Modal>
      ) : null}
    </div>
  );
}

function WorkspaceIcon(props: { workspace: WorkspaceInfo }): ReactNode {
  const w = props.workspace;
  if (w.kind === 'worktree') return <Icon name="branch" size={13} className="shrink-0 text-muted" />;
  return (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded bg-panel-2 text-[10px] font-semibold text-muted uppercase" aria-hidden="true">
      {w.name.slice(0, 1)}
    </span>
  );
}

/** Right-aligned marks: four then `+n`; plain dots when narrow; counts on the phone beyond three. */
function Marks(props: { row: WorkspaceRowModel; variant: Variant; dots: boolean }): ReactNode {
  const { row } = props;
  if (row.marks.length === 0) return null;
  if (props.variant === 'phone') {
    const counts = collapsedCounts(row, 3);
    if (counts) {
      return (
        <span className="flex shrink-0 items-center gap-1.5">
          {counts.map((c) => (
            <MarkCount key={c.state} state={c.state} n={c.n} />
          ))}
        </span>
      );
    }
  }
  const { shown, more } = visibleMarks(row.marks, props.variant === 'phone' ? 3 : 4);
  return (
    <span className={cx('flex shrink-0 items-center', props.dots ? 'gap-1' : 'gap-1.5')}>
      {shown.map((m) => (props.dots ? <MarkDot key={m.sessionId} state={m.state} /> : <AgentMark key={m.sessionId} agent={m.agent} state={m.state} helpers={m.helpers} size={props.variant === 'phone' ? 20 : 16} />))}
      {more > 0 ? <span className="text-[11px] text-muted tabular-nums">+{more}</span> : null}
    </span>
  );
}

function BreakdownPopover(props: { workspaceId: string; rect: DOMRect }): ReactNode {
  const { rect } = props;
  const left = Math.min(rect.right + 8, window.innerWidth - 340);
  const top = Math.min(rect.top, window.innerHeight - 220);
  return createPortal(
    <div className="pointer-events-none fixed z-40 w-80 rounded-lg border border-border bg-panel p-2 shadow-lg" style={{ left, top }} role="tooltip">
      <Breakdown workspaceId={props.workspaceId} />
    </div>,
    document.body,
  );
}

/** One line per live session: agent, title, state, reason, age, context %. */
function Breakdown(props: { workspaceId: string; phone?: boolean }): ReactNode {
  const lines = useBizzi((s) => selectWorkspaceBreakdown(s, props.workspaceId), breakdownEqual);
  if (lines.length === 0) return <div className="text-xs text-muted">No live sessions</div>;
  return (
    <ul className="flex flex-col gap-1.5">
      {lines.map((l) => (
        <li key={l.sessionId} style={{ paddingLeft: l.depth * 14 }}>
          {props.phone ? (
            <a href={routeHref({ name: 'session', sessionId: l.sessionId, tab: 'chat' })} className="flex min-h-11 items-center gap-2" onClick={() => navigate({ name: 'session', sessionId: l.sessionId, tab: 'chat' })}>
              <BreakdownLine line={l} />
            </a>
          ) : (
            <div className="flex items-center gap-2">
              <BreakdownLine line={l} />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function BreakdownLine(props: { line: SessionBreakdownLine }): ReactNode {
  const l = props.line;
  return (
    <>
      <AgentMark agent={l.agent} state={l.state} size={16} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs text-fg">
          <span className="text-muted">{AGENT_LABEL[l.agent]} · </span>
          {l.title}
        </span>
        <span className="block truncate text-[11px] text-muted">
          <span className={MARK_TEXT[l.state]}>{MARK_LABEL[l.state]}</span>
          {l.reason ? ` · ${l.reason}` : ''} · {formatRelative(l.updatedAt)}
          {l.context !== undefined ? ` · context ${Math.round(l.context * 100)}%` : ''}
        </span>
      </span>
    </>
  );
}

function breakdownEqual(a: SessionBreakdownLine[], b: SessionBreakdownLine[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (!x || !y || !shallowEqual(x, y)) return false;
  }
  return true;
}
