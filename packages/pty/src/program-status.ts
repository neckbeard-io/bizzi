// OSC 7501 "Program Status Protocol" (Rex; also read by herdr-core): a TUI reports its own state
// as `ESC ] 7501 ; key=value:key=value ST`. See docs/landscape.md §4.1 and the README.
//
// - `state` is required: idle | working | done | blocked | error, or `clear` to drop the record.
// - `id` (optional) names the record; `/` nests (`build/tests` is a child of `build`). No id = the
//   root record; clearing the root clears everything.
// - `app`, `kind` (blocked: permission | question | auth), `progress` (0-100 or n/m),
//   `title` and `msg` (base64 UTF-8).
// - A report replaces its record. Malformed pairs are skipped; an oversized report, a missing or
//   unknown state, or bad base64 / UTF-8 in title or msg discards the whole report.
// - working/blocked records drop on process exit and on a new prompt (OSC 133 ; A).
// - `7501;?` is a capability query. bizzi does not answer it (see README).

import type { SessionStatus } from '@bizzi/protocol';

export type ProgramState = 'idle' | 'working' | 'done' | 'blocked' | 'error';
export type BlockedKind = 'permission' | 'question' | 'auth';

const STATES: readonly string[] = ['idle', 'working', 'done', 'blocked', 'error'];
const KINDS: readonly string[] = ['permission', 'question', 'auth'];

export interface ProgramStatusRecord {
  /** '' = the root record (report without an id). */
  id: string;
  state: ProgramState;
  kind?: BlockedKind;
  app?: string;
  title?: string;
  msg?: string;
  /** Percent, 0-100. */
  progress?: number;
  /** ms epoch when this record was last reported. */
  at: number;
  /** Arrival order, for tie-breaks between records reported in the same millisecond. */
  order: number;
}

export type ProgramStatusReport =
  | { type: 'set'; record: Omit<ProgramStatusRecord, 'at' | 'order'> }
  | { type: 'clear'; id: string }
  | { type: 'query' };

export type ParseResult = { ok: true; report: ProgramStatusReport } | { ok: false; error: string };

const KEY_RE = /^[a-z][a-z0-9_-]*$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{2,3})?$/;
const MAX_ID = 256;
const MAX_APP = 128;
const utf8 = new TextDecoder('utf-8', { fatal: true });

function decodeBase64Utf8(value: string): string | undefined {
  if (!BASE64_RE.test(value)) return undefined;
  try {
    return utf8.decode(Buffer.from(value, 'base64'));
  } catch {
    return undefined;
  }
}

function parseProgress(value: string): number | undefined {
  const frac = /^(\d{1,9})\/(\d{1,9})$/.exec(value);
  if (frac) {
    const n = Number(frac[1]);
    const d = Number(frac[2]);
    if (d === 0 || n > d) return undefined;
    return Math.round((n / d) * 100);
  }
  if (!/^\d{1,3}(?:\.\d+)?%?$/.test(value)) return undefined;
  const p = Number.parseFloat(value);
  return p >= 0 && p <= 100 ? p : undefined;
}

/** Parse the body after `7501;`. `overflow` comes from the scanner (body exceeded the cap). */
export function parseProgramStatus(payload: string, overflow = false): ParseResult {
  if (overflow) return { ok: false, error: 'report too large' };
  if (payload.trim() === '?') return { ok: true, report: { type: 'query' } };
  const fields = new Map<string, string>();
  for (const pair of payload.split(':')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue; // malformed pair: skipped
    const key = pair.slice(0, eq).trim().toLowerCase();
    if (!KEY_RE.test(key)) continue;
    fields.set(key, pair.slice(eq + 1));
  }
  const state = fields.get('state')?.trim().toLowerCase();
  if (!state) return { ok: false, error: 'missing state' };

  let id = fields.get('id') ?? '';
  if (id.length > MAX_ID) return { ok: false, error: 'id too long' };
  // Normalize nesting: no empty segments, no leading/trailing slashes.
  id = id
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .join('/');

  if (state === 'clear') return { ok: true, report: { type: 'clear', id } };
  if (!STATES.includes(state)) return { ok: false, error: `unknown state ${JSON.stringify(state.slice(0, 32))}` };

  const record: Omit<ProgramStatusRecord, 'at' | 'order'> = { id, state: state as ProgramState };
  for (const k of ['title', 'msg'] as const) {
    const raw = fields.get(k);
    if (raw === undefined) continue;
    const text = decodeBase64Utf8(raw.trim());
    if (text === undefined) return { ok: false, error: `bad base64 in ${k}` };
    if (text !== '') record[k] = text;
  }
  const app = fields.get('app')?.trim();
  if (app) record.app = app.slice(0, MAX_APP);
  const kind = fields.get('kind')?.trim().toLowerCase();
  if (kind && KINDS.includes(kind) && record.state === 'blocked') record.kind = kind as BlockedKind;
  const progress = fields.get('progress');
  if (progress !== undefined && (record.state === 'working' || record.state === 'blocked')) {
    const p = parseProgress(progress.trim());
    if (p !== undefined) record.progress = p;
  }
  return { ok: true, report: { type: 'set', record } };
}

