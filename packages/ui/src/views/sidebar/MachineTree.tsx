import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  breakdownEqual,
  collapsedCounts,
  contextView,
  machineSummaryEqual,
  machineTotalsLabel,
  selectMachineList,
  selectMachineSummary,
  selectEndedSessions,
  selectMachineWorkspaces,
  selectWorkspaceBreakdown,
  selectWorkspaceRow,
  shallowEqual,
  workspaceRowEqual,
  workspaceTreeEqual,
} from '@bizzi/client';
import type { ContextView, SessionBreakdownLine, WorkspaceRowModel } from '@bizzi/client';
import type { MachineInfo, SessionInfo } from '@bizzi/protocol';
import { openAddWorkspace } from '../../app/addWorkspace.ts';
import { contextMenuHandler } from '../../app/contextMenu.ts';
import { useBizzi, useStore } from '../../app/context.tsx';
import { isMac, startDefaultSession } from '../../app/hotkeys.ts';
import { reopenSessionFlow } from '../../app/sessionActions.ts';
import { navigate, useLongPress, useMediaQuery } from '../../app/hooks.ts';
import { Icon } from '../../components/icons.tsx';
import { WorkspaceTile } from '../../components/labels.tsx';
import { PresenceDot } from '../../components/MachineSwitcher.tsx';
import { AgentMark, MarkCount, MarkDot } from '../../components/marks.tsx';
import { Modal, cx } from '../../components/ui.tsx';
import { formatRelative, keepAwakeSummary } from '../../lib/format.ts';
import { HOTKEYS, hotkeyLabel } from '../../lib/hotkeys.ts';
import { LABEL_COLOR_NAME, labelVar, machineTagsLabel } from '../../lib/labels.ts';
import { routeHref } from '../../lib/router.ts';
import { AGENT_LABEL, MARK_LABEL, MARK_SYMBOL, MARK_TEXT, aheadBehind, pendingUpdatesLabel, visibleMarks } from '../../lib/states.ts';
import { groupWorkspaces, readCollapsed } from '../../lib/sidebarTree.ts';
import type { WorkspaceGroup } from '../../lib/sidebarTree.ts';
import { loadJson, saveJson } from '../../lib/storage.ts';
import { machineMenu, sessionMenu, workspaceMenu } from '../menus.ts';

type Variant = 'desktop' | 'phone';

const COLLAPSED_KEY = 'bizzi.sidebar.collapsed';
const FOLDED_KEY = 'bizzi.sidebar.folded';

/**
 * A file tree (spec §11.1): machines, their workspaces, and under each workspace its open sessions (helpers
 * under their parent), a folded "Ended (n)" group of closed sessions, and then its worktrees, with guide lines. Each session row shows its state, name and a
 * context bar. Machines and workspaces fold and remember it on this device; a folded workspace summarizes
 * its sessions as marks, an urgent line and a hover breakdown. Each machine header opens the machine's page.
 *
 * Auto width (Shell): elements marked `data-fit-ignore` (session rows, notes) don't widen the sidebar.
 */
export function MachineTree(props: {
  variant: Variant;
  activeWorkspaceId?: string | null;
  activeMachineId?: string | null;
  activeSessionId?: string | null;
  className?: string;
}): ReactNode {
  const machines = useBizzi(selectMachineList, shallowEqual);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => loadJson<Record<string, boolean>>(COLLAPSED_KEY) ?? {});
  const toggle = useCallback((id: string) => {
    setCollapsed((c) => {
      const next = { ...c, [id]: !c[id] };
      saveJson(COLLAPSED_KEY, next);
      return next;
    });
  }, []);
  const [folded, setFolded] = useState<Record<string, boolean>>(() => readCollapsed(loadJson(FOLDED_KEY)));
  const fold = useCallback((id: string) => {
    setFolded((c) => {
      const next = { ...c };
      if (next[id]) delete next[id];
      else next[id] = true;
      saveJson(FOLDED_KEY, next);
      return next;
    });
  }, []);
  if (machines.length === 0) return <div className="px-2 text-xs text-muted">No machines yet</div>;
  return (
    <div className={cx('flex flex-col gap-1', props.className)}>
      {machines.map((m) => (
        <MachineSection
          key={m.id}
          machine={m}
          variant={props.variant}
          collapsed={collapsed[m.id] ?? false}
          onToggle={toggle}
          activeWorkspaceId={props.activeWorkspaceId ?? null}
          activeSessionId={props.activeSessionId ?? null}
          folded={folded}
          onFold={fold}
          active={props.activeMachineId === m.id}
        />
      ))}
    </div>
  );
}

