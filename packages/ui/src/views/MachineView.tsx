import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { selectAgentJob, selectAgents, shallowEqual } from '@bizzi/client';
import type { JobAction } from '@bizzi/client';
import type { AgentCapabilities, AgentKind, AgentListing, AgentRemedy, MachineInfo, RestartPolicy, UpdatePolicy } from '@bizzi/protocol';
import { openAddWorkspace } from '../app/addWorkspace.ts';
import { useBizzi, useStore } from '../app/context.tsx';
import { navigate, useAction } from '../app/hooks.ts';
import { useIsHub, useMachine, useMachineOnline, useTargetMachineId } from '../app/machine.ts';
import { Icon } from '../components/icons.tsx';
import { PresenceDot } from '../components/MachineSwitcher.tsx';
import { Page, PageHeader, SectionTitle } from '../components/layout.tsx';
import { Badge, Button, Card, CopyButton, Empty, ErrorText, Field, Input, Spinner, Textarea, cx } from '../components/ui.tsx';
import { WidgetRow } from '../components/Widget.tsx';
import { machinePresence } from '../lib/format.ts';
import { parseTags } from '../lib/knowledge.ts';
import { agentActions, hasUpdate } from '../lib/provision.ts';
import { AGENT_LABEL, BILLING_HINT, BILLING_LABEL, RESTART_POLICY_LABEL, UPDATE_POLICY_LABEL, pendingUpdatesLabel } from '../lib/states.ts';
import { OrchestrationPanel } from './settings/OrchestrationPanel.tsx';
import { JobProgress } from './provision/JobProgress.tsx';
import { PlanModal } from './provision/PlanModal.tsx';
import { SecretsPanel } from './provision/SecretsPanel.tsx';
import { WorkspaceRow } from './WorkspacesView.tsx';

/**
 * One machine (opened from its sidebar tile): what it is, its workspaces, which agents it has (install /
 * update / log in, update and restart policies), its API keys and widgets, and its machine-scoped settings.
 */
