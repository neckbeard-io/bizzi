import { selectMachineOnline, selectTargetMachineId } from '@bizzi/client';
import type { MachineInfo } from '@bizzi/protocol';
import { useBizzi } from './context.tsx';

/** The machine machine-targeted actions go to (the selected one). */
export function useTargetMachineId(): string | null {
  return useBizzi(selectTargetMachineId);
}

export function useMachine(machineId: string | null | undefined): MachineInfo | null {
  return useBizzi((s) => (machineId ? (s.machines[machineId] ?? (s.machine?.id === machineId ? s.machine : null)) : null));
}

/** Whether requests to the machine can reach it now (connected, and the node is online behind the hub). */
export function useMachineOnline(machineId: string | null | undefined): boolean {
  return useBizzi((s) => selectMachineOnline(s, machineId));
}

export function useIsHub(): boolean {
  return useBizzi((s) => s.role === 'hub');
}

/**
 * Whether headers should name the machine (spec §11.1 identity): when there's more than one, or when the
 * user gave this one a color or tags.
 */
export function useShowMachine(machine: MachineInfo | null): boolean {
  const several = useBizzi((s) => s.role === 'hub' && Object.keys(s.machines).length > 1);
  return machine !== null && (several || machine.color !== undefined || machine.tags.length > 0);
}
