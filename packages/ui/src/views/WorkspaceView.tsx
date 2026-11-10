import { useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { selectAgents, selectNestedSessions, selectSessionPrompt, shallowEqual, treeRowsEqual } from '@bizzi/client';
import { BizziError } from '@bizzi/protocol';
import type { AgentKind, AgentListing, SessionInfo, SessionMode, WorkspaceInfo } from '@bizzi/protocol';
import { useBizzi, useStore } from '../app/context.tsx';
import { navigate, useAction } from '../app/hooks.ts';
import { useMachine, useMachineOnline } from '../app/machine.ts';
import { OfflineMachineBanner } from '../components/OfflineMachineBanner.tsx';
import { Icon } from '../components/icons.tsx';
import { Page, PageHeader } from '../components/layout.tsx';
import { Badge, Button, Card, Disclosure, Empty, ErrorText, Field, Input, Modal, Select, Spinner, StatusBadge, cx } from '../components/ui.tsx';
import { WidgetRow } from '../components/Widget.tsx';
import { formatRelative } from '../lib/format.ts';
import { routeHref } from '../lib/router.ts';
import { AGENT_LABEL, BILLING_HINT, BILLING_LABEL, aheadBehind } from '../lib/states.ts';
import { OrchestrationPanel } from './settings/OrchestrationPanel.tsx';

export function WorkspaceView(props: { workspaceId: string }): ReactNode {
  const store = useStore();
  const ws = useBizzi((s) => s.workspaces?.[props.workspaceId] ?? null);
  const wsLoaded = useBizzi((s) => s.workspaces !== null);
  const rows = useBizzi((s) => selectNestedSessions(s, props.workspaceId), treeRowsEqual);
  const worktrees = useBizzi((s) => Object.values(s.workspaces ?? {}).filter((w) => w.parentWorkspaceId === props.workspaceId), shallowEqual);
  const git = useBizzi((s) => s.gitStatus[props.workspaceId] ?? null);
  const [creating, setCreating] = useState(false);
  const [newWorktree, setNewWorktree] = useState(false);
  const online = useMachineOnline(ws?.machineId);
  const machine = useMachine(ws?.machineId);
  const multiMachine = useBizzi((s) => s.role === 'hub' && Object.keys(s.machines).length > 1);
  const remove = useAction(async () => {
    await store.removeWorkspace(props.workspaceId);
    navigate({ name: 'workspaces' }, { replace: true });
  });
  const kind = ws?.kind;
  useEffect(() => {
    if (online && kind && kind !== 'dir') store.loadGitStatus(props.workspaceId).catch(() => {});
  }, [store, online, kind, props.workspaceId]);
  // Worktrees: refuse on uncommitted changes, then ask before discarding them (force).
  const removeWorktree = useAction(async () => {
    const parent = ws?.parentWorkspaceId;
    try {
      await store.removeWorktree(props.workspaceId);
    } catch (e) {
      // Live sessions block removal outright (data.sessions); only uncommitted changes (data.paths) can be forced.
      const data = e instanceof BizziError ? (e.data as { sessions?: unknown; paths?: unknown } | undefined) : undefined;
      if (!(e instanceof BizziError && e.code === 'conflict') || data?.sessions !== undefined) throw e;
      if (!window.confirm(`${e.message}\n\nRemove the worktree anyway and discard them? The branch is kept.`)) return;
      await store.removeWorktree(props.workspaceId, true);
    }
    navigate(parent ? { name: 'workspace', workspaceId: parent } : { name: 'workspaces' }, { replace: true });
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
            <>
              {ws.kind !== 'dir' ? (
                <Button size="sm" variant="ghost" icon="branch" disabled={!online} onClick={() => setNewWorktree(true)} title="git worktree add: a new branch in its own directory, as a workspace">
                  <span className="hidden sm:inline">New worktree</span>
                </Button>
              ) : null}
              <Button variant="primary" size="sm" icon="plus" disabled={!online} onClick={() => setCreating((c) => !c)}>
                New session
              </Button>
            </>
          }
        />
      }
    >
      <OfflineMachineBanner machineId={ws.machineId} className="mb-3" />
      {creating && online ? <NewSessionForm workspaceId={ws.id} onCancel={() => setCreating(false)} /> : null}
      <RepoLine workspace={ws} git={git} worktrees={worktrees} />
      <WidgetRow placement="workspace" machineId={ws.machineId} className="mb-3" />
      {rows.length === 0 ? (
        <Empty icon="chat" title="No sessions in this workspace">
          Start one with an installed agent.
        </Empty>
      ) : (
        <div className="grid gap-2">
          {rows.map((r) => (
            <SessionRow key={r.session.id} session={r.session} depth={r.depth} foreign={r.session.workspaceId !== ws.id} />
          ))}
        </div>
      )}
      <Disclosure className="mt-6" header={<span className="text-xs font-semibold tracking-wide text-muted uppercase">Agent-to-agent limits for this workspace</span>}>
        {() => (
          <div className="mt-2">
            <OrchestrationPanel machineId={ws.machineId} workspaceId={ws.id} online={online} />
          </div>
        )}
      </Disclosure>
      <div className="mt-8 flex flex-wrap items-center gap-2 border-t border-border pt-4 text-xs text-muted">
        <span className="flex-1">
          {ws.kind === 'git' ? 'Git repository' : ws.kind === 'worktree' ? `Worktree of ${ws.branch ?? 'a branch'}` : 'Directory'} · added {formatRelative(ws.createdAt)}
        </span>
        {ws.kind === 'worktree' ? (
          <Button
            variant="ghost"
            size="sm"
            icon="trash"
            disabled={!online}
            busy={removeWorktree.busy}
            onClick={() => {
              if (window.confirm(`Remove the worktree "${ws.name}"? Its directory is deleted; the branch ${ws.branch ?? ''} is kept.`)) void removeWorktree.run();
            }}
          >
            Remove worktree
          </Button>
        ) : (
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
        )}
      </div>
      <ErrorText error={remove.error ?? removeWorktree.error} />
      {newWorktree ? <WorktreeDialog workspace={ws} onClose={() => setNewWorktree(false)} /> : null}
    </Page>
  );
}

