import { useState } from 'react';
import type { ReactNode } from 'react';
import { useBizzi, useStore } from '../../app/context.tsx';
import { useAction } from '../../app/hooks.ts';
import { ErrorText, Input, Select, Spinner } from '../../components/ui.tsx';

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
          <label className={label}>
            Model
            {Array.isArray(caps.models) ? (
              <Select className={select} value={session.model ?? ''} onChange={(e) => void set.run({ model: e.target.value })}>
                {session.model && !caps.models.includes(session.model) ? <option value={session.model}>{session.model}</option> : null}
                {!session.model ? <option value="">default</option> : null}
                {caps.models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </Select>
            ) : (
              <Input
                className="h-7 w-40 text-xs"
                value={modelDraft ?? session.model ?? ''}
                placeholder="default"
                onChange={(e) => setModelDraft(e.target.value)}
                onBlur={() => {
                  if (modelDraft !== null && modelDraft !== (session.model ?? '')) void set.run({ model: modelDraft });
                  setModelDraft(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                }}
              />
            )}
          </label>
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
