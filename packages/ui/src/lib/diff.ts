// Unified diff parser (git diff / diff -u). Pure; runs in Node tests, the main thread or a worker.

export type DiffLineType = 'context' | 'add' | 'del' | 'hunk' | 'noeol';

export interface DiffLine {
  type: DiffLineType;
  /** Line text without the leading +/-/space marker (hunk header text for 'hunk'). */
  text: string;
  oldNo?: number;
  newNo?: number;
}

export type DiffFileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied';

export interface DiffFile {
  oldPath: string | null;
  newPath: string | null;
  /** Display path (new path, else old path). */
  path: string;
  status: DiffFileStatus;
  binary: boolean;
  /** Extra header lines (mode changes, similarity index, …). */
  meta: string[];
  lines: DiffLine[];
  additions: number;
  deletions: number;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function stripPrefix(p: string): string | null {
  const path = p.replace(/\t.*$/, '').trim();
  if (path === '/dev/null') return null;
  const unq = path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path;
  return unq.replace(/^[ab]\//, '');
}

function newFile(oldPath: string | null, newPath: string | null): DiffFile {
  return {
    oldPath,
    newPath,
    path: newPath ?? oldPath ?? '',
    status: 'modified',
    binary: false,
    meta: [],
    lines: [],
    additions: 0,
    deletions: 0,
  };
}

function finalize(f: DiffFile): DiffFile {
  if (f.oldPath === null && f.newPath !== null) f.status = 'added';
  else if (f.newPath === null && f.oldPath !== null) f.status = 'deleted';
  f.path = f.newPath ?? f.oldPath ?? f.path;
  return f;
}

/**
 * Parse a unified diff into files and numbered lines. Accepts `git diff` output (with `diff --git`
 * headers), plain `diff -u` output, or a bare hunk (`@@ … @@`) for which `fallbackPath` names the file.
 */
export function parseUnifiedDiff(text: string, fallbackPath = ''): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let oldNo = 0;
  let newNo = 0;
  let oldLeft = 0;
  let newLeft = 0;
  let inHunk = false;
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const start = (oldPath: string | null, newPath: string | null): DiffFile => {
    if (cur) files.push(finalizeKeepingStatus(cur));
    cur = newFile(oldPath, newPath);
    inHunk = false;
    return cur;
  };

  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;

    if (line.startsWith('diff --git ')) {
      const m = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/.exec(line);
      start(m?.[1] ?? null, m?.[2] ?? null);
      continue;
    }

    if (inHunk && cur && (oldLeft > 0 || newLeft > 0 || line.startsWith('\\'))) {
      const f: DiffFile = cur;
      const c = line[0];
      if (c === '+') {
        f.lines.push({ type: 'add', text: line.slice(1), newNo: newNo++ });
        f.additions++;
        newLeft--;
        continue;
      }
      if (c === '-') {
        f.lines.push({ type: 'del', text: line.slice(1), oldNo: oldNo++ });
        f.deletions++;
        oldLeft--;
        continue;
      }
      if (c === ' ' || line === '') {
        f.lines.push({ type: 'context', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
        oldLeft--;
        newLeft--;
        continue;
      }
      if (c === '\\') {
        f.lines.push({ type: 'noeol', text: line.slice(2) });
        continue;
      }
      inHunk = false;
    }

    const hm = HUNK_RE.exec(line);
    if (hm) {
      if (!cur) cur = newFile(fallbackPath || null, fallbackPath || null);
      oldNo = Number(hm[1]);
      newNo = Number(hm[3]);
      oldLeft = hm[2] === undefined ? 1 : Number(hm[2]);
      newLeft = hm[4] === undefined ? 1 : Number(hm[4]);
      inHunk = true;
      cur.lines.push({ type: 'hunk', text: line });
      continue;
    }

    if (line.startsWith('--- ')) {
      const p = stripPrefix(line.slice(4));
      if (!cur || cur.lines.length > 0) start(p, null);
      else if (cur) cur.oldPath = p;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = stripPrefix(line.slice(4));
      if (!cur) start(null, p);
      else cur.newPath = p;
      continue;
    }
    if (!cur) continue;
    const f: DiffFile = cur;
    if (line.startsWith('new file mode')) {
      f.oldPath = null;
      f.status = 'added';
      f.meta.push(line);
    } else if (line.startsWith('deleted file mode')) {
      f.newPath = null;
      f.status = 'deleted';
      f.meta.push(line);
    } else if (line.startsWith('rename from ')) {
      f.oldPath = line.slice('rename from '.length);
      f.status = 'renamed';
    } else if (line.startsWith('rename to ')) {
      f.newPath = line.slice('rename to '.length);
      f.status = 'renamed';
    } else if (line.startsWith('copy from ') || line.startsWith('copy to ')) {
      f.status = 'copied';
      f.meta.push(line);
    } else if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      f.binary = true;
    } else if (line.startsWith('index ') || line.startsWith('similarity index') || line.startsWith('old mode') || line.startsWith('new mode')) {
      f.meta.push(line);
    }
  }
  if (cur) files.push(finalizeKeepingStatus(cur));
  return files;
}

function finalizeKeepingStatus(f: DiffFile): DiffFile {
  if (f.status === 'renamed' || f.status === 'copied') {
    f.path = f.newPath ?? f.oldPath ?? f.path;
    return f;
  }
  return finalize(f);
}

export function diffStats(files: DiffFile[]): { files: number; additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    additions += f.additions;
    deletions += f.deletions;
  }
  return { files: files.length, additions, deletions };
}
