// Routing rules (spec §11.2 step 3, knowledge.md §9.3) and the recorded routes (the labelled set for
// choosing a classifier). Rules live where routing happens: on the hub, or on the node in local mode.
import { useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { selectMachineList } from '@bizzi/client';
import type { AgentKind, RouteDecision, RoutingRule } from '@bizzi/protocol';
import { useBizzi, useStore } from '../../app/context.tsx';
import { useAction } from '../../app/hooks.ts';
import { Button, ErrorText, Field, IconButton, Input, Select, Spinner } from '../../components/ui.tsx';
import { errorInfo } from '../../lib/format.ts';
import { ROUTABLE_AGENTS, parseRuleWords } from '../../lib/onePane.ts';
import { AGENT_LABEL } from '../../lib/states.ts';

type Loaded = { rules: RoutingRule[] } | { unsupported: true } | null;

export function RoutingRules(props: { draft?: { workspaceId: string }; onSaved?: () => void }): ReactNode {
  const store = useStore();
  const machines = useBizzi(selectMachineList);
  const workspaces = useBizzi((s) => s.workspaces);
  const [loaded, setLoaded] = useState<Loaded>(null);
  const [loadError, setLoadError] = useState<unknown>(null);

  useEffect(() => {
    store.getRouteRules().then(
      (rules) => setLoaded({ rules }),
      (e: unknown) => (errorInfo(e).code === 'unsupported' ? setLoaded({ unsupported: true }) : setLoadError(e)),
    );
  }, [store]);

  const save = useAction(async (rules: RoutingRule[]) => {
    const next = await store.setRouteRules(rules);
    setLoaded({ rules: next });
    return next;
  });

  const tags = useMemo(() => [...new Set(machines.flatMap((m) => m.tags))].sort(), [machines]);
  const wsList = useMemo(() => Object.values(workspaces ?? {}).filter((w) => w.kind !== 'worktree'), [workspaces]);
  const describe = (r: RoutingRule): string => {
    if (r.tag) return `machines tagged ${r.tag}`;
    if (r.machineId) return machines.find((m) => m.id === r.machineId)?.name ?? r.machineId;
    const w = wsList.find((x) => x.id === r.workspaceId);
    const m = w && machines.find((x) => x.id === w.machineId);
    return w ? `${m?.name ?? '?'} · ${w.name}` : (r.workspaceId ?? '?');
  };

  if (loadError) return <ErrorText error={loadError} />;
  if (!loaded) return <Spinner />;
  if ('unsupported' in loaded) return <div className="text-sm text-muted">This server doesn't keep routing rules yet.</div>;

  return (
    <div className="flex flex-col gap-3 text-sm">
      {!props.draft ? (
        loaded.rules.length ? (
          <ul className="flex flex-col gap-1">
            {loaded.rules.map((r) => (
              <li key={r.id} className="flex items-center gap-2 rounded-md border border-border px-2 py-1">
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-fg">{r.match.join(', ')}</span> <span className="text-muted">→ {describe(r)}</span>
                  {r.agent ? <span className="text-muted"> · {AGENT_LABEL[r.agent]}</span> : null}
                </span>
                <IconButton icon="trash" label="Remove rule" size={15} disabled={save.busy} onClick={() => void save.run(loaded.rules.filter((x) => x.id !== r.id))} />
              </li>
            ))}
          </ul>
        ) : (
          <div className="text-muted">No rules yet. A rule sends prompts with certain words to a machine tag, a machine or a workspace, before any classifier sees them.</div>
        )
      ) : null}
      <RuleForm
        tags={tags}
        machines={machines.map((m) => ({ id: m.id, name: m.name }))}
        workspaces={wsList.map((w) => ({ id: w.id, label: `${machines.find((m) => m.id === w.machineId)?.name ?? '?'} · ${w.name}` }))}
        initial={props.draft ? `ws:${props.draft.workspaceId}` : tags[0] ? `tag:${tags[0]}` : ''}
        busy={save.busy}
        onAdd={async (rule) => {
          const next = await save.run([...loaded.rules, rule]);
          if (next) props.onSaved?.();
        }}
      />
      <ErrorText error={save.error} />
      {!props.draft ? <RecordedRoutes /> : null}
    </div>
  );
}

function RuleForm(props: {
  tags: string[];
  machines: { id: string; name: string }[];
  workspaces: { id: string; label: string }[];
  initial: string;
  busy: boolean;
  onAdd: (rule: RoutingRule) => Promise<void>;
}): ReactNode {
  const [words, setWords] = useState('');
  const [to, setTo] = useState(props.initial);
  const [agent, setAgent] = useState<AgentKind | ''>('');
  const match = parseRuleWords(words);
  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const [kind, id = ''] = [to.slice(0, to.indexOf(':')), to.slice(to.indexOf(':') + 1)];
    if (!match.length || !id) return;
    // The server assigns the id.
    const rule: RoutingRule = { id: '', match, ...(kind === 'tag' ? { tag: id } : kind === 'machine' ? { machineId: id } : { workspaceId: id }), ...(agent ? { agent } : {}) };
    await props.onAdd(rule);
    setWords('');
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-2">
      <Field label="When the prompt mentions" hint="Comma-separated words or phrases; prod* matches production, prod-logs…">
        <Input value={words} onChange={(e) => setWords(e.target.value)} placeholder="production, prod*, checkout 502s" />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Field label="Send it to" className="min-w-48 flex-1">
          <Select value={to} onChange={(e) => setTo(e.target.value)}>
            {!to ? <option value="">Choose…</option> : null}
            {props.tags.length ? (
              <optgroup label="Machines tagged">
                {props.tags.map((t) => (
                  <option key={t} value={`tag:${t}`}>
                    {t}
                  </option>
                ))}
              </optgroup>
            ) : null}
            <optgroup label="Machine">
              {props.machines.map((m) => (
                <option key={m.id} value={`machine:${m.id}`}>
                  {m.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="Workspace">
              {props.workspaces.map((w) => (
                <option key={w.id} value={`ws:${w.id}`}>
                  {w.label}
                </option>
              ))}
            </optgroup>
          </Select>
        </Field>
        <Field label="Agent" className="w-36">
          <Select value={agent} onChange={(e) => setAgent(e.target.value as AgentKind | '')} className="w-36">
            <option value="">Default</option>
            {ROUTABLE_AGENTS.map((a) => (
              <option key={a} value={a}>
                {AGENT_LABEL[a]}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div>
        <Button type="submit" variant="primary" size="sm" icon="plus" busy={props.busy} disabled={!match.length || !to}>
          Add rule
        </Button>
      </div>
    </form>
  );
}

/** How many routed prompts were recorded, how many overrode the router, and a JSON download of them all. */
function RecordedRoutes(): ReactNode {
  const store = useStore();
  const [counts, setCounts] = useState<{ total: number; overridden: number } | null>(null);
  useEffect(() => {
    Promise.all([store.listRouteDecisions({ limit: 1 }), store.listRouteDecisions({ limit: 1, overridden: true })]).then(
      ([a, b]) => setCounts({ total: a.total, overridden: b.total }),
      () => setCounts(null),
    );
  }, [store]);
  const download = useAction(async () => {
    const all: RouteDecision[] = [];
    let before: string | undefined;
    for (;;) {
      const { decisions } = await store.listRouteDecisions({ limit: 1000, ...(before ? { before } : {}) });
      all.push(...decisions);
      if (decisions.length < 1000) break;
      before = decisions[decisions.length - 1]!.id;
    }
    const url = URL.createObjectURL(new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bizzi-routes.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  if (!counts) return null;
  return (
    <div className="flex items-center gap-2 border-t border-border pt-2 text-xs text-muted">
      <span className="flex-1">
        {counts.total} routed prompt{counts.total === 1 ? '' : 's'} recorded, {counts.overridden} moved by you. They become the labelled set for comparing classifiers.
      </span>
      {counts.total > 0 ? (
        <Button size="sm" variant="ghost" icon="download" busy={download.busy} onClick={() => void download.run()}>
          JSON
        </Button>
      ) : null}
    </div>
  );
}
