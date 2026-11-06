import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useBizzi } from '../../app/context.tsx';
import { Icon } from '../../components/icons.tsx';
import { Empty, Spinner } from '../../components/ui.tsx';
import { TimelineRow } from './items.tsx';

const EMPTY: readonly string[] = [];
const PIN_THRESHOLD = 80;

/**
 * Virtualized session timeline. Only visible rows are mounted; each row subscribes to its own item.
 * Sticks to the bottom while new output arrives unless the user scrolled up.
 */
export function Timeline(props: { sessionId: string }): ReactNode {
  const { sessionId } = props;
  const order = useBizzi((s) => s.timelines[sessionId]?.order ?? EMPTY);
  const loaded = useBizzi((s) => (s.timelines[sessionId]?.lastSeq ?? 0) > 0);
  const gap = useBizzi((s) => s.gaps[`session:${sessionId}`]?.state === 'skipped');
  const parentRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const v = useVirtualizer({
    count: order.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 64,
    overscan: 6,
    getItemKey: (i) => order[i] ?? i,
    paddingStart: 16,
    paddingEnd: 16,
  });

  const total = v.getTotalSize();

  useLayoutEffect(() => {
    const el = parentRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [total, order.length]);

  const onScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD;
    pinned.current = atBottom;
    setShowJump(!atBottom);
  }, []);

  const jump = (): void => {
    pinned.current = true;
    setShowJump(false);
    if (order.length > 0) v.scrollToIndex(order.length - 1, { align: 'end' });
    const el = parentRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  if (order.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        {loaded ? (
          <Empty icon="chat" title="No messages yet">
            Send a message to start.
          </Empty>
        ) : (
          <Spinner className="text-muted" />
        )}
      </div>
    );
  }

  return (
    <div className="relative h-full">
      <div ref={parentRef} onScroll={onScroll} className="scrollbar-thin h-full overflow-y-auto" style={{ overflowAnchor: 'none' }}>
        {gap ? <div className="mx-auto max-w-3xl px-4 pt-2 text-xs text-warn">Some events could not be loaded; the timeline may be incomplete.</div> : null}
        <div style={{ height: total, position: 'relative' }}>
          {v.getVirtualItems().map((vi) => {
            const id = order[vi.index];
            if (!id) return null;
            return (
              <div
                key={vi.key}
                data-index={vi.index}
                ref={v.measureElement}
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }}
              >
                <div className="mx-auto max-w-3xl px-3 py-1.5 md:px-5">
                  <TimelineRow sessionId={sessionId} itemId={id} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {showJump ? (
        <button
          type="button"
          onClick={jump}
          className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-panel px-3 py-1 text-xs shadow-md"
        >
          <Icon name="chevronDown" size={14} /> Latest
        </button>
      ) : null}
    </div>
  );
}