function MachineSection(props: {
  machine: MachineInfo;
  variant: Variant;
  collapsed: boolean;
  onToggle: (id: string) => void;
  activeWorkspaceId: string | null;
  activeSessionId: string | null;
  folded: Record<string, boolean>;
  onFold: (id: string) => void;
  active: boolean;
}): ReactNode {
  const { machine: m, variant, collapsed } = props;
  const store = useStore();
  const summary = useBizzi((s) => selectMachineSummary(s, m.id), machineSummaryEqual);
  const rows = useBizzi((s) => selectMachineWorkspaces(s, m.id), workspaceTreeEqual);
  const groups = useMemo(() => groupWorkspaces(rows), [rows]);
  const phone = variant === 'phone';
  const totals = machineTotalsLabel(summary);
  const unsupported = summary.unsupported.map((a) => AGENT_LABEL[a]).join(', ');
  const tags = machineTagsLabel(m);
  // A quiet sun while bizzi holds the machine awake (spec §8.1); the tooltip says why.
  const awake = summary.online && m.keepAwake?.active ? keepAwakeSummary(m.keepAwake) : undefined;
  return (
    <section className={cx('relative', !summary.online && 'opacity-60')}>
      {m.color ? (
        // Identity stripe (spec §11.1): the machine's color down the left edge of its whole group.
        <span aria-hidden="true" className="pointer-events-none absolute inset-y-1 left-0 z-10 w-0.5 rounded-full" style={{ backgroundColor: labelVar(m.color) }} />
      ) : null}
      <div
        onContextMenu={contextMenuHandler(() => machineMenu(store, m, { collapsed, onToggle: () => props.onToggle(m.id) }), m.name)}
        className={cx(
          'group relative flex items-center rounded-md pr-1.5',
          phone ? 'min-h-11' : 'h-8',
          props.active ? (phone ? 'bg-panel-2' : 'bg-sidebar-accent text-sidebar-accent-foreground') : phone ? 'active:bg-panel-2' : 'hover:bg-sidebar-accent/70',
        )}
      >
        <button
          type="button"
          onClick={() => props.onToggle(m.id)}
          className={cx('flex shrink-0 items-center justify-center rounded-md text-muted hover:text-fg', phone ? 'h-11 w-9' : 'h-8 w-6')}
          aria-expanded={!collapsed}
          aria-label={collapsed ? `Expand ${m.name}` : `Collapse ${m.name}`}
        >
          <Icon name={collapsed ? 'chevronRight' : 'chevronDown'} size={14} />
        </button>
        <a
          href={routeHref({ name: 'machine', machineId: m.id })}
          onClick={() => store.selectMachine(m.id)}
          className={cx('flex min-w-0 flex-1 items-center gap-1.5 self-stretch rounded-md', phone ? 'text-sm' : 'text-xs')}
          title={`Open ${m.name} (${m.hostname}${summary.online ? '' : ', offline'}${m.tags.length ? `; tags: ${m.tags.join(', ')}` : ''}${m.color ? `; ${LABEL_COLOR_NAME[m.color].toLowerCase()}` : ''})`}
          aria-current={props.active ? 'page' : undefined}
        >
          <PresenceDot online={summary.online} className="h-1.5 w-1.5" />
          <span className="min-w-0 truncate font-semibold">{m.name}</span>
          {summary.online ? null : <span className="shrink-0 font-normal text-muted">(offline)</span>}
          {awake ? (
            <span className="shrink-0 text-muted" title={awake} aria-label={awake}>
              <Icon name="sun" size={11} />
            </span>
          ) : null}
          <span className="min-w-1 flex-1" />
          {summary.unsupported.length > 0 ? (
            <span className="shrink-0 text-warn" title={`Not supported here: ${unsupported}. Open the machine for remedies.`}>
              <Icon name="alert" size={13} />
            </span>
          ) : null}
          {totals ? <span className={cx('shrink-0 text-[11px] tabular-nums', summary.waiting > 0 ? 'text-warn' : 'text-muted')}>{totals}</span> : null}
        </a>
        {phone ? null : (
          // Hover actions overlay the totals, so they never change the row's width.
          <span className="absolute top-1/2 right-1 hidden -translate-y-1/2 items-center gap-0.5 rounded-md bg-sidebar-accent pl-1 group-focus-within:flex group-hover:flex">
            <button
              type="button"
              className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-sidebar hover:text-fg disabled:opacity-40"
              title={`Add a workspace on ${m.name} (${hotkeyLabel(HOTKEYS.find((h) => h.id === 'newWorkspace')!, isMac())})`}
              aria-label={`Add a workspace on ${m.name}`}
              disabled={!summary.online}
              onClick={() => {
                store.selectMachine(m.id);
                openAddWorkspace(m.id);
              }}
            >
              <Icon name="plus" size={14} />
            </button>
            <a
              href={routeHref({ name: 'machine', machineId: m.id })}
              onClick={() => store.selectMachine(m.id)}
              className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-sidebar hover:text-fg"
              title={`${m.name}: agents and machine settings`}
              aria-label={`${m.name} settings`}
            >
              <Icon name="settings" size={14} />
            </a>
          </span>
        )}
      </div>
      {tags && !phone ? (
        <div data-fit-ignore className="-mt-1 truncate pl-7 text-[11px] text-muted" title={`Tags: ${m.tags.join(', ')}`}>
          {tags}
        </div>
      ) : null}
      {!collapsed && summary.staleSessions > 0 && !phone ? (
        <div data-fit-ignore className="truncate pl-7 text-[11px] text-muted">
          {pendingUpdatesLabel(summary.staleSessions)}
        </div>
      ) : null}
      {!collapsed ? (
        // Guide line down from the machine's chevron.
        <div className={cx('flex flex-col border-l border-sidebar-border', phone ? 'ml-[18px] pl-0.5' : 'ml-3 pl-0.5')}>
          {groups.map((g) => (
            <WorkspaceNode
              key={g.workspace.id}
              group={g}
              variant={variant}
              online={summary.online}
              activeWorkspaceId={props.activeWorkspaceId}
              activeSessionId={props.activeSessionId}
              folded={props.folded}
              onFold={props.onFold}
            />
          ))}
          {rows.length === 0 ? <div data-fit-ignore className="py-1 pl-4 text-[11px] text-muted">No workspaces</div> : null}
        </div>
      ) : null}
    </section>
  );
}

