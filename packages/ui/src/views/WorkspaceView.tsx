import { useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { PIPELINE_STATUS_LABEL, fanoutGroupsEqual, pipelinesEqual, selectAgents, selectFanoutGroups, selectNestedSessions, selectPipelines, selectSessionPrompt, shallowEqual, treeRowsEqual } from '@bizzi/client';
import { BizziError, defaultProfileId, preferredProfile, profilesFor, ulid } from '@bizzi/protocol';
import type { AgentKind, AgentListing, AgentProfile, LabelColor, SessionInfo, SessionMode, WorkspaceInfo } from '@bizzi/protocol';
import { useBizzi, useStore } from '../app/context.tsx';
import { navigate, useAction } from '../app/hooks.ts';
import { useMachine, useMachineOnline, useShowMachine } from '../app/machine.ts';
import { OfflineMachineBanner } from '../components/OfflineMachineBanner.tsx';
import { Icon } from '../components/icons.tsx';
import { ModelPicker, effortsFor, useAgentModels } from '../components/ModelPicker.tsx';
import { LabelColorField, MachineChip, WorkspaceTile, stripeStyle } from '../components/labels.tsx';
import { Page, PageHeader } from '../components/layout.tsx';
import { Badge, Button, Card, Disclosure, Empty, ErrorText, Field, IconButton, Input, Modal, Select, Spinner, StatusBadge, cx } from '../components/ui.tsx';
import { WidgetRow } from '../components/Widget.tsx';
import { formatRelative } from '../lib/format.ts';
import { iconInputError, workspaceMonogram } from '../lib/labels.ts';
import { routeHref } from '../lib/router.ts';
import { AGENT_LABEL, BILLING_HINT, BILLING_LABEL, aheadBehind } from '../lib/states.ts';
import { FanoutDialog } from './fanout/FanoutDialog.tsx';
import { PipelineDialog } from './pipelines/PipelineDialog.tsx';
import { PIPELINE_TONE } from './pipelines/PipelineGateCard.tsx';
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
  const [fanout, setFanout] = useState(false);
  const groups = useBizzi((s) => selectFanoutGroups(s, props.workspaceId), fanoutGroupsEqual);
  const [pipeline, setPipeline] = useState(false);
  const pipelines = useBizzi((s) => selectPipelines(s, props.workspaceId), pipelinesEqual);
  const online = useMachineOnline(ws?.machineId);
  const machine = useMachine(ws?.machineId);
  const showMachine = useShowMachine(machine);
  const [editing, setEditing] = useState(false);
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
          style={stripeStyle(machine?.color)}
          title={
            <span className="flex min-w-0 items-center gap-2">
              <WorkspaceTile workspace={ws} size="md" />
              <span className="truncate">{ws.name}</span>
            </span>
          }
          subtitle={
            <span className="inline-flex max-w-full min-w-0 items-center gap-1">
              {showMachine && machine ? (
                <>
                  <MachineChip machine={machine} />
                  <span className="shrink-0">·</span>
                </>
              ) : null}
              <span className="truncate font-mono">{ws.path}</span>
            </span>
          }
          back={() => navigate({ name: 'workspaces' })}
          actions={
            <>
              <Button size="sm" variant="ghost" icon="bolt" disabled={!online} onClick={() => setPipeline(true)} title="Pipeline: planner → implementer → reviewer, one stage after another, with gates you approve">
                <span className="hidden sm:inline">Pipeline</span>
              </Button>
              <IconButton icon="edit" label="Name, color and icon" disabled={!online} onClick={() => setEditing(true)} />
              {ws.kind !== 'dir' ? (
                <Button size="sm" variant="ghost" icon="tree" disabled={!online} onClick={() => setFanout(true)} title="Fan out: the same prompt to several agents, each in its own worktree, then compare">
                  <span className="hidden sm:inline">Fan out</span>
                </Button>
              ) : null}
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
      {editing ? <WorkspaceIdentityDialog workspace={ws} onClose={() => setEditing(false)} /> : null}
      {creating && online ? <NewSessionForm workspaceId={ws.id} onCancel={() => setCreating(false)} /> : null}
      <RepoLine workspace={ws} git={git} worktrees={worktrees} />
      <WidgetRow placement="workspace" machineId={ws.machineId} className="mb-3" />
      {groups.length > 0 ? (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted">Fan-outs:</span>
          {groups.map((g) => (
            <a key={g.group} href={routeHref({ name: 'fanout', group: g.group })} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 hover:bg-panel-2">
              <Icon name="tree" size={12} className="text-muted" />
              <span className="max-w-[16rem] truncate">{g.title}</span>
              <span className="text-muted">· {g.sessions.length} runs</span>
            </a>
          ))}
        </div>
      ) : null}
      {pipelines.length > 0 ? (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted">Pipelines:</span>
          {pipelines.slice(0, 8).map((p) => (
            <a key={p.id} href={routeHref({ name: 'pipeline', pipelineId: p.id })} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 hover:bg-panel-2">
              <Icon name="bolt" size={12} className="text-muted" />
              <span className="max-w-[16rem] truncate">{p.title}</span>
              <Badge tone={PIPELINE_TONE[p.status]}>{p.status === 'running' ? `${p.stages[p.current]?.name ?? ''}` : PIPELINE_STATUS_LABEL[p.status]}</Badge>
            </a>
          ))}
        </div>
      ) : null}
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
          {ws.kind === 'git'
            ? 'Git repository'
            : ws.kind === 'worktree'
              ? `Worktree of ${ws.branch ?? 'a branch'}`
              : ws.kind === 'container'
                ? `Container${ws.container ? ` (${ws.container.image})` : ''}`
                : 'Directory'}{' '}
          · added {formatRelative(ws.createdAt)}
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
      {fanout ? <FanoutDialog workspace={ws} onClose={() => setFanout(false)} /> : null}
      {pipeline ? <PipelineDialog workspace={ws} onClose={() => setPipeline(false)} /> : null}
    </Page>
  );
}