/** Branch, ahead/behind and the worktrees made from this repo. */
function RepoLine(props: { workspace: WorkspaceInfo; git: { branch?: string; ahead: number; behind: number; dirty: boolean } | null; worktrees: WorkspaceInfo[] }): ReactNode {
  const { workspace: w, git, worktrees } = props;
  const branch = git?.branch ?? w.branch;
  const ab = git ? aheadBehind(git.ahead, git.behind) : '';
  if (!branch && worktrees.length === 0) return null;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
      {branch ? (
        <span className="inline-flex items-center gap-1 font-mono">
          <Icon name="branch" size={12} />
          {branch}
          {git?.dirty ? '*' : ''}
          {ab ? <span className="ml-1">{ab}</span> : null}
        </span>
      ) : null}
      {worktrees.length > 0 ? (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          worktrees:
          {worktrees.map((t) => (
            <a key={t.id} href={routeHref({ name: 'workspace', workspaceId: t.id })} className="font-mono text-fg hover:underline">
              {t.branch ?? t.name}
            </a>
          ))}
        </span>
      ) : null}
    </div>
  );
}

/** `worktree.create`: a branch (new from `base`, or existing) checked out in its own directory, as a workspace. */
function WorktreeDialog(props: { workspace: WorkspaceInfo; onClose: () => void }): ReactNode {
  const store = useStore();
  const git = useBizzi((s) => s.gitStatus[props.workspace.id] ?? null);
  const [branch, setBranch] = useState('');
  const [base, setBase] = useState('');
  const [name, setName] = useState('');
  const create = useAction(async () => {
    const params: Parameters<typeof store.createWorktree>[0] = { workspaceId: props.workspace.id, branch: branch.trim() };
    if (base.trim()) params.base = base.trim();
    if (name.trim()) params.name = name.trim();
    const w = await store.createWorktree(params);
    props.onClose();
    navigate({ name: 'workspace', workspaceId: w.id });
  });
  const valid = /^[\w][\w./-]*$/.test(branch.trim()) && !branch.includes('..');
  return (
    <Modal
      title={`New worktree of ${props.workspace.name}`}
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon="branch" disabled={!valid} busy={create.busy} onClick={() => void create.run()}>
            Create worktree
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) void create.run();
        }}
      >
        <Field label="Branch" hint="Created from the base unless it already exists.">
          <Input autoFocus value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="feat/oauth" spellCheck={false} autoCapitalize="off" />
        </Field>
        <Field label="Base (optional)">
          <Input value={base} onChange={(e) => setBase(e.target.value)} placeholder={git?.branch ? `${git.branch} (HEAD)` : 'HEAD'} spellCheck={false} autoCapitalize="off" />
        </Field>
        <Field label="Workspace name (optional)">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={branch ? `${props.workspace.name} · ${branch}` : ''} />
        </Field>
        <ErrorText error={create.error} />
      </form>
    </Modal>
  );
}

function SessionRow(props: { session: SessionInfo; depth?: number; foreign?: boolean }): ReactNode {
  const s = props.session;
  const prompt = useBizzi((st) => selectSessionPrompt(st, s.id));
  const where = useBizzi((st) => (props.foreign ? (st.workspaces?.[s.workspaceId]?.branch ?? st.workspaces?.[s.workspaceId]?.name ?? null) : null));
  const depth = props.depth ?? 0;
  return (
    <a href={routeHref({ name: 'session', sessionId: s.id, tab: 'chat' })} className="block" style={{ marginLeft: depth * 20 }}>
      <Card className={cx('flex items-center gap-3 hover:bg-panel-2', depth > 0 ? 'p-2.5' : 'p-3')}>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-panel-2 text-muted">
          <Icon name={s.mode === 'terminal' ? 'terminal' : 'chat'} size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{s.title || 'Untitled session'}</div>
          <div className="truncate text-xs text-muted">
            {depth > 0 ? <span className="text-fg/80">helper · </span> : null}
            {AGENT_LABEL[s.agent]}
            {s.model ? ` · ${s.model}` : ''} · {formatRelative(s.updatedAt)}
            {s.forkedFrom ? ' · fork' : ''}
            {where ? ` · in ${where}` : ''}
          </div>
        </div>
        {s.billing && s.billing !== 'plan' ? <Badge title={BILLING_HINT[s.billing]}>{BILLING_LABEL[s.billing]}</Badge> : null}
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

  const unsupported = listing?.support === 'unsupported';
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
        {unsupported && mode === 'structured' ? (
          <div className="text-xs text-err sm:col-span-2">
            {listing?.supportReason ?? 'This version is not supported.'} Structured sessions won't start; use terminal mode or fix it on the machine page.
          </div>
        ) : null}
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
