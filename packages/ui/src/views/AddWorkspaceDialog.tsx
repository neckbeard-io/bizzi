import type { ReactNode } from 'react';
import { closeAddWorkspace, useAddWorkspaceRequest } from '../app/addWorkspace.ts';
import { WorkspacePicker } from './workspaces/WorkspacePicker.tsx';

/**
 * The add-workspace dialog, mounted once by the shell and opened with `openAddWorkspace(machineId, path)`
 * from every entry point (sidebar machine tile "+", machine page, phone workspaces page, the
 * `#/workspaces?add=1&machine=…&path=…` deep link).
 */
export function AddWorkspaceDialog(): ReactNode {
  const req = useAddWorkspaceRequest();
  if (!req) return null;
  return <WorkspacePicker machineId={req.machineId} {...(req.path ? { initialPath: req.path } : {})} onClose={closeAddWorkspace} />;
}
