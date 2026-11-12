import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode, RefObject } from 'react';
import { selectKnowledgeSuggestionCount, selectMachineList, selectWaitingCount } from '@bizzi/client';
import { openAddWorkspace } from '../app/addWorkspace.ts';
import { useBizzi, useBizziContext } from '../app/context.tsx';
import { navigate, useIsWide, useRoute, useTheme } from '../app/hooks.ts';
import type { ThemePref } from '../app/hooks.ts';
import { useTargetMachineId } from '../app/machine.ts';
import { sidebarStore, useSidebarPref } from '../app/sidebar.ts';
import { useServerThemes } from '../app/theme.ts';
import { Icon } from '../components/icons.tsx';
import type { IconName } from '../components/icons.tsx';
import { Button, Spinner, cx } from '../components/ui.tsx';
import { pickerRequestFromHash } from '../lib/picker.ts';
import { desktopRedirect, routeHref } from '../lib/router.ts';
import type { Route } from '../lib/router.ts';
import { SIDEBAR_MIN, keyWidth, manualMax, clampManual, sidebarWidth } from '../lib/sidebarWidth.ts';
import { AddWorkspaceDialog } from './AddWorkspaceDialog.tsx';
import { Logo } from './ConnectScreen.tsx';
import { InboxView } from './InboxView.tsx';
import { MachinesView } from './MachinesView.tsx';
import { MachineView } from './MachineView.tsx';
import { WorkspaceView } from './WorkspaceView.tsx';
import { WorkspacesView } from './WorkspacesView.tsx';
import { MachineTree } from './sidebar/MachineTree.tsx';
import { UsageBar } from './usage/Usage.tsx';

const SessionView = lazy(() => import('./session/SessionView.tsx').then((m) => ({ default: m.SessionView })));
const LoginView = lazy(() => import('./provision/LoginView.tsx').then((m) => ({ default: m.LoginView })));
const KnowledgeView = lazy(() => import('./knowledge/KnowledgeView.tsx').then((m) => ({ default: m.KnowledgeView })));
const FanoutView = lazy(() => import('./fanout/FanoutView.tsx').then((m) => ({ default: m.FanoutView })));
const SettingsView = lazy(() => import('./settings/SettingsView.tsx').then((m) => ({ default: m.SettingsView })));

export function Shell(props: { onFatal: (message: string) => void }): ReactNode {
  const { store } = useBizziContext();
  const conn = useBizzi((s) => s.connection);
  const route = useRoute();
  const wide = useIsWide();
  const target = useTargetMachineId();
  const firstMachine = useBizzi((s) => selectMachineList(s)[0]?.id ?? null);
  const { onFatal } = props;

  // Theme choice and custom themes come from the server (theming.md §5).
  useServerThemes(store, conn.state === 'open');

  useEffect(() => {
    if (conn.state === 'closed' && conn.lastError) onFatal(conn.lastError.message);
  }, [conn.state, conn.lastError, onFatal]);

  // `#/workspaces?add=1[&machine=…][&path=…]` opens the workspace picker, wherever the page lands.
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash, () => '');
  const addRequest = useMemo(() => pickerRequestFromHash(hash), [hash]);

  // Desktop: the sidebar is the tree, so the list pages open the machine page instead.
  const redirect = desktopRedirect(route, wide, addRequest?.machineId ?? target ?? firstMachine);
  const redirectHref = redirect ? routeHref(redirect) : null;
  useEffect(() => {
    if (!addRequest) return;
    openAddWorkspace(addRequest.machineId ?? null, addRequest.path);
    // Drop the query so closing the picker (or a reload) doesn't reopen it.
    if (!redirect) navigate(route, { replace: true });
  }, [hash]);
  useEffect(() => {
    if (redirect) navigate(redirect, { replace: true });
  }, [redirectHref]);
  const shown = redirect ?? route;

  const fullScreen = shown.name === 'session' || shown.name === 'login';

  if (conn.state === 'connecting' && conn.sessions === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted">
        <Spinner size={22} />
        <div className="text-sm">Connecting to {conn.url}…</div>
      </div>
    );
  }

  const main = (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center text-muted">
          <Spinner />
        </div>
      }
    >
      <RouteView route={shown} />
    </Suspense>
  );

  if (wide) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex min-h-0 flex-1">
          <Sidebar route={shown} />
          <main className="flex min-w-0 flex-1 flex-col">
            <ConnectionBanner />
            <div className="min-h-0 flex-1">{main}</div>
          </main>
        </div>
        <UsageBar />
        <AddWorkspaceDialog />
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col">
      <ConnectionBanner />
      <div className="min-h-0 flex-1">{main}</div>
      {fullScreen ? null : <BottomNav route={shown} />}
      <AddWorkspaceDialog />
    </div>
  );
}

