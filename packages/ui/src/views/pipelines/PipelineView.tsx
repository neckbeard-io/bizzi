import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { PIPELINE_STATUS_LABEL, pipelineModelSignature, selectPipeline } from '@bizzi/client';
import type { PipelineStageModel } from '@bizzi/client';
import { useBizzi, useStore } from '../../app/context.tsx';
import { navigate, useAction } from '../../app/hooks.ts';
import { useMachineOnline } from '../../app/machine.ts';
import { Icon } from '../../components/icons.tsx';
import { Page, PageHeader } from '../../components/layout.tsx';
import { AgentMark } from '../../components/marks.tsx';
import { Badge, Button, Card, Empty, ErrorText, Spinner, cx } from '../../components/ui.tsx';
import { PIPELINE_TONE, PipelineGateCard } from './PipelineGateCard.tsx';
import { formatRelative } from '../../lib/format.ts';
import { routeHref } from '../../lib/router.ts';
import { AGENT_LABEL, MARK_LABEL, MARK_TEXT } from '../../lib/states.ts';

/** A pipeline run (docs/pipelines.md): the gate when one is open, then the stages top to bottom. */
export function PipelineView(props: { pipelineId: string }): ReactNode {
  const store = useStore();
  const model = useBizzi(
    (s) => selectPipeline(s, props.pipelineId),
    (a, b) => pipelineModelSignature(a) === pipelineModelSignature(b),
  );
  const loaded = useBizzi((s) => s.sessionsLoaded);
  const p = model?.pipeline;
  const online = useMachineOnline(p?.machineId);
  const ws = useBizzi((s) => (p ? (s.workspaces?.[p.workspaceId] ?? null) : null));
  const cancel = useAction(async () => {
    if (p) await store.cancelPipeline(p);
  });
  const remove = useAction(async () => {
    if (!p) return;
    await store.deletePipeline(p);
    navigate(ws ? { name: 'workspace', workspaceId: ws.id } : { name: 'workspaces' }, { replace: true });
  });
  // Stage sessions' channels, so marks (working, waiting on an approval) are live.
  const ids = model?.stages.map((s) => s.run.sessionId ?? '').join(',') ?? '';
  useEffect(() => {
    for (const id of ids.split(',').filter(Boolean)) store.openSession(id).catch(() => {});
  }, [store, ids]);

  const back = (): void => navigate(ws ? { name: 'workspace', workspaceId: ws.id } : { name: 'workspaces' });
  if (!model || !p) {
    return (
      <Page header={<PageHeader title="Pipeline" back={back} />}>
        {loaded ? <Empty icon="tree" title="Pipeline not found">It may have been deleted, or its machine is not connected.</Empty> : <Spinner />}
      </Page>
    );
  }
  const live = p.status === 'running' || p.status === 'waiting';
  return (
    <Page
      header={
        <PageHeader
          title={p.title}
          subtitle={
            <span>
              {ws ? `${ws.name} · ` : ''}
              {p.stages.length} stages · started {formatRelative(p.createdAt)}
            </span>
          }
          back={back}
          actions={
            live ? (
              <Button size="sm" variant="ghost" icon="stop" disabled={!online} busy={cancel.busy} onClick={() => window.confirm('Cancel this pipeline? The running stage is stopped.') && void cancel.run()}>
                Cancel
              </Button>
            ) : (
              <Button size="sm" variant="ghost" icon="trash" disabled={!online} busy={remove.busy} onClick={() => window.confirm('Forget this pipeline run? Its sessions and worktree are kept.') && void remove.run()}>
                Delete
              </Button>
            )
          }
        />
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <Badge tone={PIPELINE_TONE[p.status]}>{PIPELINE_STATUS_LABEL[p.status]}</Badge>
        {p.spec.budgetUsd !== undefined ? <span className="text-xs text-muted">metered cap ${p.spec.budgetUsd.toFixed(2)}</span> : null}
        {p.worktreeId ? (
          <a className="text-xs text-muted hover:text-fg" href={routeHref({ name: 'workspace', workspaceId: p.worktreeId })}>
            <Icon name="branch" size={12} className="mr-1 inline" />
            worktree
          </a>
        ) : null}
      </div>
      {p.error ? <ErrorText error={p.error} className="mb-3" /> : null}
      {p.gate ? <PipelineGateCard pipeline={p} className="mb-4" /> : null}
      <Card className="mb-4 p-3">
        <div className="text-xs font-semibold tracking-wide text-muted uppercase">Task</div>
        <div className="mt-1 max-h-40 overflow-y-auto text-sm whitespace-pre-wrap">{p.task}</div>
      </Card>
      <ol className="flex flex-col gap-2">
        {model.stages.map((st) => (
          <StageRow key={st.index} stage={st} current={p.current === st.index && live} />
        ))}
      </ol>
      <ErrorText error={cancel.error ?? remove.error} className="mt-3" />
    </Page>
  );
}

const STAGE_TEXT: Record<PipelineStageModel['run']['status'], string> = {
  pending: 'pending',
  running: 'running',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
};

function StageRow(props: { stage: PipelineStageModel; current: boolean }): ReactNode {
  const { stage: st } = props;
  const r = st.run;
  return (
    <li>
      <Card className={cx('flex items-start gap-3 p-3', props.current && 'border-accent/60', st.gated && 'border-state-waiting')}>
        <div className="mt-0.5 shrink-0">
          {st.session && st.mark ? <AgentMark agent={r.agent} state={st.mark} size={20} /> : <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-border text-[10px] text-muted">{st.index + 1}</span>}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2">
            <span className="font-medium">{r.name}</span>
            <span className="text-xs text-muted">
              {AGENT_LABEL[r.agent]} · {st.where === 'worktree' ? 'worktree' : 'workspace'}
              {st.gate ? ' · gate' : ''}
            </span>
            <span className={cx('ml-auto text-xs', r.status === 'failed' ? 'text-err' : r.status === 'done' ? 'text-ok' : 'text-muted')}>
              {st.gated ? 'waiting for your approval' : r.status === 'running' && st.mark ? <span className={MARK_TEXT[st.mark]}>{MARK_LABEL[st.mark]}</span> : STAGE_TEXT[r.status]}
            </span>
          </div>
          {r.summary ? <div className="mt-1 line-clamp-3 text-sm whitespace-pre-wrap text-muted">{r.summary}</div> : null}
          {r.error ? <div className="mt-1 text-sm text-err">{r.error}</div> : null}
          <div className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-muted">
            {r.changedFiles ? <span>{r.changedFiles} changed file(s)</span> : null}
            {r.startedAt ? <span>started {formatRelative(r.startedAt)}</span> : null}
            {r.sessionId ? (
              <a className="hover:text-fg" href={routeHref({ name: 'session', sessionId: r.sessionId, tab: 'chat' })}>
                open session →
              </a>
            ) : null}
          </div>
        </div>
      </Card>
    </li>
  );
}
