import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { selectMachineList, shallowEqual } from '@bizzi/client';
import type { MachineInfo } from '@bizzi/protocol';
import { useBizzi, useStore } from '../app/context.tsx';
import { navigate, useRoute } from '../app/hooks.ts';
import { useTargetMachineId } from '../app/machine.ts';
import { machinePresence } from '../lib/format.ts';
import { routeHref } from '../lib/router.ts';
import { Icon } from './icons.tsx';
import { cx } from './ui.tsx';

export function PresenceDot(props: { online: boolean; className?: string }): ReactNode {
  return <span className={cx('inline-block h-2 w-2 shrink-0 rounded-full', props.online ? 'bg-ok' : 'bg-muted/50 ring-1 ring-muted/60', props.className)} aria-label={props.online ? 'online' : 'offline'} />;
}

/** Machine is first in the hierarchy: pick the machine everything else (workspaces, agents, knowledge) is about. */
export function MachineSwitcher(props: { className?: string }): ReactNode {
  const store = useStore();
  const route = useRoute();
  const machines = useBizzi(selectMachineList, shallowEqual);
  const selectedId = useTargetMachineId();
  const hub = useBizzi((s) => s.role === 'hub');
  const selected = machines.find((m) => m.id === selectedId) ?? null;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (m: MachineInfo): void => {
    setOpen(false);
    store.selectMachine(m.id);
    if (route.name === 'machine') navigate({ name: 'machine', machineId: m.id });
    else if (route.name === 'workspace' || route.name === 'session') navigate({ name: 'workspaces' });
  };

  const canSwitch = hub && machines.length > 1;
  return (
    <div ref={ref} className={cx('relative', props.className)}>
      <button
        type="button"
        onClick={() => (canSwitch ? setOpen((o) => !o) : navigate({ name: 'machine' }))}
        className="flex w-full min-w-0 items-center gap-2 rounded-md border border-border bg-bg px-2.5 py-1.5 text-left hover:bg-panel-2"
        aria-haspopup={canSwitch ? 'listbox' : undefined}
        aria-expanded={canSwitch ? open : undefined}
      >
        <Icon name="machine" size={16} className="shrink-0 text-muted" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{selected?.name ?? 'No machine'}</span>
          <span className="flex items-center gap-1.5 text-[11px] text-muted">
            {selected ? <PresenceDot online={selected.online} className="h-1.5 w-1.5" /> : null}
            <span className="truncate">{selected ? machinePresence(selected) : 'connecting…'}</span>
          </span>
        </span>
        {canSwitch ? <Icon name="chevronDown" size={14} className="shrink-0 text-muted" /> : null}
      </button>
      {open ? (
        <div role="listbox" className="absolute top-full right-0 left-0 z-40 mt-1 overflow-hidden rounded-md border border-border bg-panel shadow-lg">
          {machines.map((m) => (
            <button
              key={m.id}
              type="button"
              role="option"
              aria-selected={m.id === selectedId}
              onClick={() => pick(m)}
              className={cx('flex w-full items-center gap-2 px-2.5 py-2 text-left hover:bg-panel-2', m.id === selectedId && 'bg-panel-2')}
            >
              <PresenceDot online={m.online} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{m.name}</span>
                <span className="block truncate text-[11px] text-muted">
                  {m.hostname} · {machinePresence(m)}
                </span>
              </span>
              {m.id === selectedId ? <Icon name="check" size={14} className="text-accent-text" /> : null}
            </button>
          ))}
          <a href={routeHref({ name: 'machines' })} onClick={() => setOpen(false)} className="block border-t border-border px-2.5 py-2 text-xs text-muted hover:bg-panel-2 hover:text-fg">
            All machines…
          </a>
        </div>
      ) : null}
    </div>
  );
}
