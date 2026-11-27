import type { ReactNode } from 'react';
import type { KeepAwakeMode, KeepAwakeSettings, MachineInfo } from '@bizzi/protocol';
import { useStore } from '../../app/context.tsx';
import { useAction } from '../../app/hooks.ts';
import { Icon } from '../../components/icons.tsx';
import { Card, ErrorText, Field, Select, Spinner } from '../../components/ui.tsx';
import { keepAwakeSummary } from '../../lib/format.ts';

const MODE_LABEL: Record<KeepAwakeMode, string> = {
  off: 'Never',
  turns: 'While a turn runs',
  turns_and_background: 'While a turn runs or background work is going',
};

const MODE_HINT: Record<KeepAwakeMode, string> = {
  off: 'The machine sleeps on its usual schedule, even mid-turn.',
  turns: 'While an agent works on a turn or a terminal session is busy, plus a minute and a half after.',
  turns_and_background: 'Also while an agent watches background work between turns (a CI run, a dev server, a subagent).',
};

/**
 * Keep the machine awake while its agents work (spec §8.1). Per machine, stored on its node; changes apply
 * at once. Only idle system sleep is held: the display still sleeps, and closing a laptop's lid still does.
 */
export function KeepAwakePanel(props: { machine: MachineInfo; online: boolean }): ReactNode {
  const { machine: m, online } = props;
  const store = useStore();
  const set = useAction((patch: Partial<KeepAwakeSettings>) => store.setMachine({ machineId: m.id, keepAwake: patch }));
  const k = m.keepAwake;

  if (!k) return <Card className="p-4 text-sm text-muted">{online ? 'This node does not support keeping the machine awake yet.' : 'Available when the machine is online.'}</Card>;
  if (!k.supported) {
    return (
      <Card className="p-4 text-sm text-muted">
        Keeping the machine awake isn't available on {m.os === 'linux' ? 'Linux' : m.os === 'win32' ? 'Windows' : 'this OS'} yet; it sleeps on its usual schedule.
      </Card>
    );
  }
  const disabled = !online || set.busy;
  const summary = online ? keepAwakeSummary(k) : undefined;
  return (
    <Card className="p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Keep this machine awake" hint={MODE_HINT[k.settings.mode]}>
          <Select value={k.settings.mode} disabled={disabled} onChange={(e) => void set.run({ mode: e.target.value as KeepAwakeMode })}>
            {(Object.keys(MODE_LABEL) as KeepAwakeMode[]).map((mode) => (
              <option key={mode} value={mode}>
                {MODE_LABEL[mode]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Power" hint="On battery, a closed lid still sleeps the machine either way.">
          <Select value={k.settings.onBattery ? 'battery' : 'ac'} disabled={disabled || k.settings.mode === 'off'} onChange={(e) => void set.run({ onBattery: e.target.value === 'battery' })}>
            <option value="ac">Only on a power adapter</option>
            <option value="battery">Also on battery</option>
          </Select>
        </Field>
      </div>
      <div className="mt-3 flex items-center gap-2 text-xs text-muted">
        {set.busy ? <Spinner size={12} /> : <Icon name={k.active ? 'sun' : 'moon'} size={13} className={k.active ? 'text-warn' : undefined} />}
        <span>{summary ?? (online ? 'Not keeping the machine awake right now.' : 'Machine offline.')}</span>
        {online && k.power && k.power !== 'unknown' ? <span className="ml-auto">{k.power === 'ac' ? 'on power adapter' : 'on battery'}</span> : null}
      </div>
      <ErrorText error={set.error} className="mt-2 text-xs" />
    </Card>
  );
}
