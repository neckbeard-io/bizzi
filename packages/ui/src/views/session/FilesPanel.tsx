import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { FsEntry, MethodResult } from '@bizzi/protocol';
import { useBizziContext } from '../../app/context.tsx';
import { Icon } from '../../components/icons.tsx';
import { ErrorText, IconButton, Spinner, cx } from '../../components/ui.tsx';
import { formatBytes, joinPath, parentPath } from '../../lib/format.ts';

type FileContent = MethodResult<'fs.read'>;

/** Workspace file browser (fs.list / fs.read). Lists and file contents are virtualized. */
export function FilesPanel(props: { workspaceId: string }): ReactNode {
  const { client } = useBizziContext();
  const [dir, setDir] = useState('');
  const [entries, setEntries] = useState<FsEntry[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [file, setFile] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setEntries(null);
    setError(null);
    client.request('fs.list', dir ? { workspaceId: props.workspaceId, path: dir } : { workspaceId: props.workspaceId }).then(
      (r) => {
        if (!alive) return;
        const sorted = [...r.entries].sort((a, b) => (a.type === 'dir') === (b.type === 'dir') ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);
        setEntries(sorted);
      },
      (e: unknown) => alive && setError(e),
    );
    return () => {
      alive = false;
    };
  }, [client, props.workspaceId, dir]);

  if (file) return <FileViewer workspaceId={props.workspaceId} path={file} onBack={() => setFile(null)} />;

  const crumbs = dir ? dir.split('/') : [];
  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-10 items-center gap-1 overflow-x-auto border-b border-border px-2 text-sm">
        {dir ? <IconButton icon="back" label="Up" onClick={() => setDir(parentPath(dir))} /> : null}
        <button type="button" className="rounded px-1.5 py-0.5 text-muted hover:text-fg" onClick={() => setDir('')}>
          root
        </button>
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center gap-1">
            <span className="text-muted">/</span>
            <button type="button" className="rounded px-1 py-0.5 whitespace-nowrap hover:text-accent" onClick={() => setDir(crumbs.slice(0, i + 1).join('/'))}>
              {c}
            </button>
          </span>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {error ? (
          <div className="p-3">
            <ErrorText error={error} />
          </div>
        ) : entries === null ? (
          <div className="flex justify-center p-6 text-muted">
            <Spinner />
          </div>
        ) : entries.length === 0 ? (
          <div className="p-4 text-sm text-muted">Empty directory</div>
        ) : (
          <EntryList entries={entries} onOpen={(e) => (e.type === 'dir' ? setDir(joinPath(dir, e.name)) : setFile(joinPath(dir, e.name)))} />
        )}
      </div>
    </div>
  );
}

function EntryList(props: { entries: FsEntry[]; onOpen: (e: FsEntry) => void }): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({ count: props.entries.length, getScrollElement: () => ref.current, estimateSize: () => 34, overscan: 12 });
  return (
    <div ref={ref} className="scrollbar-thin h-full overflow-y-auto">
      <div style={{ height: v.getTotalSize(), position: 'relative' }}>
        {v.getVirtualItems().map((vi) => {
          const e = props.entries[vi.index];
          if (!e) return null;
          return (
            <button
              key={vi.key}
              type="button"
              onClick={() => props.onOpen(e)}
              className="absolute left-0 flex w-full items-center gap-2 px-3 text-left text-sm hover:bg-panel-2"
              style={{ top: 0, height: vi.size, transform: `translateY(${vi.start}px)` }}
            >
              <Icon name={e.type === 'dir' ? 'folder' : 'file'} size={15} className={cx('shrink-0', e.type === 'dir' ? 'text-accent' : 'text-muted')} />
              <span className="min-w-0 flex-1 truncate">{e.name}</span>
              {e.type === 'file' ? <span className="shrink-0 text-xs text-muted">{formatBytes(e.size)}</span> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function FileViewer(props: { workspaceId: string; path: string; onBack: () => void }): ReactNode {
  const { client } = useBizziContext();
  const [content, setContent] = useState<FileContent | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let alive = true;
    client.request('fs.read', { workspaceId: props.workspaceId, path: props.path, maxBytes: 2 * 1024 * 1024 }).then(
      (r) => alive && setContent(r),
      (e: unknown) => alive && setError(e),
    );
    return () => {
      alive = false;
    };
  }, [client, props.workspaceId, props.path]);
  const lines = useMemo(() => (content?.encoding === 'utf8' ? content.content.split('\n') : []), [content]);
  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-10 items-center gap-1 border-b border-border px-2">
        <IconButton icon="back" label="Back to files" onClick={props.onBack} />
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{props.path}</span>
        {content?.truncated ? <span className="text-xs text-warn">truncated</span> : null}
      </div>
      <div className="min-h-0 flex-1">
        {error ? (
          <div className="p-3">
            <ErrorText error={error} />
          </div>
        ) : !content ? (
          <div className="flex justify-center p-6 text-muted">
            <Spinner />
          </div>
        ) : content.encoding === 'base64' ? (
          <div className="p-4 text-sm text-muted">Binary file ({formatBytes(Math.floor((content.content.length * 3) / 4))})</div>
        ) : (
          <CodeLines lines={lines} />
        )}
      </div>
    </div>
  );
}

function CodeLines(props: { lines: string[] }): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({ count: props.lines.length, getScrollElement: () => ref.current, estimateSize: () => 20, overscan: 30 });
  const gutter = String(props.lines.length).length;
  return (
    <div ref={ref} className="scrollbar-thin h-full overflow-auto font-mono text-xs leading-5">
      <div style={{ height: v.getTotalSize(), position: 'relative', minWidth: 'max-content' }}>
        {v.getVirtualItems().map((vi) => (
          <div key={vi.key} className="absolute left-0 flex w-full whitespace-pre" style={{ top: 0, height: vi.size, transform: `translateY(${vi.start}px)` }}>
            <span className="shrink-0 pr-3 pl-2 text-right text-muted/60 select-none" style={{ width: `${gutter + 2}ch` }}>
              {vi.index + 1}
            </span>
            <span className="pr-4">{props.lines[vi.index]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