/** Branch, ahead/behind and the worktrees made from this repo. */
/** Rename the workspace and pick its identity color and icon (spec §11.1); stored on its node, replicated by the hub. */
function WorkspaceIdentityDialog(props: { workspace: WorkspaceInfo; onClose: () => void }): ReactNode {
  const w = props.workspace;
  const store = useStore();
  const [name, setName] = useState(w.name);
  const [color, setColor] = useState<LabelColor | undefined>(w.color);
  const [icon, setIcon] = useState(w.icon ?? '');
  const iconError = iconInputError(icon);
  const parent = useBizzi((s) => (w.kind === 'worktree' && w.parentWorkspaceId ? (s.workspaces?.[w.parentWorkspaceId] ?? null) : null));
  const valid = name.trim() !== '' && iconError === null;
  const save = useAction(async () => {
    await store.setWorkspace({ workspaceId: w.id, name: name.trim(), color: color ?? '', icon: icon.trim() });
    props.onClose();
  });
  const preview: WorkspaceInfo = { ...w, name: name.trim() || w.name };
  if (color) preview.color = color;
  else delete preview.color;
  if (icon.trim() && !iconError) preview.icon = icon.trim();
  else delete preview.icon;
  return (
    <Modal
      title="Name, color and icon"
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={save.busy} disabled={!valid} onClick={() => void save.run()}>
            Save
          </Button>
        </>
      }
    >
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) void save.run();
        }}
      >
        <Field label="Name" hint="bizzi's name for it; the directory isn't renamed.">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} autoFocus />
        </Field>
        <LabelColorField
          value={color}
          onChange={setColor}
          label="Workspace color"
          hint={!color && parent?.color ? `None set: it shows ${parent.name}'s color.` : 'On its sidebar tile and in headers; readable in every theme.'}
        />
        <Field label="Icon" hint={iconError ?? 'One or two characters or an emoji, in place of the first letter.'}>
          <div className="flex items-center gap-2">
            <Input value={icon} onChange={(e) => setIcon(e.target.value)} maxLength={16} placeholder={workspaceMonogram({ name: preview.name })} className="w-24" spellCheck={false} autoCapitalize="off" />
            <WorkspaceTile workspace={preview} size="md" />
            <span className="min-w-0 truncate text-sm">{preview.name}</span>
          </div>
        </Field>
        <button type="submit" hidden />
      </form>
      <ErrorText error={save.error} />
    </Modal>
  );
}

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