/** Session-level view of the records: what bizzi should show. */
export interface ProgramStatusSummary {
  status: SessionStatus;
  prompt?: 'approval' | 'input' | 'login' | 'question';
  reason: string;
  /** The record that decided it. */
  record: ProgramStatusRecord;
}

/** Most urgent first. */
const PRIORITY: Record<ProgramState, number> = { blocked: 4, working: 3, error: 2, done: 1, idle: 0 };

function isWithin(id: string, parent: string): boolean {
  return parent === '' || id === parent || id.startsWith(`${parent}/`);
}

/** Map one record to a session status (landscape.md §4.1, README "OSC 7501"). */
export function summarizeRecord(record: ProgramStatusRecord): ProgramStatusSummary {
  const text = record.msg ?? record.title;
  const why = (fallback: string) => text ?? fallback;
  switch (record.state) {
    case 'working':
      return { status: 'running', reason: why('working'), record };
    case 'blocked':
      switch (record.kind) {
        case 'permission':
          return { status: 'waiting_approval', prompt: 'approval', reason: why('blocked:permission'), record };
        case 'question':
          return { status: 'waiting_input', prompt: 'question', reason: why('blocked:question'), record };
        case 'auth':
          return { status: 'waiting_input', prompt: 'login', reason: why('blocked:auth'), record };
        default:
          return { status: 'waiting_input', prompt: 'input', reason: why('blocked'), record };
      }
    case 'idle':
      return { status: 'waiting_input', prompt: 'input', reason: why('idle'), record };
    case 'done':
      return { status: 'idle', reason: why('done'), record };
    case 'error':
      // Not 'failed': the core treats failed as terminal and stops the session, but the process is
      // still alive and usually waiting for the next prompt. The error goes into the reason.
      return { status: 'waiting_input', prompt: 'input', reason: text ? `error: ${text}` : 'error', record };
  }
}

/** The set of live OSC 7501 records for one terminal. */
export class ProgramStatusTracker {
  readonly #records = new Map<string, ProgramStatusRecord>();
  #order = 0;
  #lastReportAt = -Infinity;

  /** Apply a parsed report. Returns true when the record set changed. */
  apply(report: ProgramStatusReport, now: number = Date.now()): boolean {
    if (report.type === 'query') return false;
    this.#lastReportAt = now;
    if (report.type === 'clear') {
      let changed = false;
      for (const id of [...this.#records.keys()]) {
        if (isWithin(id, report.id)) changed = this.#records.delete(id) || changed;
      }
      return changed;
    }
    this.#records.set(report.record.id, { ...report.record, at: now, order: ++this.#order });
    return true;
  }

  /** Drop working/blocked records (new prompt, OSC 133 ; A). Returns true when any were dropped. */
  dropTransient(): boolean {
    let changed = false;
    for (const [id, r] of this.#records) {
      if (r.state === 'working' || r.state === 'blocked') changed = this.#records.delete(id) || changed;
    }
    return changed;
  }

  clearAll(): void {
    this.#records.clear();
  }

  get size(): number {
    return this.#records.size;
  }

  /** When the last report (set or clear) arrived; -Infinity if never. */
  get lastReportAt(): number {
    return this.#lastReportAt;
  }

  records(): ProgramStatusRecord[] {
    return [...this.#records.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  get(id: string): ProgramStatusRecord | undefined {
    return this.#records.get(id);
  }

  /** The most urgent record (blocked > working > error > done > idle; newest wins ties). */
  current(): ProgramStatusRecord | undefined {
    let best: ProgramStatusRecord | undefined;
    for (const r of this.#records.values()) {
      if (!best || PRIORITY[r.state] > PRIORITY[best.state] || (PRIORITY[r.state] === PRIORITY[best.state] && r.order > best.order)) {
        best = r;
      }
    }
    return best;
  }

  summary(): ProgramStatusSummary | undefined {
    const r = this.current();
    return r ? summarizeRecord(r) : undefined;
  }
}
