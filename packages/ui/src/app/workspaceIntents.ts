// "New session…" from a menu outside the workspace page: the page opens its form when it mounts
// (or is already showing that workspace).
import { useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

let pending: string | null = null;
const listeners = new Set<(workspaceId: string) => void>();

export function requestNewSession(workspaceId: string): void {
  pending = workspaceId;
  for (const l of listeners) l(workspaceId);
}

/** True once a new session was requested for this workspace; the request is consumed. */
export function useNewSessionRequest(workspaceId: string): [boolean, Dispatch<SetStateAction<boolean>>] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (take(workspaceId)) setOpen(true);
    const l = (id: string): void => {
      if (id === workspaceId && take(workspaceId)) setOpen(true);
    };
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, [workspaceId]);
  return [open, setOpen];
}

function take(workspaceId: string): boolean {
  if (pending !== workspaceId) return false;
  pending = null;
  return true;
}
