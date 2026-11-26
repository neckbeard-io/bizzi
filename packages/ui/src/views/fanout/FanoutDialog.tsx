import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  PRICE_TABLE_NOTE,
  budgetlessAgents,
  defaultBranchPrefix,
  fanoutBranch,
  formatTokens,
  formatUsd,
  loadBaselines,
  preflightRun,
  preflightTotal,
  selectAccounts,
  selectAgents,
  startFanout,
} from '@bizzi/client';
import type { FanoutRunResult, FanoutRunSpec, RunPreflight } from '@bizzi/client';
import type { AccountUsage, AgentKind, AgentListing, ContextBaseline, WidgetValue, WorkspaceInfo } from '@bizzi/protocol';
import { useBizzi, useStore } from '../../app/context.tsx';
import { navigate, useAction } from '../../app/hooks.ts';
import { Icon } from '../../components/icons.tsx';
import { Badge, Button, ErrorText, Field, IconButton, Input, Modal, Select, Textarea, cx } from '../../components/ui.tsx';
import { ModelPicker } from '../../components/ModelPicker.tsx';
import { AGENT_LABEL, BILLING_HINT, BILLING_LABEL } from '../../lib/states.ts';

const MAX_RUNS = 6;

interface RunDraft {
  key: number;
  agent: AgentKind;
  model: string;
  /** Text field; empty = no per-run budget. */
  budget: string;
}

