import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { BizziError } from '@bizzi/protocol';
import type { OrchestrationSettings } from '@bizzi/protocol';
import { useStore } from '../../app/context.tsx';
import { useAction } from '../../app/hooks.ts';
import { Button, Card, Checkbox, ErrorText, Field, Input, Select, Spinner } from '../../components/ui.tsx';

/**
 * Guardrails for agent-to-agent helpers (spec §12.2): depth, concurrency, what happens at the limit, who
 * answers helpers' approvals, and a metered budget per session tree. Per machine, optionally per workspace.
 */
export function OrchestrationPanel(props: { machineId: string; workspaceId?: string; online: boolean }): ReactNode {
  const { machineId, workspaceId, online } = props;
  const store = useStore();
  const [saved, setSaved] = useState<OrchestrationSettings | null>(null);
  const [draft, setDraft] = useState<OrchestrationSettings | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);

  useEffect(() => {
    if (!online) return;
    let live = true;
    setLoadError(null);
    store.getOrchestrationSettings(workspaceId ? { machineId, workspaceId } : { machineId }).then(
      (s) => {
        if (!live) return;
        setSaved(s);
        setDraft(s);
      },
      (e: unknown) => live && setLoadError(e),
    );
    return () => {
      live = false;
    };
  }, [store, machineId, workspaceId, online]);

  const save = useAction(async () => {
    if (!draft || !saved) return;
    const patch: Partial<OrchestrationSettings> = {};
    for (const k of Object.keys(draft) as (keyof OrchestrationSettings)[]) if (draft[k] !== saved[k]) (patch as Record<string, unknown>)[k] = draft[k];
    if (saved.treeBudgetUsd !== undefined && draft.treeBudgetUsd === undefined) patch.treeBudgetUsd = 0;
    const next = await store.setOrchestrationSettings(workspaceId ? { machineId, workspaceId, settings: patch } : { machineId, settings: patch });
    setSaved(next);
    setDraft(next);
  });

  if (!online) return <Card className="p-4 text-sm text-muted">Available when the machine is online.</Card>;
  if (loadError) {
    const unsupported = loadError instanceof BizziError && loadError.code === 'unsupported';
    return <Card className="p-4 text-sm text-muted">{unsupported ? 'This node does not support agent-to-agent settings yet.' : <ErrorText error={loadError} />}</Card>;
  }
  if (!draft || !saved) {
    return (
      <div className="flex justify-center py-4 text-muted">
        <Spinner />
      </div>
    );
  }
  const dirty = (Object.keys(draft) as (keyof OrchestrationSettings)[]).some((k) => draft[k] !== saved[k]) || draft.treeBudgetUsd !== saved.treeBudgetUsd;
  const num = (v: string, min: number, max: number): number => Math.min(max, Math.max(min, Math.round(Number(v) || 0)));
  const set = <K extends keyof OrchestrationSettings>(k: K, v: OrchestrationSettings[K]): void => setDraft({ ...draft, [k]: v });
  return (
    <Card className="p-4">
      <p className="mb-3 text-xs text-muted">
        {workspaceId ? 'Overrides for this workspace; everything else follows the machine.' : 'Limits for helpers that agents start through bizzi on this machine.'}
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Max depth" hint="parent → helper → helper's helper = 2">
          <Input type="number" min={0} max={5} value={draft.maxDepth} onChange={(e) => set('maxDepth', num(e.target.value, 0, 5))} />
        </Field>
        <Field label="Helpers per parent">
          <Input type="number" min={0} max={32} value={draft.maxHelpersPerParent} onChange={(e) => set('maxHelpersPerParent', num(e.target.value, 0, 32))} />
        </Field>
        <Field label="Helpers per machine">
          <Input type="number" min={0} max={64} value={draft.maxHelpersPerMachine} onChange={(e) => set('maxHelpersPerMachine', num(e.target.value, 0, 64))} />
        </Field>
        <Field label="At the limit">
          <Select value={draft.onLimit} onChange={(e) => set('onLimit', e.target.value as OrchestrationSettings['onLimit'])}>
            <option value="fail">Fail the start</option>
            <option value="queue">Queue it</option>
          </Select>
        </Field>
        <Field label="Tree budget (metered, USD)" hint="Plan and budgetless spend don't count">
          <Input
            type="number"
            min={0}
            step="0.5"
            placeholder="none"
            value={draft.treeBudgetUsd || ''}
            onChange={(e) => {
              const v = e.target.value;
              const next = { ...draft };
              if (v === '' || Number(v) <= 0) delete next.treeBudgetUsd;
              else next.treeBudgetUsd = Number(v);
              setDraft(next);
            }}
          />
        </Field>
        <div className="flex items-end pb-2">
          <Checkbox checked={draft.parentAnswersApprovals} onChange={(v) => set('parentAnswersApprovals', v)} label="Parent answers helpers' approvals" />
        </div>
      </div>
      <div className="mt-3 flex items-center justify-end gap-2">
        <ErrorText error={save.error} className="flex-1" />
        <Button size="sm" variant="ghost" disabled={!dirty} onClick={() => setDraft(saved)}>
          Reset
        </Button>
        <Button size="sm" variant="primary" disabled={!dirty} busy={save.busy} onClick={() => void save.run()}>
          Save
        </Button>
      </div>
    </Card>
  );
}
