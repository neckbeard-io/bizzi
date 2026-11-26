// What the right-click menus (and the "⋯" header menus) offer for a machine, a workspace and a session.
import type { BizziStore } from '@bizzi/client';
import type { MachineInfo, SessionInfo, WorkspaceInfo } from '@bizzi/protocol';
import { openAddWorkspace } from '../app/addWorkspace.ts';
import { copyText, openDialog, showToast } from '../app/contextMenu.ts';
import type { MenuItem } from '../app/contextMenu.ts';
import { navigate } from '../app/hooks.ts';
import { requestNewSession } from '../app/workspaceIntents.ts';
import { removeWorkspaceFlow } from './workspaces/WorkspaceDialogs.tsx';

const OFFLINE = 'The machine is offline';

export function machineMenu(store: BizziStore, m: MachineInfo, opts: { collapsed?: boolean; onToggle?: () => void } = {}): MenuItem[] {
  const online = m.online !== false;
  const items: MenuItem[] = [
    {
      label: 'Open machine',
      icon: 'machine',
      onSelect: () => {
        store.selectMachine(m.id);
        navigate({ name: 'machine', machineId: m.id });
      },
    },
    {
      label: 'Add workspace…',
      icon: 'plus',
      disabled: !online,
      ...(online ? {} : { hint: OFFLINE }),
      onSelect: () => {
        store.selectMachine(m.id);
        openAddWorkspace(m.id);
      },
    },
    {
      label: 'Re-check agents',
      icon: 'refresh',
      disabled: !online,
      hint: online ? 'Probe installs, versions and logins again' : OFFLINE,
      onSelect: async () => {
        await store.loadAgents(m.id, true);
        showToast(`Agents on ${m.name} re-checked`);
      },
    },
    {
      label: 'Tags, description and color…',
      icon: 'tag',
      onSelect: () => {
        store.selectMachine(m.id);
        navigate({ name: 'machine', machineId: m.id });
      },
    },
  ];
  if (opts.onToggle) items.push('separator', { label: opts.collapsed ? 'Expand' : 'Collapse', icon: opts.collapsed ? 'chevronRight' : 'chevronDown', onSelect: opts.onToggle });
  items.push('separator', { label: 'Copy hostname', icon: 'copy', onSelect: () => copyText(m.hostname, 'hostname') }, { label: 'Copy machine ID', icon: 'copy', onSelect: () => copyText(m.id, 'machine ID') });
  return items;
}

export function workspaceMenu(store: BizziStore, ws: WorkspaceInfo, online: boolean): MenuItem[] {
  const offline = online ? {} : { hint: OFFLINE };
  const git = ws.kind === 'git' || ws.kind === 'worktree';
  const items: MenuItem[] = [
    { label: 'Open', icon: 'folder', onSelect: () => navigate({ name: 'workspace', workspaceId: ws.id }) },
    {
      label: 'New session…',
      icon: 'plus',
      disabled: !online,
      ...offline,
      onSelect: () => {
        requestNewSession(ws.id);
        navigate({ name: 'workspace', workspaceId: ws.id });
      },
    },
  ];
  if (git) items.push({ label: 'New worktree…', icon: 'branch', disabled: !online, ...offline, onSelect: () => openDialog({ kind: 'newWorktree', workspaceId: ws.id }) });
  items.push(
    'separator',
    { label: 'Name, color and icon…', icon: 'edit', disabled: !online, ...offline, onSelect: () => openDialog({ kind: 'editWorkspace', workspaceId: ws.id }) },
    { label: 'Copy path', icon: 'copy', onSelect: () => copyText(ws.path, 'path') },
  );
  if (ws.kind === 'worktree' && ws.branch) items.push({ label: 'Copy branch name', icon: 'copy', onSelect: () => copyText(ws.branch!, 'branch name') });
  items.push('separator', {
    label: ws.kind === 'worktree' ? 'Remove worktree…' : 'Remove from bizzi…',
    icon: 'trash',
    danger: true,
    disabled: !online,
    hint: online ? (ws.kind === 'worktree' ? 'Deletes the directory; the branch is kept' : 'Files on disk are not touched') : OFFLINE,
    onSelect: () => removeWorkspaceFlow(store, ws),
  });
  return items;
}

/** The CLI command that resumes the agent's own session outside bizzi, when the agent has one. */
function resumeCommand(s: SessionInfo): string | null {
  if (!s.agentSessionRef) return null;
  if (s.agent === 'claude') return `claude --resume ${s.agentSessionRef}`;
  if (s.agent === 'codex') return `codex resume ${s.agentSessionRef}`;
  return null;
}

export function sessionMenu(store: BizziStore, s: SessionInfo, online: boolean): MenuItem[] {
  const st = store.getState();
  const offline = online ? {} : { hint: OFFLINE };
  const ended = s.status === 'ended' || s.status === 'failed';
  const canFork = (st.capabilities[s.id] ?? st.agents[s.machineId]?.find((a) => a.agent === s.agent)?.capabilities)?.fork ?? false;
  const unread = s.lastSeq > (s.seenThrough ?? 0);
  const label = s.title ? `"${s.title}"` : 'this session';
  const items: MenuItem[] = [
    { label: 'Open', icon: s.mode === 'terminal' ? 'terminal' : 'chat', onSelect: () => navigate({ name: 'session', sessionId: s.id, tab: 'chat' }) },
    { label: 'Rename…', icon: 'edit', disabled: !online, ...offline, onSelect: () => openDialog({ kind: 'renameSession', sessionId: s.id }) },
  ];
  if (canFork && s.mode === 'structured') {
    items.push({
      label: 'Fork',
      icon: 'fork',
      disabled: !online,
      hint: online ? 'A new session continuing this conversation' : OFFLINE,
      onSelect: async () => {
        const f = await store.forkSession(s.id);
        navigate({ name: 'session', sessionId: f.id, tab: 'chat' });
      },
    });
  }
  if (unread) items.push({ label: 'Mark as read', icon: 'check', onSelect: () => store.markSeen(s.id, s.lastSeq) });
  items.push('separator', { label: 'Copy session ID', icon: 'copy', onSelect: () => copyText(s.id, 'session ID') });
  const resume = resumeCommand(s);
  if (resume) items.push({ label: 'Copy resume command', icon: 'terminal', hint: resume, onSelect: () => copyText(resume, 'resume command') });
  items.push('separator');
  if (!ended) {
    items.push({
      label: 'End session',
      icon: 'stop',
      disabled: !online,
      ...offline,
      onSelect: async () => {
        if (window.confirm(`End ${label}? The agent process will be stopped.`)) await store.stop(s.id);
      },
    });
  }
  items.push({
    label: 'Delete…',
    icon: 'trash',
    danger: true,
    disabled: !online,
    ...offline,
    onSelect: async () => {
      if (!window.confirm(`Delete ${label}? The agent is stopped and the session and its history are removed. This cannot be undone.`)) return;
      await store.deleteSession(s.id);
      if (window.location.hash.includes(s.id)) navigate({ name: 'workspace', workspaceId: s.workspaceId }, { replace: true });
    },
  });
  return items;
}