function WorkspaceNode(props: {
  group: WorkspaceGroup;
  variant: Variant;
  online: boolean;
  activeWorkspaceId: string | null;
  activeSessionId: string | null;
  folded: Record<string, boolean>;
  onFold: (id: string) => void;
}): ReactNode {
  const { group, variant, online, folded, onFold } = props;
  const w = group.workspace;
  const store = useStore();
  const row = useBizzi((s) => selectWorkspaceRow(s, w.id), workspaceRowEqual);
  // Each session sits under its own workspace only: a helper running in a worktree isn't repeated under
  // its parent's workspace (the hover breakdown still nests it there).
  const lines = useBizzi((s) => selectWorkspaceBreakdown(s, w.id).filter((l) => s.sessions[l.sessionId]?.workspaceId === w.id), breakdownEqual);
  const ended = useBizzi((s) => selectEndedSessions(s, w.id), shallowEqual);
  const git = useBizzi((s) => s.gitStatus[w.id] ?? null);
  const iconsFit = useMediaQuery('(min-width: 1024px)');
  const phone = variant === 'phone';
  const [hover, setHover] = useState<DOMRect | null>(null);
  const [sheet, setSheet] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const hasChildren = lines.length > 0 || ended.length > 0 || group.worktrees.length > 0;
  const open = hasChildren && !folded[w.id];
  const longPress = useLongPress(() => {
    if (!open) setSheet(true);
  });

  // Repo state for the row (branch, dirty) and the line under it (ahead/behind); refreshed while mounted.
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
  // Folded rows summarize their sessions: marks, the urgent line and the hover breakdown.
  const onEnter = (): void => {
    if (phone || open || row.marks.length === 0) return;
    timer.current = setTimeout(() => setHover(ref.current?.getBoundingClientRect() ?? null), 450);
  };
  const onLeave = (): void => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setHover(null);
  };
  const here = props.activeWorkspaceId === w.id;
  // The open session gets the highlight when its row is showing; otherwise its workspace does.
  const activeEnded = ended.some((x) => x.id === props.activeSessionId);
  const highlighted = here && !(open && (lines.some((l) => l.sessionId === props.activeSessionId) || activeEnded));
  const newSession = HOTKEYS.find((h) => h.id === 'newSession')!;

  return (
    <div>
      <div
        ref={ref}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        onContextMenu={contextMenuHandler(() => {
          onLeave();
          return workspaceMenu(store, w, online);
        }, w.name)}
        className={cx(
          'group relative flex items-center rounded-md pr-2',
          phone ? 'min-h-11 text-sm' : 'h-7 text-[13px]',
          highlighted ? (phone ? 'bg-panel-2' : 'bg-sidebar-accent') : phone ? 'active:bg-panel-2' : 'hover:bg-sidebar-accent/70',
          here ? 'font-medium text-fg' : 'text-fg/90',
        )}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => onFold(w.id)}
            className={cx('flex shrink-0 items-center justify-center self-stretch rounded text-muted hover:text-fg', phone ? 'w-7' : 'w-[18px]')}
            aria-expanded={open}
            aria-label={open ? `Collapse ${w.name}` : `Expand ${w.name}`}
          >
            <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
          </button>
        ) : (
          <span className={cx('shrink-0', phone ? 'w-7' : 'w-[18px]')} />
        )}
        <a
          href={routeHref({ name: 'workspace', workspaceId: w.id })}
          className="flex min-w-0 flex-1 items-center gap-2 self-stretch"
          title={w.path}
          aria-current={highlighted ? 'page' : undefined}
          {...(phone ? longPress : {})}
        >
          <WorkspaceTile workspace={w} />
          <span className="min-w-[4.5rem] truncate">{w.kind === 'worktree' && w.branch ? w.branch : w.name}</span>
          {branch && w.kind !== 'worktree' ? (
            <span className="min-w-0 shrink-[4] truncate font-mono text-[11px] font-normal text-muted">
              {branch}
              {git?.dirty ? '*' : ''}
            </span>
          ) : w.kind === 'worktree' && git?.dirty ? (
            <span className="font-mono text-[11px] text-muted">*</span>
          ) : null}
          <span className="flex-1" />
          {open ? null : <Marks row={row} variant={variant} dots={!phone && !iconsFit} />}
        </a>
        {phone ? null : (
          // Overlays the marks on hover, so it never changes the row's width.
          <span className="absolute top-1/2 right-1 hidden -translate-y-1/2 items-center rounded-md bg-sidebar-accent pl-1 group-focus-within:flex group-hover:flex">
            <button
              type="button"
              className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-sidebar hover:text-fg disabled:opacity-40"
              title={`New session in ${w.name}, default profile (${hotkeyLabel(newSession, isMac())})`}
              aria-label={`New session in ${w.name}`}
              disabled={!online}
              onClick={() => void startDefaultSession(store, w.id)}
            >
              <Icon name="plus" size={14} />
            </button>
          </span>
        )}
      </div>
      {!open && row.urgent ? (
        <a
          data-fit-ignore
          href={routeHref({ name: 'session', sessionId: row.urgent.sessionId, tab: 'chat' })}
          className={cx('flex items-center gap-1.5 truncate rounded-md pr-2 pl-10 text-xs text-muted hover:text-fg', phone ? 'min-h-11 hover:bg-panel-2' : 'h-6 hover:bg-sidebar-accent/70')}
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
      {!phone && ab ? <div data-fit-ignore className="h-5 truncate pl-10 font-mono text-[11px] leading-5 text-muted">{ab}</div> : null}
      {open ? (
        // The guide line runs down from the chevron; sessions first, then the repo's worktrees.
        <div className={cx('flex flex-col border-l border-sidebar-border', phone ? 'ml-3.5 pl-1' : 'ml-[9px] pl-0.5')}>
          {lines.length > 0 ? (
            <div data-fit-ignore className="flex flex-col">
              {lines.map((l) => (
                <SessionLeaf key={l.sessionId} line={l} phone={phone} online={online} active={props.activeSessionId === l.sessionId} />
              ))}
            </div>
          ) : null}
          {ended.length > 0 ? <EndedGroup sessions={ended} phone={phone} online={online} activeSessionId={props.activeSessionId} /> : null}
          {group.worktrees.map((t) => (
            <WorkspaceNode
              key={t.id}
              group={{ workspace: t, worktrees: [] }}
              variant={variant}
              online={online}
              activeWorkspaceId={props.activeWorkspaceId}
              activeSessionId={props.activeSessionId}
              folded={folded}
              onFold={onFold}
            />
          ))}
        </div>
      ) : null}
      {hover ? <BreakdownPopover workspaceId={w.id} rect={hover} /> : null}
      {sheet ? (
        <Modal title={w.name} onClose={() => setSheet(false)}>
          <Breakdown workspaceId={w.id} phone />
        </Modal>
      ) : null}
    </div>
  );
}

