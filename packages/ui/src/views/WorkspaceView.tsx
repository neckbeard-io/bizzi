import { useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { selectAgents, selectWorkspaceSessions, shallowEqual } from '@bizzi/client';
import type { AgentKind, AgentListing, SessionInfo, SessionMode } from '@bizzi/protocol';
import { selectSessionPrompt } from '@bizzi/client';
import { useBizzi, useStore } from '../app/context.tsx';
import { navigate, useAction } from '../app/hooks.ts';
import { useMachine, useMachineOnline } from '../app/machine.ts';
import { OfflineMachineBanner } from '../components/OfflineMachineBanner.tsx';
import { Icon } from '../components/icons.tsx';
import { Page, PageHeader } from '../components/layout.tsx';
import { Badge, Button, Card, Empty, ErrorText, Field, Input, Select, Spinner, StatusBadge } from '../components/ui.tsx';
import { formatRelative } from '../lib/format.ts';
import { routeHref } from '../lib/router.ts';

export function WorkspaceView(props: { workspaceId: string }): ReactNode {
  const store = useStore();
  const ws = useBizzi((s) => s.workspaces?.[props.workspaceId] ?? null);
  const wsLoaded = useBizzi((s) => s.workspaces !== null);
  const sessions = useBizzi((s) => selectWorkspaceSessions(s, props.workspaceId), shallowEqual);
  const [creating, setCreating] = useState(false);
  const online = useMachineOnline(ws?.machineId);
  const machine = useMachine(ws?.machineId);
  const multiMachine = useBizzi((s) => s.role === 'hub' && Object.keys(s.machines).length > 1);
  const remove = useAction(async () => {
    await store.removeWorkspace(props.workspaceId);
    navigate({ name: 'workspaces' }, { replace: true });
  });

  if (!ws) {
    return (
      <Page header={<PageHeader title="Workspace" back={() => navigate({ name: 'workspaces' })} />}>
        {wsLoaded ? <Empty icon="folder" title="Workspace not found" /> : <Spinner />}
      </Page>
    );
  }

  return (
    <Page
      header={
        <PageHeader
          title={ws.name}
          subtitle={
            <span>
              {multiMachine && machine ? <span>{machine.name} · </span> : null}
              <span className="font-mono">{ws.path}</span>
            </span>
          }
          back={() => navigate({ name: 'workspaces' })}
          actions={
            <Button variant="primary" size="sm" icon="plus" disabled={!online} onClick={() => setCreating((c) => !c)}>
              New session
            </Button>
          }
        />
      }
    >
      <OfflineMachineBanner machineId={ws.machineId} className="mb-3" />
      {creating && online ? <NewSessionForm workspaceId={ws.id} onCancel={() => setCreating(false)} /> : null}
      {sessions.length === 0 ? (
        <Empty icon="chat" title="No sessions in this workspace">
          Start one with an installed agent.
        </Empty>
      ) : (
        <div className="grid gap-2">
          {sessions.map((s) => (
            <SessionRow key={s.id} session={s} />
          ))}
        </div>
      )}
      <div className="mt-8 flex flex-wrap items-center gap-2 border-t border-border pt-4 text-xs text-muted">
        <span className="flex-1">
          {ws.kind === 'git' ? 'Git repository' : 'Directory'} · added {formatRelative(ws.createdAt)}
        </span>
        <Button
          variant="ghost"
          size="sm"
          disabled={!online}
          busy={remove.busy}
          onClick={() => {
            if (window.confirm(`Remove "${ws.name}" from bizzi? Files on disk are not touched.`)) void remove.run();
          }}
        >
          Remove from bizzi
        </Button>
      </div>
      <ErrorText error={remove.error} />
    </Page>
  );
}

function SessionRow(props: { session: SessionInfo }): ReactNode {
  const s = props.session;
  const prompt = useBizzi((st) => selectSessionPrompt(st, s.id));
  return (
    <a href={routeHref({ name: 'session', sessionId: s.id, tab: 'chat' })} className="block">
      <Card className="flex items-center gap-3 p-3 hover:bg-panel-2">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-panel-2 text-muted">
          <Icon name={s.mode === 'terminal' ? 'terminal' : 'chat'} size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{s.title || 'Untitled session'}</div>
          <div className="truncate text-xs text-muted">
            <span className="capitalize">{s.agent}</span>
            {s.model ? ` · ${s.model}` : ''} · {formatRelative(s.updatedAt)}
            {s.forkedFrom ? ' · fork' : ''}
          </div>
        </div>
        <StatusBadge status={s.status} prompt={prompt} />
      </Card>
    </a>
  );
}

const FALLBACK_MODES: SessionMode[] = ['structured'];

function NewSessionForm(props: { workspaceId: string; onCancel: () => void }): ReactNode {
  const store = useStore();
  const agents = useBizzi((s) => selectAgents(s, s.workspaces?.[props.workspaceId]?.machineId ?? null));
  const installed = useMemo(() => (agents ?? []).filter((a) => a.installed), [agents]);
  const defaultAgent = installed.find((a) => a.auth === 'ok' && a.capabilities?.modes.includes('structured')) ?? installed[0];
  const [agent, setAgent] = useState<AgentKind | ''>(defaultAgent?.agent ?? '');
  const listing: AgentListing | undefined = installed.find((a) => a.agent === agent) ?? defaultAgent;
  const caps = listing?.capabilities;
  const modes = caps?.modes.length ? caps.modes : FALLBACK_MODES;
  const [modeChoice, setMode] = useState<SessionMode>('structured');
  const mode = modes.includes(modeChoice) ? modeChoice : (modes[0] ?? 'structured');
  const [model, setModel] = useState('');
  const [permissionMode, setPermissionMode] = useState('');
  const [effort, setEffort] = useState('');
  const [title, setTitle] = useState('');

  const create = useAction(async () => {
    if (!listing) throw new Error('No installed agent');
    const params: Parameters<typeof store.createSession>[0] = { workspaceId: props.workspaceId, agent: listing.agent, mode };
    if (title.trim()) params.title = title.trim();
    if (mode === 'structured') {
      if (model.trim()) params.model = model.trim();
      if (permissionMode) params.permissionMode = permissionMode;
      if (effort) params.effort = effort;
    } else {
      params.cols = 100;
      params.rows = 30;
    }
    return store.createSession(params);
  });

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const s = await create.run();
    if (s) navigate({ name: 'session', sessionId: s.id, tab: 'chat' });
  };

  if (agents === null) return <Spinner />;
  if (installed.length === 0) {
    return (
      <Card className="mb-4 p-4 text-sm text-muted">
        No agents are installed on this machine. See <a href={routeHref({ name: 'machine' })} className="text-accent underline">Machine</a> to install one.
      </Card>
    );
  }

  const structured = mode === 'structured';
  return (
    <Card className="mb-4 p-4">
      <form onSubmit={(e) => void submit(e)} className="grid gap-3 sm:grid-cols-2">
        <Field label="Agent">
          <Select value={listing?.agent ?? ''} onChange={(e) => setAgent(e.target.value as AgentKind)}>
            {installed.map((a) => (
              <option key={a.agent} value={a.agent}>
                {a.agent}
                {a.version ? ` ${a.version}` : ''}
                {a.auth !== 'ok' ? ` (${a.auth === 'expired' ? 'login expired' : 'not signed in'})` : ''}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Mode">
          <div className="flex h-9 gap-1 rounded-md border border-border p-0.5">
            {modes.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`flex-1 rounded px-2 text-sm capitalize ${mode === m ? 'bg-panel-2 font-medium' : 'text-muted'}`}
              >
                {m}
              </button>
            ))}
          </div>
        </Field>
        {structured && caps ? (
          <>
            {Array.isArray(caps.models) && caps.models.length > 0 ? (
              <Field label="Model">
                <Select value={model} onChange={(e) => setModel(e.target.value)}>
                  <option value="">Agent default</option>
                  {caps.models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : caps.models === 'dynamic' ? (
              <Field label="Model">
                <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="Agent default" spellCheck={false} autoCapitalize="off" />
              </Field>
            ) : null}
            {caps.permissionModes.length > 0 ? (
              <Field label="Permission mode">
                <Select value={permissionMode} onChange={(e) => setPermissionMode(e.target.value)}>
                  <option value="">Agent default</option>
                  {caps.permissionModes.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            {caps.effort?.length ? (
              <Field label="Effort">
                <Select value={effort} onChange={(e) => setEffort(e.target.value)}>
                  <option value="">Agent default</option>
                  {caps.effort.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
          </>
        ) : null}
        <Field label="Title (optional)" className="sm:col-span-2">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={structured ? 'What is this session about?' : 'Terminal'} />
        </Field>
        {listing && listing.auth !== 'ok' ? (
          <div className="text-xs text-warn sm:col-span-2">
            <Badge tone="warn">{listing.auth}</Badge> {listing.agent} may ask you to log in before it can work.
          </div>
        ) : null}
        <div className="flex items-center justify-end gap-2 sm:col-span-2">
          <Button variant="ghost" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" busy={create.busy}>
            Start session
          </Button>
        </div>
        <div className="sm:col-span-2">
          <ErrorText error={create.error} />
        </div>
      </form>
    </Card>
  );
}
