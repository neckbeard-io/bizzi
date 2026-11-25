import { memo, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  ApprovalItem,
  ErrorItem,
  FileChangeItem,
  MessageItem,
  CompactItem,
  QuestionItem,
  RawItem,
  ReasoningItem,
  RestartItem,
  StatusItem,
  SteerItem,
  SubagentItem,
  TimelineItem,
  ToolItem,
  TurnEndItem,
  TurnItem,
} from '@bizzi/client';
import { questionSpecs, selectMachineOnline } from '@bizzi/client';
import type { ApprovalDecisionKind, ApprovalResolution, InputBlock, QuestionItem as QuestionSpec, ToolKind } from '@bizzi/protocol';
import { useBizzi, useStore } from '../../app/context.tsx';
import { useAction } from '../../app/hooks.ts';
import { DiffBlock } from '../../components/DiffView.tsx';
import { Icon } from '../../components/icons.tsx';
import type { IconName } from '../../components/icons.tsx';
import { Badge, Button, Disclosure, ErrorText, Input, Spinner, Textarea, cx } from '../../components/ui.tsx';
import { diffStats, parseUnifiedDiff } from '../../lib/diff.ts';
import { formatDuration, formatTokens, prettyJson, tail, usageSummary } from '../../lib/format.ts';
import { EMPTY_DRAFT, answerText, buildAnswers, isOptional, isQuickPick, missingAnswers, setText, toggleOption } from '../../lib/questions.ts';
import type { QuestionDraft } from '../../lib/questions.ts';
import { Markdown } from './Markdown.tsx';

/** One timeline row. Subscribes to its own item only, so a streaming delta re-renders just this row. */
export const TimelineRow = memo(function TimelineRow(props: { sessionId: string; itemId: string }): ReactNode {
  const item = useBizzi((s) => s.timelines[props.sessionId]?.items[props.itemId]);
  if (!item) return null;
  return <ItemView sessionId={props.sessionId} item={item} />;
});

function ItemView(props: { sessionId: string; item: TimelineItem }): ReactNode {
  const { item, sessionId } = props;
  switch (item.kind) {
    case 'turn':
      return <TurnRow item={item} />;
    case 'steer':
      return <SteerRow item={item} />;
    case 'message':
      return <MessageRow item={item} />;
    case 'reasoning':
      return <ReasoningRow item={item} />;
    case 'tool':
      return <ToolCard item={item} />;
    case 'approval':
      return <ApprovalCard sessionId={sessionId} item={item} />;
    case 'question':
      return <QuestionCard sessionId={sessionId} item={item} />;
    case 'file':
      return <FileChangeRow item={item} />;
    case 'turn-end':
      return <TurnEndRow item={item} />;
    case 'error':
      return <ErrorRow item={item} />;
    case 'status':
      return <StatusRow item={item} />;
    case 'subagent':
      return <SubagentRow item={item} />;
    case 'raw':
      return <RawRow item={item} />;
    case 'restart':
      return <RestartRow item={item} />;
    case 'compact':
      return <CompactRow item={item} />;
  }
}

