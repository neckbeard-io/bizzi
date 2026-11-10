import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import type { BrowseEntry, MethodResult, WorkspaceInfo } from '@bizzi/protocol';
import { useBizzi, useStore } from '../../app/context.tsx';
import { navigate, useAction, useIsWide } from '../../app/hooks.ts';
import { useMachine, useMachineOnline } from '../../app/machine.ts';
import { Icon } from '../../components/icons.tsx';
import { Badge, Button, Checkbox, ErrorText, Field, IconButton, Input, Kbd, Spinner, cx } from '../../components/ui.tsx';
import { errorInfo } from '../../lib/format.ts';
import {
  basename,
  breadcrumbs,
  dirInput,
  dropdownKey,
  exactMatch,
  expandTilde,
  isAbsoluteLike,
  splitInput,
  toTilde,
} from '../../lib/picker.ts';
import type { DropdownState } from '../../lib/picker.ts';

/** Debounce for fs.complete / fs.browse while typing (performance guardrail). */
const DEBOUNCE_MS = 120;

type Listing = MethodResult<'fs.browse'>;

/**
 * "Add workspace" for one machine: a path input with directory autocompletion (fs.complete) over a
 * browser pane (fs.browse) with breadcrumbs, Up / Home, hidden toggle and quick picks (fs.suggest).
 * Typing and browsing stay in sync: the browser shows the directory being typed into, and clicking a
 * folder puts its path in the input. Full-screen sheet on phones.
 */
