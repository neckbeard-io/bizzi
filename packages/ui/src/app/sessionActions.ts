// Ending, reopening and deleting a session, shared by the session's "⋯" / right-click menu, its page, the
// sidebar and ⌘W (Settings › Hotkeys).
import { nextSessionAfterClose } from '@bizzi/client';
import type { BizziStore } from '@bizzi/client';
import type { SessionInfo } from '@bizzi/protocol';
import { isBusy } from '../lib/format.ts';
import { showToast } from './contextMenu.ts';
import { navigate } from './hooks.ts';

function sessionLabel(s: SessionInfo): string {
  return s.title ? `"${s.title}"` : 'this session';
}

function isOpenHere(s: SessionInfo): boolean {
  return window.location.hash.includes(s.id);
}

/** Leave a session's page for the next live session in its workspace, else the workspace page. */
function leave(store: BizziStore, s: SessionInfo, next: string | null): void {
  if (!isOpenHere(s)) return;
  if (next) navigate({ name: 'session', sessionId: next, tab: 'chat' }, { replace: true });
  else navigate({ name: 'workspace', workspaceId: s.workspaceId }, { replace: true });
}

/**
 * ⌘W: end the session (the agent and its helpers stop, the history stays) and move on to the next session in
 * its workspace. Asks only when a turn is in progress, since that work can't be undone; otherwise a toast
 * offers Undo, which reopens it. An already ended session is just left. False when you said no.
 */
export async function closeSessionFlow(store: BizziStore, s: SessionInfo): Promise<boolean> {
  const status = store.getState().timelines[s.id]?.status ?? s.status;
  const next = nextSessionAfterClose(store.getState(), s.id);
  if (status === 'ended') {
    leave(store, s, next);
    return true;
  }
  if (!confirmIfWorking(store, s)) return false;
  await store.stop(s.id);
  leave(store, s, next);
  showToast(`Ended ${sessionLabel(s)}. Find it under Ended in the sidebar.`, 'ok', {
    label: 'Undo',
    run: () => void reopenSessionFlow(store, s, { open: true }),
  });
  return true;
}

/** End from a menu: like ⌘W, but stays on the page, which then offers Reopen. False when you said no. */
export async function endSessionFlow(store: BizziStore, s: SessionInfo): Promise<boolean> {
  if (!confirmIfWorking(store, s)) return false;
  await store.stop(s.id);
  return true;
}

/** Ending is undone by reopening, except for a turn in progress: ask only then. */
function confirmIfWorking(store: BizziStore, s: SessionInfo): boolean {
  const status = store.getState().timelines[s.id]?.status ?? s.status;
  return !isBusy(status) || window.confirm(`End ${sessionLabel(s)}? The agent is working and its turn will be stopped. The history is kept, and you can reopen it.`);
}

/** Reopen an ended session so it takes messages again; with `open`, go to it. */
export async function reopenSessionFlow(store: BizziStore, s: SessionInfo, opts: { open?: boolean } = {}): Promise<void> {
  try {
    await store.reopenSession(s.id);
    if (opts.open) navigate({ name: 'session', sessionId: s.id, tab: 'chat' });
  } catch (err) {
    showToast(`Could not reopen the session: ${err instanceof Error ? err.message : String(err)}`, 'err');
  }
}

/** Ask, delete for good, and leave the session's page for its workspace if it was open. False when you said no. */
export async function deleteSessionFlow(store: BizziStore, s: SessionInfo): Promise<boolean> {
  if (!window.confirm(`Delete ${sessionLabel(s)}? The agent is stopped and the session and its history are removed. This cannot be undone.`)) return false;
  await store.deleteSession(s.id);
  if (isOpenHere(s)) navigate({ name: 'workspace', workspaceId: s.workspaceId }, { replace: true });
  return true;
}
