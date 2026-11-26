// Workspace dialogs and the remove flow, shared by the workspace page, its "⋯" menu and the sidebar's
// right-click menu.
import { useState } from 'react';
import type { ReactNode } from 'react';
import type { BizziStore } from '@bizzi/client';
import { BizziError } from '@bizzi/protocol';
import type { LabelColor, WorkspaceInfo } from '@bizzi/protocol';
import { useBizzi, useStore } from '../../app/context.tsx';
import { navigate, useAction } from '../../app/hooks.ts';
import { LabelColorField, WorkspaceTile } from '../../components/labels.tsx';
import { Button, ErrorText, Field, Input, Modal } from '../../components/ui.tsx';
import { iconInputError, workspaceMonogram } from '../../lib/labels.ts';
import { parseHash } from '../../lib/router.ts';

/**
 * Ask, then remove a workspace from bizzi (a worktree: `git worktree remove`, asking again before
 * discarding uncommitted changes). Leaves its page (or one of its sessions) if that's open. Resolves
 * false when the user said no.
 */
export async function removeWorkspaceFlow(store: BizziStore, ws: WorkspaceInfo): Promise<boolean> {
  if (ws.kind === 'worktree') {
    if (!window.confirm(`Remove the worktree "${ws.name}"? Its directory is deleted; the branch ${ws.branch ?? ''} is kept.`)) return false;
    try {
      await store.removeWorktree(ws.id);
    } catch (e) {
      // Live sessions block removal outright (data.sessions); only uncommitted changes (data.paths) can be forced.
      const data = e instanceof BizziError ? (e.data as { sessions?: unknown; paths?: unknown } | undefined) : undefined;
      if (!(e instanceof BizziError && e.code === 'conflict') || data?.sessions !== undefined) throw e;
      if (!window.confirm(`${e.message}\n\nRemove the worktree anyway and discard them? The branch is kept.`)) return false;
      await store.removeWorktree(ws.id, true);
    }
  } else {
    if (!window.confirm(`Remove "${ws.name}" from bizzi? Files on disk are not touched.`)) return false;
    await store.removeWorkspace(ws.id);
  }
  const r = parseHash(window.location.hash);
  const here = (r.name === 'workspace' && r.workspaceId === ws.id) || (r.name === 'session' && store.getState().sessions[r.sessionId]?.workspaceId === ws.id);
  if (here) navigate(ws.parentWorkspaceId ? { name: 'workspace', workspaceId: ws.parentWorkspaceId } : { name: 'workspaces' }, { replace: true });
  return true;
}

/** Rename the workspace and pick its identity color and icon (spec §11.1); stored on its node, replicated by the hub. */
export function WorkspaceIdentityDialog(props: { workspace: WorkspaceInfo; onClose: () => void }): ReactNode {
  const w = props.workspace;
  const store = useStore();
  const [name, setName] = useState(w.name);
  const [color, setColor] = useState<LabelColor | undefined>(w.color);
  const [icon, setIcon] = useState(w.icon ?? '');
  const iconError = iconInputError(icon);
  const parent = useBizzi((s) => (w.kind === 'worktree' && w.parentWorkspaceId ? (s.workspaces?.[w.parentWorkspaceId] ?? null) : null));
  const valid = name.trim() !== '' && iconError === null;
  const save = useAction(async () => {
    await store.setWorkspace({ workspaceId: w.id, name: name.trim(), color: color ?? '', icon: icon.trim() });
    props.onClose();
  });
  const remove = useAction(() => removeWorkspaceFlow(store, w));
  const preview: WorkspaceInfo = { ...w, name: name.trim() || w.name };
  if (color) preview.color = color;
  else delete preview.color;
  if (icon.trim() && !iconError) preview.icon = icon.trim();
  else delete preview.icon;
  return (
    <Modal
      title="Name, color and icon"
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={save.busy} disabled={!valid} onClick={() => void save.run()}>
            Save
          </Button>
        </>
      }
    >
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) void save.run();
        }}
      >
        <Field label="Name" hint="bizzi's name for it; the directory isn't renamed.">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} autoFocus />
        </Field>
        <LabelColorField
          value={color}
          onChange={setColor}
          label="Workspace color"
          hint={!color && parent?.color ? `None set: it shows ${parent.name}'s color.` : 'On its sidebar tile and in headers; readable in every theme.'}
        />
        <Field label="Icon" hint={iconError ?? 'One or two characters or an emoji, in place of the first letter.'}>
          <div className="flex items-center gap-2">
            <Input value={icon} onChange={(e) => setIcon(e.target.value)} maxLength={16} placeholder={workspaceMonogram({ name: preview.name })} className="w-24" spellCheck={false} autoCapitalize="off" />
            <WorkspaceTile workspace={preview} size="md" />
            <span className="min-w-0 truncate text-sm">{preview.name}</span>
          </div>
        </Field>
        <button type="submit" hidden />
      </form>
      <ErrorText error={save.error} />
      <div className="mt-4 flex items-center gap-3 border-t border-border pt-3">
        <span className="min-w-0 flex-1 text-xs text-muted">
          {w.kind === 'worktree' ? `Deletes the worktree's directory; the branch ${w.branch ?? ''} is kept.` : 'Removes it from bizzi only; files on disk are not touched.'}
        </span>
        <Button
          variant="ghost"
          size="sm"
          icon="trash"
          className="text-err"
          busy={remove.busy}
          onClick={() =>
            void remove.run().then((done) => {
              if (done) props.onClose();
            })
          }
        >
          {w.kind === 'worktree' ? 'Remove worktree' : 'Remove from bizzi'}
        </Button>
      </div>
      <ErrorText error={remove.error} />
    </Modal>
  );
}

/** `worktree.create`: a branch (new from `base`, or existing) checked out in its own directory, as a workspace. */
export function WorktreeDialog(props: { workspace: WorkspaceInfo; onClose: () => void }): ReactNode {
  const store = useStore();
  const git = useBizzi((s) => s.gitStatus[props.workspace.id] ?? null);
  const [branch, setBranch] = useState('');
  const [base, setBase] = useState('');
  const [name, setName] = useState('');
  const create = useAction(async () => {
    const params: Parameters<typeof store.createWorktree>[0] = { workspaceId: props.workspace.id, branch: branch.trim() };
    if (base.trim()) params.base = base.trim();
    if (name.trim()) params.name = name.trim();
    const w = await store.createWorktree(params);
    props.onClose();
    navigate({ name: 'workspace', workspaceId: w.id });
  });
  const valid = /^[\w][\w./-]*$/.test(branch.trim()) && !branch.includes('..');
  return (
    <Modal
      title={`New worktree of ${props.workspace.name}`}
      onClose={props.onClose}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon="branch" disabled={!valid} busy={create.busy} onClick={() => void create.run()}>
            Create worktree
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) void create.run();
        }}
      >
        <Field label="Branch" hint="Created from the base unless it already exists.">
          <Input autoFocus value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="feat/oauth" spellCheck={false} autoCapitalize="off" />
        </Field>
        <Field label="Base (optional)">
          <Input value={base} onChange={(e) => setBase(e.target.value)} placeholder={git?.branch ? `${git.branch} (HEAD)` : 'HEAD'} spellCheck={false} autoCapitalize="off" />
        </Field>
        <Field label="Workspace name (optional)">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={branch ? `${props.workspace.name} · ${branch}` : ''} />
        </Field>
        <ErrorText error={create.error} />
      </form>
    </Modal>
  );
}
