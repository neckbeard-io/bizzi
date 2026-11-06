import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { selectAgentJob, selectAgents } from '@bizzi/client';
import type { AgentCapabilities, AgentKind, AgentListing, InstallAction, MachineInfo } from '@bizzi/protocol';
import { useBizzi, useStore } from '../app/context.tsx';
import { navigate, useAction } from '../app/hooks.ts';
import { useIsHub, useMachine, useMachineOnline, useTargetMachineId } from '../app/machine.ts';
import { Icon } from '../components/icons.tsx';
import { PresenceDot } from '../components/MachineSwitcher.tsx';
import { Page, PageHeader, SectionTitle } from '../components/layout.tsx';
import { Badge, Button, Card, Empty, ErrorText, Spinner, cx } from '../components/ui.tsx';
import { machinePresence } from '../lib/format.ts';
import { agentActions, hasUpdate } from '../lib/provision.ts';
import { routeHref } from '../lib/router.ts';
import { JobProgress } from './provision/JobProgress.tsx';
import { PlanModal } from './provision/PlanModal.tsx';
import { SecretsPanel } from './provision/SecretsPanel.tsx';

/** One machine: what it is, which agents it has (install / update / log in), and its API keys. */
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
  const [plan, setPlan] = useState<{ agent: AgentKind; action: InstallAction } | null>(null);
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
            <Button size="sm" variant="ghost" icon="refresh" busy={refresh.busy} disabled={!online} onClick={() => void refresh.run()}>
              Re-probe
            </Button>
          }
        />
      }
    >
      {!online && machine ? <OfflineBanner machine={machine} /> : null}
      {machine ? <MachineCard machine={machine} /> : null}

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
            <AgentCard key={a.agent} machineId={machineId} online={online} agent={a} onPlan={(action) => setPlan({ agent: a.agent, action })} onSecret={() => setSecretFor(a.agent)} />
          ))}
        </div>
      )}

      <SecretsPanel machineId={machineId} online={online} preset={secretFor} onPresetUsed={clearSecretFor} />

      {!hub ? (
        <p className="mt-6 text-xs text-muted">
          Connected directly to this node. Other machines are reached through a hub; see{' '}
          <a className="text-accent underline-offset-2 hover:underline" href={routeHref({ name: 'machines' })}>
            Machines
          </a>
          .
        </p>
      ) : null}
      {plan ? <PlanModal machineId={machineId} machineName={name} agent={plan.agent} action={plan.action} onClose={() => setPlan(null)} /> : null}
    </Page>
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

function Fact(props: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-muted">{props.label}</div>
      <div className="truncate text-sm">{props.children}</div>
    </div>
  );
}

function MachineCard(props: { machine: MachineInfo }): ReactNode {
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
        <Fact label="Tags">{m.tags.length ? m.tags.join(', ') : '–'}</Fact>
      </div>
    </Card>
  );
}

const AUTH_TONE = { ok: 'ok', missing: 'warn', expired: 'err', unknown: 'neutral' } as const;
const AUTH_LABEL = { ok: 'signed in', missing: 'not signed in', expired: 'login expired', unknown: 'auth unknown' } as const;

function AgentCard(props: { machineId: string; online: boolean; agent: AgentListing; onPlan: (action: InstallAction) => void; onSecret: () => void }): ReactNode {
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
          <div className="truncate text-xs text-muted" title={a.path}>
            {a.installed ? `${a.version ?? 'unknown version'}${a.path ? ` · ${a.path}` : ''}` : 'not installed'}
          </div>
        </div>
        {a.installed ? <Badge tone={AUTH_TONE[a.auth]}>{AUTH_LABEL[a.auth]}</Badge> : <Badge>missing</Badge>}
      </div>
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
