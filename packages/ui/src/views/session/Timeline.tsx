import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useBizzi, useStore } from '../../app/context.tsx';
import { Icon } from '../../components/icons.tsx';
import { Empty, Spinner, cx } from '../../components/ui.tsx';
import { pinnedPromptIndex, promptText } from '../../lib/pinnedPrompt.ts';
import { TimelineRow } from './items.tsx';

const EMPTY: readonly string[] = [];
const PIN_THRESHOLD = 80;

/**
 * Virtualized session timeline. Only visible rows are mounted; each row subscribes to its own item.
 * Sticks to the bottom while new output arrives unless the user scrolled up. Once the prompt of the turn
 * in view scrolls off the top, it stays pinned above the timeline.
 */
export function Timeline(props: { sessionId: string }): ReactNode {
  const { sessionId } = props;
  const order = useBizzi((s) => s.timelines[sessionId]?.order ?? EMPTY);
  const loaded = useBizzi((s) => (s.timelines[sessionId]?.lastSeq ?? 0) > 0);
  const gap = useBizzi((s) => s.gaps[`session:${sessionId}`]?.state === 'skipped');
  const parentRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [pinnedIndex, setPinnedIndex] = useState(-1);
  const store = useStore();
  // Prompt rows, in order. `order` changes only when items are added, and a prompt's input never changes.
  const prompts = useMemo(() => {
    const items = store.getState().timelines[sessionId]?.items ?? {};
    const out: number[] = [];
    order.forEach((id, i) => {
      if (promptText(items[id]) !== null) out.push(i);
    });
    return out;
  }, [store, sessionId, order]);

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

  const updatePinned = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    const cache = v.measurementsCache;
    setPinnedIndex(pinnedPromptIndex(prompts, (i) => cache[i], el.scrollTop));
  }, [v, prompts]);

  useLayoutEffect(() => {
    const el = parentRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
    updatePinned();
  }, [total, order.length, updatePinned]);

  const onScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD;
    pinned.current = atBottom;
    setShowJump(!atBottom);
    updatePinned();
  }, [updatePinned]);

  const jumpToPrompt = (index: number): void => {
    pinned.current = false;
    v.scrollToIndex(index, { align: 'start' });
  };

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
      {pinnedIndex >= 0 && order[pinnedIndex] ? <PinnedPrompt key={order[pinnedIndex]} sessionId={sessionId} itemId={order[pinnedIndex]} onJump={() => jumpToPrompt(pinnedIndex)} /> : null}
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

/** The prompt of the turn in view, kept above the timeline once its bubble scrolls off the top. */
function PinnedPrompt(props: { sessionId: string; itemId: string; onJump: () => void }): ReactNode {
  const text = useBizzi((s) => promptText(s.timelines[props.sessionId]?.items[props.itemId]));
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <div className="absolute inset-x-0 top-0 z-10 border-b border-border bg-bg/90 px-3 py-1.5 shadow-sm backdrop-blur md:px-5">
      <div className="mx-auto flex max-w-3xl items-start gap-1 rounded-xl bg-accent-soft py-1 pr-1 pl-3 text-sm">
        <button
          type="button"
          className={cx('min-w-0 flex-1 py-0.5 text-left break-words whitespace-pre-wrap text-fg', open ? 'scrollbar-thin max-h-[40vh] overflow-y-auto' : 'line-clamp-2')}
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          title={open ? 'Collapse' : 'Show the whole prompt'}
        >
          {text}
        </button>
        <button type="button" className="shrink-0 rounded-md p-1 text-muted hover:bg-panel-2 hover:text-fg" onClick={props.onJump} title="Scroll to this prompt" aria-label="Scroll to this prompt">
          <Icon name="chevronDown" size={14} className="rotate-180" />
        </button>
      </div>
    </div>
  );
}