/** One live session: its state, name and context bar; why it waits or failed, or what runs in the background, on a second line. */
function SessionLeaf(props: { line: SessionBreakdownLine; phone: boolean; online: boolean; active: boolean }): ReactNode {
  const { line: l, phone } = props;
  const store = useStore();
  const ctx = contextView(l.contextUsage);
  const reason = l.reason && (l.state === 'waiting' || l.state === 'failed' || l.state === 'background') ? l.reason : null;
  const title = `${AGENT_LABEL[l.agent]} · ${l.title} · ${MARK_LABEL[l.state]}${ctx.known ? ` · context ${ctx.label}` : ''}${reason ? `\n${reason}` : ''}`;
  return (
    <a
      href={routeHref({ name: 'session', sessionId: l.sessionId, tab: 'chat' })}
      onContextMenu={contextMenuHandler(() => {
        const s = store.getState().sessions[l.sessionId];
        return s ? sessionMenu(store, s, props.online) : [];
      }, l.title)}
      className={cx(
        'block rounded-md pr-2',
        props.active ? (phone ? 'bg-panel-2 font-medium text-fg' : 'bg-sidebar-accent font-medium text-sidebar-accent-foreground') : phone ? 'text-fg/85 active:bg-panel-2' : 'text-fg/85 hover:bg-sidebar-accent/70',
      )}
      style={{ paddingLeft: 6 + l.depth * 12 }}
      title={title}
      aria-current={props.active ? 'page' : undefined}
    >
      <span className={cx('flex items-center gap-1.5', phone ? 'min-h-11 text-sm' : 'h-7 text-[13px]')}>
        <AgentMark agent={l.agent} state={l.state} size={phone ? 18 : 14} title={`${AGENT_LABEL[l.agent]} · ${MARK_LABEL[l.state]}`} />
        {l.mode === 'terminal' ? <Icon name="terminal" size={12} className="shrink-0 text-muted" /> : null}
        <span className="min-w-0 flex-1 truncate">{l.title}</span>
        {ctx.known ? <ContextBar view={ctx} /> : null}
      </span>
      {reason ? <span className={cx('-mt-1 block truncate pb-1 text-[11px]', l.state === 'background' ? 'text-muted' : MARK_TEXT[l.state])} style={{ paddingLeft: phone ? 24 : 20 }}>{reason}</span> : null}
    </a>
  );
}

