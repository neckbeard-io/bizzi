import type { ReactNode } from 'react';
import { shallowEqual } from '@bizzi/client';
import type { AgentCapabilities, AgentListing, MachineInfo } from '@bizzi/protocol';
import { useBizzi, useStore } from '../app/context.tsx';
import { useAction } from '../app/hooks.ts';
import { Icon } from '../components/icons.tsx';
import { Page, PageHeader, SectionTitle } from '../components/layout.tsx';
import { Badge, Button, Card, Empty, ErrorText, Spinner, cx } from '../components/ui.tsx';

export function MachineView(): ReactNode {
  const store = useStore();
  const machine = useBizzi((s) => s.machine);
  const others = useBizzi((s) => Object.values(s.machines).filter((m) => m.id !== s.machine?.id), shallowEqual);
  const agents = useBizzi((s) => s.agents);
  const install = useBizzi((s) => s.install);
  const serverVersion = useBizzi((s) => s.connection.serverVersion);
  const refresh = useAction(() => store.loadAgents(true));

  return (
    <Page
      header={
        <PageHeader
          title={machine?.name ?? 'Machine'}
          subtitle={machine ? `${machine.hostname} · bizzi ${machine.bizziVersion}${serverVersion ? ` · server ${serverVersion}` : ''}` : undefined}
        />
      }
    >
      {machine ? <MachineCard machine={machine} current /> : null}

      <SectionTitle
        actions={
          <Button size="sm" variant="ghost" icon="refresh" busy={refresh.busy} onClick={() => void refresh.run()}>
            Re-probe
          </Button>
        }
      >
        Agents
      </SectionTitle>
      <ErrorText error={refresh.error} />
      {agents === null ? (
        <div className="flex justify-center py-8 text-muted">
          <Spinner />
        </div>
      ) : agents.length === 0 ? (
        <Empty icon="bolt" title="No agents detected" />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {agents.map((a) => (
            <AgentCard key={a.agent} agent={a} progress={install[a.agent]} />
          ))}
        </div>
      )}

      {others.length > 0 ? (
        <>
          <SectionTitle>Other machines</SectionTitle>
          <div className="grid gap-3 sm:grid-cols-2">
            {others.map((m) => (
              <MachineCard key={m.id} machine={m} />
            ))}
          </div>
          <p className="mt-2 text-xs text-muted">Sessions on other machines are reached through the hub. Agent details are shown for the machine you are connected to.</p>
        </>
      ) : null}
    </Page>
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

function MachineCard(props: { machine: MachineInfo; current?: boolean }): ReactNode {
  const m = props.machine;
  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center gap-2">
        <Icon name="machine" size={18} className="text-muted" />
        <div className="min-w-0 flex-1 truncate font-medium">{m.name}</div>
        {props.current ? <Badge tone="accent">this connection</Badge> : null}
        <Badge tone={m.online ? 'ok' : 'neutral'}>{m.online ? 'online' : 'offline'}</Badge>
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

function AgentCard(props: { agent: AgentListing; progress?: { stage: string; message?: string; done?: boolean; ok?: boolean } | undefined }): ReactNode {
  const a = props.agent;
  const update = a.installed && a.latestVersion && a.version && a.latestVersion !== a.version;
  return (
    <Card className={cx('p-4', !a.installed && 'opacity-80')}>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-medium capitalize">{a.agent}</div>
          <div className="truncate text-xs text-muted">{a.installed ? `${a.version ?? 'unknown version'}${a.path ? ` · ${a.path}` : ''}` : 'not installed'}</div>
        </div>
        {a.installed ? <Badge tone={AUTH_TONE[a.auth]}>{AUTH_LABEL[a.auth]}</Badge> : <Badge>missing</Badge>}
      </div>
      {a.account ? <div className="mt-2 truncate text-xs text-muted">{a.account}</div> : null}
      {update ? (
        <div className="mt-2 text-xs text-info">
          Update available: {a.version} → {a.latestVersion}
        </div>
      ) : null}
      {a.notes?.length ? (
        <ul className="mt-2 list-disc pl-4 text-xs text-muted">
          {a.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
      {props.progress && !props.progress.done ? (
        <div className="mt-2 flex items-center gap-2 text-xs text-muted">
          <Spinner size={12} /> {props.progress.stage}
          {props.progress.message ? `: ${props.progress.message}` : ''}
        </div>
      ) : null}
      {a.capabilities ? <CapabilityChips caps={a.capabilities} /> : null}
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
