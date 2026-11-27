import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { shallowEqual } from '@bizzi/client';
import type { KnowledgeInboxCard, KnowledgeItemInfo, KnowledgeScope, KnowledgeScopeLevel } from '@bizzi/protocol';
import { useBizzi, useStore } from '../../app/context.tsx';
import { useAction } from '../../app/hooks.ts';
import { Icon } from '../../components/icons.tsx';
import { SectionTitle } from '../../components/layout.tsx';
import { Badge, Button, ErrorText, Select, cx } from '../../components/ui.tsx';
import { formatRelative } from '../../lib/format.ts';
import { SCOPE_LEVELS, cardSummary, groupByScope, noticeAction, retargetScope, scopeLabel, splitInbox } from '../../lib/knowledge.ts';
import type { KnowledgeNotice, ScopeContext } from '../../lib/knowledge.ts';
import { routeHref } from '../../lib/router.ts';

type Target = 'keep' | KnowledgeScopeLevel;

function useScopeCtx(): ScopeContext {
  return useBizzi((s) => ({ machines: s.machines, workspaces: s.workspaces, sessions: s.sessions }), shallowEqual);
}

/**
 * Knowledge in the inbox, in two parts: suggestions waiting for a decision (one card per session,
 * accept / move / reject, in bulk), and changes agents already made that you can dismiss or undo.
 */
export function KnowledgeInbox(): ReactNode {
  const cards = useBizzi((s) => s.knowledgeInbox);
  const { suggestions, notices } = useMemo(() => splitInbox(cards ?? []), [cards]);
  if (suggestions.length === 0 && notices.length === 0) return null;
  return (
    <>
      {suggestions.length > 0 ? (
        <>
          <SectionTitle>Knowledge suggestions</SectionTitle>
          <div className="flex flex-col gap-4">
            {suggestions.map((c, i) => (
              <SuggestionCard key={c.sessionId ?? `card-${i}`} card={c} />
            ))}
          </div>
          <p className="mt-2 text-xs text-muted">Not live yet. Suggestions come from agents and transcripts; accepted items reach every matching session on every machine.</p>
        </>
      ) : null}
      {notices.length > 0 ? <RecentChanges notices={notices} /> : null}
    </>
  );
}

/** Changes that are already in effect: nothing to approve, only dismiss (keep) or undo. */
function RecentChanges(props: { notices: KnowledgeNotice[] }): ReactNode {
  const store = useStore();
  const ctx = useScopeCtx();
  const dismiss = useAction(async (ids: string[]) => store.acceptKnowledge(ids));
  const undo = useAction(async (ids: string[]) => store.rejectKnowledge(ids));
  const busy = dismiss.busy || undo.busy;
  const n = props.notices.length;
  return (
    <>
      <SectionTitle>Recent knowledge changes</SectionTitle>
      <div className="rounded-lg border border-border bg-panel">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
          <Icon name="check" size={16} className="shrink-0 text-ok" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">
              {n} change{n === 1 ? '' : 's'} already live
            </div>
            <div className="text-xs text-muted">Nothing to approve. Agents saved these because you asked or your settings allow it. Dismiss to keep them, or undo.</div>
          </div>
          <Button size="sm" icon="check" disabled={busy} onClick={() => void dismiss.run(props.notices.map((x) => x.item.id))}>
            Dismiss all
          </Button>
        </div>
        <ul className="divide-y divide-border">
          {props.notices.map((x) => (
            <NoticeRow key={x.item.id} notice={x} ctx={ctx} disabled={busy} onDismiss={() => void dismiss.run([x.item.id])} onUndo={() => void undo.run([x.item.id])} />
          ))}
        </ul>
        {dismiss.error || undo.error ? (
          <div className="px-3 pb-2">
            <ErrorText error={dismiss.error ?? undo.error} />
          </div>
        ) : null}
      </div>
    </>
  );
}

const NOTICE_LABEL = { added: 'added', updated: 'updated', forgot: 'forgotten' } as const;
const UNDO_HINT = {
  added: 'Undo removes it',
  updated: 'Undo brings back the previous version',
  forgot: 'Undo brings it back',
} as const;

