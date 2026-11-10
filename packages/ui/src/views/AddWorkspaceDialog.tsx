import type { ReactNode } from 'react';
import { closeAddWorkspace, useAddWorkspaceRequest } from '../app/addWorkspace.ts';
import { useMachine, useTargetMachineId } from '../app/machine.ts';
import { Modal } from '../components/ui.tsx';
import { AddWorkspaceForm } from './WorkspacesView.tsx';

/**
 * The add-workspace dialog, mounted once by the shell and opened with `openAddWorkspace(machineId)`.
 * The body is the existing add-workspace form; a filesystem picker can replace it here.
 */
export function AddWorkspaceDialog(): ReactNode {
  const req = useAddWorkspaceRequest();
  const selected = useTargetMachineId();
  const machineId = req?.machineId ?? selected;
  const machine = useMachine(machineId);
  if (!req) return null;
  return (
    <Modal title={machine ? `Add a workspace on ${machine.name}` : 'Add a workspace'} onClose={closeAddWorkspace} wide>
      <AddWorkspaceForm machineId={machineId} onDone={closeAddWorkspace} />
    </Modal>
  );
}
