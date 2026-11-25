import { useState } from 'react';
import type { ReactNode } from 'react';
import type { PipelineInfo } from '@bizzi/protocol';
import { useStore } from '../../app/context.tsx';
import { useAction } from '../../app/hooks.ts';
import { useMachineOnline } from '../../app/machine.ts';
import { Icon } from '../../components/icons.tsx';
import { Button, Card, ErrorText, Input, cx } from '../../components/ui.tsx';
import { routeHref } from '../../lib/router.ts';

export const PIPELINE_TONE: Record<PipelineInfo['status'], 'neutral' | 'ok' | 'warn' | 'err'> = {
  running: 'neutral',
  waiting: 'warn',
  done: 'ok',
  failed: 'err',
  cancelled: 'neutral',
};

/** The open gate of a run: approve (with an optional note for the next stage) or reject. Also used by the inbox. */
export function PipelineGateCard(props: { pipeline: PipelineInfo; className?: string; showTitle?: boolean }): ReactNode {
  const p = props.pipeline;
  const store = useStore();
  const online = useMachineOnline(p.machineId);
  const [note, setNote] = useState('');
  const approve = useAction(() => store.gatePipeline(p, 'approve', note));
  const reject = useAction(() => store.gatePipeline(p, 'reject', note));
  if (!p.gate) return null;
  const prev = p.gate.stage > 0 ? p.stages[p.gate.stage - 1] : undefined;
  return (
    <Card className={cx('border-state-waiting/60 p-3', props.className)}>
      <div className="flex items-start gap-2">
        <Icon name={p.gate.reason === 'budget' ? 'gauge' : 'shield'} size={16} className="mt-0.5 shrink-0 text-state-waiting" />
        <div className="min-w-0 flex-1">
          {props.showTitle ? (
            <a className="text-xs text-muted hover:text-fg" href={routeHref({ name: 'pipeline', pipelineId: p.id })}>
              {p.title}
            </a>
          ) : null}
          <div className="text-sm font-medium">{p.gate.message}</div>
          {prev?.summary ? <div className="mt-1 line-clamp-4 text-sm whitespace-pre-wrap text-muted">{prev.name}: {prev.summary}</div> : null}
          {prev?.sessionId ? (
            <a className="text-xs text-muted hover:text-fg" href={routeHref({ name: 'session', sessionId: prev.sessionId, tab: 'chat' })}>
              Read or continue {prev.name} first →
            </a>
          ) : null}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Input className="min-w-0 flex-1" placeholder="Note for the next stage (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
        <Button size="sm" variant="primary" icon="check" disabled={!online} busy={approve.busy} onClick={() => void approve.run()}>
          Approve
        </Button>
        <Button size="sm" variant="ghost" icon="x" disabled={!online} busy={reject.busy} onClick={() => void reject.run()}>
          Reject
        </Button>
      </div>
      <ErrorText error={approve.error ?? reject.error} className="mt-2" />
    </Card>
  );
}
