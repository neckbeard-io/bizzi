import { Suspense, lazy, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { selectKnowledgeSuggestionCount, selectWaitingCount } from '@bizzi/client';
import { useBizzi, useBizziContext } from '../app/context.tsx';
import { navigate, useIsWide, useRoute, useTheme } from '../app/hooks.ts';
import type { ThemePref } from '../app/hooks.ts';
import { Icon } from '../components/icons.tsx';
import type { IconName } from '../components/icons.tsx';
import { Button, Spinner, cx } from '../components/ui.tsx';
import { routeHref } from '../lib/router.ts';
import type { Route } from '../lib/router.ts';
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
const SettingsView = lazy(() => import('./settings/SettingsView.tsx').then((m) => ({ default: m.SettingsView })));

export function Shell(props: { onFatal: (message: string) => void }): ReactNode {
  const conn = useBizzi((s) => s.connection);
  const route = useRoute();
  const wide = useIsWide();
  const { onFatal } = props;

  useEffect(() => {
    if (conn.state === 'closed' && conn.lastError) onFatal(conn.lastError.message);
  }, [conn.state, conn.lastError, onFatal]);

  const fullScreen = route.name === 'session' || route.name === 'login';

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
      <RouteView route={route} />
    </Suspense>
  );

  if (wide) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex min-h-0 flex-1">
          <Sidebar route={route} />
          <main className="flex min-w-0 flex-1 flex-col">
            <ConnectionBanner />
            <div className="min-h-0 flex-1">{main}</div>
          </main>
        </div>
        <UsageBar />
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col">
      <ConnectionBanner />
      <div className="min-h-0 flex-1">{main}</div>
      {fullScreen ? null : <BottomNav route={route} />}
    </div>
  );
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

const NAV: { route: Route; label: string; short?: string; icon: IconName; match: Route['name'][] }[] = [
  { route: { name: 'machine' }, label: 'Machine', icon: 'machine', match: ['machine', 'machines', 'login'] },
  { route: { name: 'workspaces' }, label: 'Workspaces', short: 'Work', icon: 'folder', match: ['workspaces', 'workspace', 'session'] },
  { route: { name: 'inbox' }, label: 'Inbox', icon: 'inbox', match: ['inbox'] },
  { route: { name: 'knowledge' }, label: 'Knowledge', short: 'Memory', icon: 'book', match: ['knowledge'] },
  { route: { name: 'settings', section: 'general' }, label: 'Settings', icon: 'settings', match: ['settings'] },
];

function Sidebar(props: { route: Route }): ReactNode {
  const { disconnect, target } = useBizziContext();
  const conn = useBizzi((s) => s.connection.state);
  const role = useBizzi((s) => s.role);
  const hubName = useBizzi((s) => (s.role === 'hub' ? (s.machine?.name ?? null) : null));
  const inbox = useInboxCount();
  const suggestions = useBizzi(selectKnowledgeSuggestionCount);
  const activeWs = useBizzi((s) =>
    props.route.name === 'workspace' ? props.route.workspaceId : props.route.name === 'session' ? (s.sessions[props.route.sessionId]?.workspaceId ?? null) : null,
  );
  const status = conn === 'open' ? (target.source === 'mock' ? `mock ${role ?? ''}` : role === 'hub' ? `hub${hubName ? ` · ${hubName}` : ''}` : 'connected') : conn;
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-panel lg:w-72">
      <div className="flex items-center gap-2 px-3 pt-3 pb-2">
        <Logo size={24} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">bizzi</div>
          <div className="flex items-center gap-1.5 text-[11px] text-muted">
            <span className={cx('h-1.5 w-1.5 rounded-full', conn === 'open' ? 'bg-ok' : conn === 'reconnecting' ? 'bg-warn' : 'bg-muted')} />
            <span className="truncate">{status}</span>
          </div>
        </div>
      </div>
      <nav className="flex flex-col gap-0.5 px-2">
        {NAV.map((n) => (
          <a
            key={n.label}
            href={routeHref(n.route)}
            className={cx(
              'flex h-8 items-center gap-2 rounded-md px-2 text-sm',
              n.match.includes(props.route.name) && !(n.label === 'Workspaces' && activeWs) ? 'bg-panel-2 font-medium' : 'text-muted hover:bg-panel-2 hover:text-fg',
            )}
          >
            <Icon name={n.icon} />
            <span className="flex-1">{n.label}</span>
            {n.label === 'Inbox' && inbox > 0 ? <span className="rounded-full bg-warn px-1.5 text-[11px] font-semibold text-white dark:text-black">{inbox}</span> : null}
            {n.label === 'Knowledge' && suggestions > 0 ? (
              <span className="rounded-full bg-panel-2 px-1.5 text-[11px] font-semibold text-muted" title="suggestions to review">
                {suggestions}
              </span>
            ) : null}
          </a>
        ))}
      </nav>
      <div className="scrollbar-thin mt-3 flex min-h-0 flex-1 flex-col overflow-y-auto border-t border-border px-1 pt-2 pb-2">
        <MachineTree variant="desktop" activeWorkspaceId={activeWs} />
      </div>
      <div className="flex items-center gap-1 border-t border-border px-2 py-2">
        <ThemeToggle />
        <div className="flex-1" />
        <Button variant="ghost" size="sm" icon="logout" onClick={disconnect}>
          {target.source === 'mock' ? 'Exit demo' : 'Disconnect'}
        </Button>
      </div>
    </aside>
  );
}

export function ThemeToggle(): ReactNode {
  const [pref, setPref] = useTheme();
  const next: Record<ThemePref, ThemePref> = { system: 'light', light: 'dark', dark: 'system' };
  const icon: IconName = pref === 'dark' ? 'moon' : pref === 'light' ? 'sun' : 'settings';
  return (
    <Button variant="ghost" size="sm" icon={icon} onClick={() => setPref(next[pref])} title="Theme">
      {pref === 'system' ? 'Auto' : pref === 'light' ? 'Light' : 'Dark'}
    </Button>
  );
}

function BottomNav(props: { route: Route }): ReactNode {
  const inbox = useInboxCount();
  return (
    <nav className="pb-safe flex shrink-0 border-t border-border bg-panel">
      {NAV.map((n) => {
        const active = n.match.includes(props.route.name);
        return (
          <button
            key={n.label}
            type="button"
            onClick={() => navigate(n.route)}
            className={cx('relative flex h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px]', active ? 'text-accent' : 'text-muted')}
          >
            <Icon name={n.icon} size={20} />
            {n.short ?? n.label}
            {n.label === 'Inbox' && inbox > 0 ? (
              <span className="absolute top-1.5 left-1/2 ml-2 rounded-full bg-warn px-1.5 text-[10px] font-semibold text-white dark:text-black">{inbox}</span>
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}