/** What a profile sets, as the form holds it ('' = the agent's default). */
interface ProfileFields {
  mode: SessionMode | '';
  model: string;
  permissionMode: string;
  effort: string;
}

function fieldsOf(p: AgentProfile): ProfileFields {
  return { mode: p.mode ?? '', model: p.model ?? '', permissionMode: p.permissionMode ?? '', effort: p.effort ?? '' };
}

function sameFields(a: ProfileFields, b: ProfileFields): boolean {
  return a.mode === b.mode && a.model === b.model && a.permissionMode === b.permissionMode && a.effort === b.effort;
}

function withFields(p: AgentProfile, f: ProfileFields): AgentProfile {
  const out: AgentProfile = { id: p.id, agent: p.agent, name: p.name };
  if (f.mode) out.mode = f.mode;
  if (f.model.trim()) out.model = f.model.trim();
  if (f.permissionMode) out.permissionMode = f.permissionMode;
  if (f.effort) out.effort = f.effort;
  return out;
}

function NewSessionForm(props: { workspaceId: string; onCancel: () => void }): ReactNode {
  const store = useStore();
  const machineId = useBizzi((s) => s.workspaces?.[props.workspaceId]?.machineId ?? null);
  const agents = useBizzi((s) => selectAgents(s, machineId));
  const prefs = useBizzi((s) => s.prefs);
  const installed = useMemo(() => (agents ?? []).filter((a) => a.installed), [agents]);
  const defaultAgent = installed.find((a) => a.auth === 'ok' && a.capabilities?.modes.includes('structured')) ?? installed[0];
  const [agent, setAgent] = useState<AgentKind | ''>(defaultAgent?.agent ?? '');
  const listing: AgentListing | undefined = installed.find((a) => a.agent === agent) ?? defaultAgent;
  const caps = listing?.capabilities;
  const modes = caps?.modes.length ? caps.modes : FALLBACK_MODES;

  // Profiles (user-wide prefs). Without prefs support on the server there are none: plain fields.
  const profiles = useMemo(() => (listing ? profilesFor(prefs ?? undefined, listing.agent) : []), [prefs, listing]);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [fields, setFields] = useState<ProfileFields>({ mode: '', model: '', permissionMode: '', effort: '' });
  /** The user changed something since the profile was applied: prefs arriving late must not overwrite it. */
  const [touched, setTouched] = useState(false);
  const profile = profiles.find((p) => p.id === profileId) ?? (listing ? preferredProfile(prefs ?? undefined, listing.agent) : undefined);
  useEffect(() => {
    if (!listing || touched) return;
    const p = preferredProfile(prefs ?? undefined, listing.agent);
    setProfileId(p.id);
    setFields(fieldsOf(p));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listing?.agent, prefs]);
  const edit = (patch: Partial<ProfileFields>): void => {
    setTouched(true);
    setFields((f) => ({ ...f, ...patch }));
  };
  const pickProfile = (id: string): void => {
    const p = profiles.find((x) => x.id === id);
    if (!p) return;
    setProfileId(p.id);
    setFields(fieldsOf(p));
    setTouched(true);
  };
  const pickAgent = (a: AgentKind): void => {
    setAgent(a);
    const p = preferredProfile(prefs ?? undefined, a);
    setProfileId(p.id);
    setFields(fieldsOf(p));
    setTouched(false);
  };

  const mode: SessionMode = fields.mode && modes.includes(fields.mode) ? fields.mode : modes.includes('structured') ? 'structured' : (modes[0] ?? 'structured');
  const { models } = useAgentModels(machineId, caps && mode === 'structured' && caps.models === 'dynamic' ? listing?.agent : undefined);
  const efforts = effortsFor(models, fields.model, caps?.effort ?? undefined);
  const [title, setTitle] = useState('');

  const unsupported = listing?.support === 'unsupported';
  const create = useAction(async () => {
    if (!listing) throw new Error('No installed agent');
    const params: Parameters<typeof store.createSession>[0] = { workspaceId: props.workspaceId, agent: listing.agent, mode };
    if (title.trim()) params.title = title.trim();
    if (mode === 'structured') {
      if (fields.model.trim()) params.model = fields.model.trim();
      if (fields.permissionMode) params.permissionMode = fields.permissionMode;
      if (fields.effort && efforts.includes(fields.effort)) params.effort = fields.effort;
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
        No agents are installed on this machine. See <a href={routeHref({ name: 'machine' })} className="text-accent-text underline">Machine</a> to install one.
      </Card>
    );
  }

  const structured = mode === 'structured';
  return (
    <Card className="mb-4 p-4">
      <form onSubmit={(e) => void submit(e)} className="grid gap-3 sm:grid-cols-2">
        <Field label="Agent">
          <Select value={listing?.agent ?? ''} onChange={(e) => pickAgent(e.target.value as AgentKind)}>
            {installed.map((a) => (
              <option key={a.agent} value={a.agent}>
                {a.agent}
                {a.version ? ` ${a.version}` : ''}
                {a.auth !== 'ok' ? ` (${a.auth === 'expired' ? 'login expired' : 'not signed in'})` : ''}
              </option>
            ))}
          </Select>
        </Field>
        {prefs && listing && profile ? (
          <ProfileField
            agent={listing.agent}
            profiles={profiles}
            profile={profile}
            fields={{ ...fields, mode: fields.mode && modes.includes(fields.mode) ? fields.mode : '' }}
            preferredId={preferredProfile(prefs, listing.agent).id}
            onPick={pickProfile}
            onSaved={(p) => {
              setProfileId(p.id);
              setFields(fieldsOf(p));
            }}
          />
        ) : (
          <div className="hidden sm:block" />
        )}
        <Field label="Mode">
          <div className="flex h-9 gap-1 rounded-md border border-border p-0.5">
            {modes.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => edit({ mode: m })}
                className={`flex-1 rounded px-2 text-sm capitalize ${mode === m ? 'bg-panel-2 font-medium' : 'text-muted'}`}
              >
                {m}
              </button>
            ))}
          </div>
        </Field>
        {structured && caps && listing ? (
          <>
            {caps.models === 'dynamic' || caps.models.length > 0 ? (
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted">Model</span>
                <ModelPicker
                  machineId={machineId}
                  agent={listing.agent}
                  value={fields.model}
                  onChange={(model) => edit({ model })}
                  {...(Array.isArray(caps.models) ? { fixed: caps.models } : {})}
                />
              </div>
            ) : (
              <div className="hidden sm:block" />
            )}
            {caps.permissionModes.length > 0 ? (
              <Field label="Permission mode">
                <Select value={fields.permissionMode} onChange={(e) => edit({ permissionMode: e.target.value })}>
                  <option value="">Agent default</option>
                  {caps.permissionModes.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            {efforts.length ? (
              <Field label="Effort">
                <Select value={efforts.includes(fields.effort) ? fields.effort : ''} onChange={(e) => edit({ effort: e.target.value })}>
                  <option value="">Agent default</option>
                  {efforts.map((m) => (
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

/**
 * Profile picker with its actions: save the form into the selected profile, save it as a new one,
 * preselect it for this agent (star), delete it (not Default).
 */
function ProfileField(props: {
  agent: AgentKind;
  profiles: readonly AgentProfile[];
  profile: AgentProfile;
  fields: ProfileFields;
  preferredId: string;
  onPick: (id: string) => void;
  onSaved: (p: AgentProfile) => void;
}): ReactNode {
  const store = useStore();
  const { agent, profiles, profile, fields } = props;
  const [naming, setNaming] = useState<string | null>(null);
  const isDefault = profile.id === defaultProfileId(agent);
  const dirty = !sameFields(fieldsOf(profile), fields);
  const preferred = props.preferredId === profile.id;

  const save = useAction(async (list: AgentProfile[], preferredChange?: string | null) => store.saveAgentProfiles(agent, list, preferredChange));
  /** Stored profiles of this agent; Default is stored only once it differs from blank. */
  const stored = (): AgentProfile[] => profiles.filter((p) => p.id !== defaultProfileId(agent) || p.model || p.mode || p.permissionMode || p.effort);

  const update = async (): Promise<void> => {
    const next = withFields(profile, fields);
    const list = stored().some((p) => p.id === next.id) ? stored().map((p) => (p.id === next.id ? next : p)) : [next, ...stored()];
    if (await save.run(list)) props.onSaved(next);
  };
  const saveAs = async (name: string): Promise<void> => {
    const next = withFields({ id: `pr_${ulid()}`, agent, name: name.trim() }, fields);
    if (await save.run([...stored(), next])) {
      setNaming(null);
      props.onSaved(next);
    }
  };
  const remove = async (): Promise<void> => {
    if (isDefault) return;
    if (await save.run(stored().filter((p) => p.id !== profile.id), preferred ? null : undefined)) props.onPick(defaultProfileId(agent));
  };

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted">Profile</span>
      {naming !== null ? (
        <div className="flex items-center gap-1">
          <Input
            value={naming}
            onChange={(e) => setNaming(e.target.value)}
            placeholder="Profile name"
            autoFocus
            maxLength={80}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (naming.trim()) void saveAs(naming);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setNaming(null);
              }
            }}
          />
          <Button size="md" variant="primary" disabled={!naming.trim()} busy={save.busy} onClick={() => void saveAs(naming)}>
            Save
          </Button>
          <IconButton icon="x" label="Cancel" className="h-9 w-9" onClick={() => setNaming(null)} />
        </div>
      ) : (
        <div className="flex items-center gap-1">
          <Select value={profile.id} onChange={(e) => props.onPick(e.target.value)}>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.id === props.preferredId ? ' ★' : ''}
              </option>
            ))}
          </Select>
          <IconButton
            icon="sparkle"
            label={preferred ? 'Preselected for new sessions' : 'Preselect this profile for new sessions'}
            className={cx('h-9 w-9', preferred && 'text-accent-text')}
            disabled={preferred || save.busy}
            onClick={() => void save.run(stored(), isDefault ? null : profile.id)}
          />
          <IconButton icon="plus" label="Save these settings as a new profile" className="h-9 w-9" disabled={save.busy} onClick={() => setNaming('')} />
          {!isDefault ? <IconButton icon="trash" label={`Delete profile ${profile.name}`} className="h-9 w-9" disabled={save.busy} onClick={() => void remove()} /> : null}
        </div>
      )}
      {dirty && naming === null ? (
        <div className="flex items-center gap-2 text-xs text-muted">
          <span>Changed from {profile.name}.</span>
          <button type="button" className="text-accent-text underline disabled:opacity-50" disabled={save.busy} onClick={() => void update()}>
            Update profile
          </button>
        </div>
      ) : null}
      <ErrorText error={save.error} />
    </div>
  );
}
