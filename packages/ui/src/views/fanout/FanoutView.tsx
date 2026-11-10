import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { formatTokens, selectFanoutGroup } from '@bizzi/client';
import type { FanoutGroupModel, FanoutRunModel } from '@bizzi/client';
import { BizziError } from '@bizzi/protocol';
import type { GitFileStatus } from '@bizzi/protocol';
import { useBizzi, useStore } from '../../app/context.tsx';
import { navigate, useAction, useIsWide } from '../../app/hooks.ts';
import { useMachineOnline } from '../../app/machine.ts';
import { DiffBlock } from '../../components/DiffView.tsx';
import { Icon } from '../../components/icons.tsx';
import { AgentMark, Meter } from '../../components/marks.tsx';
import { Page, PageHeader } from '../../components/layout.tsx';
import { Badge, Button, Card, Empty, ErrorText, Spinner, Tabs, cx } from '../../components/ui.tsx';
import { formatCost } from '../../lib/format.ts';
import { routeHref } from '../../lib/router.ts';
import { AGENT_LABEL, BILLING_HINT, BILLING_LABEL, MARK_LABEL, MARK_TEXT } from '../../lib/states.ts';

/** What re-renders the compare view: per run, the fields it shows. */
function signature(g: FanoutGroupModel | null): string {
  if (!g) return '';
  return g.runs
    .map((r) => [r.session.id, r.session.status, r.state, r.workspace?.id ?? '', r.finalMessage?.length ?? 0, r.files.length, r.tokens ?? '', r.meteredUsd ?? '', r.contextLabel ?? '', r.model ?? ''].join('|'))
    .join('\n');
}

/**
 * Fan-out compare view (spec §12): the group's sessions side by side on desktop, tabbed on the phone:
 * status, final message, changed files with diffs, tokens, metered spend, context.
 */
