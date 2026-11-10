import { useMemo, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { shallowEqual } from '@bizzi/client';
import type { WorkspaceInfo } from '@bizzi/protocol';
import { useBizzi } from '../app/context.tsx';
import { navigate, useIsWide } from '../app/hooks.ts';
import { useMachine, useMachineOnline, useTargetMachineId } from '../app/machine.ts';
import { OfflineMachineBanner } from '../components/OfflineMachineBanner.tsx';
import { Icon } from '../components/icons.tsx';
import { Page, PageHeader } from '../components/layout.tsx';
import { Badge, Button, Card, Checkbox, Empty, Spinner } from '../components/ui.tsx';
import { pickerRequestFromHash } from '../lib/picker.ts';
import { routeHref } from '../lib/router.ts';
import { MachineTree } from './sidebar/MachineTree.tsx';
import { WorkspacePicker } from './workspaces/WorkspacePicker.tsx';

function subscribeHash(cb: () => void): () => void {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
}

/** `#/workspaces?add=1[&machine=…][&path=…]` opens the picker (deep link for any "Add workspace" entry point). */
function usePickerRequest(): { machineId?: string; path?: string } | null {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash, () => '');
  return useMemo(() => pickerRequestFromHash(hash), [hash]);
}

export function WorkspacesView(): ReactNode {
  const machineId = useTargetMachineId();
  const machine = useMachine(machineId);
  const online = useMachineOnline(machineId);
  const wide = useIsWide();
  const hub = useBizzi((s) => s.role === 'hub');
  const loaded = useBizzi((s) => s.workspaces !== null);
  const [showAll, setShowAll] = useState(false);
  const workspaces = useBizzi(
    (s) =>
      Object.values(s.workspaces ?? {})
        .filter((w) => showAll || !machineId || w.machineId === machineId)
        .sort((a, b) => a.name.localeCompare(b.name)),
    shallowEqual,
  );
  const otherCount = useBizzi((s) => Object.values(s.workspaces ?? {}).filter((w) => machineId && w.machineId !== machineId).length);
  const [adding, setAdding] = useState(false);
  const request = usePickerRequest();
  const closePicker = (): void => {
    setAdding(false);
    if (request) navigate({ name: 'workspaces' }, { replace: true });
  };

  return (
    <Page
      header={
        <PageHeader
          title="Workspaces"
          subtitle={machine ? `Directories on ${machine.name} where agents work` : 'Directories where agents work'}
          actions={
            <Button variant="primary" icon="plus" size="sm" disabled={!online} onClick={() => setAdding(true)}>
              Add workspace
            </Button>
          }
        />
      }
    >
      <OfflineMachineBanner machineId={machineId} className="mb-3" />
      {adding || request ? <WorkspacePicker machineId={request?.machineId ?? machineId} {...(request?.path ? { initialPath: request.path } : {})} onClose={closePicker} /> : null}
      {!wide ? (
        // Phone: the sidebar's machine → workspace structure, rows 1–2 only (spec §11.1).
        <MachineTree variant="phone" className="-mx-2" />
      ) : !loaded ? (
        <div className="flex justify-center py-10 text-muted">
          <Spinner />
        </div>
      ) : workspaces.length === 0 ? (
        <Empty icon="folder" title="No workspaces yet">
          Add a git repository or a plain directory to start a session in it.
        </Empty>
      ) : (
        <div className="grid gap-2">
          {workspaces.map((w) => (
            <WorkspaceRow key={w.id} workspace={w} foreign={machineId !== null && w.machineId !== machineId} />
          ))}
        </div>
      )}
      {wide && otherCount > 0 ? (
        <div className="mt-4">
          <Checkbox checked={showAll} onChange={setShowAll} label={`Show workspaces on other machines (${otherCount})`} />
        </div>
      ) : null}
    </Page>
  );
}

function WorkspaceRow(props: { workspace: WorkspaceInfo; foreign: boolean }): ReactNode {
  const w = props.workspace;
  const counts = useBizzi((s) => {
    let total = 0;
    let attention = 0;
    let running = 0;
    for (const x of Object.values(s.sessions)) {
      if (x.workspaceId !== w.id) continue;
      total++;
      if (x.status === 'waiting_approval' || x.status === 'waiting_input') attention++;
      else if (x.status === 'running' || x.status === 'starting') running++;
    }
    return { total, attention, running };
  }, shallowEqual);
  return (
    <a href={routeHref({ name: 'workspace', workspaceId: w.id })} className="block">
      <Card className="flex items-center gap-3 p-3 hover:bg-panel-2">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-panel-2 text-muted">
          <Icon name={w.kind === 'git' ? 'git' : 'folder'} size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{w.name}</div>
          <div className="truncate font-mono text-xs text-muted">{w.path}</div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
          {props.foreign ? <Badge>other machine</Badge> : null}
          {counts.attention ? <Badge tone="warn">{counts.attention} waiting</Badge> : null}
          {counts.running ? <Badge tone="accent">{counts.running} running</Badge> : null}
          <Badge>{counts.total} sessions</Badge>
        </div>
      </Card>
    </a>
  );
}
