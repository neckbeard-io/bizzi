import type { ReactNode } from 'react';
import {
  inboxEqual,
  pipelinesEqual,
  restartPromptsEqual,
  selectInbox,
  selectKnowledgeSuggestionCount,
  selectPipelineGates,
  selectRestartPrompts,
  selectSessionPrompt,
  selectUnsupportedAgents,
  sessionMarkState,
  shallowEqual,
  waitingText,
  type RestartPrompt,
} from '@bizzi/client';
import type { SessionInfo } from '@bizzi/protocol';
import { useBizzi, useStore } from '../app/context.tsx';
import { useAction, useIsWide } from '../app/hooks.ts';
import { useMachineOnline } from '../app/machine.ts';
import { Icon } from '../components/icons.tsx';
import { Page, PageHeader, SectionTitle } from '../components/layout.tsx';
import { Button, Card, Empty, ErrorText, StatusBadge } from '../components/ui.tsx';
import { formatRelative } from '../lib/format.ts';
import { routeHref } from '../lib/router.ts';
import { AGENT_LABEL } from '../lib/states.ts';
import { UsageChip } from './usage/Usage.tsx';
import { KnowledgeInbox } from './knowledge/KnowledgeInbox.tsx';
import { ApprovalCard, QuestionCard } from './session/items.tsx';
import { PipelineGateCard } from './pipelines/PipelineGateCard.tsx';

/** Pending approvals and questions across every session (and machine), waiting sessions, knowledge suggestions. */
export function InboxView(): ReactNode {
  const entries = useBizzi(selectInbox, inboxEqual);
  const covered = new Set(entries.map((e) => e.sessionId));
  // Every session waiting on you; the ones with an approval/question card above are skipped below.
  const waiting = useBizzi((s) => Object.values(s.sessions).filter((x) => sessionMarkState(s, x) === 'waiting'), shallowEqual);
  const unsupported = useBizzi(selectUnsupportedAgents, unsupportedEqual);
  const wide = useIsWide();
  const sessions = useBizzi((s) => s.sessions);
  const workspaces = useBizzi((s) => s.workspaces);
  const machines = useBizzi((s) => s.machines);
  const multiMachine = useBizzi((s) => s.role === 'hub' && Object.keys(s.machines).length > 1);
  const suggestions = useBizzi(selectKnowledgeSuggestionCount);
  const gates = useBizzi(selectPipelineGates, pipelinesEqual);
  const restarts = useBizzi(selectRestartPrompts, restartPromptsEqual);

  return (
    <Page header={<PageHeader title="Inbox" subtitle="Approvals, questions, restarts and knowledge suggestions waiting for you" actions={wide ? null : <UsageChip />} />}>
      {unsupported.length > 0 ? (
        <div className="mb-4 flex flex-col gap-2">
          {unsupported.map(({ machineId, agent }) => (
            <a key={`${machineId}:${agent.agent}`} href={routeHref({ name: 'machine', machineId })} className="block">
              <Card className="flex items-start gap-2.5 border-err/40 p-3 hover:bg-panel-2">
                <Icon name="alert" size={16} className="mt-0.5 shrink-0 text-err" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">
                    {AGENT_LABEL[agent.agent]} {agent.version ?? ''} is not supported on {machines[machineId]?.name ?? machineId}
                  </div>
                  <div className="truncate text-xs text-muted">
                    {agent.supportReason ?? 'Structured sessions will not start.'}
                    {agent.remedies?.length ? ` · ${agent.remedies.map((r) => r.title).join(' / ')}` : ''}
                  </div>
                </div>
              </Card>
            </a>
          ))}
        </div>
      ) : null}
      {gates.length > 0 ? (
        <div className="mb-4 flex flex-col gap-2">
          {gates.map((p) => (
            <PipelineGateCard key={p.id} pipeline={p} showTitle />
          ))}
        </div>
      ) : null}
      {restarts.length > 0 ? (
        <div className="mb-4 flex flex-col gap-2">
          {restarts.map((r) => (
            <RestartPromptCard key={r.session.id} prompt={r} machineName={multiMachine ? (machines[r.session.machineId]?.name ?? r.session.machineId) : undefined} />
          ))}
        </div>
      ) : null}
      {entries.length === 0 && waiting.length === 0 && suggestions === 0 && unsupported.length === 0 && gates.length === 0 && restarts.length === 0 ? (
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

function unsupportedEqual(a: ReturnType<typeof selectUnsupportedAgents>, b: ReturnType<typeof selectUnsupportedAgents>): boolean {
  return a.length === b.length && a.every((x, i) => x.agent === b[i]?.agent && x.machineId === b[i]?.machineId);
}

/** Restart policy `ask` (updates.md §6): a newer agent version is installed; restart this session onto it? */
function RestartPromptCard(props: { prompt: RestartPrompt; machineName?: string | undefined }): ReactNode {
  const { session: s, running, installed } = props.prompt;
  const store = useStore();
  const online = useMachineOnline(s.machineId);
  const restarting = useBizzi((st) => st.timelines[s.id]?.restartItemId != null);
  const restart = useAction(() => store.restartSession(s.id));
  return (
    <Card className="flex items-start gap-2.5 p-3">
      <Icon name="refresh" size={16} className="mt-0.5 shrink-0 text-accent-text" />
      <div className="min-w-0 flex-1">
        <a href={routeHref({ name: 'session', sessionId: s.id, tab: 'chat' })} className="block truncate text-sm font-medium hover:underline">
          {s.title ?? s.id}
        </a>
        <div className="truncate text-xs text-muted">
          {AGENT_LABEL[s.agent]} {running} · {installed} installed{props.machineName ? ` on ${props.machineName}` : ''}. Restarts at the next safe point and resumes.
        </div>
        {restart.error ? <ErrorText error={restart.error} className="py-0.5 text-xs" /> : null}
      </div>
      <Button size="sm" variant="ghost" icon="refresh" busy={restart.busy || restarting} disabled={!online} onClick={() => void restart.run()}>
        {restarting ? 'Restarting' : `Restart on ${installed}`}
      </Button>
    </Card>
  );
}

function WaitingRow(props: { session: SessionInfo }): ReactNode {
  const s = props.session;
  const prompt = useBizzi((st) => selectSessionPrompt(st, s.id));
  const reason = useBizzi((st) => waitingText(st, s.id));
  return (
    <Card className="flex items-center gap-2 p-3 hover:bg-panel-2">
      <span className="min-w-0 flex-1">
        <span className="block truncate">{s.title ?? s.id}</span>
        <span className="block truncate text-xs text-muted">
          {AGENT_LABEL[s.agent]}: {reason}
        </span>
      </span>
      <StatusBadge status={s.status} prompt={prompt} />
    </Card>
  );
}