export function MachineView(props: { machineId?: string }): ReactNode {
  const store = useStore();
  const hub = useIsHub();
  const target = useTargetMachineId();
  const machineId = props.machineId ?? target;
  const machine = useMachine(machineId);
  const online = useMachineOnline(machineId);
  const agents = useBizzi((s) => selectAgents(s, machineId));
  const loadError = useBizzi((s) => (machineId ? (s.machineErrors[machineId] ?? null) : null));
  const serverVersion = useBizzi((s) => s.connection.serverVersion);
  const refresh = useAction(() => store.loadAgents(machineId, true));
  const [plan, setPlan] = useState<{ agent: AgentKind; action: JobAction; method?: string } | null>(null);
  const [secretFor, setSecretFor] = useState<AgentKind | null>(null);
  const clearSecretFor = useCallback(() => setSecretFor(null), []);

  // Opening #/m/<id> directly makes that machine the selected one.
  useEffect(() => {
    if (hub && props.machineId && props.machineId !== target) store.selectMachine(props.machineId);
  }, [hub, props.machineId, target, store]);

  if (!machineId || (!machine && !agents)) {
    return (
      <Page header={<PageHeader title="Machine" back={() => navigate({ name: 'machines' })} />}>
        <div className="flex justify-center py-10 text-muted">
          <Spinner />
        </div>
      </Page>
    );
  }

  const name = machine?.name ?? machineId;
  return (
    <Page
      header={
        <PageHeader
          title={name}
          subtitle={machine ? `${machine.hostname} · bizzi ${machine.bizziVersion}${serverVersion && !hub ? ` · server ${serverVersion}` : ''}` : undefined}
          back={() => navigate({ name: 'machines' })}
          actions={
            <>
              <Button size="sm" variant="ghost" icon="refresh" busy={refresh.busy} disabled={!online} onClick={() => void refresh.run()}>
                Re-probe
              </Button>
              <Button size="sm" variant="primary" icon="plus" disabled={!online} onClick={() => openAddWorkspace(machineId)}>
                Add workspace
              </Button>
            </>
          }
        />
      }
    >
      {!online && machine ? <OfflineBanner machine={machine} /> : null}
      {agents ? <UnsupportedBanner agents={agents} machineName={name} /> : null}
      {machine ? <MachineCard machine={machine} online={online} /> : null}
      <WidgetRow placement="machine" machineId={machineId} className="mt-3 rounded-lg border border-border bg-panel px-4 py-2" />

      <MachineWorkspaces machineId={machineId} online={online} />

      <SectionTitle>Agents</SectionTitle>
      <ErrorText error={refresh.error ?? (online ? loadError : null)} className="mb-2" />
      {agents === null ? (
        online ? (
          <div className="flex justify-center py-8 text-muted">
            <Spinner />
          </div>
        ) : (
          <Empty icon="wifiOff" title="No cached agent status">
            {name} has not been reachable since this device connected.
          </Empty>
        )
      ) : agents.length === 0 ? (
        <Empty icon="bolt" title="No agents detected" />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {agents.map((a) => (
            <AgentCard key={a.agent} machineId={machineId} online={online} agent={a} onPlan={(action, method) => setPlan(method ? { agent: a.agent, action, method } : { agent: a.agent, action })} onSecret={() => setSecretFor(a.agent)} />
          ))}
        </div>
      )}

      <SecretsPanel machineId={machineId} online={online} preset={secretFor} onPresetUsed={clearSecretFor} />

      <SectionTitle>Machine settings · agent-to-agent</SectionTitle>
      <OrchestrationPanel machineId={machineId} online={online} />
      <p className="mt-2 text-xs text-muted">Update and restart policies are on each agent's card above. App-wide settings (appearance, knowledge, devices) are under Settings.</p>

      {!hub ? <p className="mt-6 text-xs text-muted">Connected directly to this node. Other machines are reached through a hub.</p> : null}
      {plan ? <PlanModal machineId={machineId} machineName={name} agent={plan.agent} action={plan.action} {...(plan.method ? { method: plan.method } : {})} onClose={() => setPlan(null)} /> : null}
    </Page>
  );
}

/** This machine's workspaces (the sidebar shows the same tree; here with paths and session counts). */
function MachineWorkspaces(props: { machineId: string; online: boolean }): ReactNode {
  const loaded = useBizzi((s) => s.workspaces !== null);
  const workspaces = useBizzi(
    (s) =>
      Object.values(s.workspaces ?? {})
        .filter((w) => w.machineId === props.machineId)
        .sort((a, b) => a.name.localeCompare(b.name)),
    shallowEqual,
  );
  return (
    <>
      <SectionTitle
        actions={
          workspaces.length > 0 ? (
            <Button size="sm" variant="ghost" icon="plus" disabled={!props.online} onClick={() => openAddWorkspace(props.machineId)}>
              Add
            </Button>
          ) : null
        }
      >
        Workspaces
      </SectionTitle>
      {!loaded ? (
        <div className="flex justify-center py-6 text-muted">
          <Spinner />
        </div>
      ) : workspaces.length === 0 ? (
        <Empty icon="folder" title="No workspaces yet">
          <div className="grid justify-items-center gap-3">
            <span>Add a git repository or a plain directory to start a session in it.</span>
            <Button size="sm" variant="primary" icon="plus" disabled={!props.online} onClick={() => openAddWorkspace(props.machineId)}>
              Add workspace
            </Button>
          </div>
        </Empty>
      ) : (
        <div className="grid gap-2">
          {workspaces.map((w) => (
            <WorkspaceRow key={w.id} workspace={w} foreign={false} />
          ))}
        </div>
      )}
    </>
  );
}

