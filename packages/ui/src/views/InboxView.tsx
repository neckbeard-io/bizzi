import type { ReactNode } from 'react';
import { inboxEqual, selectInbox, selectKnowledgeSuggestionCount, selectSessionPrompt, shallowEqual } from '@bizzi/client';
import type { SessionInfo } from '@bizzi/protocol';
import { useBizzi } from '../app/context.tsx';
import { Page, PageHeader, SectionTitle } from '../components/layout.tsx';
import { Card, Empty, StatusBadge } from '../components/ui.tsx';
import { formatRelative } from '../lib/format.ts';
import { routeHref } from '../lib/router.ts';
import { KnowledgeInbox } from './knowledge/KnowledgeInbox.tsx';
import { ApprovalCard, QuestionCard } from './session/items.tsx';

/** Pending approvals and questions across every session (and machine), waiting sessions, knowledge suggestions. */
export function InboxView(): ReactNode {
  const entries = useBizzi(selectInbox, inboxEqual);
  const covered = new Set(entries.map((e) => e.sessionId));
  const waiting = useBizzi(
    (s) => Object.values(s.sessions).filter((x) => (x.status === 'waiting_approval' || x.status === 'waiting_input') && !(s.timelines[x.id]?.lastSeq)),
    shallowEqual,
  );
  const sessions = useBizzi((s) => s.sessions);
  const workspaces = useBizzi((s) => s.workspaces);
  const machines = useBizzi((s) => s.machines);
  const multiMachine = useBizzi((s) => s.role === 'hub' && Object.keys(s.machines).length > 1);
  const suggestions = useBizzi(selectKnowledgeSuggestionCount);

  return (
    <Page header={<PageHeader title="Inbox" subtitle="Approvals, questions and knowledge suggestions waiting for you" />}>
      {entries.length === 0 && waiting.length === 0 && suggestions === 0 ? (
        <Empty icon="inbox" title="All clear">
          Nothing needs your attention.
        </Empty>
      ) : null}
      <div className="flex flex-col gap-4">
        {entries.map(({ sessionId, item }) => {
          const s = sessions[sessionId];
          const ws = s && workspaces?.[s.workspaceId];
          return (
            <div key={`${sessionId}:${item.id}`}>
              <a href={routeHref({ name: 'session', sessionId, tab: 'chat' })} className="mb-1.5 flex items-center gap-2 text-xs text-muted hover:text-fg">
                <span className="font-medium text-fg">{s?.title ?? sessionId}</span>
                {ws ? <span>· {ws.name}</span> : null}
                {multiMachine && s ? <span>· {machines[s.machineId]?.name ?? s.machineId}</span> : null}
                {s ? <span className="capitalize">· {s.agent}</span> : null}
                <span className="ml-auto">{formatRelative(item.ts)}</span>
              </a>
              {item.kind === 'approval' ? <ApprovalCard sessionId={sessionId} item={item} compact /> : <QuestionCard sessionId={sessionId} item={item} />}
            </div>
          );
        })}
      </div>
      {waiting.filter((w) => !covered.has(w.id)).length > 0 ? (
        <>
          <SectionTitle>Waiting sessions</SectionTitle>
          <div className="grid gap-2">
            {waiting
              .filter((w) => !covered.has(w.id))
              .map((s) => (
                <a key={s.id} href={routeHref({ name: 'session', sessionId: s.id, tab: 'chat' })}>
                  <WaitingRow session={s} />
                </a>
              ))}
          </div>
        </>
      ) : null}
      <KnowledgeInbox />
    </Page>
  );
}

function WaitingRow(props: { session: SessionInfo }): ReactNode {
  const s = props.session;
  const prompt = useBizzi((st) => selectSessionPrompt(st, s.id));
  return (
    <Card className="flex items-center gap-2 p-3 hover:bg-panel-2">
      <span className="min-w-0 flex-1 truncate">{s.title ?? s.id}</span>
      <StatusBadge status={s.status} prompt={prompt} />
    </Card>
  );
}