function subscribeHash(cb: () => void): () => void {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
}

function RouteView(props: { route: Route }): ReactNode {
  const r = props.route;
  switch (r.name) {
    case 'machines':
      return <MachinesView />;
    case 'machine':
      return <MachineView key={r.machineId ?? 'selected'} {...(r.machineId ? { machineId: r.machineId } : {})} />;
    case 'workspaces':
      return <WorkspacesView />;
    case 'workspace':
      return <WorkspaceView workspaceId={r.workspaceId} />;
    case 'session':
      return <SessionView key={r.sessionId} sessionId={r.sessionId} tab={r.tab} />;
    case 'fanout':
      return <FanoutView key={r.group} group={r.group} />;
    case 'login':
      return <LoginView key={r.sessionId} sessionId={r.sessionId} />;
    case 'inbox':
      return <InboxView />;
    case 'knowledge':
      return <KnowledgeView />;
    case 'settings':
      return <SettingsView section={r.section} />;
  }
}

/** Inbox badge: sessions waiting on you across every machine (spec §11.1). */
function useInboxCount(): number {
  return useBizzi(selectWaitingCount);
}

function ConnectionBanner(): ReactNode {
  const { client } = useBizziContext();
  const conn = useBizzi((s) => s.connection);
  const [, tick] = useState(0);
  useEffect(() => {
    if (conn.state !== 'reconnecting') return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [conn.state]);
  if (conn.state !== 'reconnecting') return null;
  const secs = conn.nextRetryAt ? Math.max(0, Math.ceil((conn.nextRetryAt - Date.now()) / 1000)) : 0;
  return (
    <div className="flex items-center gap-2 border-b border-warn/30 bg-warn/10 px-3 py-1.5 text-xs text-warn">
      <Spinner size={12} />
      <span className="min-w-0 flex-1 truncate">
        {conn.sessions > 0 ? 'Connection lost' : 'Cannot reach the server'}
        {conn.lastError ? ` (${conn.lastError.message})` : ''}. Retrying{secs > 0 ? ` in ${secs}s` : '…'}
      </span>
      <button type="button" className="font-medium underline-offset-2 hover:underline" onClick={() => client.reconnectNow()}>
        Retry now
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- desktop sidebar

/** The window's width, updated at most once per frame. */
function useWindowWidth(): number {
  const [w, setW] = useState(() => window.innerWidth);
  useEffect(() => {
    let raf = 0;
    const onResize = (): void => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setW(window.innerWidth);
      });
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      cancelAnimationFrame(raf);
    };
  }, []);
  return w;
}

/** Horizontal space around the tree inside the sidebar (padding, border, a thin scrollbar). */
const TREE_CHROME = 18;

/**
 * Natural width of the tree: a hidden, max-content copy laid out once, without the rows that never widen
 * the sidebar (rows 2 and 3). Truncated names count at full width, spacers at zero.
 */
function measureTree(el: HTMLElement): number {
  const parent = el.parentElement;
  if (!parent) return 0;
  const copy = el.cloneNode(true) as HTMLElement;
  for (const n of copy.querySelectorAll('[data-fit-ignore]')) n.remove();
  copy.removeAttribute('id');
  copy.setAttribute('aria-hidden', 'true');
  copy.style.cssText = 'position:fixed;left:-10000px;top:0;width:max-content;visibility:hidden;pointer-events:none;contain:layout style';
  parent.appendChild(copy);
  const w = copy.getBoundingClientRect().width;
  copy.remove();
  return Math.ceil(w);
}

/** The tree's natural width while `enabled`, re-measured (once per frame at most) when the tree changes. */
function useTreeWidth(ref: RefObject<HTMLElement | null>, enabled: boolean): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    let raf = 0;
    const measure = (): void => {
      raf = 0;
      const w = measureTree(el);
      setWidth((prev) => (prev === w ? prev : w));
    };
    const schedule = (): void => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    const mo = new MutationObserver(schedule);
    mo.observe(el, { subtree: true, childList: true, characterData: true });
    // Web fonts change text widths once they load.
    void document.fonts?.ready.then(schedule);
    measure();
    return () => {
      mo.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [ref, enabled]);
  return width;
}

