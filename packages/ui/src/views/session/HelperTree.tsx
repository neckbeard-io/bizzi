import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { selectHelperTree, selectHelperTreeModel } from '@bizzi/client';
import type { HelperTreeModel, HelperTreeNode } from '@bizzi/client';
import { useBizzi, useStore } from '../../app/context.tsx';
import { Icon } from '../../components/icons.tsx';
import { AgentMark } from '../../components/marks.tsx';
import { Badge, cx } from '../../components/ui.tsx';
import { formatCost, formatTokens } from '../../lib/format.ts';
import { routeHref } from '../../lib/router.ts';
import { AGENT_LABEL, BILLING_HINT, BILLING_LABEL, MARK_LABEL, MARK_TEXT } from '../../lib/states.ts';

/**
 * A parent's helpers as a tree (usage.md §2): agent, model, billing, context %, tokens, metered spend and
 * state. Totals at the root count metered spend only.
 */
export function HelperTree(props: { sessionId: string }): ReactNode {
  const { sessionId } = props;
  const store = useStore();
  const count = useBizzi((s) => selectHelperTree(s, sessionId).length);
  const [open, setOpen] = useState(false);
  const tree = useBizzi((s) => (count > 0 ? selectHelperTreeModel(s, sessionId) : null), treeEqual);

  // Subscribe to the helpers (a handful at most) so context, tokens and spend are live.
  useEffect(() => {
    for (const r of selectHelperTree(store.getState(), sessionId)) store.openSession(r.session.id).catch(() => {});
  }, [store, sessionId, count]);

  if (count === 0 || !tree) return null;
  return (
    <div className="shrink-0 border-b border-border bg-panel px-3 py-1.5 text-xs md:px-5">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-1.5 text-left" aria-expanded={open}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} className="text-muted" />
        <Icon name="tree" size={14} className="text-muted" />
        <span className="font-medium">
          {count} helper{count === 1 ? '' : 's'}
        </span>
        <span className="flex items-center gap-2">
          {tree.nodes.slice(1).map((n) => (n.state === 'ended' ? null : <AgentMark key={n.sessionId} agent={n.agent} state={n.state} size={14} compact backdrop="bg-panel" />))}
        </span>
        <span className="ml-auto text-muted" title="Metered spend of the whole tree (plan and budgetless sessions don't count)">
          metered {formatCost(tree.meteredUsd)}
        </span>
      </button>
      {open ? (
        <div className="mt-1.5 overflow-x-auto">
          <table className="w-full min-w-[560px] text-left">
            <thead className="text-[11px] text-muted">
              <tr>
                <th className="py-1 font-normal">Session</th>
                <th className="font-normal">Model</th>
                <th className="font-normal">Billing</th>
                <th className="text-right font-normal">Context</th>
                <th className="text-right font-normal">Tokens</th>
                <th className="text-right font-normal">Metered</th>
                <th className="pl-3 font-normal">State</th>
              </tr>
            </thead>
            <tbody>
              {tree.nodes.map((n) => (
                <TreeRow key={n.sessionId} node={n} root={n.sessionId === sessionId} />
              ))}
              <tr className="border-t border-border">
                <td className="py-1 text-muted" colSpan={5}>
                  Total (metered only)
                </td>
                <td className="text-right tabular-nums">{formatCost(tree.meteredUsd)}</td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function TreeRow(props: { node: HelperTreeNode; root: boolean }): ReactNode {
  const n = props.node;
  return (
    <tr className={cx(props.root && 'text-muted')}>
      <td className="max-w-[260px] py-1">
        <span className="flex items-center gap-1.5" style={{ paddingLeft: n.depth * 14 }}>
          {n.state !== 'ended' ? <AgentMark agent={n.agent} state={n.state} size={14} /> : <span className="w-3.5" />}
          <span className="text-muted">{AGENT_LABEL[n.agent]}</span>
          {props.root ? (
            <span className="truncate">{n.title}</span>
          ) : (
            <a className="truncate text-fg hover:underline" href={routeHref({ name: 'session', sessionId: n.sessionId, tab: 'chat' })}>
              {n.title}
            </a>
          )}
        </span>
      </td>
      <td className="max-w-[140px] truncate text-muted">{n.model ?? '–'}</td>
      <td>{n.billing ? <Badge title={BILLING_HINT[n.billing]}>{BILLING_LABEL[n.billing]}</Badge> : <span className="text-muted">–</span>}</td>
      <td className="text-right tabular-nums">{n.context !== undefined ? `${Math.round(n.context * 100)}%` : '–'}</td>
      <td className="text-right tabular-nums">{n.tokens !== undefined ? formatTokens(n.tokens) : '–'}</td>
      <td className="text-right tabular-nums">{n.meteredUsd !== undefined ? formatCost(n.meteredUsd) : '–'}</td>
      <td className={cx('pl-3', n.state === 'ended' ? 'text-muted' : MARK_TEXT[n.state])}>{n.state === 'ended' ? 'ended' : MARK_LABEL[n.state]}</td>
    </tr>
  );
}

function treeEqual(a: HelperTreeModel | null, b: HelperTreeModel | null): boolean {
  if (!a || !b) return a === b;
  if (a.meteredUsd !== b.meteredUsd || a.nodes.length !== b.nodes.length) return false;
  for (let i = 0; i < a.nodes.length; i++) {
    const x = a.nodes[i];
    const y = b.nodes[i];
    if (!x || !y) return false;
    for (const k of Object.keys(x) as (keyof HelperTreeNode)[]) if (x[k] !== y[k]) return false;
    if (Object.keys(x).length !== Object.keys(y).length) return false;
  }
  return true;
}
