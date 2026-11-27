// Deleting a session, shared by the session's "⋯" / right-click menu and ⌘W (Settings › Hotkeys).
import type { BizziStore } from '@bizzi/client';
import type { SessionInfo } from '@bizzi/protocol';
import { navigate } from './hooks.ts';

/** Ask, delete, and leave the session's page for its workspace if it was open. False when you said no. */
export async function deleteSessionFlow(store: BizziStore, s: SessionInfo): Promise<boolean> {
  const label = s.title ? `"${s.title}"` : 'this session';
  if (!window.confirm(`Delete ${label}? The agent is stopped and the session and its history are removed. This cannot be undone.`)) return false;
  await store.deleteSession(s.id);
  if (window.location.hash.includes(s.id)) navigate({ name: 'workspace', workspaceId: s.workspaceId }, { replace: true });
  return true;
}