function OfflineBanner(props: { machine: MachineInfo }): ReactNode {
  return (
    <div className="mb-3 flex items-start gap-2.5 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2.5 text-sm text-warn" role="status">
      <Icon name="wifiOff" size={18} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">
          {props.machine.name} is offline{props.machine.lastSeenAt ? ` · ${machinePresence(props.machine)}` : ''}
        </div>
        <div className="text-xs opacity-90">Showing cached data. Installs, logins and API keys are disabled until it reconnects.</div>
      </div>
    </div>
  );
}

/** spec §7: an unsupported install raises a banner on the machine (remedies are on the agent's card). */
function UnsupportedBanner(props: { agents: readonly AgentListing[]; machineName: string }): ReactNode {
  const bad = props.agents.filter((a) => a.installed && a.support === 'unsupported');
  if (bad.length === 0) return null;
  return (
    <div className="mb-3 flex items-start gap-2.5 rounded-lg border border-err/40 bg-err/5 px-3 py-2.5 text-sm text-err" role="alert">
      <Icon name="alert" size={18} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        {bad.map((a) => (
          <div key={a.agent} className="font-medium">
            {AGENT_LABEL[a.agent]} {a.version ?? ''} on {props.machineName} is not supported{a.supportReason ? `: ${a.supportReason}` : '.'}
          </div>
        ))}
        <div className="text-xs opacity-90">Structured sessions won't start on it; terminal mode still works. The fix is on its card below and runs only when you confirm.</div>
      </div>
    </div>
  );
}

function Fact(props: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-muted">{props.label}</div>
      <div className="truncate text-sm">{props.children}</div>
    </div>
  );
}

function MachineCard(props: { machine: MachineInfo; online: boolean }): ReactNode {
  const m = props.machine;
  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center gap-2">
        <Icon name="machine" size={18} className="text-muted" />
        <div className="min-w-0 flex-1 truncate font-medium">{m.name}</div>
        <Badge tone={m.online ? 'ok' : 'neutral'}>
          <PresenceDot online={m.online} className="h-1.5 w-1.5" />
          {machinePresence(m)}
        </Badge>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <Fact label="Host">{m.hostname}</Fact>
        <Fact label="Platform">
          {m.os} / {m.arch}
        </Fact>
        <Fact label="Display">{m.headful ? 'headful (GUI)' : 'headless'}</Fact>
        <Fact label="Power">{m.alwaysOn ? 'always on' : 'may sleep'}</Fact>
        <Fact label="Roles">{m.roles.join(', ')}</Fact>
        <Fact label="Version">{m.bizziVersion}</Fact>
      </div>
      <MachinePurpose machine={m} online={props.online} />
    </Card>
  );
}

/** Tags suggested from facts the node knows; tags like `prod-access` are yours to add (knowledge.md §9.1). */
function suggestedTags(m: MachineInfo): string[] {
  const out: string[] = [];
  if (m.headful) out.push('gui');
  if (m.alwaysOn) out.push('always-on');
  return out.filter((t) => !m.tags.includes(t));
}

