import type { ReactNode } from 'react';
import { shallowEqual } from '@bizzi/client';
import { useBizzi } from '../../app/context.tsx';
import { Icon } from '../../components/icons.tsx';
import { Empty, Spinner, cx } from '../../components/ui.tsx';
import { usageSummary } from '../../lib/format.ts';

export function PlanPanel(props: { sessionId: string }): ReactNode {
  const plan = useBizzi((s) => s.timelines[props.sessionId]?.plan ?? null);
  const files = useBizzi((s) => Object.values(s.timelines[props.sessionId]?.files ?? {}), shallowEqual);
  const usage = useBizzi((s) => s.timelines[props.sessionId]?.usage ?? null);
  const done = plan?.filter((p) => p.status === 'completed').length ?? 0;
  return (
    <div className="h-full overflow-y-auto p-4">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="flex-1 text-xs font-semibold tracking-wide text-muted uppercase">Plan</h3>
        {plan?.length ? (
          <span className="text-xs text-muted">
            {done}/{plan.length}
          </span>
        ) : null}
      </div>
      {plan?.length ? (
        <>
          <div className="mb-3 h-1 overflow-hidden rounded bg-panel-2">
            <div className="h-full bg-ok transition-[width]" style={{ width: `${(done / plan.length) * 100}%` }} />
          </div>
          <ol className="flex flex-col gap-1.5">
            {plan.map((p, i) => (
              <li key={p.id ?? i} className="flex items-start gap-2 text-sm">
                {p.status === 'completed' ? (
                  <Icon name="check" size={16} className="mt-0.5 shrink-0 text-ok" />
                ) : p.status === 'in_progress' ? (
                  <Spinner size={14} className="mt-1 shrink-0 text-accent" />
                ) : (
                  <span className="mt-1 ml-0.5 h-3 w-3 shrink-0 rounded-full border border-muted" />
                )}
                <span className={cx(p.status === 'completed' && 'text-muted line-through', p.status === 'in_progress' && 'font-medium')}>{p.text}</span>
              </li>
            ))}
          </ol>
        </>
      ) : (
        <Empty icon="plan" title="No plan yet">
          Agents that track todos show them here.
        </Empty>
      )}
      {files.length ? (
        <>
          <h3 className="mt-6 mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Files changed in this session</h3>
          <ul className="flex flex-col gap-1">
            {files.map((f) => (
              <li key={f.path} className="flex items-center gap-2 text-sm">
                <span className={cx('w-3 text-xs font-semibold', f.change === 'created' ? 'text-ok' : f.change === 'deleted' ? 'text-err' : 'text-info')}>
                  {f.change[0]?.toUpperCase()}
                </span>
                <span className="min-w-0 truncate font-mono text-xs">{f.path}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {usage ? (
        <>
          <h3 className="mt-6 mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Usage</h3>
          <div className="text-sm">{usageSummary(usage)}</div>
        </>
      ) : null}
    </div>
  );
}
