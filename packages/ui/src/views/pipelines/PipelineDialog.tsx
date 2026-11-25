import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { reviewPipeline, selectAgents } from '@bizzi/client';
import type { AgentKind, PipelineSpec, WorkspaceInfo } from '@bizzi/protocol';
import { useBizzi, useStore } from '../../app/context.tsx';
import { navigate, useAction } from '../../app/hooks.ts';
import { Button, Checkbox, ErrorText, Field, Input, Modal, Select, Textarea } from '../../components/ui.tsx';
import { AGENT_LABEL, BILLING_LABEL } from '../../lib/states.ts';

type Role = 'planner' | 'implementer' | 'reviewer';
const ROLES: { role: Role; label: string; hint: string }[] = [
  { role: 'planner', label: 'Planner', hint: 'read-only, in this workspace' },
  { role: 'implementer', label: 'Implementer', hint: "edits the pipeline's worktree" },
  { role: 'reviewer', label: 'Reviewer', hint: 'read-only, reads the diff' },
];

/**
 * Start a pipeline (docs/pipelines.md): planner → implementer → reviewer with gates, or a custom
 * definition as JSON. Stages run one after another on this workspace's machine.
 */
export function PipelineDialog(props: { workspace: WorkspaceInfo; onClose: () => void }): ReactNode {
  const { workspace: ws, onClose } = props;
  const store = useStore();
  const agents = useBizzi((s) => selectAgents(s, ws.machineId));
  const startable = useMemo(() => (agents ?? []).filter((a) => a.installed && a.capabilities?.modes.includes('structured')), [agents]);
  const first = startable[0]?.agent ?? 'claude';
  const pick = (prefer: AgentKind[]): AgentKind => prefer.find((a) => startable.some((x) => x.agent === a)) ?? first;

  const [task, setTask] = useState('');
  const [title, setTitle] = useState('');
  const [roles, setRoles] = useState<Record<Role, { agent: AgentKind | null; model: string }>>({
    planner: { agent: null, model: '' },
    implementer: { agent: null, model: '' },
    reviewer: { agent: null, model: '' },
  });
  const [gateImplement, setGateImplement] = useState(true);
  const [gateReview, setGateReview] = useState(false);
  const [budget, setBudget] = useState('');
  const [custom, setCustom] = useState<string | null>(null);
  const [customError, setCustomError] = useState<string | null>(null);

  const agentFor = (r: Role): AgentKind => roles[r].agent ?? (r === 'implementer' ? pick(['codex', 'claude']) : pick(['claude', 'codex', 'opencode']));
  const git = ws.kind !== 'dir';
  const built = (): PipelineSpec => {
    const spec = reviewPipeline({
      planner: agentFor('planner'),
      implementer: agentFor('implementer'),
      reviewer: agentFor('reviewer'),
      gateImplement,
      gateReview,
      plannerModel: roles.planner.model,
      implementerModel: roles.implementer.model,
      reviewerModel: roles.reviewer.model,
    });
    // Outside git there is no worktree: every stage runs in the workspace.
    if (!git) for (const s of spec.stages) delete s.where;
    const b = Number(budget);
    if (budget.trim() && Number.isFinite(b) && b > 0) spec.budgetUsd = b;
    return spec;
  };

  const start = useAction(async () => {
    let spec: PipelineSpec;
    if (custom !== null) {
      try {
        spec = JSON.parse(custom) as PipelineSpec;
      } catch (e) {
        setCustomError(`Not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    } else spec = built();
    setCustomError(null);
    const p = await store.startPipeline({ workspaceId: ws.id, spec, task: task.trim(), ...(title.trim() ? { title: title.trim() } : {}) });
    onClose();
    navigate({ name: 'pipeline', pipelineId: p.id });
  });

  return (
    <Modal
      wide
      title={`Pipeline in ${ws.name}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon="tree" disabled={!task.trim() || startable.length === 0} busy={start.busy} onClick={() => void start.run()}>
            Start pipeline
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field label="Task" hint="What {{task}} expands to in every stage's prompt">
          <Textarea rows={4} value={task} onChange={(e) => setTask(e.target.value)} placeholder="Add retry with backoff to the webhook sender" autoFocus />
        </Field>
        <Field label="Title" hint="Default: the task's first line">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        {startable.length === 0 ? <ErrorText error="No agent with structured sessions is installed on this machine." /> : null}
        {custom === null ? (
          <>
            <div className="grid gap-2 sm:grid-cols-3">
              {ROLES.map(({ role, label, hint }) => (
                <div key={role} className="flex flex-col gap-1.5 rounded-md border border-border p-2">
                  <span className="text-xs font-medium">{label}</span>
                  <Select value={agentFor(role)} onChange={(e) => setRoles((r) => ({ ...r, [role]: { ...r[role], agent: e.target.value as AgentKind } }))}>
                    {startable.map((a) => (
                      <option key={a.agent} value={a.agent}>
                        {AGENT_LABEL[a.agent]}
                        {a.billing ? ` · ${BILLING_LABEL[a.billing]}` : ''}
                      </option>
                    ))}
                  </Select>
                  <Input placeholder="model (default)" value={roles[role].model} onChange={(e) => setRoles((r) => ({ ...r, [role]: { ...r[role], model: e.target.value } }))} />
                  <span className="text-[11px] text-muted">{role === 'planner' || git ? hint : 'runs in this directory'}</span>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <Checkbox checked={gateImplement} onChange={setGateImplement} label="Approve the plan before implementing" />
              <Checkbox checked={gateReview} onChange={setGateReview} label="Approve before the review" />
            </div>
            <Field label="Metered spend cap for the run (USD)" hint="Checked before each stage; reaching it asks you before going on. Plan and budgetless logins don't count.">
              <Input className="w-40" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="none" />
            </Field>
            <button type="button" className="self-start text-xs text-muted underline hover:text-fg" onClick={() => setCustom(JSON.stringify(built(), null, 2))}>
              Edit the definition as JSON
            </button>
          </>
        ) : (
          <Field label="Definition" hint="Stages: name, agent, prompt (placeholders {{task}}, {{previous.result|diff|files}}, {{stages.<name>.result}}, {{gate.message}}), where, gate, model, permissionMode, budget.">
            <Textarea rows={16} className="font-mono text-xs" value={custom} onChange={(e) => setCustom(e.target.value)} spellCheck={false} />
            <button type="button" className="self-start text-xs text-muted underline hover:text-fg" onClick={() => setCustom(null)}>
              Back to the form
            </button>
          </Field>
        )}
        <ErrorText error={customError ?? start.error} />
      </div>
    </Modal>
  );
}
