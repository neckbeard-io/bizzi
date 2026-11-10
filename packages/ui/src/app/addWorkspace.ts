// "Add workspace" from anywhere (sidebar machine tile "+", machine page, phone workspaces page) opens one
// dialog, rendered once by the shell (views/AddWorkspaceDialog.tsx).
import { useSyncExternalStore } from 'react';

export type AddWorkspaceRequest = { machineId: string | null };

let request: AddWorkspaceRequest | null = null;
const listeners = new Set<() => void>();

function set(next: AddWorkspaceRequest | null): void {
  request = next;
  for (const l of listeners) l();
}

/** Open the add-workspace dialog for a machine (null: the selected machine). */
export function openAddWorkspace(machineId: string | null): void {
  set({ machineId });
}

export function closeAddWorkspace(): void {
  set(null);
}

export function useAddWorkspaceRequest(): AddWorkspaceRequest | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => request,
    () => null,
  );
}
