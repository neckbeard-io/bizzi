import type { ReactNode } from 'react';
import type { InstallJob } from '@bizzi/client';
import { Icon } from '../../components/icons.tsx';
import { Button, ProgressBar, Spinner, cx } from '../../components/ui.tsx';
import { formatRelative } from '../../lib/format.ts';
import { jobLabel, jobProgress, jobState } from '../../lib/provision.ts';

/** One install/update/uninstall run: label, current message, progress bar, result. */
export function JobProgress(props: { job: InstallJob; onDismiss?: () => void; className?: string }): ReactNode {
  const { job } = props;
  const state = jobState(job);
  return (
    <div
      className={cx(
        'rounded-md border px-3 py-2',
        state === 'failed' ? 'border-err/30 bg-err/5' : state === 'ok' ? 'border-ok/30 bg-ok/5' : 'border-accent/30 bg-accent-soft/40',
        props.className,
      )}
      role="status"
    >
      <div className="flex items-center gap-2 text-sm">
        {state === 'running' ? (
          <Spinner size={14} className="shrink-0 text-accent-text" />
        ) : (
          <Icon name={state === 'ok' ? 'check' : 'alert'} size={15} className={cx('shrink-0', state === 'ok' ? 'text-ok' : 'text-err')} />
        )}
        <span className="min-w-0 flex-1 truncate font-medium">{jobLabel(job)}</span>
        {state !== 'running' && props.onDismiss ? (
          <Button size="sm" variant="ghost" onClick={props.onDismiss}>
            Dismiss
          </Button>
        ) : (
          <span className="shrink-0 text-[11px] text-muted">{formatRelative(job.updatedAt)}</span>
        )}
      </div>
      {state === 'running' ? <div className="mt-0.5 truncate text-xs text-muted">{job.stage}</div> : null}
      {job.message ? <div className={cx('mt-0.5 truncate font-mono text-[11px]', state === 'failed' ? 'text-err' : 'text-muted')}>{job.message}</div> : null}
      <ProgressBar value={jobProgress(job)} tone={state === 'failed' ? 'err' : state === 'ok' ? 'ok' : 'accent'} className="mt-2" />
    </div>
  );
}
