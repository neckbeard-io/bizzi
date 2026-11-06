import type { ReactNode } from 'react';
import { useBizzi } from '../app/context.tsx';
import { useMachine, useMachineOnline } from '../app/machine.ts';
import { machinePresence } from '../lib/format.ts';
import { Icon } from './icons.tsx';
import { cx } from './ui.tsx';

/** "server-a is offline (last seen …)": shown above cached, read-only data of an unreachable machine. */
export function OfflineMachineBanner(props: { machineId: string | null | undefined; className?: string }): ReactNode {
  const machine = useMachine(props.machineId);
  const online = useMachineOnline(props.machineId);
  const connected = useBizzi((s) => s.connection.state === 'open');
  if (online || !connected || !props.machineId) return null;
  return (
    <div className={cx('flex items-start gap-2 rounded-md border border-warn/30 bg-warn/5 px-3 py-2 text-sm text-warn', props.className)} role="status">
      <Icon name="wifiOff" size={16} className="mt-0.5 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="font-medium">{machine?.name ?? 'This machine'} is offline</span>
        {machine ? ` (${machinePresence(machine)})` : ''}. Showing cached data; changes are disabled until it reconnects.
      </span>
    </div>
  );
}