/** Tags and description: what the machine is for. Sessions get both in their machine card, and tag rules follow the tags. */
function MachinePurpose(props: { machine: MachineInfo; online: boolean }): ReactNode {
  const m = props.machine;
  const store = useStore();
  const [editing, setEditing] = useState(false);
  const [tags, setTags] = useState('');
  const [description, setDescription] = useState('');
  const save = useAction(async () => {
    await store.setMachine({ machineId: m.id, tags: parseTags(tags).map((t) => t.toLowerCase()), description });
    setEditing(false);
  });
  const start = (): void => {
    setTags(m.tags.join(', '));
    setDescription(m.description ?? '');
    setEditing(true);
  };
  const current = parseTags(tags).map((t) => t.toLowerCase());
  const suggestions = suggestedTags({ ...m, tags: current });

  if (!editing) {
    return (
      <div className="mt-3 border-t border-border pt-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex flex-wrap items-center gap-1">
              {m.tags.length ? (
                m.tags.map((t) => (
                  <Badge key={t}>
                    <Icon name="tag" size={11} />
                    {t}
                  </Badge>
                ))
              ) : (
                <span className="text-xs text-muted">No tags</span>
              )}
            </div>
            {m.description ? (
              <p className="text-sm whitespace-pre-wrap">{m.description}</p>
            ) : (
              <p className="text-xs text-muted">No description. Say what this machine is for; every session started here is told.</p>
            )}
          </div>
          <Button size="sm" variant="ghost" icon="edit" disabled={!props.online} onClick={start} title={props.online ? 'Edit tags and description' : 'The machine is offline'}>
            Edit
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="mt-3 grid gap-3 border-t border-border pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        void save.run();
      }}
    >
      <Field label="Tags" hint="Comma separated. Rules scoped to a tag apply on every machine that has it.">
        <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="prod-access, gui" spellCheck={false} autoCapitalize="off" autoFocus />
      </Field>
      {suggestions.length ? (
        <div className="-mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
          Suggested:
          {suggestions.map((t) => (
            <Button key={t} size="sm" variant="ghost" icon="plus" onClick={() => setTags(current.length ? `${current.join(', ')}, ${t}` : t)}>
              {t}
            </Button>
          ))}
        </div>
      ) : null}
      <Field label="What it's for" hint="Every session started on this machine gets this in its machine card.">
        <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="Work laptop with production access. Production investigations happen here." />
      </Field>
      <ErrorText error={save.error} />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => setEditing(false)}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" busy={save.busy}>
          Save
        </Button>
      </div>
    </form>
  );
}

const AUTH_TONE = { ok: 'ok', missing: 'warn', expired: 'err', unknown: 'neutral' } as const;
const AUTH_LABEL = { ok: 'signed in', missing: 'not signed in', expired: 'login expired', unknown: 'auth unknown' } as const;