/**
 * A workspace's ended sessions, folded to one muted "Ended (n)" line (opened while one of them is open).
 * Each row opens the session to read it; its button (or right-click › Reopen) lets it take messages again.
 */
function EndedGroup(props: { sessions: SessionInfo[]; phone: boolean; online: boolean; activeSessionId: string | null }): ReactNode {
  const { sessions, phone } = props;
  const store = useStore();
  const holdsActive = sessions.some((x) => x.id === props.activeSessionId);
  const [shown, setShown] = useState(false);
  const open = shown || holdsActive;
  return (
    <div data-fit-ignore className="flex flex-col">
      <button
        type="button"
        onClick={() => setShown(!open)}
        className={cx('flex items-center gap-1 rounded-md pr-2 pl-1.5 text-left text-[11px] text-muted hover:text-fg', phone ? 'min-h-11 active:bg-panel-2' : 'h-6 hover:bg-sidebar-accent/70')}
        aria-expanded={open}
        title={open ? 'Hide ended sessions' : 'Show ended sessions: read them, or reopen one to take messages again'}
      >
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={11} />
        <span>Ended ({sessions.length})</span>
      </button>
      {open
        ? sessions.map((x) => {
            const title = x.title || 'Untitled session';
            const active = props.activeSessionId === x.id;
            return (
              <div
                key={x.id}
                onContextMenu={contextMenuHandler(() => sessionMenu(store, x, props.online), title)}
                className={cx(
                  'group relative flex items-center rounded-md',
                  active ? (phone ? 'bg-panel-2 text-fg' : 'bg-sidebar-accent text-sidebar-accent-foreground') : phone ? 'text-muted active:bg-panel-2' : 'text-muted hover:bg-sidebar-accent/70 hover:text-fg',
                )}
              >
                <a
                  href={routeHref({ name: 'session', sessionId: x.id, tab: 'chat' })}
                  className={cx('flex min-w-0 flex-1 items-center gap-1.5 pr-2 pl-[18px]', phone ? 'min-h-11 text-sm' : 'h-7 text-[13px]')}
                  title={`${AGENT_LABEL[x.agent]} · ${title} · ended ${formatRelative(x.updatedAt)}`}
                  aria-current={active ? 'page' : undefined}
                >
                  {x.mode === 'terminal' ? <Icon name="terminal" size={12} className="shrink-0" /> : null}
                  <span className="min-w-0 flex-1 truncate">{title}</span>
                  <span className="shrink-0 text-[10px] tabular-nums">{formatRelative(x.updatedAt)}</span>
                </a>
                <button
                  type="button"
                  className={cx(
                    'flex shrink-0 items-center justify-center rounded text-muted hover:bg-sidebar hover:text-fg disabled:opacity-40',
                    phone ? 'h-11 w-9' : 'absolute top-1/2 right-1 hidden h-6 w-6 -translate-y-1/2 bg-sidebar-accent group-focus-within:flex group-hover:flex',
                  )}
                  title={`Reopen ${title}: it takes messages again`}
                  aria-label={`Reopen ${title}`}
                  disabled={!props.online}
                  onClick={() => void reopenSessionFlow(store, x, { open: true })}
                >
                  <Icon name="refresh" size={13} />
                </button>
              </div>
            );
          })
        : null}
    </div>
  );
}

/**
 * How full the session's context window is, read exactly like the session header's bar (`contextView`):
 * the fill is the share of the usable window, the number the share of the whole window.
 */
function ContextBar(props: { view: Extract<ContextView, { known: true }> }): ReactNode {
  const v = props.view;
  const pct = Math.round(v.pct * 100);
  return (
    <span className="flex shrink-0 items-center gap-1" role="meter" aria-label={`Context ${v.label}`} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <span className="relative h-1 w-8 overflow-hidden rounded-full bg-sidebar-border">
        <span className={cx('absolute inset-y-0 left-0 rounded-full', v.tone === 'err' ? 'bg-err' : v.tone === 'warn' ? 'bg-warn' : 'bg-accent')} style={{ width: `${Math.max(Math.round(v.fill * 100), 4)}%` }} />
      </span>
      <span className={cx('w-7 text-right text-[10px] font-normal tabular-nums', v.tone === 'neutral' ? 'text-muted' : v.tone === 'warn' ? 'text-warn' : 'text-err')}>{pct}%</span>
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