function accountsEqual(a: AccountUsage[], b: AccountUsage[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function widgetsEqual(a: WidgetValue[], b: WidgetValue[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

let draftKey = 0;

/**
 * Fan-out (spec §12): the same prompt to N sessions, each in a new worktree, possibly different agents
 * and models. Shows the preflight per run (usage.md §2) before anything starts.
 */
export function FanoutDialog(props: { workspace: WorkspaceInfo; onClose: () => void }): ReactNode {
  const { workspace: ws, onClose } = props;
  const store = useStore();
  const agents = useBizzi((s) => selectAgents(s, ws.machineId));
  const accounts = useBizzi(selectAccounts, accountsEqual);
  const widgets = useBizzi((s) => Object.values(s.widgets), widgetsEqual);
  const git = useBizzi((s) => s.gitStatus[ws.id] ?? null);
  const startable = useMemo(() => (agents ?? []).filter((a) => a.installed && a.capabilities?.modes.includes('structured')), [agents]);

  const [prompt, setPrompt] = useState('');
  const [prefix, setPrefix] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunDraft[]>([]);
  const [baselines, setBaselines] = useState<ContextBaseline[]>([]);
  const [treeBudgetUsd, setTreeBudgetUsd] = useState<number | undefined>(undefined);
  const [results, setResults] = useState<{ group: string; runs: FanoutRunResult[] } | null>(null);
  const branchPrefix = prefix ?? defaultBranchPrefix(git?.branch ?? ws.branch);

  // Start with one run per startable agent (up to three), so the comparison is across agents.
  useEffect(() => {
    if (runs.length > 0 || startable.length === 0) return;
    setRuns(startable.slice(0, 3).map((a) => ({ key: ++draftKey, agent: a.agent, model: '', budget: '' })));
  }, [startable, runs.length]);

  useEffect(() => {
    let live = true;
    loadBaselines(store, ws.machineId)
      .then((b) => live && setBaselines(b))
      .catch(() => {});
    store
      .getOrchestrationSettings({ machineId: ws.machineId, workspaceId: ws.id })
      .then((s) => live && setTreeBudgetUsd(s.treeBudgetUsd ?? undefined))
      .catch(() => {});
    if (ws.kind !== 'dir') store.loadGitStatus(ws.id).catch(() => {});
    return () => {
      live = false;
    };
  }, [store, ws.machineId, ws.id, ws.kind]);

  const specs: FanoutRunSpec[] = runs.map((r) => {
    const spec: FanoutRunSpec = { agent: r.agent };
    if (r.model.trim()) spec.model = r.model.trim();
    const b = Number(r.budget);
    if (r.budget.trim() && Number.isFinite(b) && b > 0) spec.budgetUsd = b;
    return spec;
  });
  const ctx = { machineId: ws.machineId, workspaceId: ws.parentWorkspaceId ?? ws.id, agents: agents ?? [], accounts, baselines, widgets, ...(treeBudgetUsd !== undefined ? { treeBudgetUsd } : {}) };
  const preflights = specs.map((spec) => preflightRun(spec, ctx));
  const total = preflightTotal(preflights);
  const budgetless = budgetlessAgents(agents ?? []);
  const branchOk = /^[\w][\w./-]*$/.test(branchPrefix) && !branchPrefix.includes('..');
  const valid = prompt.trim().length > 0 && runs.length > 0 && branchOk;

  const update = (key: number, patch: Partial<RunDraft>): void => setRuns((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const start = useAction(async () => {
    const res = await startFanout(store, { workspaceId: ws.id, prompt: prompt.trim(), runs: specs, branchPrefix });
    if (res.runs.every((r) => !r.error)) {
      onClose();
      navigate({ name: 'fanout', group: res.group });
      return;
    }
    setResults(res);
  });

  return (
    <Modal
      wide
      title={`Fan out from ${ws.name}`}
      onClose={onClose}
      footer={
        results ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            {results.runs.some((r) => r.session) ? (
              <Button
                variant="primary"
                icon="tree"
                onClick={() => {
                  onClose();
                  navigate({ name: 'fanout', group: results.group });
                }}
              >
                Compare the runs that started
              </Button>
            ) : null}
          </>
        ) : (
          <>
            <span className="mr-auto text-xs text-muted" title={PRICE_TABLE_NOTE}>
              {total.usdPerTurn > 0 || total.partial ? (
                <>
                  metered ≈ {formatUsd(total.usdPerTurn)} per turn{total.partial ? ' + runs without an estimate' : ''} <span className="opacity-70">(estimate)</span>
                </>
              ) : (
                'no metered spend expected'
              )}
            </span>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" icon="branch" disabled={!valid} busy={start.busy} onClick={() => void start.run()}>
              Start {runs.length} run{runs.length === 1 ? '' : 's'}
            </Button>
          </>
        )
      }
    >
      {results ? (
        <ResultList results={results.runs} />
      ) : (
        <div className="flex flex-col gap-3">
          <Field label="Prompt" hint="Sent unchanged to every run.">
            <Textarea autoFocus rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="What should each run do?" />
          </Field>
          <Field label="Branch prefix" hint={`Each run gets its own worktree on ${fanoutBranch(branchPrefix || 'prefix', 1, runs[0]?.agent ?? 'claude')}, …, from ${git?.branch ?? 'HEAD'}.`}>
            <Input value={branchPrefix} onChange={(e) => setPrefix(e.target.value)} spellCheck={false} autoCapitalize="off" className="font-mono" />
          </Field>
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted">Runs</span>
            <Button
              size="sm"
              variant="ghost"
              icon="plus"
              disabled={runs.length >= MAX_RUNS || startable.length === 0}
              onClick={() => setRuns((rs) => [...rs, { key: ++draftKey, agent: rs[rs.length - 1]?.agent ?? startable[0]!.agent, model: '', budget: '' }])}
            >
              Add run
            </Button>
          </div>
          {startable.length === 0 ? <div className="text-sm text-muted">No agent on this machine can start structured sessions.</div> : null}
          <div className="flex flex-col gap-2">
            {runs.map((r, i) => (
              <RunRow
                key={r.key}
                machineId={ws.machineId}
                index={i}
                draft={r}
                agents={startable}
                baselines={baselines}
                preflight={preflights[i]!}
                onChange={(patch) => update(r.key, patch)}
                onRemove={runs.length > 1 ? () => setRuns((rs) => rs.filter((x) => x.key !== r.key)) : undefined}
              />
            ))}
          </div>
          {budgetless.length === 0 && preflights.some((p) => p.billing !== 'budgetless') ? (
            <div className="text-xs text-muted">No budgetless agent is installed on this machine (an agent whose probe reports billing "budgetless"), so there's nothing to swap to.</div>
          ) : null}
          <div className="text-[11px] text-muted">Estimates use the starting context bizzi has learned here × {PRICE_TABLE_NOTE.toLowerCase()}. Budgets and spend count what the agents report.</div>
          <ErrorText error={start.error} />
        </div>
      )}
    </Modal>
  );
}

function RunRow(props: {
  machineId: string;
  index: number;
  draft: RunDraft;
  agents: AgentListing[];
  baselines: ContextBaseline[];
  preflight: RunPreflight;
  onChange: (patch: Partial<RunDraft>) => void;
  onRemove: (() => void) | undefined;
}): ReactNode {
  const { draft: r, preflight: p } = props;
  const listing = props.agents.find((a) => a.agent === r.agent);
  const models = listing?.capabilities?.models;
  const known = [...new Set(props.baselines.filter((b) => b.agent === r.agent && b.model).map((b) => b.model!))];
  return (
    <div className="rounded-md border border-border p-2.5">
      <div className="grid grid-cols-[auto_1fr_auto] items-end gap-2 sm:grid-cols-[auto_9rem_1fr_6rem_auto]">
        <span className="pb-2 text-xs text-muted tabular-nums">{props.index + 1}</span>
        <Field label="Agent">
          <Select value={r.agent} onChange={(e) => props.onChange({ agent: e.target.value as AgentKind, model: '' })}>
            {props.agents.map((a) => (
              <option key={a.agent} value={a.agent}>
                {AGENT_LABEL[a.agent]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Model" className="col-span-2 row-start-2 sm:col-span-1 sm:row-start-auto">
          <ModelPicker
            machineId={props.machineId}
            agent={r.agent}
            value={r.model}
            onChange={(model) => props.onChange({ model })}
            fixed={Array.isArray(models) ? models : known}
          />
        </Field>
        <Field label="Budget $" className="row-start-2 sm:row-start-auto">
          <Input value={r.budget} onChange={(e) => props.onChange({ budget: e.target.value })} inputMode="decimal" placeholder="none" title="Metered spend cap for this run (session budget)" />
        </Field>
        {props.onRemove ? <IconButton icon="x" label="Remove run" onClick={props.onRemove} className="mb-1" /> : <span />}
      </div>
      <PreflightLine preflight={p} onSwap={p.swap ? () => props.onChange({ agent: p.swap!.agent, model: p.swap!.model ?? '' }) : undefined} />
    </div>
  );
}

/** Billing class, baseline and estimated cost per turn for one run (usage.md §2). */
function PreflightLine(props: { preflight: RunPreflight; onSwap: (() => void) | undefined }): ReactNode {
  const p = props.preflight;
  const e = p.estimate;
  return (
    <div className="mt-2 flex flex-col gap-1 text-xs">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted">
        {p.billing ? (
          <Badge tone={p.billing === 'metered' ? 'warn' : p.billing === 'budgetless' ? 'ok' : 'neutral'} title={`${BILLING_HINT[p.billing]}${p.billingSource ? ` (from the ${p.billingSource === 'probe' ? 'agent probe' : 'login usage'})` : ''}`}>
            {BILLING_LABEL[p.billing]}
          </Badge>
        ) : (
          <Badge title="bizzi doesn't know this login's billing class yet">billing unknown</Badge>
        )}
        <span title="Starting context learned from earlier sessions (median)">
          {p.baseline ? (
            <>
              starts at ≈ {formatTokens(p.baseline.tokens)}
              {p.baselineElsewhere ? ' (other workspace)' : ''}
            </>
          ) : (
            'no baseline yet'
          )}
        </span>
        <span>
          {e.kind === 'metered' ? (
            <span title={`${e.price.label}: $${e.price.inputPerMTok}/M input. ${PRICE_TABLE_NOTE}.`}>≈ {formatUsd(e.usdPerTurn)} / turn (estimate)</span>
          ) : e.kind === 'metered-unknown' ? (
            `metered: no estimate (${e.reason})`
          ) : e.kind === 'free' ? (
            <>free{e.load ? ` · ${e.load.label} ${e.load.value ?? '–'}${e.load.max !== undefined ? `/${e.load.max}` : ''}` : ''}</>
          ) : e.kind === 'plan' ? (
            e.window ? (
              `${e.account?.label ?? 'plan'} · ${e.window.label} ${Math.round(e.window.usedPercent)}%`
            ) : (
              'plan · no window data'
            )
          ) : null}
        </span>
        {props.onSwap ? (
          <button type="button" className="ml-auto inline-flex items-center gap-1 text-accent-text hover:underline" onClick={props.onSwap} title="Run this one on a budgetless model instead">
            <Icon name="bolt" size={12} />
            Use {AGENT_LABEL[p.swap!.agent]}
            {p.swap!.model ? ` · ${p.swap!.model}` : ''} (budgetless)
          </button>
        ) : null}
      </div>
      {p.warnings.map((w) => (
        <div key={w} className={cx('flex items-start gap-1 text-warn')}>
          <Icon name="alert" size={12} className="mt-0.5 shrink-0" />
          {w}
        </div>
      ))}
    </div>
  );
}

function ResultList(props: { results: FanoutRunResult[] }): ReactNode {
  return (
    <div className="flex flex-col gap-2 text-sm">
      <div className="text-muted">Some runs didn't start:</div>
      {props.results.map((r) => (
        <div key={r.index} className="flex items-start gap-2">
          <Icon name={r.error ? 'alert' : 'check'} size={14} className={cx('mt-0.5 shrink-0', r.error ? 'text-err' : 'text-ok')} />
          <span className="font-mono text-xs">{r.branch}</span>
          <span className={cx('min-w-0 flex-1', r.error ? 'text-err' : 'text-muted')}>{r.error ?? `${AGENT_LABEL[r.spec.agent]} started`}</span>
        </div>
      ))}
    </div>
  );
}