function Sidebar(props: { route: Route }): ReactNode {
  const { disconnect, target } = useBizziContext();
  const conn = useBizzi((s) => s.connection.state);
  const role = useBizzi((s) => s.role);
  const hubName = useBizzi((s) => (s.role === 'hub' ? (s.machine?.name ?? null) : null));
  const selected = useTargetMachineId();
  const activeWs = useBizzi((s) =>
    props.route.name === 'workspace' ? props.route.workspaceId : props.route.name === 'session' ? (s.sessions[props.route.sessionId]?.workspaceId ?? null) : null,
  );
  const activeMachine = props.route.name === 'machine' ? (props.route.machineId ?? selected) : null;
  const status = conn === 'open' ? (target.source === 'mock' ? `mock ${role ?? ''}` : role === 'hub' ? `hub${hubName ? ` · ${hubName}` : ''}` : 'connected') : conn;

  const pref = useSidebarPref();
  const windowWidth = useWindowWidth();
  const treeRef = useRef<HTMLDivElement>(null);
  const natural = useTreeWidth(treeRef, pref.mode === 'auto');
  const width = sidebarWidth(pref, natural === null ? null : natural + TREE_CHROME, windowWidth);

  return (
    <aside className="relative flex shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground" style={{ width }} data-sidebar>
      <div className="flex items-center gap-2 px-3 pt-3 pb-2">
        <Logo size={24} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">bizzi</div>
          <div className="flex items-center gap-1.5 text-[11px] text-muted">
            <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', conn === 'open' ? 'bg-ok' : conn === 'reconnecting' ? 'bg-warn' : 'bg-muted')} />
            <span className="truncate">{status}</span>
          </div>
        </div>
        <HeaderNav route={props.route} />
      </div>
      <div className="scrollbar-thin flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto border-t border-sidebar-border px-1 pt-2 pb-2">
        <div ref={treeRef}>
          <MachineTree variant="desktop" activeWorkspaceId={activeWs} activeMachineId={activeMachine} />
        </div>
      </div>
      <div className="flex items-center gap-1 border-t border-sidebar-border px-2 py-2">
        <ThemeToggle />
        <div className="flex-1" />
        <Button variant="ghost" size="sm" icon="logout" onClick={disconnect}>
          {target.source === 'mock' ? 'Exit demo' : 'Disconnect'}
        </Button>
      </div>
      <ResizeHandle width={width} windowWidth={windowWidth} auto={pref.mode === 'auto'} />
    </aside>
  );
}

const HEADER_NAV: { route: Route; label: string; icon: IconName; match: Route['name'][] }[] = [
  { route: { name: 'inbox' }, label: 'Inbox', icon: 'inbox', match: ['inbox'] },
  { route: { name: 'knowledge' }, label: 'Knowledge', icon: 'book', match: ['knowledge'] },
  { route: { name: 'settings', section: 'general' }, label: 'Settings', icon: 'settings', match: ['settings'] },
];

/** Inbox, Knowledge and Settings as compact icon buttons; the tree below is the navigation. */
function HeaderNav(props: { route: Route }): ReactNode {
  const inbox = useInboxCount();
  const suggestions = useBizzi(selectKnowledgeSuggestionCount);
  return (
    <nav className="flex shrink-0 items-center gap-0.5" aria-label="Main">
      {HEADER_NAV.map((n) => {
        const active = n.match.includes(props.route.name);
        const badge = n.label === 'Inbox' ? inbox : n.label === 'Knowledge' ? suggestions : 0;
        const title = n.label === 'Inbox' && inbox > 0 ? `Inbox: ${inbox} waiting` : n.label === 'Knowledge' && suggestions > 0 ? `Knowledge: ${suggestions} suggestions to review` : n.label;
        return (
          <a
            key={n.label}
            href={routeHref(n.route)}
            title={title}
            aria-label={title}
            aria-current={active ? 'page' : undefined}
            className={cx(
              'relative flex h-8 w-8 items-center justify-center rounded-md',
              active ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'text-muted hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
            )}
          >
            <Icon name={n.icon} size={17} />
            {badge > 0 ? (
              <span
                className={cx(
                  'absolute -top-0.5 -right-0.5 min-w-4 rounded-full px-1 text-center text-[10px] leading-4 font-semibold tabular-nums',
                  n.label === 'Inbox' ? 'bg-warn text-white dark:text-black' : 'bg-panel-2 text-muted ring-1 ring-sidebar-border',
                )}
              >
                {badge > 99 ? '99+' : badge}
              </span>
            ) : null}
          </a>
        );
      })}
    </nav>
  );
}

/**
 * The sidebar's right edge: drag to resize (manual width), double-click or the context menu's "Fit
 * automatically" to return to auto. Focusable: arrow keys resize (Shift: larger steps), Home/End jump to the
 * limits, Enter fits automatically. During a drag the width is written to the DOM directly and committed once
 * on release, so nothing re-renders per pointer event.
 */