/** Divider: "restarted on 2.1.322" (updates.md §5); the bizzi session and its seq carry on. */
function RestartRow(props: { item: RestartItem }): ReactNode {
  const r = props.item;
  const text =
    r.state === 'restarting'
      ? `restarting${r.toVersion ? ` on ${r.toVersion}` : ''}…`
      : r.state === 'ok'
        ? `restarted on ${r.toVersion ?? 'the installed version'}`
        : `restart failed${r.error ? `: ${r.error}` : ''}`;
  return (
    <div className={cx('flex items-center gap-3 text-xs', r.state === 'failed' ? 'text-err' : 'text-muted')} role="separator">
      <span className="h-px flex-1 bg-border" />
      {r.state === 'restarting' ? <Spinner size={11} /> : <Icon name="refresh" size={12} />}
      <span title={r.fromVersion ? `from ${r.fromVersion}${r.reason ? ` · ${r.reason}` : ''}` : r.reason}>{text}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function CompactRow(props: { item: CompactItem }): ReactNode {
  const c = props.item;
  const sizes = c.before !== undefined && c.after !== undefined ? ` · ${formatTokens(c.before)} → ${formatTokens(c.after)}` : '';
  return (
    <div className="flex items-center gap-3 text-xs text-muted" role="separator">
      <span className="h-px flex-1 bg-border" />
      <span>context compacted{sizes}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function UserBubble(props: { children: ReactNode }): ReactNode {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-accent-soft px-3.5 py-2 whitespace-pre-wrap text-fg">{props.children}</div>
    </div>
  );
}

function inputParts(input: readonly InputBlock[]): ReactNode[] {
  return input.map((b, i) =>
    b.type === 'text' ? (
      <span key={i}>{b.text}</span>
    ) : b.type === 'file' ? (
      <span key={i} className="font-mono text-xs">
        @{b.path}{' '}
      </span>
    ) : (
      <span key={i} className="text-xs text-muted">
        [image]{' '}
      </span>
    ),
  );
}

function TurnRow(props: { item: TurnItem }): ReactNode {
  const parts = inputParts(props.item.input);
  if (parts.length === 0) return null;
  return <UserBubble>{parts}</UserBubble>;
}

/** Input steered into the running turn: a user bubble marked as such. */
function SteerRow(props: { item: SteerItem }): ReactNode {
  const parts = inputParts(props.item.input);
  if (parts.length === 0) return null;
  return (
    <div className="flex flex-col items-end gap-0.5">
      <span className="flex items-center gap-1 pr-1 text-[11px] text-muted">
        <Icon name="send" size={11} /> steered mid-turn
      </span>
      <div className="max-w-[85%] rounded-2xl rounded-br-md border border-dashed border-accent/50 bg-accent-soft/60 px-3.5 py-2 whitespace-pre-wrap text-fg">{parts}</div>
    </div>
  );
}

function MessageRow(props: { item: MessageItem }): ReactNode {
  const m = props.item;
  if (m.role === 'user') return <UserBubble>{m.text}</UserBubble>;
  if (m.role === 'system') return <div className="text-xs whitespace-pre-wrap text-muted">{m.text}</div>;
  if (m.streaming) {
    // While streaming: plain pre-wrapped text (no markdown parse per delta).
    return (
      <div className="leading-relaxed whitespace-pre-wrap">
        {m.text}
        <span className="ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 animate-pulse bg-accent" />
      </div>
    );
  }
  return <Markdown text={m.text} className="leading-relaxed" />;
}

function ReasoningRow(props: { item: ReasoningItem }): ReactNode {
  const r = props.item;
  return (
    <Disclosure
      className="text-sm text-muted"
      header={
        <span className="flex min-w-0 items-center gap-1.5">
          {r.streaming ? <Spinner size={12} /> : <Icon name="brain" size={14} />}
          <span className="shrink-0">{r.streaming ? 'Thinking…' : r.summary ? 'Reasoning summary' : 'Thought'}</span>
          {!r.streaming ? <span className="min-w-0 truncate opacity-70">{r.text.split('\n')[0]}</span> : null}
        </span>
      }
    >
      {() => <div className="mt-1 ml-5 border-l-2 border-border pl-3 text-[13px] whitespace-pre-wrap">{r.text}</div>}
    </Disclosure>
  );
}

const TOOL_ICON: Record<ToolKind, IconName> = {
  shell: 'terminal',
  read: 'file',
  edit: 'file',
  write: 'file',
  search: 'refresh',
  web: 'link',
  mcp: 'tool',
  task: 'bolt',
  other: 'tool',
};

const TOOL_STATUS_TONE = { running: 'accent', ok: 'ok', error: 'err', denied: 'warn', cancelled: 'neutral' } as const;

const OUTPUT_LIMIT = 20_000;

export function ToolCard(props: { item: ToolItem }): ReactNode {
  const t = props.item;
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
  const out = full ? { text: t.output, truncated: 0 } : tail(t.output, OUTPUT_LIMIT);
  return (
    <div className={cx('rounded-lg border border-border bg-panel', t.parentToolId && 'ml-5')}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left">
        <Icon name={TOOL_ICON[t.toolKind]} size={15} className="shrink-0 text-muted" />
        <span className="shrink-0 text-xs font-medium text-muted">{t.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{t.title}</span>
        {t.approvalId ? <Badge tone="warn">needs approval</Badge> : null}
        {t.progress && t.status === 'running' ? <span className="shrink-0 text-xs text-muted">{t.progress}</span> : null}
        {t.status === 'running' ? <Spinner size={14} className="shrink-0 text-accent-text" /> : <Badge tone={TOOL_STATUS_TONE[t.status]}>{t.status}</Badge>}
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} className="shrink-0 text-muted" />
      </button>
      {open ? (
        <div className="space-y-2 border-t border-border px-3 py-2">
          {t.input !== undefined ? (
            <div>
              <div className="mb-1 text-[11px] font-medium text-muted uppercase">Input</div>
              <pre className="max-h-64 overflow-auto rounded bg-code p-2 font-mono text-xs whitespace-pre-wrap">{prettyJson(t.input)}</pre>
            </div>
          ) : null}
          {t.output ? (
            <div>
              <div className="mb-1 text-[11px] font-medium text-muted uppercase">Output</div>
              {out.truncated > 0 ? (
                <button type="button" className="mb-1 text-xs text-accent-text" onClick={() => setFull(true)}>
                  {out.truncated.toLocaleString()} earlier characters hidden. Show all
                </button>
              ) : null}
              <pre className="max-h-96 overflow-auto rounded bg-code p-2 font-mono text-xs whitespace-pre-wrap">{out.text}</pre>
            </div>
          ) : t.status === 'running' ? (
            <div className="text-xs text-muted">Waiting for output…</div>
          ) : null}
          {t.error ? <div className="text-xs text-err">{t.error}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

const DECISION_LABEL: Record<ApprovalResolution, string> = { allow: 'Allow', allow_always: 'Allow always', deny: 'Deny', cancelled: 'Cancelled' };

export function ApprovalCard(props: { sessionId: string; item: ApprovalItem; compact?: boolean }): ReactNode {
  const store = useStore();
  const editableCap = useBizzi((s) => s.capabilities[props.sessionId]?.editableApprovals ?? true);
  const online = useBizzi((s) => selectMachineOnline(s, s.sessions[props.sessionId]?.machineId));
  const a = props.item;
  const req = a.request;
  const editable = req.editable && editableCap && req.input !== undefined;
  const [editing, setEditing] = useState(false);
  const original = useMemo(() => prettyJson(req.input), [req.input]);
  const [draft, setDraft] = useState(original);
  const [note, setNote] = useState('');
  const [showNote, setShowNote] = useState(false);
  const [sent, setSent] = useState<ApprovalDecisionKind | null>(null);
  let parseError: string | null = null;
  let edited: unknown;
  if (editing) {
    try {
      edited = JSON.parse(draft);
    } catch (e) {
      parseError = e instanceof Error ? e.message : 'invalid JSON';
    }
  }
  const respond = useAction(async (decision: ApprovalDecisionKind) => {
    const d: { decision: ApprovalDecisionKind; message?: string; editedInput?: unknown } = { decision };
    if (note.trim()) d.message = note.trim();
    if (editing && decision !== 'deny' && draft !== original) d.editedInput = edited;
    await store.respondApproval(props.sessionId, a.approvalId, d);
    setSent(decision);
  });

  const pending = a.status === 'pending';
  return (
    <div className={cx('rounded-lg border bg-panel', pending ? 'border-warn/50 shadow-sm' : 'border-border')}>
      <div className="flex items-start gap-2 px-3 py-2.5">
        <Icon name="shield" size={16} className={cx('mt-0.5 shrink-0', pending ? 'text-warn' : 'text-muted')} />
        <div className="min-w-0 flex-1">
          <div className="font-medium break-words">{req.title}</div>
          {req.description ? <div className="mt-0.5 text-sm text-muted">{req.description}</div> : null}
        </div>
        {!pending ? (
          <Badge tone={a.status === 'expired' || a.decision === 'cancelled' ? 'neutral' : a.decision === 'deny' ? 'err' : 'ok'} title={a.decision === 'cancelled' ? 'The turn ended or the node restarted before anyone decided' : undefined}>
            {a.status === 'expired' ? 'expired' : a.decision ? DECISION_LABEL[a.decision] : 'resolved'}
            {a.by === 'parent' ? ' by parent' : ''}
          </Badge>
        ) : (
          <Badge tone="warn">{req.kind}</Badge>
        )}
      </div>
      {req.input !== undefined && (pending || !props.compact) ? (
        <div className="px-3 pb-2">
          {editing ? (
            <>
              <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={Math.min(14, draft.split('\n').length + 1)} className="font-mono text-xs" spellCheck={false} />
              {parseError ? <div className="mt-1 text-xs text-err">{parseError}</div> : null}
            </>
          ) : (
            <pre className="max-h-48 overflow-auto rounded bg-code p-2 font-mono text-xs whitespace-pre-wrap">{original}</pre>
          )}
        </div>
      ) : null}
      {pending ? (
        <div className="flex flex-col gap-2 border-t border-border px-3 py-2">
          {showNote ? <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Message to the agent (optional)" /> : null}
          <div className="flex flex-wrap items-center gap-1.5">
            {req.options.map((o) => (
              <Button
                key={o}
                size="sm"
                variant={o === 'deny' ? 'secondary' : o === 'allow' ? 'primary' : 'secondary'}
                icon={o === 'deny' ? 'x' : 'check'}
                busy={respond.busy && sent === null}
                disabled={!online || sent !== null || (editing && parseError !== null && o !== 'deny')}
                onClick={() => void respond.run(o)}
              >
                {DECISION_LABEL[o]}
              </Button>
            ))}
            <div className="flex-1" />
            {editable ? (
              <Button size="sm" variant="ghost" onClick={() => setEditing((e) => !e)}>
                {editing ? 'Cancel edit' : 'Edit input'}
              </Button>
            ) : null}
            {!showNote ? (
              <Button size="sm" variant="ghost" onClick={() => setShowNote(true)}>
                Add note
              </Button>
            ) : null}
          </div>
          {sent ? <div className="text-xs text-muted">Sent “{DECISION_LABEL[sent]}”, waiting for the agent…</div> : null}
          {!online ? <div className="text-xs text-warn">The machine is offline; you can decide once it reconnects.</div> : null}
          <ErrorText error={respond.error} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * A question from the agent (`question.asked`): one or more questions with options (single or multi
 * select), optional free text. Answers go out with `question.respond`; "Decline" cancels.
 */
export function QuestionCard(props: { sessionId: string; item: QuestionItem }): ReactNode {
  const store = useStore();
  const q = props.item;
  const specs = useMemo(() => questionSpecs(q), [q]);
  const online = useBizzi((s) => selectMachineOnline(s, s.sessions[props.sessionId]?.machineId));
  const [draft, setDraft] = useState<QuestionDraft>(EMPTY_DRAFT);
  const [sent, setSent] = useState<'answer' | 'cancel' | null>(null);
  const missing = missingAnswers(specs, draft);
  const quick = isQuickPick(specs);
  const respond = useAction(async (reply: { answers: Record<string, string | string[]> } | { cancel: true }) => {
    setSent('cancel' in reply ? 'cancel' : 'answer');
    try {
      await store.respondQuestion(props.sessionId, q.questionId, reply);
    } catch (e) {
      setSent(null);
      throw e;
    }
  });
  const pending = q.status === 'pending';
  const locked = !online || sent !== null || respond.busy;

  const pick = (spec: QuestionSpec, label: string): void => {
    const next = toggleOption(draft, spec, label);
    setDraft(next);
    if (quick) void respond.run({ answers: buildAnswers(specs, next) });
  };

  return (
    <div className={cx('rounded-lg border bg-panel', pending ? 'border-info/50 shadow-sm' : 'border-border')}>
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Icon name="question" size={16} className="shrink-0 text-info" />
        <span className="min-w-0 flex-1 text-sm font-medium">{specs.length > 1 ? `${specs.length} questions from the agent` : 'The agent asks'}</span>
        {pending ? <Badge tone="info">waiting for you</Badge> : q.status === 'cancelled' ? <Badge>declined{q.by === 'parent' ? ' by parent' : ''}</Badge> : <Badge tone="ok">answered{q.by === 'parent' ? ' by parent' : ''}</Badge>}
      </div>
      <div className="flex flex-col gap-3 px-3 py-2.5">
        {specs.map((spec) => (
          <QuestionField
            key={spec.id}
            spec={spec}
            draft={draft}
            pending={pending}
            locked={locked}
            answer={q.answers?.[spec.id]}
            showText={pending && (!!spec.allowText || !spec.options?.length)}
            onPick={(label) => pick(spec, label)}
            onText={(text) => setDraft((d) => setText(d, spec.id, text))}
          />
        ))}
      </div>
      {pending ? (
        <div className="flex flex-col gap-2 border-t border-border px-3 py-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {!quick ? (
              <Button
                size="sm"
                variant="primary"
                icon="send"
                busy={respond.busy && sent === 'answer'}
                disabled={locked || missing.length > 0}
                onClick={() => void respond.run({ answers: buildAnswers(specs, draft) })}
              >
                Send answer{specs.length > 1 ? 's' : ''}
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" busy={respond.busy && sent === 'cancel'} disabled={locked} onClick={() => void respond.run({ cancel: true })}>
              Decline
            </Button>
            <div className="flex-1" />
            {!quick && missing.length > 0 && specs.length > 1 ? <span className="text-xs text-muted">{missing.length} still unanswered</span> : null}
          </div>
          {sent && !respond.error ? <div className="text-xs text-muted">{sent === 'cancel' ? 'Declined' : 'Sent'}, waiting for the agent…</div> : null}
          {!online ? <div className="text-xs text-warn">The machine is offline; you can answer once it reconnects.</div> : null}
          <ErrorText error={respond.error} />
        </div>
      ) : null}
    </div>
  );
}

function QuestionField(props: {
  spec: QuestionSpec;
  draft: QuestionDraft;
  pending: boolean;
  locked: boolean;
  answer: string | string[] | undefined;
  showText: boolean;
  onPick: (label: string) => void;
  onText: (text: string) => void;
}): ReactNode {
  const { spec, draft } = props;
  const selected = draft.selected[spec.id] ?? [];
  const answered = props.answer !== undefined ? (typeof props.answer === 'string' ? [props.answer] : props.answer) : [];
  const described = spec.options?.some((o) => o.description) ?? false;
  return (
    <fieldset className="min-w-0">
      <legend className="mb-1.5 flex flex-wrap items-baseline gap-x-2">
        {spec.header ? <span className="rounded bg-info/10 px-1.5 py-px text-[11px] font-semibold tracking-wide text-info uppercase">{spec.header}</span> : null}
        <span className="text-sm whitespace-pre-wrap">{spec.text}</span>
        {props.pending && spec.multiSelect ? <span className="text-xs text-muted">choose any</span> : null}
        {props.pending && isOptional(spec) ? <span className="text-xs text-muted">optional</span> : null}
      </legend>
      {spec.options?.length ? (
        <div className={cx('grid gap-1.5', described ? 'grid-cols-1' : 'grid-cols-2 sm:grid-cols-4')}>
          {spec.options.map((o) => {
            const on = props.pending ? selected.includes(o.label) : answered.includes(o.label);
            return (
              <button
                key={o.label}
                type="button"
                role={spec.multiSelect ? 'checkbox' : 'radio'}
                aria-checked={on}
                disabled={!props.pending || props.locked}
                onClick={() => props.onPick(o.label)}
                className={cx(
                  'flex min-w-0 items-start gap-2 rounded-md border px-2.5 py-1.5 text-left text-sm transition-colors',
                  on ? 'border-accent bg-accent-soft' : 'border-border',
                  props.pending && !props.locked ? 'hover:bg-panel-2' : 'cursor-default',
                  !props.pending && !on && 'opacity-50',
                )}
              >
                <span
                  className={cx(
                    'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border',
                    spec.multiSelect ? 'rounded' : 'rounded-full',
                    on ? 'border-accent bg-accent text-accent-fg' : 'border-border',
                  )}
                >
                  {on ? <Icon name="check" size={11} strokeWidth={3} /> : null}
                </span>
                <span className="min-w-0">
                  <span className="block font-medium">{o.label}</span>
                  {o.description ? <span className="block text-xs text-muted">{o.description}</span> : null}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
      {props.showText ? (
        <Input
          className="mt-1.5"
          value={draft.text[spec.id] ?? ''}
          onChange={(e) => props.onText(e.target.value)}
          disabled={props.locked}
          placeholder={spec.options?.length ? 'Other (type your own answer)…' : 'Your answer…'}
        />
      ) : null}
      {!props.pending && props.answer !== undefined && !spec.options?.some((o) => answered.includes(o.label)) ? (
        <div className="mt-1 rounded-md bg-panel-2 px-2.5 py-1.5 text-sm">{answerText(props.answer)}</div>
      ) : null}
    </fieldset>
  );
}

function FileChangeRow(props: { item: FileChangeItem }): ReactNode {
  const f = props.item;
  const stats = useMemo(() => (f.diff ? diffStats(parseUnifiedDiff(f.diff, f.path)) : null), [f.diff, f.path]);
  const verb = f.change === 'created' ? 'Created' : f.change === 'deleted' ? 'Deleted' : 'Edited';
  const header = (
    <span className="flex min-w-0 flex-1 items-center gap-2 text-sm">
      <Icon name="file" size={14} className="shrink-0 text-muted" />
      <span className="shrink-0 text-muted">{verb}</span>
      <span className="min-w-0 truncate font-mono text-[13px]">{f.path}</span>
      {stats ? (
        <span className="shrink-0 font-mono text-xs">
          <span className="text-ok">+{stats.additions}</span> <span className="text-err">−{stats.deletions}</span>
        </span>
      ) : null}
    </span>
  );
  if (!f.diff) return <div className="flex items-center gap-1.5 pl-5">{header}</div>;
  const diff = f.diff;
  return (
    <Disclosure header={header} defaultOpen={(stats?.additions ?? 0) + (stats?.deletions ?? 0) <= 12}>
      {() => (
        <div className="mt-1.5">
          <DiffBlock diff={diff} path={f.path} maxLines={200} />
        </div>
      )}
    </Disclosure>
  );
}

function TurnEndRow(props: { item: TurnEndItem }): ReactNode {
  const t = props.item;
  const label =
    t.stopReason === 'end_turn' ? 'Done' : t.stopReason === 'interrupted' ? 'Interrupted' : t.stopReason === 'error' ? 'Failed' : t.stopReason.replace('_', ' ');
  const parts = [label];
  if (t.durationMs !== undefined) parts.push(`in ${formatDuration(t.durationMs)}`);
  const u = usageSummary(t.usage);
  return (
    <div className="flex items-center gap-3 py-1 text-xs text-muted">
      <div className="h-px flex-1 bg-border" />
      <span className={cx(t.stopReason === 'error' && 'text-err', t.stopReason === 'interrupted' && 'text-warn')}>
        {parts.join(' ')}
        {u ? ` · ${u}` : ''}
        {t.error ? ` · ${t.error}` : ''}
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

function ErrorRow(props: { item: ErrorItem }): ReactNode {
  const e = props.item;
  return (
    <div className="flex items-start gap-2 rounded-lg border border-err/30 bg-err/5 px-3 py-2 text-sm text-err">
      <Icon name="alert" size={16} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1 break-words">
        {e.message}
        {e.code ? <span className="ml-1 text-xs opacity-70">({e.code})</span> : null}
      </div>
      {e.fatal ? <Badge tone="err">fatal</Badge> : null}
    </div>
  );
}

function StatusRow(props: { item: StatusItem }): ReactNode {
  return (
    <div className="text-center text-xs text-muted">
      Session {props.item.status}
      {props.item.reason ? `: ${props.item.reason}` : ''}
    </div>
  );
}

function SubagentRow(props: { item: SubagentItem }): ReactNode {
  const s = props.item;
  return (
    <div className={cx('flex items-center gap-2 text-sm text-muted', s.parentToolId && 'ml-5')}>
      {s.status === 'running' ? <Spinner size={12} /> : <Icon name="bolt" size={14} />}
      <span>Subagent {s.name ?? s.subagentId}</span>
      {s.description ? <span className="min-w-0 truncate">· {s.description}</span> : null}
      {s.status !== 'running' ? <Badge tone={s.status === 'ok' ? 'ok' : s.status === 'error' ? 'err' : 'neutral'}>{s.status}</Badge> : null}
    </div>
  );
}

function RawRow(props: { item: RawItem }): ReactNode {
  return (
    <Disclosure className="text-xs text-muted" header={<span className="truncate">{props.item.agent} event</span>}>
      {() => <pre className="mt-1 max-h-64 overflow-auto rounded bg-code p-2 font-mono whitespace-pre-wrap">{prettyJson(props.item.payload)}</pre>}
    </Disclosure>
  );
}