export function FanoutView(props: { group: string }): ReactNode {
  const store = useStore();
  const group = useBizzi(
    (s) => selectFanoutGroup(s, props.group),
    (a, b) => signature(a) === signature(b),
  );
  const loaded = useBizzi((s) => s.sessionsLoaded);
  const wide = useIsWide();
  const [tab, setTab] = useState<string>('');
  const ids = group?.runs.map((r) => r.session.id).join(',') ?? '';

  // Subscribe to every run so status, final message, tokens and context are live.
  useEffect(() => {
    for (const id of ids.split(',').filter(Boolean)) store.openSession(id).catch(() => {});
  }, [store, ids]);

  const back = (): void => navigate(group ? { name: 'workspace', workspaceId: group.workspaceId } : { name: 'workspaces' });
  if (!group) {
    return (
      <Page header={<PageHeader title="Fan-out" back={back} />}>
        {loaded ? <Empty icon="tree" title="Fan-out not found">Its sessions may have been deleted.</Empty> : <Spinner />}
      </Page>
    );
  }
  const current = group.runs.find((r) => r.session.id === tab) ?? group.runs[0];
  return (
    <Page
      header={
        <PageHeader
          title={group.title}
          subtitle={
            <span>
              {group.runs.length} runs · {formatTokens(group.tokens)} tokens ·{' '}
              <span title="Spend on metered logins only; plan and budgetless runs don't count">metered {formatCost(group.meteredUsd)}</span>
            </span>
          }
          back={back}
        />
      }
    >
      {wide ? (
        <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.min(group.runs.length, 4)}, minmax(0, 1fr))` }}>
          {group.runs.map((r) => (
            <RunCard key={r.session.id} run={r} />
          ))}
        </div>
      ) : (
        <>
          <Tabs
            className="mb-3"
            value={current?.session.id ?? ''}
            onChange={setTab}
            items={group.runs.map((r, i) => ({ value: r.session.id, label: `${i + 1} ${AGENT_LABEL[r.session.agent]}`, badge: r.state !== 'ended' ? <span className={cx('text-[10px]', MARK_TEXT[r.state])}>●</span> : null }))}
          />
          {current ? <RunCard run={current} /> : null}
        </>
      )}
    </Page>
  );
}

interface WorktreeState {
  files: GitFileStatus[];
  diff: string;
}

function RunCard(props: { run: FanoutRunModel }): ReactNode {
  const r = props.run;
  const s = r.session;
  const store = useStore();
  const online = useMachineOnline(s.machineId);
  const [tree, setTree] = useState<WorktreeState | null>(null);
  const [treeErr, setTreeErr] = useState<unknown>(null);
  const live = s.status !== 'ended' && s.status !== 'failed';
  const wsId = r.workspace?.id;

  // The worktree's real state (git.status + git.diff); reloaded when the run settles.
  useEffect(() => {
    if (!wsId || !online) return;
    let on = true;
    Promise.all([store.client.request('git.status', { workspaceId: wsId }), store.client.request('git.diff', { workspaceId: wsId })])
      .then(([st, d]) => {
        if (!on) return;
        setTree({ files: st.files, diff: d.diff });
        setTreeErr(null);
      })
      .catch((e: unknown) => on && setTreeErr(e));
    return () => {
      on = false;
    };
  }, [store, wsId, online, r.state, r.files.length]);

  const stop = useAction(() => store.stop(s.id));
  const remove = useAction(async () => {
    if (!wsId) return;
    try {
      await store.removeWorktree(wsId);
    } catch (e) {
      const data = e instanceof BizziError ? (e.data as { sessions?: unknown } | undefined) : undefined;
      if (!(e instanceof BizziError && e.code === 'conflict') || data?.sessions !== undefined) throw e;
      if (!window.confirm(`${e.message}\n\nRemove the worktree anyway and discard them? The branch is kept.`)) return;
      await store.removeWorktree(wsId, true);
    }
  });

  const files = tree?.files ?? r.files.map((f) => ({ path: f.path, status: f.change === 'created' ? '??' : f.change === 'deleted' ? ' D' : ' M' }));
  const diff = tree?.diff ?? r.files.map((f) => f.diff ?? '').join('');
  return (
    <Card className="flex min-w-0 flex-col p-3">
      <div className="flex items-center gap-2">
        {r.state !== 'ended' ? <AgentMark agent={s.agent} state={r.state} size={18} /> : <Icon name="check" size={16} className="text-muted" />}
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">
            {AGENT_LABEL[s.agent]}
            {r.model ? <span className="font-normal text-muted"> · {r.model}</span> : null}
          </div>
          <div className="truncate font-mono text-[11px] text-muted">{r.branch ?? r.workspace?.name ?? (r.workspace ? '' : 'worktree removed')}</div>
        </div>
        {r.billing ? (
          <Badge tone={r.billing === 'metered' ? 'warn' : r.billing === 'budgetless' ? 'ok' : 'neutral'} title={BILLING_HINT[r.billing]}>
            {BILLING_LABEL[r.billing]}
          </Badge>
        ) : null}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        <span className={r.state !== 'ended' ? MARK_TEXT[r.state] : ''}>{r.state === 'ended' ? s.status : MARK_LABEL[r.state]}</span>
        <span>{r.tokens !== undefined ? `${formatTokens(r.tokens)} tokens` : 'tokens unknown'}</span>
        <span title="Metered spend counts; plan and budgetless runs show none">{r.billing === 'metered' ? formatCost(r.meteredUsd ?? 0) : r.billing === 'budgetless' ? 'free' : r.billing === 'plan' ? 'plan' : '–'}</span>
      </div>
      <div className="mt-1.5 flex items-center gap-2 text-xs text-muted">
        <span className="shrink-0">context</span>
        {r.context !== undefined ? (
          <>
            <Meter value={r.context} tone={r.context >= 0.8 ? 'warn' : 'neutral'} className="flex-1" />
            <span className="shrink-0 tabular-nums">{r.contextLabel}</span>
          </>
        ) : (
          <span>unknown</span>
        )}
      </div>

      <div className="mt-3 text-xs font-semibold tracking-wide text-muted uppercase">Final message</div>
      <div className="mt-1 max-h-48 overflow-y-auto text-sm whitespace-pre-wrap">{r.finalMessage ?? <span className="text-muted">No reply yet.</span>}</div>

      <div className="mt-3 text-xs font-semibold tracking-wide text-muted uppercase">
        Changed files <span className="font-normal normal-case">({files.length})</span>
      </div>
      {files.length > 0 ? (
        <ul className="mt-1 flex flex-col gap-0.5 font-mono text-xs">
          {files.map((f) => (
            <li key={f.path} className="flex gap-2">
              <span className="w-5 shrink-0 text-muted">{f.status.trim() || 'M'}</span>
              <span className="truncate">{f.path}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-1 text-xs text-muted">None.</div>
      )}
      {diff.trim() ? (
        <div className="mt-2 max-h-96 overflow-auto">
          <DiffBlock diff={diff} maxLines={400} />
        </div>
      ) : null}
      {treeErr ? <ErrorText error={treeErr} className="mt-2" /> : null}

      <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-border pt-2.5" style={{ marginTop: 12 }}>
        <a href={routeHref({ name: 'session', sessionId: s.id, tab: 'chat' })}>
          <Button size="sm" icon="chat">
            Open
          </Button>
        </a>
        {live ? (
          <Button size="sm" variant="ghost" icon="stop" disabled={!online} busy={stop.busy} onClick={() => void stop.run()}>
            Stop
          </Button>
        ) : null}
        {r.workspace ? (
          <Button
            size="sm"
            variant="ghost"
            icon="trash"
            disabled={!online || live}
            busy={remove.busy}
            title={live ? 'Stop the session first' : 'Delete the worktree directory; the branch is kept'}
            onClick={() => {
              if (window.confirm(`Remove the worktree ${r.branch ?? r.workspace?.name ?? ''}? The branch is kept.`)) void remove.run();
            }}
          >
            Remove worktree
          </Button>
        ) : null}
      </div>
      <ErrorText error={stop.error ?? remove.error} className="mt-2" />
    </Card>
  );
}
