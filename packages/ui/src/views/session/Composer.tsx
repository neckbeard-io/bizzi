import { useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { selectMachineOnline } from '@bizzi/client';
import { useBizzi, useStore } from '../../app/context.tsx';
import { useAction, useIsWide } from '../../app/hooks.ts';
import { Button, ErrorText, cx } from '../../components/ui.tsx';
import { contextUse, formatCost, formatTokens, isBusy } from '../../lib/format.ts';

export function Composer(props: { sessionId: string }): ReactNode {
  const { sessionId } = props;
  const store = useStore();
  const wide = useIsWide();
  const caps = useBizzi((s) => s.capabilities[sessionId] ?? null);
  const status = useBizzi((s) => s.timelines[sessionId]?.status ?? s.sessions[sessionId]?.status ?? null);
  const activeTurn = useBizzi((s) => s.timelines[sessionId]?.activeTurnId ?? null);
  const online = useBizzi((s) => selectMachineOnline(s, s.sessions[sessionId]?.machineId));
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  const busy = activeTurn !== null || isBusy(status);
  const closed = status === 'ended' || status === 'failed' || !online;
  const canSteer = busy && (caps?.steer ?? false);
  const canInterrupt = busy && (caps?.interrupt ?? false);

  const send = useAction(async () => {
    const t = text.trim();
    if (!t) return;
    if (busy) await store.steer(sessionId, t);
    else await store.send(sessionId, t);
    setText('');
  });
  const interrupt = useAction(() => store.interrupt(sessionId));

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Desktop: Enter sends, Shift+Enter adds a line. Phones: the button sends.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && wide) {
      e.preventDefault();
      if (!busy || canSteer) void send.run();
    }
  };

  const disabled = closed || (busy && !canSteer);
  const placeholder = !online
    ? 'Machine offline: read-only until it reconnects'
    : closed
    ? `Session ${status}`
    : busy
      ? canSteer
        ? 'Steer the agent while it works…'
        : 'The agent is working…'
      : 'Message the agent…';

  return (
    <div className="pb-safe shrink-0 border-t border-border bg-panel">
      <div className="mx-auto max-w-3xl px-3 pt-2 pb-2 md:px-5">
        <ErrorText error={send.error ?? interrupt.error} />
        <div className={cx('flex items-end gap-2 rounded-xl border border-border bg-bg px-2 py-1.5 focus-within:border-accent', disabled && 'opacity-70')}>
          <textarea
            ref={ref}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            placeholder={placeholder}
            disabled={closed}
            className="max-h-[200px] min-h-[36px] flex-1 resize-none bg-transparent px-1.5 py-1.5 text-[15px] leading-6 placeholder:text-muted/80 focus:outline-none md:text-sm"
            aria-label="Message"
          />
          {canInterrupt ? (
            <Button variant="secondary" icon="stop" busy={interrupt.busy} onClick={() => void interrupt.run()} title="Interrupt the current turn">
              <span className="hidden sm:inline">Stop</span>
            </Button>
          ) : null}
          <Button
            variant="primary"
            icon="send"
            busy={send.busy}
            disabled={disabled || !text.trim()}
            onClick={() => void send.run()}
            title={busy ? 'Steer' : 'Send'}
          >
            <span className="hidden sm:inline">{busy ? 'Steer' : 'Send'}</span>
          </Button>
        </div>
        <UsageFooter sessionId={sessionId} />
      </div>
    </div>
  );
}

function UsageFooter(props: { sessionId: string }): ReactNode {
  const usage = useBizzi((s) => s.timelines[props.sessionId]?.usage ?? null);
  const ctx = contextUse(usage);
  if (!usage) return <div className="h-5" />;
  return (
    <div className="flex h-5 items-center gap-3 px-1 pt-1 text-[11px] text-muted">
      <span title="input / output tokens">
        {formatTokens(usage.inputTokens)} in · {formatTokens(usage.outputTokens)} out
      </span>
      {usage.cacheReadTokens ? <span className="hidden sm:inline">{formatTokens(usage.cacheReadTokens)} cached</span> : null}
      {usage.costUsd !== undefined ? <span>{formatCost(usage.costUsd)}</span> : null}
      {ctx !== null ? (
        <span className="ml-auto flex items-center gap-1.5" title="context window used">
          <span className="relative h-1 w-14 overflow-hidden rounded bg-panel-2">
            <span className={cx('absolute inset-y-0 left-0', ctx > 0.85 ? 'bg-err' : ctx > 0.6 ? 'bg-warn' : 'bg-accent')} style={{ width: `${Math.round(ctx * 100)}%` }} />
          </span>
          {Math.round(ctx * 100)}% context
        </span>
      ) : null}
    </div>
  );
}
