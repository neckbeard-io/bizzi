import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { JobAction } from '@bizzi/client';
import type { AgentKind, AgentRemedy, InstallPlan } from '@bizzi/protocol';
import { useBizzi, useStore } from '../../app/context.tsx';
import { useAction } from '../../app/hooks.ts';
import { Icon } from '../../components/icons.tsx';
import { Badge, Button, ErrorText, Modal, Spinner, cx } from '../../components/ui.tsx';
import { actionVerb, jobState, planSummary, stepState } from '../../lib/provision.ts';
import { JobProgress } from './JobProgress.tsx';

/**
 * Preview what an install / update / uninstall will run (agent.plan), then run it (agent.install) and
 * follow its install.progress events. `migrate` previews with `agent.migrate` dry-run and runs `agent.migrate`
 * (spec §7: switch to the preferred install method). A `remedy` with an id plans and runs that remedy's
 * own steps (e.g. a major-version upgrade). Closing the dialog never stops the job.
 */
export function PlanModal(props: {
  machineId: string | null;
  machineName: string;
  agent: AgentKind;
  action: JobAction;
  method?: string;
  remedy?: AgentRemedy;
  onClose: () => void;
}): ReactNode {
  const { machineId, agent, action, onClose, method } = props;
  const remedyId = props.remedy?.id;
  const store = useStore();
  const [plan, setPlan] = useState<InstallPlan | null>(null);
  const [planError, setPlanError] = useState<unknown>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useBizzi((s) => (jobId ? (s.jobs[jobId] ?? null) : null));

  useEffect(() => {
    let live = true;
    const preview =
      action === 'migrate'
        ? store.migrateAgent({ machineId, agent, dryRun: true, ...(method ? { toMethod: method } : {}) }).then((r) => r.plan)
        : store.planAgent({ machineId, agent, action, ...(method ? { method } : {}), ...(remedyId ? { remedy: remedyId } : {}) });
    preview.then(
      (p) => live && setPlan(p),
      (e: unknown) => live && setPlanError(e),
    );
    return () => {
      live = false;
    };
  }, [store, machineId, agent, action, method, remedyId]);

  const run = useAction(async () => {
    if (action === 'migrate') {
      const { job: j, plan: p } = await store.migrateAgent({ machineId, agent, ...(method ?? plan?.method ? { toMethod: method ?? plan?.method } : {}) });
      if (j) setJobId(j.jobId);
      setPlan(p);
      return;
    }
    const j = await store.installAgent({ machineId, agent, action, ...(plan?.method ? { method: plan.method } : {}), ...(remedyId ? { remedy: remedyId } : {}) });
    setJobId(j.jobId);
    if (j.plan) setPlan(j.plan);
  });

  const verb = actionVerb(action, 'present');
  const summary = plan ? planSummary(plan) : null;
  const state = job ? jobState(job) : null;
  const running = jobId !== null;

  return (
    <Modal
      wide
      title={
        <span>
          {remedyId && props.remedy ? props.remedy.title : verb} <span className="capitalize">{agent}</span> <span className="font-normal text-muted">on {props.machineName}</span>
        </span>
      }
      onClose={onClose}
      footer={
        running ? (
          <Button variant={state && state !== 'running' ? 'primary' : 'secondary'} onClick={onClose}>
            {state === 'running' || !state ? 'Close (keeps running)' : 'Done'}
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant={action === 'uninstall' ? 'danger' : 'primary'} icon={action === 'uninstall' ? 'trash' : 'download'} disabled={!plan} busy={run.busy} onClick={() => void run.run()}>
              {action === 'migrate' ? `Switch to ${plan?.method ?? method ?? 'the preferred method'}` : remedyId && props.remedy ? props.remedy.title : verb}
            </Button>
          </>
        )
      }
    >
      {planError ? <ErrorText error={planError} /> : null}
      {!plan && !planError ? (
        <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted">
          <Spinner /> Preparing the plan…
        </div>
      ) : null}
      {plan && summary ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-1.5 text-sm">
            <span className="text-muted">Method</span>
            <Badge tone="accent">{plan.method}</Badge>
            <Badge>
              {summary.steps} step{summary.steps === 1 ? '' : 's'}
            </Badge>
            {summary.sudo ? (
              <Badge tone="warn">
                <Icon name="lock" size={11} /> needs sudo
              </Badge>
            ) : (
              <Badge tone="ok">no sudo</Badge>
            )}
          </div>
          {job ? <JobProgress job={job} /> : null}
          <ol className="flex flex-col gap-2">
            {plan.steps.map((s, i) => {
              const st = stepState(job, i);
              return (
                <li key={s.id} className="flex gap-2.5">
                  <span
                    className={cx(
                      'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold',
                      st === 'done' ? 'bg-ok text-white dark:text-black' : st === 'running' ? 'bg-accent text-accent-fg' : st === 'failed' ? 'bg-err text-white' : 'bg-panel-2 text-muted',
                    )}
                  >
                    {st === 'done' ? <Icon name="check" size={12} /> : st === 'running' ? <Spinner size={11} /> : i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5 text-sm">
                      <span className={cx(st === 'pending' && running && 'text-muted')}>{s.title}</span>
                      {s.requiresSudo ? <Badge tone="warn">sudo</Badge> : null}
                    </div>
                    {s.command ? <pre className="mt-1 overflow-x-auto rounded bg-code px-2 py-1.5 font-mono text-xs whitespace-pre-wrap break-all">{s.command}</pre> : null}
                  </div>
                </li>
              );
            })}
          </ol>
          {plan.notes?.length ? (
            <ul className="flex flex-col gap-1 rounded-md border border-border bg-panel-2/50 px-3 py-2 text-xs text-muted">
              {plan.notes.map((n) => (
                <li key={n} className="flex gap-1.5">
                  <Icon name="alert" size={12} className="mt-0.5 shrink-0" />
                  {n}
                </li>
              ))}
            </ul>
          ) : null}
          {job && job.log.length > 0 ? <JobLog log={job.log} /> : null}
          <ErrorText error={run.error} />
        </div>
      ) : null}
    </Modal>
  );
}

function JobLog(props: { log: readonly { stage: string; message?: string; ts: string }[] }): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [props.log.length]);
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium text-muted uppercase">Log</div>
      <div ref={ref} className="max-h-40 overflow-y-auto rounded bg-code px-2 py-1.5 font-mono text-[11px] leading-5">
        {props.log.map((l, i) => (
          <div key={i} className="flex gap-2">
            <span className="shrink-0 text-muted">{l.ts.slice(11, 19)}</span>
            <span className="min-w-0 break-words">
              <span className="text-fg">{l.stage}</span>
              {l.message ? <span className="text-muted"> · {l.message}</span> : null}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
