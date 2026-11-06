import { Suspense, lazy, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useBizzi, useStore } from '../../app/context.tsx';
import { navigate, useAction, useMediaQuery } from '../../app/hooks.ts';
import { PageHeader } from '../../components/layout.tsx';
import { Button, Empty, ErrorText, IconButton, Spinner, StatusBadge, Tabs, cx } from '../../components/ui.tsx';
import type { SessionTab } from '../../lib/router.ts';
import { Composer } from './Composer.tsx';
import { PlanPanel } from './PlanPanel.tsx';
import { SessionControls } from './SessionControls.tsx';
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
  const workspace = useBizzi((s) => (session ? (s.workspaces?.[session.workspaceId] ?? null) : null));
  const planCount = useBizzi((s) => s.timelines[sessionId]?.plan?.filter((p) => p.status !== 'completed').length ?? 0);
  const fileCount = useBizzi((s) => Object.keys(s.timelines[sessionId]?.files ?? {}).length);
  const split = useMediaQuery('(min-width: 1100px)');
  const [openError, setOpenError] = useState<unknown>(null);
  const [showControls, setShowControls] = useState(false);
  const [sideTab, setSideTab] = useState<SideTab>(props.tab === 'chat' ? 'plan' : props.tab);
  const stop = useAction(() => store.stop(sessionId));

  useEffect(() => {
    setOpenError(null);
    store.openSession(sessionId).catch((e: unknown) => setOpenError(e));
  }, [store, sessionId]);

  if (!session) {
    return (
      <div className="flex h-full flex-col">
        <PageHeader title="Session" back={() => navigate({ name: 'workspaces' })} />
        {openError ? (
          <div className="p-4">
            <ErrorText error={openError} />
          </div>
        ) : sessionsLoaded ? (
          <Empty icon="chat" title="Session not found" />
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
            <StatusBadge status={status} />
            {!terminal ? <IconButton icon="settings" label="Session settings" onClick={() => setShowControls((v) => !v)} className={cx(showControls && 'bg-panel-2 text-fg')} /> : null}
            {!ended ? (
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
      <ErrorText error={openError ?? stop.error} />
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

function Count(props: { n: number }): ReactNode {
  return <span className="rounded-full bg-panel-2 px-1.5 text-[10px] font-semibold text-muted">{props.n}</span>;
}