function AgentCard(props: { machineId: string; online: boolean; agent: AgentListing; onPlan: (action: JobAction, method?: string) => void; onSecret: () => void }): ReactNode {
  const { agent: a, machineId, online } = props;
  const store = useStore();
  const job = useBizzi((s) => selectAgentJob(s, machineId, a.agent));
  const actions = agentActions(a);
  const busy = job !== null && !job.done;
  const disabled = !online || busy;
  const login = useAction(async () => {
    const session = await store.loginAgent({ machineId, agent: a.agent });
    navigate({ name: 'login', sessionId: session.id });
  });
  const update = hasUpdate(a);
  return (
    <Card className={cx('flex flex-col p-4', !a.installed && 'border-dashed')}>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-medium capitalize">{a.agent}</div>
          <div className="truncate text-xs text-muted" title={a.realPath && a.realPath !== a.path ? `${a.path} → ${a.realPath}` : a.path}>
            {a.installed ? `${a.version ?? 'unknown version'}${a.method ? ` · ${a.method}` : ''}${a.path ? ` · ${a.path}` : ''}` : 'not installed'}
          </div>
        </div>
        {a.installed && a.billing ? <Badge title={BILLING_HINT[a.billing]}>{BILLING_LABEL[a.billing]}</Badge> : null}
        {a.installed ? <Badge tone={AUTH_TONE[a.auth]}>{AUTH_LABEL[a.auth]}</Badge> : <Badge>missing</Badge>}
      </div>
      {a.installed ? <SupportNotice agent={a} disabled={disabled} onRemedy={(r) => props.onPlan(r.kind === 'migrate' ? 'migrate' : 'update', r.method)} /> : null}
      {a.account ? (
        <div className="mt-2 flex items-center gap-1.5 truncate text-xs text-muted">
          <Icon name="user" size={12} />
          {a.account}
        </div>
      ) : null}
      {update ? (
        <div className="mt-2 text-xs text-info">
          Update available{a.version && a.latestVersion ? `: ${a.version} → ${a.latestVersion}` : ''}
        </div>
      ) : null}
      {a.installed && a.onPath === false ? <div className="mt-2 text-xs text-warn">Not on the PATH of background services; agents may not find it.</div> : null}
      {a.installed && a.staleSessions ? (
        <div className="mt-2 text-xs text-muted" title="These sessions still run the previous version; restart them from the session header, or let the restart policy do it.">
          {pendingUpdatesLabel(a.staleSessions)}
        </div>
      ) : null}
      {a.installed && a.agent !== 'shell' && a.agent !== 'api' ? <PolicySelects machineId={machineId} agent={a} disabled={!online} /> : null}
      {a.notes?.length ? (
        <ul className="mt-2 list-disc pl-4 text-xs text-muted">
          {a.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
      {a.capabilities ? <CapabilityChips caps={a.capabilities} /> : null}
      {job ? <JobProgress job={job} className="mt-3" onDismiss={() => store.dismissJob(job.jobId)} /> : null}
      <ErrorText error={login.error} className="mt-2" />
      {a.agent !== 'shell' ? (
        <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-3">
          {actions.install ? (
            <Button size="sm" variant="primary" icon="download" disabled={disabled} onClick={() => props.onPlan('install')}>
              Install
            </Button>
          ) : null}
          {actions.login ? (
            <Button size="sm" variant={actions.loginProminent ? 'primary' : 'secondary'} icon="key" busy={login.busy} disabled={disabled} onClick={() => void login.run()}>
              {actions.loginProminent ? 'Log in' : 'Re-login'}
            </Button>
          ) : null}
          {actions.update ? (
            <Button size="sm" variant={actions.loginProminent ? 'secondary' : 'primary'} icon="upload" disabled={disabled} onClick={() => props.onPlan('update')}>
              Update
            </Button>
          ) : null}
          {actions.secrets ? (
            <Button size="sm" variant="ghost" icon="lock" disabled={!online} onClick={props.onSecret}>
              API key
            </Button>
          ) : null}
          <div className="flex-1" />
          {actions.uninstall ? (
            <Button size="sm" variant="ghost" icon="trash" disabled={disabled} onClick={() => props.onPlan('uninstall')} title={`Uninstall ${a.agent}`} className="text-muted">
              <span className="sr-only sm:not-sr-only">Uninstall</span>
            </Button>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

/**
 * spec §7 supported versions and install method: `unsupported` is an alert with confirm-first remedies,
 * `untested` a quiet note, a non-preferred method an offer to switch.
 */
function SupportNotice(props: { agent: AgentListing; disabled: boolean; onRemedy: (r: AgentRemedy) => void }): ReactNode {
  const a = props.agent;
  const remedies = a.remedies ?? [];
  const actionable = remedies.filter((r) => r.kind !== 'restart-service');
  const service = remedies.find((r) => r.kind === 'restart-service');
  if (a.support === 'unsupported') {
    return (
      <div className="mt-2 rounded-md border border-err/40 bg-err/5 px-2.5 py-2 text-xs text-err" role="alert">
        <div className="font-medium">Not supported{a.supportReason ? `: ${a.supportReason}` : ''}</div>
        <Remedies remedies={actionable} disabled={props.disabled} onRemedy={props.onRemedy} />
      </div>
    );
  }
  return (
    <>
      {a.support === 'untested' ? <div className="mt-2 text-xs text-muted">Untested version{a.supportReason ? `: ${a.supportReason}` : ''}</div> : null}
      {actionable.length > 0 ? (
        <div className="mt-2 rounded-md border border-border bg-panel-2/50 px-2.5 py-2 text-xs text-muted">
          {a.method && a.preferredMethod && a.method !== a.preferredMethod ? (
            <div>
              Installed with {a.method}; bizzi prefers {a.preferredMethod} here.
            </div>
          ) : null}
          <Remedies remedies={actionable} disabled={props.disabled} onRemedy={props.onRemedy} />
        </div>
      ) : null}
      {service ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-warn">
          <span>{service.title}</span>
          {service.command ? <CopyButton text={service.command} label={service.command} /> : null}
        </div>
      ) : null}
    </>
  );
}

function Remedies(props: { remedies: AgentRemedy[]; disabled: boolean; onRemedy: (r: AgentRemedy) => void }): ReactNode {
  if (props.remedies.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {props.remedies.map((r) => (
        <Button key={`${r.kind}:${r.method ?? ''}`} size="sm" variant="secondary" icon={r.kind === 'migrate' ? 'refresh' : 'upload'} disabled={props.disabled} onClick={() => props.onRemedy(r)} title={r.command ? `Runs: ${r.command}` : undefined}>
          {r.title}
        </Button>
      ))}
    </div>
  );
}

/** Update / restart policy per agent and machine (updates.md §6). */
function PolicySelects(props: { machineId: string; agent: AgentListing; disabled: boolean }): ReactNode {
  const { agent: a, machineId } = props;
  const store = useStore();
  const set = useAction((p: { update?: UpdatePolicy; restart?: RestartPolicy }) => store.setAgentPolicy({ machineId, agent: a.agent, ...p }));
  if (!a.updatePolicy && !a.restartPolicy) return null;
  // A plain compact select: the shared Select is a full-height form control.
  const sel = 'h-7 rounded-md border border-border bg-panel px-1.5 text-xs text-fg focus:border-accent focus:outline-none disabled:opacity-50';
  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        <label className="flex items-center gap-1.5">
          Updates
          <select className={sel} value={a.updatePolicy ?? 'auto'} disabled={props.disabled || set.busy} onChange={(e) => void set.run({ update: e.target.value as UpdatePolicy })}>
            {(Object.keys(UPDATE_POLICY_LABEL) as UpdatePolicy[]).map((p) => (
              <option key={p} value={p}>
                {UPDATE_POLICY_LABEL[p]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          Restarts
          <select className={sel} value={a.restartPolicy ?? 'when-idle'} disabled={props.disabled || set.busy} onChange={(e) => void set.run({ restart: e.target.value as RestartPolicy })}>
            {(Object.keys(RESTART_POLICY_LABEL) as RestartPolicy[]).map((p) => (
              <option key={p} value={p}>
                {RESTART_POLICY_LABEL[p]}
              </option>
            ))}
          </select>
        </label>
        {set.busy ? <Spinner size={12} /> : null}
      </div>
      <ErrorText error={set.error} className="mt-1 text-xs" />
    </div>
  );
}

export function CapabilityChips(props: { caps: AgentCapabilities }): ReactNode {
  const c = props.caps;
  const chips: string[] = [];
  for (const m of c.modes) chips.push(m);
  if (c.streaming !== 'none') chips.push(`${c.streaming} streaming`);
  if (c.steer) chips.push('steer');
  if (c.interrupt) chips.push('interrupt');
  if (c.approvals !== 'none') chips.push(`approvals: ${c.approvals}`);
  if (c.editableApprovals) chips.push('editable approvals');
  if (c.questions) chips.push('questions');
  if (c.fork) chips.push('fork');
  if (c.planMode) chips.push('plan mode');
  if (c.subagents) chips.push('subagents');
  if (c.effort?.length) chips.push(`effort: ${c.effort.join('/')}`);
  if (Array.isArray(c.models) && c.models.length) chips.push(`models: ${c.models.join(', ')}`);
  else if (c.models === 'dynamic') chips.push('models: dynamic');
  if (c.usage !== 'none') chips.push(`usage: ${c.usage}`);
  if (c.resume) chips.push('resume');
  if (c.images) chips.push('images');
  return (
    <div className="mt-3 flex flex-wrap gap-1">
      {chips.map((t) => (
        <span key={t} className="rounded bg-panel-2 px-1.5 py-0.5 text-[11px] text-muted">
          {t}
        </span>
      ))}
    </div>
  );
}
