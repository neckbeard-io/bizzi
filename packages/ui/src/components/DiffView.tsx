import { memo, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { parseUnifiedDiff } from '../lib/diff.ts';
import type { DiffFile, DiffLine } from '../lib/diff.ts';
import { cx } from './ui.tsx';

type Row = { kind: 'file'; file: DiffFile } | { kind: 'line'; line: DiffLine } | { kind: 'binary' } | { kind: 'more'; count: number };

function rowsOf(files: DiffFile[], showHeaders: boolean, maxLines = Infinity): Row[] {
  const rows: Row[] = [];
  let n = 0;
  for (const f of files) {
    if (showHeaders) rows.push({ kind: 'file', file: f });
    if (f.binary) rows.push({ kind: 'binary' });
    for (const line of f.lines) {
      if (n >= maxLines) {
        const remaining = files.reduce((acc, x) => acc + x.lines.length, 0) - n;
        rows.push({ kind: 'more', count: remaining });
        return rows;
      }
      rows.push({ kind: 'line', line });
      n++;
    }
  }
  return rows;
}

const STATUS_COLOR: Record<DiffFile['status'], string> = {
  added: 'text-ok',
  deleted: 'text-err',
  modified: 'text-info',
  renamed: 'text-warn',
  copied: 'text-warn',
};

function FileHeader(props: { file: DiffFile }): ReactNode {
  const f = props.file;
  return (
    <div className="flex items-center gap-2 border-y border-border bg-panel-2 px-3 py-1.5 font-sans text-xs">
      <span className={cx('font-semibold uppercase', STATUS_COLOR[f.status])}>{f.status[0]}</span>
      <span className="min-w-0 flex-1 truncate font-mono">
        {f.status === 'renamed' && f.oldPath ? `${f.oldPath} → ` : ''}
        {f.path}
      </span>
      <span className="text-ok">+{f.additions}</span>
      <span className="text-err">−{f.deletions}</span>
    </div>
  );
}

const LineRow = memo(function LineRow(props: { line: DiffLine; gutter: boolean }): ReactNode {
  const l = props.line;
  if (l.type === 'hunk') {
    return <div className="diff-hunk px-3 py-0.5 whitespace-pre-wrap break-all">{l.text}</div>;
  }
  if (l.type === 'noeol') {
    return <div className="px-3 text-muted italic">\ {l.text}</div>;
  }
  const sign = l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ';
  return (
    <div className={cx('flex', l.type === 'add' && 'diff-add', l.type === 'del' && 'diff-del')}>
      {props.gutter ? (
        <>
          <span className="w-10 shrink-0 pr-1 text-right text-muted/70 select-none">{l.oldNo ?? ''}</span>
          <span className="w-10 shrink-0 pr-1 text-right text-muted/70 select-none">{l.newNo ?? ''}</span>
        </>
      ) : null}
      <span className="w-4 shrink-0 text-center opacity-70 select-none">{sign}</span>
      <span className="min-w-0 flex-1 pr-3 whitespace-pre-wrap break-all">{l.text || ' '}</span>
    </div>
  );
});

function RowView(props: { row: Row; gutter: boolean }): ReactNode {
  const r = props.row;
  if (r.kind === 'file') return <FileHeader file={r.file} />;
  if (r.kind === 'binary') return <div className="px-3 py-1 text-muted italic">Binary file</div>;
  if (r.kind === 'more') return <div className="px-3 py-1 text-muted">… {r.count} more lines</div>;
  return <LineRow line={r.line} gutter={props.gutter} />;
}

/** Small inline diff (timeline cards). Not virtualized; capped. */
export function DiffBlock(props: { diff: string; path?: string; maxLines?: number }): ReactNode {
  const files = useMemo(() => parseUnifiedDiff(props.diff, props.path), [props.diff, props.path]);
  const rows = useMemo(() => rowsOf(files, files.length > 1, props.maxLines ?? 300), [files, props.maxLines]);
  if (files.length === 0) return <pre className="px-3 py-2 font-mono text-xs whitespace-pre-wrap">{props.diff}</pre>;
  return (
    <div className="overflow-hidden rounded-md border border-border font-mono text-xs leading-5">
      {rows.map((r, i) => (
        <RowView key={i} row={r} gutter={false} />
      ))}
    </div>
  );
}

/** Full diff viewer: virtualized, only visible lines are mounted. */
export function DiffViewer(props: { diff: string; className?: string }): ReactNode {
  const files = useMemo(() => parseUnifiedDiff(props.diff), [props.diff]);
  const rows = useMemo(() => rowsOf(files, true), [files]);
  const parentRef = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => (rows[i]?.kind === 'file' ? 30 : 20),
    overscan: 20,
  });
  if (files.length === 0) {
    return <div className="p-4 text-sm text-muted">{props.diff.trim() ? <pre className="whitespace-pre-wrap">{props.diff}</pre> : 'No changes.'}</div>;
  }
  return (
    <div ref={parentRef} className={cx('scrollbar-thin h-full overflow-y-auto font-mono text-xs leading-5', props.className)}>
      <div style={{ height: v.getTotalSize(), position: 'relative' }}>
        {v.getVirtualItems().map((vi) => {
          const row = rows[vi.index];
          if (!row) return null;
          return (
            <div key={vi.key} data-index={vi.index} ref={v.measureElement} style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }}>
              <RowView row={row} gutter />
            </div>
          );
        })}
      </div>
    </div>
  );
}