function NoticeRow(props: { notice: KnowledgeNotice; ctx: ScopeContext; disabled: boolean; onDismiss: () => void; onUndo: () => void }): ReactNode {
  const { item: it, sessionId, agent } = props.notice;
  const session = useBizzi((s) => (sessionId ? (s.sessions[sessionId] ?? null) : null));
  const action = noticeAction(it);
  return (
    <li className="flex gap-2.5 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1">
          <Badge tone={it.type === 'rule' ? 'accent' : 'info'}>{it.type}</Badge>
          <Badge tone={action === 'forgot' ? 'warn' : 'ok'}>{NOTICE_LABEL[action]}</Badge>
          {it.source.userRequested ? <Badge tone="ok">you asked</Badge> : null}
          <span className={cx('min-w-0 font-medium break-words', action === 'forgot' && 'line-through decoration-muted')}>{it.title}</span>
        </div>
        {it.body ? <div className="mt-0.5 line-clamp-2 text-sm whitespace-pre-wrap text-muted">{it.body}</div> : null}
        <div className="mt-1 truncate text-xs text-muted">
          {scopeLabel(it.scope, props.ctx)}
          {agent ? <span className="capitalize">{` · ${agent}`}</span> : null}
          {sessionId ? (
            <>
              {' · '}
              <a className="hover:text-fg hover:underline" href={routeHref({ name: 'session', sessionId, tab: 'chat' })}>
                {session?.title ?? sessionId}
              </a>
            </>
          ) : null}
          {` · ${formatRelative(it.updatedAt)}`}
        </div>
      </div>
      <div className="flex shrink-0 flex-col gap-1 sm:flex-row sm:items-start">
        <Button size="sm" icon="check" disabled={props.disabled} onClick={props.onDismiss} title="Keep it and clear this notice">
          Dismiss
        </Button>
        <Button size="sm" variant="ghost" icon="back" disabled={props.disabled} onClick={props.onUndo} title={UNDO_HINT[action]}>
          Undo
        </Button>
      </div>
    </li>
  );
}

/** The scope an item would be accepted with (undefined = keep its own). */
function resolveTarget(item: KnowledgeItemInfo, t: Target, ctx: ScopeContext): KnowledgeScope | undefined | null {
  if (t === 'keep' || t === item.scope.level) return undefined;
  return retargetScope(item, t, ctx);
}

