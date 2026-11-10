import { Suspense, lazy, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { selectSessionPrompt } from '@bizzi/client';
import type { SessionStatus } from '@bizzi/protocol';
import { useBizzi, useStore } from '../../app/context.tsx';
import { navigate, useAction, useMediaQuery } from '../../app/hooks.ts';
import { useMachine, useMachineOnline } from '../../app/machine.ts';
import { Icon } from '../../components/icons.tsx';
import { PageHeader } from '../../components/layout.tsx';
import { Button, Empty, ErrorText, IconButton, Spinner, StatusBadge, Tabs, cx } from '../../components/ui.tsx';
import { STATUS_LABEL, machinePresence } from '../../lib/format.ts';
import { statusSourceLabel } from '../../lib/states.ts';
import type { SessionTab } from '../../lib/router.ts';
import { Composer } from './Composer.tsx';
import { HelperTree } from './HelperTree.tsx';
import { PlanPanel } from './PlanPanel.tsx';
import { SessionControls } from './SessionControls.tsx';
import { SessionHeaderBar } from './SessionHeaderBar.tsx';
import { Timeline } from './Timeline.tsx';

// Heavy, rarely-first panels load on demand.
const TerminalView = lazy(() => import('./TerminalView.tsx').then((m) => ({ default: m.TerminalView })));
const FilesPanel = lazy(() => import('./FilesPanel.tsx').then((m) => ({ default: m.FilesPanel })));
const GitPanel = lazy(() => import('./GitPanel.tsx').then((m) => ({ default: m.GitPanel })));

type SideTab = Exclude<SessionTab, 'chat'>;

const Loading = (): ReactNode => (
  <div className="flex h-full items-center justify-center text-muted">
    <Spinner />
  </div>
);

export function SessionView(props: { sessionId: string; tab: SessionTab }): ReactNode {
  const { sessionId } = props;
  const store = useStore();
  const session = useBizzi((s) => s.sessions[sessionId] ?? null);
  const sessionsLoaded = useBizzi((s) => s.sessionsLoaded);
  const status = useBizzi((s) => s.timelines[sessionId]?.status ?? s.sessions[sessionId]?.status ?? null);
  const prompt = useBizzi((s) => selectSessionPrompt(s, sessionId));
  const statusSource = useBizzi((s) => s.timelines[sessionId]?.statusSource);
  const statusReason = useBizzi((s) => s.timelines[sessionId]?.statusReason);
  const lastSeq = useBizzi((s) => s.timelines[sessionId]?.lastSeq ?? 0);
  const canFork = useBizzi((s) => s.capabilities[sessionId]?.fork ?? false);
  const isLogin = useBizzi((s) => s.timelines[sessionId]?.login != null);
  const machine = useMachine(session?.machineId);
  const online = useMachineOnline(session?.machineId);
  const workspace = useBizzi((s) => (session ? (s.workspaces?.[session.workspaceId] ?? null) : null));
  const planCount = useBizzi((s) => s.timelines[sessionId]?.plan?.filter((p) => p.status !== 'completed').length ?? 0);
  const fileCount = useBizzi((s) => Object.keys(s.timelines[sessionId]?.files ?? {}).length);
  const split = useMediaQuery('(min-width: 1100px)');
  const [openError, setOpenError] = useState<unknown>(null);
  const [showControls, setShowControls] = useState(false);
  const [sideTab, setSideTab] = useState<SideTab>(props.tab === 'chat' ? 'plan' : props.tab);
  const stop = useAction(() => store.stop(sessionId));
  const fork = useAction(async () => {
    const s = await store.forkSession(sessionId);
    navigate({ name: 'session', sessionId: s.id, tab: 'chat' });
  });
  const remove = useAction(async () => {
    const workspaceId = session?.workspaceId;
    await store.deleteSession(sessionId);
    navigate(workspaceId ? { name: 'workspace', workspaceId } : { name: 'workspaces' }, { replace: true });
  });

  useEffect(() => {
    setOpenError(null);
    store.openSession(sessionId).catch((e: unknown) => setOpenError(e));
  }, [store, sessionId]);

  // Viewing a session marks it seen through what has arrived (spec §4 seen_through), so "done, not yet
  // seen" clears here and on every other device. Only while the page is visible; never backwards.
  useEffect(() => {
    if (lastSeq === 0) return;
    const mark = (): void => {
      if (document.visibilityState === 'visible') store.markSeen(sessionId, lastSeq);
    };
    // Debounced: a streaming turn advances lastSeq every frame; "done" only matters once it settles.
    const t = setTimeout(mark, 500);
    document.addEventListener('visibilitychange', mark);
    return () => {
      clearTimeout(t);
      document.removeEventListener('visibilitychange', mark);
    };
  }, [store, sessionId, lastSeq]);

  if (!session) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader title="Session" back={() => navigate({ name: 'workspaces' })} />
        {openError ? (
          <div className="p-4">
            <ErrorText error={openError} />
          </div>
        ) : sessionsLoaded ? (
          <Empty icon="chat" title="Session not found">
            It may have been deleted.
          </Empty>
        ) : (
          <Loading />
        )}
      </div>
    );
  }

  const terminal = session.mode === 'terminal';
  const setTab = (tab: SessionTab): void => navigate({ name: 'session', sessionId, tab }, { replace: true });
  const tabs: { value: SessionTab; label: string; badge?: ReactNode }[] = [
    { value: 'chat', label: terminal ? 'Terminal' : 'Chat' },
    { value: 'plan', label: 'Plan', badge: planCount ? <Count n={planCount} /> : undefined },
    { value: 'files', label: 'Files' },
    { value: 'changes', label: 'Changes', badge: fileCount ? <Count n={fileCount} /> : undefined },
  ];

  const main = terminal ? (
    <Suspense fallback={<Loading />}>
      <TerminalView sessionId={sessionId} />
    </Suspense>
  ) : (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1">
        <Timeline sessionId={sessionId} />
      </div>
      <Composer sessionId={sessionId} />
    </div>
  );

  const side = (tab: SideTab): ReactNode => (
    <Suspense fallback={<Loading />}>
      {tab === 'plan' ? <PlanPanel sessionId={sessionId} /> : tab === 'files' ? <FilesPanel workspaceId={session.workspaceId} /> : <GitPanel workspaceId={session.workspaceId} />}
    </Suspense>
  );

  const ended = status === 'ended' || status === 'failed';
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={session.title || 'Untitled session'}
        subtitle={
          <span>
            <span className="capitalize">{session.agent}</span>
            {session.model ? ` · ${session.model}` : ''}
            {workspace ? (
              <>
                {' · '}
                <a className="hover:underline" href={`#/w/${encodeURIComponent(workspace.id)}`}>
                  {workspace.name}
                </a>
              </>
            ) : null}
          </span>
        }
        back={() => navigate({ name: 'workspace', workspaceId: session.workspaceId })}
        actions={
          <>
            <StatusBadge status={status} prompt={prompt} title={statusTitle(status, statusReason, statusSource)} />
            {!terminal ? <IconButton icon="settings" label="Session settings" onClick={() => setShowControls((v) => !v)} className={cx(showControls && 'bg-panel-2 text-fg')} /> : null}
            {canFork ? <IconButton icon="fork" label="Fork: new session continuing this conversation" disabled={!online || fork.busy} onClick={() => void fork.run()} /> : null}
            <IconButton
              icon="trash"
              label="Delete session"
              disabled={!online || remove.busy}
              onClick={() => {
                if (window.confirm(`Delete "${session.title || 'this session'}"? The agent is stopped and the session and its history are removed. This cannot be undone.`)) void remove.run();
              }}
            />
            {!ended && online ? (
              <Button
                size="sm"
                variant="ghost"
                icon="stop"
                busy={stop.busy}
                onClick={() => {
                  if (window.confirm('End this session? The agent process will be stopped.')) void stop.run();
                }}
                className="hidden sm:inline-flex"
              >
                End
              </Button>
            ) : null}
          </>
        }
      />
      <SessionHeaderBar session={session} />
      <HelperTree sessionId={sessionId} />
      {showControls && !terminal ? (
        <div className="shrink-0 border-b border-border bg-panel px-3 py-2 md:px-5">
          <SessionControls sessionId={sessionId} />
          {!ended ? (
            <Button size="sm" variant="ghost" icon="stop" className="mt-2 sm:hidden" onClick={() => void stop.run()}>
              End session
            </Button>
          ) : null}
        </div>
      ) : null}
      {!online ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-warn/30 bg-warn/10 px-3 py-1.5 text-xs text-warn md:px-5" role="status">
          <Icon name="wifiOff" size={14} className="shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="font-medium">{machine?.name ?? 'The machine'} is offline</span>
            {machine ? ` (${machinePresence(machine)})` : ''}. Showing the cached timeline; sending, approvals and changes are disabled until it reconnects.
          </span>
        </div>
      ) : null}
      {isLogin ? (
        <a href={`#/login/${encodeURIComponent(sessionId)}`} className="flex shrink-0 items-center gap-2 border-b border-border bg-accent-soft px-3 py-1.5 text-xs text-accent md:px-5">
          <Icon name="key" size={14} /> This is a login session. Open the login helper for links and codes.
        </a>
      ) : null}
      <ErrorText error={openError ?? stop.error ?? fork.error ?? remove.error} />
      {split ? (
        <div className="flex min-h-0 flex-1">
          <section className="min-w-0 flex-1">{main}</section>
          <aside className="flex w-[380px] shrink-0 flex-col border-l border-border bg-panel">
            <Tabs<SideTab> className="shrink-0 border-b border-border px-2 py-1.5" value={sideTab} onChange={setSideTab} items={tabs.filter((t): t is { value: SideTab; label: string; badge?: ReactNode } => t.value !== 'chat')} />
            <div className="min-h-0 flex-1">{side(sideTab)}</div>
          </aside>
        </div>
      ) : (
        <>
          <Tabs<SessionTab> className="shrink-0 border-b border-border bg-panel px-2 py-1" value={props.tab} onChange={setTab} items={tabs} />
          <div className="min-h-0 flex-1">{props.tab === 'chat' ? main : side(props.tab)}</div>
        </>
      )}
    </div>
  );
}

/** Status tooltip: the status, its reason and what produced it ("via OSC 7501", "detector: claude-permission"). */
function statusTitle(status: SessionStatus | null, reason: string | undefined, source: string | undefined): string | undefined {
  if (!status) return undefined;
  const src = statusSourceLabel(source);
  return [STATUS_LABEL[status], reason, src].filter(Boolean).join(' · ');
}

function Count(props: { n: number }): ReactNode {
  return <span className="rounded-full bg-panel-2 px-1.5 text-[10px] font-semibold text-muted">{props.n}</span>;
}
