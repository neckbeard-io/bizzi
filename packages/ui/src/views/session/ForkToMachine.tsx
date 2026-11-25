// Fork to another machine (topology.md §6): pick an online machine, optionally a target directory, and
// carry the session's work there as a new session. Only through a hub (the nodes talk through it).

import { useState } from 'react';
import type { ReactNode } from 'react';
import type { MachineInfo, SessionInfo } from '@bizzi/protocol';
import { useBizzi, useStore } from '../../app/context.tsx';
import { navigate, useAction } from '../../app/hooks.ts';
import { Button, ErrorText, Field, Input, Select } from '../../components/ui.tsx';

function isAgentMachine(m: MachineInfo): boolean {
  return !(m.roles?.length === 1 && m.roles[0] === 'hub');
}

export function ForkToMachine(props: { session: SessionInfo; onDone: () => void }): ReactNode {
  const { session } = props;
  const store = useStore();
  const machines = useBizzi((s) => s.machines);
  const kind = useBizzi((s) => s.workspaces?.[session.workspaceId]?.kind ?? null);
  const targets = Object.values(machines).filter((m) => m.online && m.id !== session.machineId && isAgentMachine(m));
  const [machineId, setMachineId] = useState<string>('');
  const [toPath, setToPath] = useState('');
  const [prompt, setPrompt] = useState('');
  const chosen = machineId || targets[0]?.id || '';
  const needsPath = kind === 'dir';
  const fork = useAction(async () => {
    const res = await store.forkSessionTo({
      sessionId: session.id,
      toMachineId: chosen,
      ...(toPath.trim() ? { toPath: toPath.trim() } : {}),
      ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
    });
    props.onDone();
    navigate({ name: 'session', sessionId: res.session.id, tab: 'chat' });
  });

  if (targets.length === 0) {
    return <p className="text-xs text-muted">No other machine is online to fork to.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted">
        Copies the workspace state ({kind === 'dir' ? 'a snapshot of the directory' : 'the branch plus uncommitted changes'}) to the other machine and starts a new session there with a brief
        from this one. This session keeps running here.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Machine" className="w-48">
          <Select value={chosen} onChange={(e) => setMachineId(e.target.value)}>
            {targets.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={needsPath ? 'New directory there' : 'New directory there (optional)'} className="min-w-[14rem] flex-1">
          <Input
            value={toPath}
            placeholder={needsPath ? '/path/on/that/machine' : 'default: a worktree of the linked repository'}
            onChange={(e) => setToPath(e.target.value)}
          />
        </Field>
      </div>
      <Field label="Next instruction (optional)">
        <Input value={prompt} placeholder="Carry on from where it left off" onChange={(e) => setPrompt(e.target.value)} />
      </Field>
      <div className="flex gap-2">
        <Button size="sm" icon="fork" busy={fork.busy} disabled={!chosen || (needsPath && !toPath.trim())} onClick={() => void fork.run()}>
          Fork to machine
        </Button>
        <Button size="sm" variant="ghost" onClick={props.onDone}>
          Cancel
        </Button>
      </div>
      <ErrorText error={fork.error} />
    </div>
  );
}
