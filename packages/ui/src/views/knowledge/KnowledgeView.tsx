import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { AgentKind, KnowledgeItemInfo, KnowledgeScopeLevel } from '@bizzi/protocol';
import { useBizzi, useStore } from '../../app/context.tsx';
import { navigate, useAction } from '../../app/hooks.ts';
import { useTargetMachineId } from '../../app/machine.ts';
import { Icon } from '../../components/icons.tsx';
import type { IconName } from '../../components/icons.tsx';
import { PageHeader } from '../../components/layout.tsx';
import { Badge, Button, Empty, ErrorText, IconButton, Input, Segmented, Select, Spinner, cx } from '../../components/ui.tsx';
import { formatRelative } from '../../lib/format.ts';
import { KNOWLEDGE_AGENTS, SCOPE_LEVELS, filterByAgent, scopeLabel } from '../../lib/knowledge.ts';
import type { ScopeContext } from '../../lib/knowledge.ts';
import { KnowledgeEditor, useScopeContext } from './KnowledgeEditor.tsx';
import type { EditorTarget } from './KnowledgeEditor.tsx';
import { PromoteDialog } from './PromoteDialog.tsx';

type LevelFilter = 'all' | KnowledgeScopeLevel;
type TypeFilter = 'all' | 'rule' | 'memory';

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Rules and memories, filtered by scope, type, agent and a search; create, edit, forget. */
export function KnowledgeView(): ReactNode {
  const store = useStore();
  const rev = useBizzi((s) => s.knowledgeRev);
  const open = useBizzi((s) => s.connection.state === 'open');
  const machineId = useTargetMachineId();
  const suggestions = useBizzi((s) => (s.knowledgeInbox ?? []).reduce((n, c) => n + c.items.length, 0));
  const ctx = useScopeContext();
  const [level, setLevel] = useState<LevelFilter>('all');
  const [type, setType] = useState<TypeFilter>('all');
  const [agent, setAgent] = useState<'all' | AgentKind>('all');
  const [query, setQuery] = useState('');
  const debounced = useDebounced(query.trim(), 250);
  const [items, setItems] = useState<KnowledgeItemInfo[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [promoting, setPromoting] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const params: Parameters<typeof store.listKnowledge>[0] = { limit: 500 };
    if (level !== 'all') params.scopeLevel = level;
    if (type !== 'all') params.type = type;
    if (debounced) params.query = debounced;
    store.listKnowledge(params).then(
      (r) => {
        if (cancelled) return;
        setItems(r);
        setError(null);
      },
      (e: unknown) => {
        if (!cancelled) setError(e);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [store, open, level, type, debounced, rev, machineId]);

  const visible = useMemo(() => filterByAgent(items ?? [], agent), [items, agent]);
  const filtered = level !== 'all' || type !== 'all' || agent !== 'all' || debounced !== '';

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Knowledge"
        subtitle="Rules every matching session gets, and memories agents recall"
        actions={
          <>
            <Button size="sm" variant="primary" icon="plus" onClick={() => setEditor({ mode: 'new', type: 'rule' })}>
              Rule
            </Button>
            <Button size="sm" icon="plus" onClick={() => setEditor({ mode: 'new', type: 'memory' })}>
              Memory
            </Button>
            <Button size="sm" icon="file" onClick={() => setPromoting(true)} title="Copy picked memories into a workspace's AGENTS.md">
              AGENTS.md…
            </Button>
            <IconButton icon="settings" label="Knowledge settings" onClick={() => navigate({ name: 'settings', section: 'knowledge' })} />
          </>
        }
      />
      <div className="shrink-0 border-b border-border bg-panel">
        <div className="mx-auto flex w-full max-w-4xl flex-wrap items-center gap-2 px-3 py-2 md:px-5">
          <div className="relative min-w-48 flex-1">
            <Icon name="search" size={15} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search titles, details, tags" className="pl-8" aria-label="Search knowledge" type="search" />
          </div>
          <Segmented<TypeFilter>
            size="sm"
            value={type}
            onChange={setType}
            items={[
              { value: 'all', label: 'All' },
              { value: 'rule', label: 'Rules' },
              { value: 'memory', label: 'Memories' },
            ]}
          />
          <Select className="h-8 w-auto py-0 text-xs" value={level} onChange={(e) => setLevel(e.target.value as LevelFilter)} aria-label="Scope">
            <option value="all">Every scope</option>
            {SCOPE_LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </Select>
          <Select className="h-8 w-auto py-0 text-xs" value={agent} onChange={(e) => setAgent(e.target.value as 'all' | AgentKind)} aria-label="Agent">
            <option value="all">Every agent</option>
            {KNOWLEDGE_AGENTS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </Select>
        </div>
        {suggestions > 0 ? (
          <div className="mx-auto w-full max-w-4xl px-3 pb-2 md:px-5">
            <a href="#/inbox" className="inline-flex items-center gap-1.5 text-xs text-accent-text hover:underline">
              <Icon name="sparkle" size={13} />
              {suggestions} suggestion{suggestions === 1 ? '' : 's'} waiting in the inbox
            </a>
          </div>
        ) : null}
      </div>
      <ErrorText error={error} className="mx-3 mt-2 md:mx-5" />
      <div className="min-h-0 flex-1">
        {items === null ? (
          <div className="flex h-full items-center justify-center text-muted">{error ? null : <Spinner />}</div>
        ) : visible.length === 0 ? (
          <Empty icon="book" title={filtered ? 'Nothing matches' : 'No knowledge yet'}>
            {filtered ? 'Try another scope, agent or search.' : 'Add a rule (“always use pnpm”) or a memory, or let agents suggest them while they work.'}
          </Empty>
        ) : (
          <KnowledgeList items={visible} ctx={ctx} onEdit={(item) => setEditor({ mode: 'edit', item })} />
        )}
      </div>
      {editor ? <KnowledgeEditor target={editor} onClose={() => setEditor(null)} /> : null}
      {promoting ? <PromoteDialog onClose={() => setPromoting(false)} /> : null}
    </div>
  );
}

/** Virtualized list: only visible rows are mounted; rows measure themselves (expandable bodies). */
function KnowledgeList(props: { items: KnowledgeItemInfo[]; ctx: ScopeContext; onEdit: (item: KnowledgeItemInfo) => void }): ReactNode {
  const { items } = props;
  const parentRef = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 132,
    overscan: 6,
    getItemKey: (i) => items[i]?.id ?? i,
    paddingStart: 12,
    paddingEnd: 24,
  });
  return (
    <div ref={parentRef} className="scrollbar-thin h-full overflow-y-auto">
      <div style={{ height: v.getTotalSize(), position: 'relative' }}>
        {v.getVirtualItems().map((vi) => {
          const item = items[vi.index];
          if (!item) return null;
          return (
            <div key={vi.key} data-index={vi.index} ref={v.measureElement} style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }}>
              <div className="mx-auto max-w-4xl px-3 py-1.5 md:px-5">
                <KnowledgeRow item={item} scope={scopeLabel(item.scope, props.ctx)} onEdit={props.onEdit} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const SCOPE_ICON: Record<KnowledgeScopeLevel, IconName> = { global: 'user', tag: 'tag', machine: 'machine', project: 'git', workspace: 'folder', session: 'chat', team: 'user' };

const VIA_LABEL: Record<KnowledgeItemInfo['source']['via'], string> = { ui: 'added by you', tool: 'saved by', harvest: 'imported from', extract: 'extracted from' };

const KnowledgeRow = memo(function KnowledgeRow(props: { item: KnowledgeItemInfo; scope: string; onEdit: (item: KnowledgeItemInfo) => void }): ReactNode {
  const store = useStore();
  const it = props.item;
  const [expanded, setExpanded] = useState(false);
  const forget = useAction(() => store.forgetKnowledge(it.id));
  const long = it.body.length > 220 || it.body.split('\n').length > 3;
  const src = it.source;
  const provenance = src.via === 'ui' ? VIA_LABEL.ui : `${VIA_LABEL[src.via]} ${src.agent ?? 'an agent'}`;
  return (
    <article className="rounded-lg border border-border bg-panel px-3.5 py-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-1">
            <Badge tone={it.type === 'rule' ? 'accent' : 'info'}>{it.type}</Badge>
            {it.kind ? <Badge>{it.kind}</Badge> : null}
            <Badge title="scope">
              <Icon name={SCOPE_ICON[it.scope.level]} size={11} />
              {props.scope}
            </Badge>
            {it.appliesTo?.length ? <Badge tone="warn">only {it.appliesTo.join(', ')}</Badge> : null}
          </div>
          <h3 className="font-medium break-words">{it.title}</h3>
        </div>
        <IconButton icon="edit" label="Edit" onClick={() => props.onEdit(it)} />
        <IconButton
          icon="trash"
          label="Forget"
          disabled={forget.busy}
          onClick={() => {
            if (window.confirm(`Forget “${it.title}”? Agents will stop seeing it.`)) void forget.run();
          }}
        />
      </div>
      {it.body ? (
        <div className={cx('mt-1 text-sm whitespace-pre-wrap text-muted', !expanded && long && 'line-clamp-3')}>{it.body}</div>
      ) : null}
      {long ? (
        <button type="button" className="mt-0.5 text-xs text-accent-text hover:underline" onClick={() => setExpanded((e) => !e)}>
          {expanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
        {it.tags.map((t) => (
          <span key={t} className="rounded bg-panel-2 px-1.5 py-0.5">
            #{t}
          </span>
        ))}
        <span className="ml-auto">
          {provenance}
          {src.userRequested ? ' at your request' : ''} · {formatRelative(it.updatedAt)}
        </span>
      </div>
      <ErrorText error={forget.error} className="mt-2" />
    </article>
  );
});
