import type { ReactNode } from 'react';
import { selectMachineList, shallowEqual } from '@bizzi/client';
import type { MachineInfo } from '@bizzi/protocol';
import { useBizzi, useStore } from '../app/context.tsx';
import { navigate } from '../app/hooks.ts';
import { useTargetMachineId } from '../app/machine.ts';
import { Icon } from '../components/icons.tsx';
import { PresenceDot } from '../components/MachineSwitcher.tsx';
import { Page, PageHeader } from '../components/layout.tsx';
import { Badge, Button, Card, Empty, Spinner, cx } from '../components/ui.tsx';
import { machinePresence } from '../lib/format.ts';

/** Every machine reachable through this connection: online state, what it is good for, ADE status. */
export function MachinesView(): ReactNode {
  const machines = useBizzi(selectMachineList, shallowEqual);
  const loaded = useBizzi((s) => Object.keys(s.machines).length > 0 || s.machine !== null);
  const hub = useBizzi((s) => s.role === 'hub');
  return (
    <Page
      header={
        <PageHeader
          title="Machines"
          subtitle={hub ? 'Machines connected to this hub' : 'This node and the machines it knows about'}
          actions={
            hub ? (
              <Button size="sm" icon="plus" onClick={() => navigate({ name: 'settings', section: 'devices' })}>
                Add machine
              </Button>
            ) : null
          }
        />
      }
    >
      {!loaded ? (
        <div className="flex justify-center py-10 text-muted">
          <Spinner />
        </div>
      ) : machines.length === 0 ? (
        <Empty icon="machine" title="No machines yet">
          Pair a machine from Settings → Devices.
        </Empty>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {machines.map((m) => (
            <MachineTile key={m.id} machine={m} />
          ))}
        </div>
      )}
      {!hub && machines.length > 1 ? <p className="mt-3 text-xs text-muted">Other machines are reached through a hub. Connect to the hub to work on them from here.</p> : null}
    </Page>
  );
}

function MachineTile(props: { machine: MachineInfo }): ReactNode {
  const store = useStore();
  const m = props.machine;
  const selected = useTargetMachineId() === m.id;
  const hub = useBizzi((s) => s.role === 'hub');
  const self = useBizzi((s) => s.machine?.id === m.id);
  const reachable = hub || self;
  const agents = useBizzi((s) => s.agents[m.id] ?? null);
  const counts = useBizzi((s) => {
    let workspaces = 0;
    let sessions = 0;
    let attention = 0;
    for (const w of Object.values(s.workspaces ?? {})) if (w.machineId === m.id) workspaces++;
    for (const x of Object.values(s.sessions)) {
      if (x.machineId !== m.id) continue;
      sessions++;
      if (x.status === 'waiting_approval' || x.status === 'waiting_input') attention++;
    }
    return { workspaces, sessions, attention };
  }, shallowEqual);
  const open = (): void => {
    if (!reachable) return;
    store.selectMachine(m.id);
    navigate({ name: 'machine', machineId: m.id });
  };
  return (
    <Card className={cx('p-4', reachable && 'cursor-pointer hover:bg-panel-2', selected && 'ring-1 ring-accent/50', !m.online && 'opacity-90')}>
      <div role={reachable ? 'button' : undefined} tabIndex={reachable ? 0 : undefined} onClick={open} onKeyDown={(e) => e.key === 'Enter' && open()}>
        <div className="flex items-center gap-2">
          <PresenceDot online={m.online} />
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{m.name}</div>
            <div className="truncate text-xs text-muted">
              {m.hostname} · {machinePresence(m)}
            </div>
          </div>
          {selected ? <Badge tone="accent">selected</Badge> : null}
        </div>
        <div className="mt-3 flex flex-wrap gap-1">
          <Badge>{m.headful ? 'headful' : 'headless'}</Badge>
          {m.alwaysOn ? <Badge>always on</Badge> : <Badge>may sleep</Badge>}
          <Badge>
            {m.os}/{m.arch}
          </Badge>
          {m.tags.map((t) => (
            <Badge key={t}>{t}</Badge>
          ))}
        </div>
        {agents ? (
          <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs">
            {agents
              .filter((a) => a.agent !== 'shell')
              .map((a) => (
                <span key={a.agent} className={cx('inline-flex items-center gap-1', !a.installed ? 'text-muted' : a.auth === 'ok' ? 'text-fg' : 'text-warn')}>
                  <Icon name={!a.installed ? 'x' : a.auth === 'ok' ? 'check' : 'alert'} size={12} />
                  {a.agent}
                </span>
              ))}
          </div>
        ) : null}
        <div className="mt-3 text-xs text-muted">
          {counts.workspaces} workspaces · {counts.sessions} sessions
          {counts.attention ? <span className="text-warn"> · {counts.attention} waiting</span> : null}
        </div>
      </div>
    </Card>
  );
}
