// Pure logic behind the workspace picker (WorkspacePicker.tsx): path splitting, tilde handling,
// breadcrumbs, common-prefix completion and the keyboard behavior of the completion dropdown.
import type { BrowseEntry } from '@bizzi/protocol';

/** The typed directory part (`~/`, `/a/b/`) and the partial name after it, as fs.complete splits it. */
export function splitInput(input: string): { base: string; partial: string } {
  if (input === '' || input === '~') return { base: '~/', partial: '' };
  const cut = Math.max(input.lastIndexOf('/'), input.lastIndexOf('\\'));
  if (cut < 0) return { base: '', partial: input };
  return { base: input.slice(0, cut + 1), partial: input.slice(cut + 1) };
}

/** Whether fs.complete / fs.browse accept the input (absolute, `~`, or a Windows drive). */
export function isAbsoluteLike(input: string): boolean {
  return input === '' || input.startsWith('/') || input === '~' || input.startsWith('~/') || /^[A-Za-z]:([\\/]|$)/.test(input) || input.startsWith('\\\\');
}

/** `~` and `~/x` → absolute using the machine's home; strips a trailing separator (except on a root). */
export function expandTilde(input: string, home: string): string {
  let p = input.trim();
  if (p === '~') p = home;
  else if (p.startsWith('~/')) p = joinPath(home, p.slice(2));
  return stripTrailingSep(p);
}

export function stripTrailingSep(p: string): string {
  if (p === '/' || /^[A-Za-z]:[\\/]$/.test(p)) return p;
  return p.replace(/[\\/]+$/, '') || p;
}

/** Absolute → `~/…` when under home (what the input shows). */
export function toTilde(abs: string, home: string): string {
  if (!home || home === '/') return abs;
  if (abs === home) return '~';
  const h = home.endsWith('/') ? home : `${home}/`;
  return abs.startsWith(h) ? `~/${abs.slice(h.length)}` : abs;
}

/** Input text for a directory picked in the browser: tilde form with a trailing `/` (`~/src/`, `~/`, `/`). */
export function dirInput(abs: string, home: string | null): string {
  const shown = home ? toTilde(abs, home) : abs;
  return shown.endsWith('/') || shown.endsWith('\\') ? shown : `${shown}/`;
}

export function joinPath(dir: string, name: string): string {
  if (!name) return dir;
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.endsWith('/') || dir.endsWith('\\') ? `${dir}${name}` : `${dir}${sep}${name}`;
}

export function basename(p: string): string {
  const s = stripTrailingSep(p);
  const cut = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return cut < 0 ? s : s.slice(cut + 1) || s;
}

/** Text for the input after picking `entry` from a completion list for `base`: descends into it. */
export function completionText(base: string, entry: Pick<BrowseEntry, 'name'>): string {
  return `${base}${entry.name}/`;
}

/** Longest common prefix (case folded when `caseInsensitive`, keeping the first name's spelling). */
export function commonPrefix(names: readonly string[], caseInsensitive = false): string {
  if (names.length === 0) return '';
  const fold = (s: string): string => (caseInsensitive ? s.toLowerCase() : s);
  const first = names[0]!;
  let n = first.length;
  for (const name of names.slice(1)) {
    let i = 0;
    while (i < n && i < name.length && fold(first[i]!) === fold(name[i]!)) i++;
    n = i;
    if (n === 0) break;
  }
  return first.slice(0, n);
}

/**
 * What Tab does with the current completions: a single match (or the highlighted one) completes fully
 * and descends (`base + name + '/'`); several matches extend the input to their common prefix. Returns
 * null when Tab has nothing to add (focus moves on as usual).
 */
export function tabCompletion(input: string, completions: readonly Pick<BrowseEntry, 'name'>[], selected: number, caseInsensitive = false): string | null {
  if (completions.length === 0) return null;
  const { base, partial } = splitInput(input);
  if (selected >= 0 && selected < completions.length) return completionText(base, completions[selected]!);
  if (completions.length === 1) return completionText(base, completions[0]!);
  const common = commonPrefix(
    completions.map((c) => c.name),
    caseInsensitive,
  );
  if (common.length > partial.length) return `${base}${common}`;
  return null;
}

