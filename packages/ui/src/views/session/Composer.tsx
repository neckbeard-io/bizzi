import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { selectMachineOnline } from '@bizzi/client';
import { useBizzi, useStore } from '../../app/context.tsx';
import { useAction, useIsWide } from '../../app/hooks.ts';
import { CompletionMenu } from '../../components/CompletionMenu.tsx';
import { ModelPicker, effortsFor, useAgentModels } from '../../components/ModelPicker.tsx';
import { Button, ChipSelect, ErrorText, Spinner, cx } from '../../components/ui.tsx';
import { useDraft } from '../../lib/drafts.ts';
import { formatCost, formatTokens, isBusy } from '../../lib/format.ts';
import { applyCommand, builtinCommand, commandDetail, matchCommands, sessionCommands, slashQuery } from '../../lib/slash.ts';
import type { SlashCommand } from '../../lib/slash.ts';
import { AttachImageButton, AttachmentTray, useDraftAttachments } from './Attachments.tsx';

export function Composer(props: { sessionId: string }): ReactNode {
  const { sessionId } = props;
  const store = useStore();
  const wide = useIsWide();
  const caps = useBizzi((s) => s.capabilities[sessionId] ?? null);
  const status = useBizzi((s) => s.timelines[sessionId]?.status ?? s.sessions[sessionId]?.status ?? null);
  const activeTurn = useBizzi((s) => s.timelines[sessionId]?.activeTurnId ?? null);
  const online = useBizzi((s) => selectMachineOnline(s, s.sessions[sessionId]?.machineId));
  const advertised = useBizzi((s) => s.timelines[sessionId]?.info.commands);
  // Unsent text survives reloads and app restarts.
  const [text, setText] = useDraft(sessionId);
  const [caret, setCaret] = useState(0);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuClosed, setMenuClosed] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const edit = (value: string, pos: number): void => {
    setText(value);
    setCaret(pos);
    setMenuClosed(false);
    setMenuIndex(0);
  };
  const draft = useDraftAttachments({ text, onChange: edit, textarea: ref, images: caps?.images ?? true });

  const commands = useMemo(() => sessionCommands(advertised), [advertised]);
  const query = menuClosed ? null : slashQuery(text, caret);
  const menu = useMemo(
    () => (query === null ? [] : matchCommands(commands, query).map((c) => {
            const detail = commandDetail(c);
            return { ...c, key: c.name, label: c.name, prefix: '/', ...(detail ? { detail } : {}) };
          })),
    [commands, query],
  );

  const busy = activeTurn !== null || isBusy(status);
  // Only a closed session is read-only: after a crash ('failed') the next message starts the agent again.
  const closed = status === 'ended' || !online;
  const canSteer = busy && (caps?.steer ?? false);
  const canInterrupt = busy && (caps?.interrupt ?? false);

  const send = useAction(async () => {
    if (builtinCommand(text) === 'clear') {
      if (busy) throw new Error('The agent is working: wait for it or stop it before clearing.');
      await store.clearSession(sessionId);
      setText('');
      draft.clear();
      return;
    }
    if (draft.pending > 0 || !draft.hasContent(text)) return;
    const input = draft.build(text);
    if (input.length === 0) return;
    if (busy) await store.steer(sessionId, input);
    else await store.send(sessionId, input);
    setText('');
    draft.clear();
  });
  const ready = draft.hasContent(text) && draft.pending === 0;
  const interrupt = useAction(() => store.interrupt(sessionId));

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    if (pendingCaret.current !== null) {
      el.setSelectionRange(pendingCaret.current, pendingCaret.current);
      pendingCaret.current = null;
    }
  }, [text]);

  const pick = (c: SlashCommand): void => {
    const next = applyCommand(text, c);
    pendingCaret.current = next.caret;
    setText(next.text);
    setCaret(next.caret);
    setMenuIndex(0);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (menu.length > 0) {
      const c = menu[Math.min(menuIndex, menu.length - 1)]!;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const d = e.key === 'ArrowDown' ? 1 : -1;
        setMenuIndex((i) => (i + d + menu.length) % menu.length);
        return;
      }
      // Tab completes; Enter completes too, unless the command is already typed out (then it runs).
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && query !== c.name)) {
        e.preventDefault();
        pick(c);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMenuClosed(true);
        return;
      }
    }
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
    ? 'Session ended: reopen it to send messages'
    : busy
      ? canSteer
        ? 'Steer the agent while it works…'
        : 'The agent is working…'
      : status === 'failed'
        ? 'The agent stopped. Send a message to resume it…'
        : 'Message the agent… (/ for commands)';

  return (
    <div className="pb-safe shrink-0 border-t border-border bg-panel">
      <div className="mx-auto max-w-3xl px-3 pt-2 pb-2 md:px-5">
        <ErrorText error={send.error ?? interrupt.error ?? draft.error} />
        <div className="relative">
          {menu.length > 0 ? <CompletionMenu title="Commands" items={menu} index={Math.min(menuIndex, menu.length - 1)} onPick={pick} onHover={setMenuIndex} /> : null}
          <div
            className={cx('rounded-xl border border-border bg-bg px-2 py-1.5 focus-within:border-accent', disabled && 'opacity-70')}
            onDragOver={closed ? undefined : draft.onDragOver}
            onDrop={closed ? undefined : draft.onDrop}
          >
            <AttachmentTray draft={draft} />
            <textarea
              ref={ref}
              rows={1}
              value={text}
              onChange={(e) => edit(e.target.value, e.target.selectionStart)}
              onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
              onKeyDown={onKey}
              onPaste={draft.onPaste}
              placeholder={placeholder}
              disabled={closed}
              className="block max-h-[200px] min-h-[36px] w-full resize-none bg-transparent px-1.5 py-1.5 text-[15px] leading-6 placeholder:text-muted/80 focus:outline-none md:text-sm"
              aria-label="Message"
            />
            <div className="flex items-center gap-1">
              {caps?.images !== false ? <AttachImageButton draft={draft} disabled={closed} /> : null}
              <SessionChips sessionId={sessionId} disabled={closed} />
              <UsageText sessionId={sessionId} />
              {canInterrupt ? (
                <Button size="sm" variant="secondary" icon="stop" busy={interrupt.busy} onClick={() => void interrupt.run()} title="Interrupt the current turn">
                  <span className="hidden sm:inline">Stop</span>
                </Button>
              ) : null}
              <Button size="sm" variant="primary" icon="send" busy={send.busy} disabled={disabled || !ready} onClick={() => void send.run()} title={busy ? 'Steer' : 'Send'}>
                <span className="hidden sm:inline">{busy ? 'Steer' : 'Send'}</span>
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Model and effort as chips in the message box's toolbar, each shown only when the agent can change it
 * mid-session. A picked option applies at once; a typed model id on blur / Enter.
 */
function SessionChips(props: { sessionId: string; disabled: boolean }): ReactNode {
  const { sessionId } = props;
  const store = useStore();
  const caps = useBizzi((s) => s.capabilities[sessionId] ?? null);
  const session = useBizzi((s) => s.sessions[sessionId] ?? null);
  const set = useAction((patch: { model?: string; effort?: string }) => store.setSession(sessionId, patch));
  const [draft, setDraft] = useState<string | null>(null);
  const canModel = !!caps && !!session && session.mode === 'structured' && caps.setModelMidSession && (caps.models === 'dynamic' || caps.models.length > 0);
  const { models } = useAgentModels(session?.machineId, canModel ? session?.agent : '');
  if (!caps || !session || session.mode !== 'structured') return null;
  const model = session.model ?? '';
  const efforts = effortsFor(models, model, caps.effort ?? undefined);
  const error = set.error ? (set.error instanceof Error ? set.error.message : String(set.error)) : undefined;
  return (
    <div className={cx('flex min-w-0 items-center', props.disabled && 'pointer-events-none opacity-60')}>
      {canModel ? (
        <ModelPicker
          bare
          className="min-w-0"
          machineId={session.machineId}
          agent={session.agent}
          value={draft ?? model}
          defaultLabel="default model"
          onChange={setDraft}
          onCommit={(next) => {
            setDraft(null);
            if (next !== model) void set.run({ model: next });
          }}
          {...(Array.isArray(caps.models) ? { fixed: caps.models } : {})}
        />
      ) : null}
      {efforts.length > 0 ? (
        <ChipSelect display={session.effort ?? 'effort'} title="Effort" aria-label="Effort" value={session.effort ?? ''} onChange={(e) => void set.run({ effort: e.target.value })}>
          {!session.effort ? <option value="">default effort</option> : null}
          {efforts.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </ChipSelect>
      ) : null}
      {set.busy ? <Spinner size={11} className="ml-1 text-muted" /> : null}
      {error ? (
        <span className="ml-1 text-[11px] text-err" title={error}>
          couldn't switch
        </span>
      ) : null}
    </div>
  );
}

/**
 * Tokens and cost of the session, filling the toolbar's middle and pushing the buttons right. Context lives
 * in the header's context bar (usage.md §1.3), never estimated here.
 */
function UsageText(props: { sessionId: string }): ReactNode {
  const usage = useBizzi((s) => s.timelines[props.sessionId]?.usage ?? null);
  return (
    <div className="flex min-w-0 flex-1 items-center justify-end gap-3 truncate px-2 text-[11px] text-muted">
      {usage ? (
        <>
          <span className="hidden sm:inline" title="input / output tokens">
            {formatTokens(usage.inputTokens)} in · {formatTokens(usage.outputTokens)} out
          </span>
          {usage.cacheReadTokens ? <span className="hidden md:inline">{formatTokens(usage.cacheReadTokens)} cached</span> : null}
          {usage.costUsd !== undefined ? <span>{formatCost(usage.costUsd)}</span> : null}
        </>
      ) : null}
    </div>
  );
}
