import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { KnowledgeItemInfo, KnowledgePromotePreview } from '@bizzi/protocol';
import { useBizzi, useStore } from '../../app/context.tsx';
import { useAction } from '../../app/hooks.ts';
import { useTargetMachineId } from '../../app/machine.ts';
import { DiffBlock } from '../../components/DiffView.tsx';
import { Badge, Button, Empty, ErrorText, Field, Input, Modal, Select, Spinner } from '../../components/ui.tsx';
import { promotionCandidates, scopeLabel } from '../../lib/knowledge.ts';
import { useScopeContext } from './KnowledgeEditor.tsx';

export const DEFAULT_HEADING = 'Notes from bizzi memory';

const SKIP_REASON: Record<KnowledgePromotePreview['skipped'][number]['reason'], string> = {
  not_found: 'not found',
  inactive: 'no longer active',
  already_promoted: 'already in AGENTS.md',
  not_visible: 'not visible in this workspace',
};

/**
 * "Add to AGENTS.md…" (knowledge.md §8): pick memories, preview the diff to the workspace's AGENTS.md
 * (appended under a heading you choose), write. bizzi never commits; written memories get the
 * `promoted` tag and aren't offered again.
 */
export function PromoteDialog(props: { onClose: () => void; workspaceId?: string }): ReactNode {
  const store = useStore();
  const ctx = useScopeContext();
  const machineId = useTargetMachineId();
  const rev = useBizzi((s) => s.knowledgeRev);
  const workspaces = useMemo(
    () => Object.values(ctx.workspaces ?? {}).filter((w) => ctx.machines[w.machineId]?.online !== false).sort((a, b) => a.name.localeCompare(b.name)),
    [ctx.workspaces, ctx.machines],
  );
  const [workspaceId, setWorkspaceId] = useState(props.workspaceId ?? workspaces.find((w) => w.machineId === machineId)?.id ?? workspaces[0]?.id ?? '');
  const workspace = workspaceId ? ctx.workspaces?.[workspaceId] : undefined;
  const [items, setItems] = useState<KnowledgeItemInfo[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [heading, setHeading] = useState(DEFAULT_HEADING);
  const [preview, setPreview] = useState<KnowledgePromotePreview | null>(null);
  const [written, setWritten] = useState<{ path: string; count: number; created: boolean } | null>(null);

  useEffect(() => {
    let cancelled = false;
    store.listKnowledge({ type: 'memory', status: 'active', limit: 2000 }).then(
      (r) => !cancelled && setItems(r),
      (e: unknown) => !cancelled && setLoadError(e),
    );
    return () => {
      cancelled = true;
    };
  }, [store, rev]);

  const candidates = useMemo(
    () => (items && workspace ? promotionCandidates(items, workspace, ctx.machines[workspace.machineId]) : []),
    [items, workspace, ctx.machines],
  );

  // Any change to the inputs invalidates the preview.
  useEffect(() => setPreview(null), [workspaceId, picked, heading]);
  useEffect(() => setPicked(new Set()), [workspaceId]);

  const ids = candidates.filter((c) => picked.has(c.id)).map((c) => c.id);
  const previewAction = useAction(async () => {
    setPreview(await store.previewPromotion({ workspaceId, ids, heading }));
  });
  const write = useAction(async () => {
    if (!preview) return;
    const res = await store.promoteKnowledge({ workspaceId, ids: preview.ids, heading: preview.heading, baseHash: preview.baseHash });
    setWritten({ path: res.path, count: res.promoted.length, created: res.created });
  });

  const toggle = (id: string, on: boolean): void =>
    setPicked((cur) => {
      const next = new Set(cur);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  if (written) {
    return (
      <Modal title="Added to AGENTS.md" onClose={props.onClose} footer={<Button variant="primary" onClick={props.onClose}>Done</Button>}>
        <p className="text-sm">
          {written.created ? 'Created' : 'Updated'} <code className="break-all">{written.path}</code> with {written.count} {written.count === 1 ? 'memory' : 'memories'}.
        </p>
        <p className="mt-2 text-sm text-muted">Nothing was committed: review and commit the change yourself.</p>
      </Modal>
    );
  }

  return (
    <Modal
      wide
      title="Add to AGENTS.md…"
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          {preview ? (
            <Button variant="primary" busy={write.busy} onClick={() => void write.run()}>
              Write AGENTS.md
            </Button>
          ) : (
            <Button variant="primary" busy={previewAction.busy} disabled={ids.length === 0 || !workspace} onClick={() => void previewAction.run()}>
              Preview
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">
          Copies the memories you pick into the workspace’s <code>AGENTS.md</code>, which every agent reads natively. bizzi appends them under a heading and
          never commits.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Workspace">
            <Select value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} · {ctx.machines[w.machineId]?.name ?? w.machineId}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Heading">
            <Input value={heading} onChange={(e) => setHeading(e.target.value)} placeholder={DEFAULT_HEADING} />
          </Field>
        </div>
        <ErrorText error={loadError} />
        {items === null && !loadError ? (
          <div className="flex justify-center py-6 text-muted">
            <Spinner />
          </div>
        ) : candidates.length === 0 ? (
          <Empty icon="book" title="Nothing to add">
            No active memories reach this workspace, or they are all in AGENTS.md already.
          </Empty>
        ) : (
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-xs font-medium text-muted">
              Memories ({ids.length} of {candidates.length} picked)
            </legend>
            {candidates.map((c) => (
              <label key={c.id} className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 hover:bg-panel-2">
                <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--primary)]" checked={picked.has(c.id)} onChange={(e) => toggle(c.id, e.target.checked)} />
                <span className="min-w-0 flex-1">
                  <span className="text-sm break-words">{c.title}</span>
                  {c.body ? <span className="line-clamp-1 text-xs text-muted">{c.body}</span> : null}
                </span>
                <Badge className="shrink-0">{scopeLabel(c.scope, ctx)}</Badge>
              </label>
            ))}
          </fieldset>
        )}
        <ErrorText error={previewAction.error ?? write.error} />
        {preview ? (
          <div className="flex flex-col gap-2">
            <div className="text-xs text-muted">
              {preview.exists ? 'Appends to' : 'Creates'} <code className="break-all">{preview.path}</code>
            </div>
            {preview.warnings.map((w) => (
              <div key={w} className="rounded-md border border-warn/30 bg-warn/5 px-3 py-2 text-sm">
                {w}
              </div>
            ))}
            {preview.skipped.length > 0 ? (
              <div className="text-xs text-muted">
                Skipped: {preview.skipped.map((s) => `${candidates.find((c) => c.id === s.id)?.title ?? s.id} (${SKIP_REASON[s.reason]})`).join(', ')}
              </div>
            ) : null}
            <div className="overflow-hidden rounded-md border border-border">
              <DiffBlock diff={preview.diff} path="AGENTS.md" />
            </div>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