/** Breadcrumb segments for an absolute path; the home prefix collapses into one `~` segment. */
export function breadcrumbs(abs: string, home: string): { label: string; path: string }[] {
  const out: { label: string; path: string }[] = [];
  let rest: string;
  let acc: string;
  if (home && home !== '/' && (abs === home || abs.startsWith(`${home}/`))) {
    out.push({ label: '~', path: home });
    acc = home;
    rest = abs.slice(home.length);
  } else if (/^[A-Za-z]:[\\/]/.test(abs)) {
    acc = abs.slice(0, 3);
    out.push({ label: abs.slice(0, 2), path: acc });
    rest = abs.slice(3);
  } else {
    acc = '/';
    out.push({ label: '/', path: '/' });
    rest = abs;
  }
  for (const part of rest.split(/[\\/]/).filter(Boolean)) {
    acc = joinPath(acc, part);
    out.push({ label: part, path: acc });
  }
  return out;
}

// ---- dropdown keyboard behavior

export interface DropdownState {
  input: string;
  completions: readonly BrowseEntry[];
  /** Highlighted completion, -1 for none. */
  selected: number;
  open: boolean;
}

export type KeyOutcome =
  /** Not handled: let the browser do its default (move focus, submit the form …). */
  | { kind: 'default' }
  | { kind: 'state'; state: DropdownState }
  /** The input changed; the caller fetches new completions. */
  | { kind: 'input'; input: string }
  /** Accept the typed path (add the workspace). */
  | { kind: 'submit' }
  /** Esc with the dropdown closed: close the dialog. */
  | { kind: 'close' };

/**
 * ↑/↓ move the highlight (opening the list), Tab completes (see tabCompletion), Enter on a highlighted
 * entry descends into it and otherwise submits, Esc closes the list first and the dialog second.
 */
export function dropdownKey(s: DropdownState, key: string, caseInsensitive = false): KeyOutcome {
  const n = s.completions.length;
  switch (key) {
    case 'ArrowDown':
    case 'ArrowUp': {
      if (n === 0) return { kind: 'default' };
      if (!s.open) return { kind: 'state', state: { ...s, open: true, selected: key === 'ArrowDown' ? 0 : n - 1 } };
      const d = key === 'ArrowDown' ? 1 : -1;
      const selected = s.selected < 0 ? (d > 0 ? 0 : n - 1) : (s.selected + d + n) % n;
      return { kind: 'state', state: { ...s, selected } };
    }
    case 'Tab': {
      const next = tabCompletion(s.input, s.completions, s.open ? s.selected : -1, caseInsensitive);
      if (next === null) return n > 0 && !s.open ? { kind: 'state', state: { ...s, open: true } } : { kind: 'default' };
      return { kind: 'input', input: next };
    }
    case 'Enter': {
      if (s.open && s.selected >= 0 && s.selected < n) return { kind: 'input', input: completionText(splitInput(s.input).base, s.completions[s.selected]!) };
      return { kind: 'submit' };
    }
    case 'Escape':
      return s.open && n > 0 ? { kind: 'state', state: { ...s, open: false, selected: -1 } } : { kind: 'close' };
    default:
      return { kind: 'default' };
  }
}

/**
 * `#/workspaces?add=1[&machine=<id>][&path=<path>]` asks for the workspace picker (any entry point can
 * link to it). Returns null when the hash doesn't ask for it.
 */
export function pickerRequestFromHash(hash: string): { machineId?: string; path?: string } | null {
  const h = hash.replace(/^#\/?/, '');
  const i = h.indexOf('?');
  if (i < 0) return null;
  const q = new URLSearchParams(h.slice(i + 1));
  if (q.get('add') !== '1') return null;
  const out: { machineId?: string; path?: string } = {};
  const machine = q.get('machine');
  const path = q.get('path');
  if (machine) out.machineId = machine;
  if (path) out.path = path;
  return out;
}

/** Whether the typed name is one of the completions (the path exists as a directory). */
export function exactMatch(partial: string, completions: readonly BrowseEntry[], caseInsensitive = false): BrowseEntry | undefined {
  return completions.find((c) => c.name === partial) ?? (caseInsensitive ? completions.find((c) => c.name.toLowerCase() === partial.toLowerCase()) : undefined);
}
