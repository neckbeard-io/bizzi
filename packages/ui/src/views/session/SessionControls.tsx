import { useState } from 'react';
import type { ReactNode } from 'react';
import { useBizzi, useStore } from '../../app/context.tsx';
import { useAction } from '../../app/hooks.ts';
import { ModelPicker } from '../../components/ModelPicker.tsx';
import { ErrorText, Select, Spinner } from '../../components/ui.tsx';

/** Model / permission mode / effort, each shown only when the agent's capabilities allow changing it. */
export function SessionControls(props: { sessionId: string; className?: string }): ReactNode {
  const { sessionId } = props;
  const store = useStore();
  const caps = useBizzi((s) => s.capabilities[sessionId] ?? null);
  const session = useBizzi((s) => s.sessions[sessionId] ?? null);
  const set = useAction((patch: { model?: string; permissionMode?: string; effort?: string }) => store.setSession(sessionId, patch));
  const [modelDraft, setModelDraft] = useState<string | null>(null);

  if (!caps || !session || session.mode !== 'structured') return null;
  const canModel = caps.setModelMidSession && (caps.models === 'dynamic' || caps.models.length > 0);
  const canPerm = caps.permissionModes.length > 0;
  const canEffort = (caps.effort?.length ?? 0) > 0;
  if (!canModel && !canPerm && !canEffort) return null;

  const label = 'flex items-center gap-1.5 text-xs text-muted';
  const select = 'h-7 w-auto min-w-24 py-0 text-xs';
  return (
    <div className={props.className}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {canModel ? (
          <div className={label}>
            Model
            <ModelPicker
              size="sm"
              className="min-w-40"
              machineId={session.machineId}
              agent={session.agent}
              value={modelDraft ?? session.model ?? ''}
              defaultLabel="default"
              onChange={(model) => {
                // A picked option applies at once; typed text applies on blur / Enter.
                setModelDraft(model);
              }}
              onCommit={(model) => {
                setModelDraft(null);
                if (model !== (session.model ?? '')) void set.run({ model });
              }}
              {...(Array.isArray(caps.models) ? { fixed: caps.models } : {})}
            />
          </div>
        ) : null}
        {canPerm ? (
          <label className={label}>
            Permissions
            <Select className={select} value={session.permissionMode ?? ''} onChange={(e) => void set.run({ permissionMode: e.target.value })}>
              {!session.permissionMode ? <option value="">default</option> : null}
              {caps.permissionModes.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
          </label>
        ) : null}
        {canEffort ? (
          <label className={label}>
            Effort
            <Select className={select} value={session.effort ?? ''} onChange={(e) => void set.run({ effort: e.target.value })}>
              {!session.effort ? <option value="">default</option> : null}
              {(caps.effort ?? []).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
          </label>
        ) : null}
        {set.busy ? <Spinner size={12} className="text-muted" /> : null}
      </div>
      <ErrorText error={set.error} />
    </div>
  );
}
