import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { shallowEqual } from '@bizzi/client';
import type { WorkspaceInfo } from '@bizzi/protocol';
import { useBizzi, useStore } from '../app/context.tsx';
import { navigate, useAction } from '../app/hooks.ts';
import { Icon } from '../components/icons.tsx';
import { Page, PageHeader } from '../components/layout.tsx';
import { Badge, Button, Card, Checkbox, Empty, ErrorText, Field, Input, Spinner } from '../components/ui.tsx';
import { routeHref } from '../lib/router.ts';

export function WorkspacesView(): ReactNode {
  const machineId = useBizzi((s) => s.machine?.id ?? null);
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

  return (
    <Page
      header={
        <PageHeader
          title="Workspaces"
          subtitle="Directories on this machine where agents work"
          actions={
            <Button variant="primary" icon="plus" size="sm" onClick={() => setAdding((a) => !a)}>
              Add workspace
            </Button>
          }
        />
      }
    >
      {adding ? <AddWorkspaceForm onDone={() => setAdding(false)} /> : null}
      {!loaded ? (
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
      {otherCount > 0 ? (
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

function AddWorkspaceForm(props: { onDone: () => void }): ReactNode {
  const store = useStore();
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [create, setCreate] = useState(false);
  const action = useAction(async () => {
    const params: { path: string; name?: string; create?: boolean } = { path: path.trim() };
    if (name.trim()) params.name = name.trim();
    if (create) params.create = true;
    return store.createWorkspace(params);
  });
  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const ws = await action.run();
    if (ws) {
      props.onDone();
      navigate({ name: 'workspace', workspaceId: ws.id });
    }
  };
  return (
    <Card className="mb-4 p-4">
      <form onSubmit={(e) => void submit(e)} className="grid gap-3 sm:grid-cols-[2fr_1fr]">
        <Field label="Path on this machine">
          <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/Users/you/src/project" className="font-mono" autoFocus required spellCheck={false} autoCapitalize="off" />
        </Field>
        <Field label="Name (optional)">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="defaults to the folder name" />
        </Field>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          <Checkbox checked={create} onChange={setCreate} label="Create the directory if it does not exist" />
          <div className="flex-1" />
          <Button variant="ghost" onClick={props.onDone}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={action.busy} disabled={!path.trim()}>
            Add
          </Button>
        </div>
        <div className="sm:col-span-2">
          <ErrorText error={action.error} />
        </div>
      </form>
    </Card>
  );
}