function SuggestionCard(props: { card: KnowledgeInboxCard }): ReactNode {
  const store = useStore();
  const { card } = props;
  const ctx = useScopeCtx();
  const session = useBizzi((s) => (card.sessionId ? (s.sessions[card.sessionId] ?? null) : null));
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [perItem, setPerItem] = useState<Readonly<Record<string, Target>>>({});
  const [bulk, setBulk] = useState<Target>('keep');
  const allSelected = card.items.length > 0 && card.items.every((i) => selected.has(i.id));
  const newest = useMemo(() => card.items.reduce((m, i) => (i.createdAt > m ? i.createdAt : m), ''), [card.items]);

  const accept = useAction(async (items: KnowledgeItemInfo[], override?: Target) => {
    const entries: { id: string; scope?: KnowledgeScope }[] = [];
    for (const it of items) {
      const scope = resolveTarget(it, override && override !== 'keep' ? override : (perItem[it.id] ?? 'keep'), ctx);
      if (scope === null) throw new Error(`Cannot move “${it.title}” to that scope: its session has no such ${override ?? perItem[it.id]}.`);
      entries.push(scope ? { id: it.id, scope } : { id: it.id });
    }
    for (const g of groupByScope(entries)) await store.acceptKnowledge(g.ids, g.scope);
    setSelected((cur) => new Set([...cur].filter((id) => !items.some((i) => i.id === id))));
  });
  const reject = useAction(async (ids: string[]) => {
    await store.rejectKnowledge(ids);
    setSelected((cur) => new Set([...cur].filter((id) => !ids.includes(id))));
  });
  const busy = accept.busy || reject.busy;
  const chosen = card.items.filter((i) => selected.has(i.id));

  const toggle = (id: string, on: boolean): void =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <div className="rounded-lg border border-border bg-panel">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
        <Icon name="sparkle" size={16} className="shrink-0 text-accent-text" />
        <div className="min-w-0 flex-1">
          <div className="font-medium first-letter:uppercase">{cardSummary(card)}</div>
          <div className="truncate text-xs text-muted">
            {card.agent ? <span className="capitalize">{card.agent}</span> : 'Extracted'}
            {card.sessionId ? (
              <>
                {' · '}
                <a className="hover:text-fg hover:underline" href={routeHref({ name: 'session', sessionId: card.sessionId, tab: 'chat' })}>
                  {session?.title ?? card.sessionId}
                </a>
              </>
            ) : null}
            {newest ? ` · ${formatRelative(newest)}` : ''}
          </div>
        </div>
        <Button size="sm" variant="primary" icon="check" disabled={busy} onClick={() => void accept.run(card.items)}>
          Accept all
        </Button>
      </div>
      <ul className="divide-y divide-border">
        {card.items.map((it) => (
          <SuggestionRow
            key={it.id}
            item={it}
            ctx={ctx}
            checked={selected.has(it.id)}
            onCheck={(on) => toggle(it.id, on)}
            target={perItem[it.id] ?? 'keep'}
            onTarget={(t) => setPerItem((cur) => ({ ...cur, [it.id]: t }))}
            disabled={busy}
            onAccept={() => void accept.run([it])}
            onReject={() => void reject.run([it.id])}
          />
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2">
        <label className="inline-flex items-center gap-2 text-xs text-muted select-none">
          <input
            type="checkbox"
            className="h-4 w-4 accent-[var(--primary)]"
            checked={allSelected}
            onChange={(e) => setSelected(e.target.checked ? new Set(card.items.map((i) => i.id)) : new Set())}
          />
          {chosen.length ? `${chosen.length} selected` : 'Select all'}
        </label>
        <div className="flex-1" />
        <Select className="h-7 w-auto py-0 text-xs" value={bulk} onChange={(e) => setBulk(e.target.value as Target)} aria-label="Accept selected as" disabled={chosen.length === 0}>
          <option value="keep">as suggested</option>
          {SCOPE_LEVELS.map((l) => (
            <option key={l} value={l}>
              as {l}
            </option>
          ))}
        </Select>
        <Button size="sm" icon="check" disabled={chosen.length === 0 || busy} onClick={() => void accept.run(chosen, bulk)}>
          Accept selected
        </Button>
        <Button size="sm" variant="ghost" icon="x" disabled={chosen.length === 0 || busy} onClick={() => void reject.run(chosen.map((i) => i.id))}>
          Reject selected
        </Button>
      </div>
      {accept.error || reject.error ? (
        <div className="px-3 pb-2">
          <ErrorText error={accept.error ?? reject.error} />
        </div>
      ) : null}
    </div>
  );
}

function SuggestionRow(props: {
  item: KnowledgeItemInfo;
  ctx: ScopeContext;
  checked: boolean;
  onCheck: (on: boolean) => void;
  target: Target;
  onTarget: (t: Target) => void;
  disabled: boolean;
  onAccept: () => void;
  onReject: () => void;
}): ReactNode {
  const { item: it, ctx } = props;
  const moved = props.target !== 'keep' && props.target !== it.scope.level ? retargetScope(it, props.target, ctx) : null;
  return (
    <li className={cx('flex gap-2.5 px-3 py-2.5', props.checked && 'bg-accent-soft/40')}>
      <input type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-[var(--primary)]" checked={props.checked} onChange={(e) => props.onCheck(e.target.checked)} aria-label={`Select ${it.title}`} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1">
          <Badge tone={it.type === 'rule' ? 'accent' : 'info'}>{it.type}</Badge>
          {it.kind ? <Badge>{it.kind}</Badge> : null}
          {it.appliesTo?.length ? <Badge tone="warn">only {it.appliesTo.join(', ')}</Badge> : null}
          {it.source.userRequested ? <Badge tone="ok">you asked</Badge> : null}
          <span className="min-w-0 font-medium break-words">{it.title}</span>
        </div>
        {it.body ? <div className="mt-0.5 line-clamp-2 text-sm whitespace-pre-wrap text-muted">{it.body}</div> : null}
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted">
          <span>Scope</span>
          <Select className="h-7 w-auto max-w-full py-0 text-xs" value={props.target} onChange={(e) => props.onTarget(e.target.value as Target)} aria-label="Accept with scope">
            <option value="keep">{scopeLabel(it.scope, ctx)}</option>
            {SCOPE_LEVELS.filter((l) => l !== it.scope.level).map((l) => {
              const s = retargetScope(it, l, ctx);
              return (
                <option key={l} value={l} disabled={!s}>
                  {s ? scopeLabel(s, ctx) : `${l} (unknown)`}
                </option>
              );
            })}
          </Select>
          {moved ? <span className="text-accent-text">will move from {it.scope.level}</span> : null}
        </div>
      </div>
      <div className="flex shrink-0 flex-col gap-1 sm:flex-row sm:items-start">
        <Button size="sm" icon="check" disabled={props.disabled} onClick={props.onAccept}>
          Accept
        </Button>
        <Button size="sm" variant="ghost" icon="x" disabled={props.disabled} onClick={props.onReject}>
          Reject
        </Button>
      </div>
    </li>
  );
}
