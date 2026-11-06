import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { MethodResult } from '@bizzi/protocol';
import { useBizziContext } from '../../app/context.tsx';
import { DiffViewer } from '../../components/DiffView.tsx';
import { Badge, Button, Empty, ErrorText, IconButton, Spinner, cx } from '../../components/ui.tsx';

type Status = MethodResult<'git.status'>;

function describe(code: string): { label: string; tone: string } {
  if (code === '??') return { label: 'U', tone: 'text-ok' };
  const c = code.replace(/ /g, '');
  if (c.includes('A')) return { label: 'A', tone: 'text-ok' };
  if (c.includes('D')) return { label: 'D', tone: 'text-err' };
  if (c.includes('R')) return { label: 'R', tone: 'text-warn' };
  if (c.includes('U')) return { label: '!', tone: 'text-err' };
  return { label: 'M', tone: 'text-info' };
}

function untrackedDiff(path: string, content: string): string {
  const lines = content.endsWith('\n') ? content.slice(0, -1).split('\n') : content.split('\n');
  return [`diff --git a/${path} b/${path}`, 'new file mode 100644', '--- /dev/null', `+++ b/${path}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`), ''].join('\n');
}

/** git.status file list + unified diff of the selected file (or everything). */
export function GitPanel(props: { workspaceId: string }): ReactNode {
  const { client } = useBizziContext();
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [selected, setSelected] = useState<string | null | undefined>(undefined);
  const [diff, setDiff] = useState<string | null>(null);
  const [diffError, setDiffError] = useState<unknown>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    setError(null);
    client.request('git.status', { workspaceId: props.workspaceId }).then(
      (r) => alive && setStatus(r),
      (e: unknown) => alive && setError(e),
    );
    return () => {
      alive = false;
    };
  }, [client, props.workspaceId, reload]);

  const loadDiff = useCallback(
    async (path: string | null, code?: string) => {
      setSelected(path);
      setDiff(null);
      setDiffError(null);
      try {
        const base = path ? { workspaceId: props.workspaceId, path } : { workspaceId: props.workspaceId };
        let { diff: d } = await client.request('git.diff', base);
        if (!d.trim()) ({ diff: d } = await client.request('git.diff', { ...base, staged: true }));
        if (!d.trim() && path && code === '??') {
          // Untracked files have no diff; show their content as an addition.
          const f = await client.request('fs.read', { workspaceId: props.workspaceId, path, maxBytes: 512 * 1024 });
          if (f.encoding === 'utf8') d = untrackedDiff(path, f.content);
        }
        setDiff(d);
      } catch (e) {
        setDiffError(e);
      }
    },
    [client, props.workspaceId],
  );

  if (error) {
    return (
      <div className="p-3">
        <ErrorText error={error} />
      </div>
    );
  }
  if (!status) {
    return (
      <div className="flex justify-center p-6 text-muted">
        <Spinner />
      </div>
    );
  }
  if (!status.isRepo) return <Empty icon="git" title="Not a git repository" />;

  if (selected !== undefined) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex min-h-10 items-center gap-1 border-b border-border px-2">
          <IconButton icon="back" label="Back to changes" onClick={() => setSelected(undefined)} />
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{selected ?? 'All changes'}</span>
        </div>
        <div className="min-h-0 flex-1">
          {diffError ? (
            <div className="p-3">
              <ErrorText error={diffError} />
            </div>
          ) : diff === null ? (
            <div className="flex justify-center p-6 text-muted">
              <Spinner />
            </div>
          ) : (
            <DiffViewer diff={diff} />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-10 flex-wrap items-center gap-2 border-b border-border px-3 py-1.5 text-sm">
        <span className="font-mono text-xs">{status.branch ?? '(detached)'}</span>
        {status.ahead ? <Badge tone="info">↑{status.ahead}</Badge> : null}
        {status.behind ? <Badge tone="warn">↓{status.behind}</Badge> : null}
        <div className="flex-1" />
        <IconButton icon="refresh" label="Refresh" onClick={() => setReload((n) => n + 1)} />
        {status.files.length ? (
          <Button size="sm" onClick={() => void loadDiff(null)}>
            View all
          </Button>
        ) : null}
      </div>
      {status.files.length === 0 ? (
        <Empty icon="check" title="Working tree clean" />
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto py-1">
          {status.files.map((f) => {
            const d = describe(f.status);
            return (
              <li key={f.path}>
                <button type="button" onClick={() => void loadDiff(f.path, f.status)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-panel-2">
                  <span className={cx('w-3 shrink-0 font-mono text-xs font-semibold', d.tone)} title={f.status}>
                    {d.label}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{f.path}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