function ResizeHandle(props: { width: number; windowWidth: number; auto: boolean }): ReactNode {
  const { width, windowWidth, auto } = props;
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startX: number; startW: number; w: number; id: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const aside = (): HTMLElement | null => ref.current?.closest('[data-sidebar]') ?? null;

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startW: width, w: width, id: e.pointerId };
    setDragging(true);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const w = clampManual(d.startW + e.clientX - d.startX, window.innerWidth);
    if (w === d.w) return;
    d.w = w;
    const el = aside();
    if (el) el.style.width = `${w}px`;
    ref.current?.setAttribute('aria-valuenow', String(w));
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (d.w !== d.startW) sidebarStore.setWidth(d.w);
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sidebarStore.setAuto(true);
      return;
    }
    const w = keyWidth(e.key, e.shiftKey, width, windowWidth);
    if (w === null) return;
    e.preventDefault();
    sidebarStore.setWidth(w);
  };

  return (
    <>
      <div
        ref={ref}
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize sidebar${auto ? ' (fits automatically)' : ''}`}
        aria-valuemin={SIDEBAR_MIN}
        aria-valuemax={manualMax(windowWidth)}
        aria-valuenow={width}
        tabIndex={0}
        title="Drag to resize · double-click to fit automatically · right-click for options"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => sidebarStore.setAuto(true)}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        className="group absolute top-0 -right-1.5 bottom-0 z-20 w-3 cursor-col-resize touch-none outline-none"
      >
        <span
          className={cx(
            'absolute top-0 bottom-0 left-1/2 w-0.5 -translate-x-1/2 transition-colors',
            dragging ? 'bg-accent' : 'bg-transparent group-hover:bg-accent/60 group-focus-visible:bg-accent',
          )}
        />
      </div>
      {menu ? <HandleMenu x={menu.x} y={menu.y} auto={auto} width={width} onClose={() => setMenu(null)} /> : null}
    </>
  );
}

function HandleMenu(props: { x: number; y: number; auto: boolean; width: number; onClose: () => void }): ReactNode {
  const { onClose } = props;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    ref.current?.querySelector('button')?.focus();
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  const pick = useCallback(
    (fn: () => void) => () => {
      fn();
      onClose();
    },
    [onClose],
  );
  return (
    <div ref={ref} role="menu" className="fixed z-50 w-52 rounded-md border border-border bg-panel p-1 text-sm shadow-lg" style={{ left: props.x + 4, top: props.y }}>
      <button type="button" role="menuitemcheckbox" aria-checked={props.auto} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-panel-2" onClick={pick(() => sidebarStore.setAuto(!props.auto, props.width))}>
        <span className="flex w-4 justify-center">{props.auto ? <Icon name="check" size={14} /> : null}</span>
        Fit automatically
      </button>
    </div>
  );
}

export function ThemeToggle(): ReactNode {
  const [pref, setPref] = useTheme();
  const next: Record<ThemePref, ThemePref> = { system: 'light', light: 'dark', dark: 'system' };
  const icon: IconName = pref === 'dark' ? 'moon' : pref === 'light' ? 'sun' : 'machine';
  return (
    <Button variant="ghost" size="sm" icon={icon} onClick={() => setPref(next[pref])} title="Light or dark, on this device">
      {pref === 'system' ? 'Auto' : pref === 'light' ? 'Light' : 'Dark'}
    </Button>
  );
}

// ---------------------------------------------------------------- phone

const PHONE_NAV: { route: Route; label: string; icon: IconName; match: Route['name'][] }[] = [
  { route: { name: 'machines' }, label: 'Machines', icon: 'machine', match: ['machines', 'machine', 'login', 'workspaces', 'workspace', 'session', 'fanout'] },
  { route: { name: 'inbox' }, label: 'Inbox', icon: 'inbox', match: ['inbox'] },
  { route: { name: 'knowledge' }, label: 'Knowledge', icon: 'book', match: ['knowledge'] },
  { route: { name: 'settings', section: 'general' }, label: 'Settings', icon: 'settings', match: ['settings'] },
];

function BottomNav(props: { route: Route }): ReactNode {
  const inbox = useInboxCount();
  const suggestions = useBizzi(selectKnowledgeSuggestionCount);
  return (
    <nav className="pb-safe flex shrink-0 border-t border-border bg-panel">
      {PHONE_NAV.map((n) => {
        const active = n.match.includes(props.route.name);
        const badge = n.label === 'Inbox' ? inbox : n.label === 'Knowledge' ? suggestions : 0;
        return (
          <button
            key={n.label}
            type="button"
            onClick={() => navigate(n.route)}
            aria-current={active ? 'page' : undefined}
            className={cx('relative flex h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px]', active ? 'text-accent-text' : 'text-muted')}
          >
            <Icon name={n.icon} size={20} />
            {n.label}
            {badge > 0 ? (
              <span className={cx('absolute top-1.5 left-1/2 ml-2 rounded-full px-1.5 text-[10px] font-semibold', n.label === 'Inbox' ? 'bg-warn text-white dark:text-black' : 'bg-panel-2 text-muted')}>{badge}</span>
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}