export function WorkspacePicker(props: { machineId: string | null; initialPath?: string; onClose: () => void; onCreated?: (ws: WorkspaceInfo) => void }): ReactNode {
  const { onClose } = props;
  const store = useStore();
  const wide = useIsWide();
  const machineId = useBizzi((s) => props.machineId ?? s.selectedMachineId ?? s.machine?.id ?? null);
  const machine = useMachine(machineId);
  const online = useMachineOnline(machineId);
  // Matches fs.complete on the node: macOS and Windows filesystems ignore case.
  const caseInsensitive = machine?.os === 'darwin' || machine?.os === 'win32';
  const workspaces = useBizzi((s) => s.workspaces);

  const [input, setInput] = useState(props.initialPath ?? '~/');
  const [home, setHome] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [listing, setListing] = useState<Listing | null>(null);
  const [listingError, setListingError] = useState<unknown>(null);
  const [listingLoading, setListingLoading] = useState(false);
  const [baseMissing, setBaseMissing] = useState(false);
  const [suggestions, setSuggestions] = useState<BrowseEntry[]>([]);
  const [completion, setCompletion] = useState<{ input: string; base: string; entries: BrowseEntry[] } | null>(null);
  const [completeError, setCompleteError] = useState<unknown>(null);
  const [selected, setSelected] = useState(-1);
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  /** Opened with ↑/↓/Tab although nothing is typed after the last '/' (otherwise the browser shows it all). */
  const [forced, setForced] = useState(false);
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [create, setCreate] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const completeSeq = useRef(0);
  const browseSeq = useRef(0);
  /** Next input change comes from navigation (no debounce, dropdown stays closed). */
  const navigating = useRef(false);
  const lastBrowsed = useRef<string | null>(null);

  const browse = useCallback(
    async (path: string, hidden: boolean): Promise<void> => {
      const seq = ++browseSeq.current;
      setListingLoading(true);
      try {
        const r = await store.browseDirs({ ...(machineId ? { machineId } : {}), path, showHidden: hidden });
        if (seq !== browseSeq.current) return;
        setListing(r);
        setHome(r.home);
        setListingError(null);
        setBaseMissing(false);
      } catch (err) {
        if (seq !== browseSeq.current) return;
        const missing = (err as { code?: string }).code === 'not_found';
        setBaseMissing(missing);
        // A directory that doesn't exist yet isn't an error: the workspace may be created there.
        setListingError(missing ? null : err);
      } finally {
        if (seq === browseSeq.current) setListingLoading(false);
      }
    },
    [store, machineId],
  );

  // Quick picks once per machine.
  useEffect(() => {
    if (!online) return;
    let live = true;
    store
      .suggestDirs(machineId)
      .then((r) => live && setSuggestions(r.entries))
      .catch(() => live && setSuggestions([]));
    return () => {
      live = false;
    };
  }, [store, machineId, online]);

  // Typing: complete the input and browse the directory part, debounced; stale answers are dropped.
  useEffect(() => {
    if (!online) return;
    const immediate = navigating.current;
    navigating.current = false;
    const t = setTimeout(
      () => {
        if (!isAbsoluteLike(input)) {
          completeSeq.current++;
          setCompletion({ input, base: '', entries: [] });
          setCompleteError(null);
          return;
        }
        const { base } = splitInput(input);
        const browseKey = `${base}\0${showHidden}`;
        if (lastBrowsed.current !== browseKey) {
          lastBrowsed.current = browseKey;
          void browse(base, showHidden);
        }
        const seq = ++completeSeq.current;
        store
          .completePath({ ...(machineId ? { machineId } : {}), prefix: input, showHidden })
          .then((r) => {
            if (seq !== completeSeq.current) return;
            setCompletion({ input, base: r.base, entries: r.completions });
            setCompleteError(null);
            setSelected(-1);
          })
          .catch((err: unknown) => {
            if (seq !== completeSeq.current) return;
            setCompletion({ input, base, entries: [] });
            setCompleteError(err);
          });
      },
      immediate ? 0 : DEBOUNCE_MS,
    );
    return () => clearTimeout(t);
  }, [input, showHidden, online, store, machineId, browse]);

  const fresh = completion?.input === input ? completion : null;
  const entries = fresh?.entries ?? [];
  const { partial } = splitInput(input);
  const valid = isAbsoluteLike(input) && input.trim() !== '';
  const abs = home && valid ? expandTilde(input, home) : null;
  const match = partial ? exactMatch(partial, entries, caseInsensitive) : undefined;
  // true: an existing directory; false: doesn't exist (offer to create); null: not known yet.
  const exists: boolean | null = !valid || !home ? null : partial ? (match ? true : fresh ? false : null) : baseMissing ? false : listing && listing.path === abs ? true : null;
  // Already registered: by path in the store, or the node's mark on the matching completion (real path).
  const existing = useMemo(() => {
    if (!abs) return undefined;
    const ws = Object.values(workspaces ?? {}).find((w) => w.machineId === machineId && w.path === abs);
    return ws ?? (match?.workspaceId ? workspaces?.[match.workspaceId] : undefined);
  }, [abs, workspaces, machineId, match]);
  const defaultName = abs ? basename(abs) : '';
  const shownName = nameTouched ? name : defaultName;
  const dropdownOpen = open && focused && entries.length > 0 && (partial !== '' || forced);

  const setPath = (absPath: string): void => {
    navigating.current = true;
    setOpen(false);
    setInput(dirInput(absPath, home));
  };

  const submit = useAction(async () => {
    if (!abs) return;
    if (existing) {
      onClose();
      navigate({ name: 'workspace', workspaceId: existing.id });
      return;
    }
    const params: { machineId?: string; path: string; name?: string; create?: boolean } = { path: abs };
    if (machineId) params.machineId = machineId;
    if (shownName.trim() && shownName.trim() !== defaultName) params.name = shownName.trim();
    if (exists === false && create) params.create = true;
    const ws = await store.createWorkspace(params);
    onClose();
    if (props.onCreated) props.onCreated(ws);
    else navigate({ name: 'workspace', workspaceId: ws.id });
  });
  const canSubmit = online && abs !== null && (existing !== undefined || exists === true || (exists === false && create));

  const onInputKey = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    const state: DropdownState = { input, completions: entries, selected, open: dropdownOpen };
    const out = dropdownKey(state, e.key, caseInsensitive);
    switch (out.kind) {
      case 'default':
        return;
      case 'state':
        e.preventDefault();
        e.stopPropagation();
        setOpen(out.state.open);
        setForced(out.state.open);
        setSelected(out.state.selected);
        return;
      case 'input':
        e.preventDefault();
        setInput(out.input);
        setOpen(true);
        setForced(false);
        setSelected(-1);
        return;
      case 'submit':
        e.preventDefault();
        if (canSubmit && !submit.busy) void submit.run();
        return;
      case 'close':
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
    }
  };

  // Esc anywhere in the dialog (outside the input, which handles its own) closes it.
  const onPanelKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape' && e.target !== inputRef.current) {
      e.preventDefault();
      onClose();
    }
  };

  useEffect(() => {
    inputRef.current?.focus();
    const el = inputRef.current;
    if (el) el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const crumbs = listing && home ? breadcrumbs(listing.path, home) : [];
  const quick = suggestions.filter((s) => s.suggest !== 'repo');
  const repos = suggestions.filter((s) => s.suggest === 'repo').slice(0, 8);
  const title = `Add workspace${machine ? ` on ${machine.name}` : ''}`;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/40 sm:items-center sm:p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={onPanelKey}
        className="flex h-full w-full flex-col border-border bg-panel shadow-xl outline-none sm:h-[min(44rem,92vh)] sm:max-w-2xl sm:rounded-xl sm:border"
        style={wide ? undefined : { paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Icon name="folder" size={18} className="text-muted" />
          <div className="min-w-0 flex-1 truncate font-semibold">{title}</div>
          <IconButton icon="x" label="Close" onClick={onClose} className="-mr-2 h-11 w-11 sm:h-8 sm:w-8" />
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pt-3">
          {!online ? <ErrorText error={{ code: 'machine_offline', message: `${machine?.name ?? 'The machine'} is offline; its folders can't be browsed until it reconnects.` }} /> : null}

          {/* Path input with the completion dropdown */}
          <div className="relative">
            <label className="mb-1 block text-xs font-medium text-muted" htmlFor="wp-path">
              Folder on {machine?.name ?? 'this machine'}
            </label>
            <input
              id="wp-path"
              ref={inputRef}
              value={input}
              disabled={!online}
              onChange={(e) => {
                setInput(e.target.value);
                setOpen(true);
                setForced(false);
                setSelected(-1);
              }}
              onKeyDown={onInputKey}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              placeholder="~/src/project"
              className="h-11 w-full rounded-md border border-border bg-panel px-2.5 font-mono text-sm placeholder:text-muted/70 focus:border-accent focus:outline-none disabled:opacity-50 sm:h-9"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              autoComplete="off"
              role="combobox"
              aria-expanded={dropdownOpen}
              aria-controls="wp-completions"
              aria-autocomplete="list"
              aria-activedescendant={dropdownOpen && selected >= 0 ? `wp-c-${selected}` : undefined}
            />
            {dropdownOpen ? (
              <ul id="wp-completions" role="listbox" className="absolute inset-x-0 top-full z-10 mt-1 max-h-64 overflow-y-auto rounded-md border border-border bg-panel py-1 shadow-lg">
                {entries.map((c, i) => (
                  <li
                    key={c.path}
                    id={`wp-c-${i}`}
                    role="option"
                    aria-selected={i === selected}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setSelected(i)}
                    onClick={() => {
                      setInput(`${fresh?.base ?? splitInput(input).base}${c.name}/`);
                      setSelected(-1);
                    }}
                    className={cx('flex h-11 cursor-pointer items-center gap-2 px-3 font-mono text-sm sm:h-8', i === selected ? 'bg-accent-soft' : 'hover:bg-panel-2')}
                  >
                    <EntryIcon entry={c} />
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-semibold">{c.name.slice(0, partial.length)}</span>
                      {c.name.slice(partial.length)}
                    </span>
                    <EntryBadges entry={c} />
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="mt-1 min-h-4 text-xs text-muted">
              {!valid && input.trim() ? (
                <span className="text-warn">Type an absolute path, or start with ~</span>
              ) : completeError ? (
                <span className="text-err">{errorInfo(completeError).message}</span>
              ) : existing ? (
                <span className="text-accent">Already a workspace: {existing.name}</span>
              ) : exists === false && entries.length > 0 ? (
                <span>
                  {entries.length} matching folder{entries.length === 1 ? '' : 's'} · <Kbd>Tab</Kbd> completes
                </span>
              ) : exists === false ? (
                <span className="text-warn">This folder doesn't exist yet</span>
              ) : (
                <span className="hidden sm:inline">
                  <Kbd>Tab</Kbd> completes · <Kbd>↑</Kbd>
                  <Kbd>↓</Kbd> choose · <Kbd>Enter</Kbd> opens a folder or adds
                </span>
              )}
            </div>
          </div>

          {/* Quick picks */}
          {quick.length > 0 || repos.length > 0 ? (
            <div className="-mx-4 flex flex-col gap-1.5 px-4">
              {quick.length > 0 ? (
                <ChipRow label="Quick">
                  {quick.map((s) => (
                    <Chip key={s.path} entry={s} label={home ? toTilde(s.path, home) : s.name} onClick={() => setPath(s.path)} />
                  ))}
                </ChipRow>
              ) : null}
              {repos.length > 0 ? (
                <ChipRow label="Repos">
                  {repos.map((s) => (
                    <Chip key={s.path} entry={s} label={s.name} title={home ? toTilde(s.path, home) : s.path} onClick={() => setPath(s.path)} />
                  ))}
                </ChipRow>
              ) : null}
            </div>
          ) : null}

          {/* Browser pane */}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border">
            <div className="flex items-center gap-1 border-b border-border bg-panel-2/50 px-1.5 py-1">
              <IconButton
                icon="back"
                label="Up"
                className="h-11 w-11 rotate-90 sm:h-7 sm:w-7"
                disabled={!online || !listing?.parent}
                onClick={() => listing?.parent && setPath(listing.parent)}
              />
              <IconButton icon="home" label="Home" className="h-11 w-11 sm:h-7 sm:w-7" disabled={!online || !home} onClick={() => home && setPath(home)} />
              <nav aria-label="Path" className="flex min-w-0 flex-1 items-center overflow-x-auto font-mono text-xs whitespace-nowrap">
                {crumbs.map((c, i) => (
                  <span key={c.path} className="flex items-center">
                    {i > 0 && crumbs[i - 1]!.label !== '/' ? <span className="px-0.5 text-muted">/</span> : null}
                    <button
                      type="button"
                      onClick={() => setPath(c.path)}
                      className={cx('rounded px-1 py-1 hover:bg-panel-2', i === crumbs.length - 1 ? 'font-semibold text-fg' : 'text-muted')}
                    >
                      {c.label}
                    </button>
                  </span>
                ))}
              </nav>
              {listingLoading ? <Spinner size={14} className="mx-1 shrink-0 text-muted" /> : null}
              <label className="ml-1 inline-flex shrink-0 cursor-pointer items-center gap-1.5 px-1 text-xs text-muted select-none">
                <input type="checkbox" className="h-4 w-4 accent-[var(--primary)]" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
                Hidden
              </label>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto" role="list" aria-label="Folders">
              {listingError ? (
                <ErrorText error={listingError} className="m-2" />
              ) : !listing ? (
                <div className="flex justify-center py-8 text-muted">{online ? <Spinner /> : null}</div>
              ) : baseMissing ? (
                <div className="px-3 py-6 text-center text-sm text-muted">{splitInput(input).base} doesn't exist yet.</div>
              ) : listing.entries.length === 0 ? (
                <div className="px-3 py-6 text-center text-sm text-muted">No folders in here{showHidden ? '' : ' (hidden folders are not shown)'}.</div>
              ) : (
                <>
                  {listing.entries.map((e) => (
                    <button
                      key={e.path}
                      type="button"
                      role="listitem"
                      onClick={() => setPath(e.path)}
                      className={cx(
                        'flex h-11 w-full items-center gap-2 border-b border-border/60 px-3 text-left text-sm last:border-b-0 hover:bg-panel-2 sm:h-9',
                        match?.path === e.path ? 'bg-accent-soft' : '',
                      )}
                    >
                      <EntryIcon entry={e} />
                      <span className={cx('min-w-0 flex-1 truncate', e.hidden ? 'text-muted' : '')}>{e.name}</span>
                      <EntryBadges entry={e} />
                      <Icon name="chevronRight" size={14} className="shrink-0 text-muted" />
                    </button>
                  ))}
                  {listing.truncated ? <div className="px-3 py-2 text-xs text-muted">Showing the first {listing.entries.length} folders. Type to narrow down.</div> : null}
                </>
              )}
            </div>
          </div>

          {/* Name and create */}
          <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
            <Field label="Workspace name">
              <Input
                value={shownName}
                onChange={(e) => {
                  setNameTouched(true);
                  setName(e.target.value);
                }}
                placeholder="the folder's name"
                className="h-11 sm:h-9"
                disabled={!online || existing !== undefined}
              />
            </Field>
            {exists === false ? (
              <div className="pb-2">
                <Checkbox checked={create} onChange={setCreate} label="Create this folder" />
              </div>
            ) : null}
          </div>
          <ErrorText error={submit.error} />
        </div>

        <div className="mt-3 flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <span className="mr-auto min-w-0 truncate font-mono text-xs text-muted" title={abs ?? undefined}>
            {abs ?? ''}
          </span>
          <Button variant="ghost" onClick={onClose} className="h-11 sm:h-9">
            Cancel
          </Button>
          <Button variant="primary" icon={existing ? 'external' : 'plus'} busy={submit.busy} disabled={!canSubmit} onClick={() => void submit.run()} className="h-11 sm:h-9">
            {existing ? 'Open workspace' : exists === false && create ? 'Create and add' : 'Add workspace'}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function EntryIcon(props: { entry: BrowseEntry }): ReactNode {
  const e = props.entry;
  return <Icon name={e.git ? 'git' : e.kind === 'symlink' ? 'link' : 'folder'} size={16} className={cx('shrink-0', e.git ? 'text-accent' : 'text-muted')} />;
}

function EntryBadges(props: { entry: BrowseEntry }): ReactNode {
  const e = props.entry;
  return (
    <span className="flex shrink-0 items-center gap-1">
      {e.kind === 'symlink' ? <Badge title="Symbolic link to a folder">link</Badge> : null}
      {e.git ? <Badge title="Has a .git (repository or worktree)">git</Badge> : null}
      {e.workspaceId ? (
        <Badge tone="accent" title="Already a bizzi workspace">
          <Icon name="check" size={11} />
          workspace
        </Badge>
      ) : null}
    </span>
  );
}

function ChipRow(props: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="flex items-center gap-2">
      <span className="w-12 shrink-0 text-[11px] font-medium text-muted uppercase">{props.label}</span>
      <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto pb-0.5">{props.children}</div>
    </div>
  );
}

function Chip(props: { entry: BrowseEntry; label: string; title?: string; onClick: () => void }): ReactNode {
  return (
    <button
      type="button"
      title={props.title ?? props.entry.path}
      onClick={props.onClick}
      className="inline-flex h-9 shrink-0 items-center gap-1 rounded-full border border-border bg-panel px-2.5 font-mono text-xs hover:bg-panel-2 sm:h-7"
    >
      <EntryIcon entry={props.entry} />
      {props.label}
      {props.entry.workspaceId ? <Icon name="check" size={11} className="text-accent" /> : null}
    </button>
  );
}
