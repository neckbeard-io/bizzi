// SQLite persistence for the node role: machine identity, workspaces, sessions and the event log.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { BizziError } from '@bizzi/protocol';
import type { AgentKind, ChannelEvent, SessionInfo, WorkspaceInfo } from '@bizzi/protocol';
import type { Spent } from './budget.ts';

/** Core-private per-session state persisted next to the public SessionInfo. */
export interface SessionState {
  /** The turn in flight, if any (between turn.started and turn.completed). */
  currentTurnId?: string;
  /** Terminal mode: argv to run instead of the agent's TUI (session.create `command`). */
  command?: string[];
  /** Forked session not started yet: the source's agentSessionRef to fork from on first start. */
  forkOf?: string;
  /** Approvals / questions awaiting an answer; canceled after a node restart. */
  pendingApprovals?: string[];
  pendingQuestions?: string[];
  /** Terminal size. */
  cols?: number;
  rows?: number;
  /** What this session's own turns have used (budgets, usage.md §2). */
  spent?: Spent;
  /** Set while the session is held at a turn boundary because a budget was reached (the reason text). */
  budgetBlocked?: string;
  /** The user renamed the session (`session.set` title): agent-reported titles no longer replace it. */
  titleByUser?: boolean;
  /** The title was made by bizzi from the first message (titles.ts), not given by the user or the agent. */
  titleAuto?: boolean;
  /** The user's first message, clipped (titles.ts `INTENT_MAX`): what re-titling starts from. */
  intent?: string;
  /** The user's messages since the automatic title was made; re-titles at `RETITLE_AT`. */
  userTurns?: number;
  /** `/clear` started a fresh conversation: the next user message titles the session again. */
  retitleNext?: boolean;
  /** A helper waiting for a concurrency slot (spec §12.2); not started yet. */
  queued?: boolean;
  /**
   * Someone closed the session (`session.stop`, a parent stopping its helper, removing the
   * workspace). The only way a session ends: an agent process that exits, crashes or is stopped by
   * bizzi leaves the session open, and the next message resumes it (spec §4.1).
   */
  closed?: boolean;
  /** The agent can't resume this conversation after a node restart: the next start is a fresh one. */
  startFresh?: boolean;
  /**
   * Real path of the executable the running agent process was launched from (updates.md §2), when
   * it existed at spawn. Gone from disk later = the process is stale.
   */
  agentPath?: string;
  /**
   * The agent process was running when the node went down (bizzi restarted or updated, updates.md
   * §7). The next start resumes through the restart sequence (verify, divider) and clears it.
   * `fromVersion`: the version that process ran.
   */
  nodeRestarted?: { fromVersion?: string };
  /**
   * bizzi stopped this structured session mid-turn (it shut down, or was killed and found the turn
   * still open at load). Once the node is back, `Sessions.resumeInterrupted` sends a continuation so
   * the agent carries on instead of waiting for a message. `at`: when it was cut off.
   */
  interruptedTurn?: { at: string; planned?: true };
  /** Automatic resumes after a crash since someone last sent a message; capped so a crash loop can't spin. */
  autoResumes?: number;
  /** Automatic resumes after a clean stop (`interruptedTurn.planned`) since the last message; capped higher. */
  plannedResumes?: number;
  /** Cross-machine helper (spec §12.4): the parent's agent and mode, for the permission cap on `session.set`. */
  remoteParent?: { machineId: string; agent: AgentKind; permissionMode?: string };
  /** Last known spend of this session's helpers on other machines, by helper id (counted in its tree). */
  remoteSpent?: Record<string, Spent>;
}

export interface SessionRow {
  info: SessionInfo;
  state: SessionState;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workspaces (
  id   TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  info         TEXT NOT NULL,
  state        TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  ch   TEXT NOT NULL,
  seq  INTEGER NOT NULL,
  ts   TEXT NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (ch, seq)
) WITHOUT ROWID;
`;

/**
 * Full-text history (bizzi-memory `history_search`): user prompts and top-level assistant replies, one row
 * each in `history`, indexed by the external-content FTS5 table `history_fts` that triggers keep in step.
 * Rows are added as events are appended; existing events are indexed once at open (meta `history.indexed`).
 */
const HISTORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS history (
  id   INTEGER PRIMARY KEY,
  ch   TEXT NOT NULL,
  seq  INTEGER NOT NULL,
  ts   TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS history_ch_seq ON history (ch, seq);
`;
const HISTORY_FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(text, content='history', content_rowid='id', tokenize='porter unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS history_ai AFTER INSERT ON history BEGIN
  INSERT INTO history_fts (rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS history_ad AFTER DELETE ON history BEGIN
  INSERT INTO history_fts (history_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
`;
/** Bump to rebuild the history index from the event log at the next open. */
const HISTORY_VERSION = '1';
const HISTORY_META = 'history.indexed';
/** Longest text kept per history row. */
export const HISTORY_MAX_TEXT = 20_000;

export interface HistoryDoc {
  role: 'user' | 'assistant';
  text: string;
}

/** The searchable text of an event, if it has any: what the user asked, or what the agent answered. */
export function historyDoc(type: string, data: unknown): HistoryDoc | undefined {
  const d = data as Record<string, unknown> | null;
  if (!d || typeof d !== 'object') return undefined;
  let doc: HistoryDoc | undefined;
  if (type === 'turn.started' || type === 'turn.steered') {
    if (d.auto || d.agent || !Array.isArray(d.input)) return undefined;
    const text = (d.input as { type?: string; text?: unknown; path?: unknown }[])
      .map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : b.type === 'file' && typeof b.path === 'string' ? `[file ${b.path}]` : ''))
      .filter(Boolean)
      .join('\n')
      .trim();
    // bizzi's own prompts (the continuation after a restart) aren't the user's words.
    if (text && !text.startsWith('[bizzi]')) doc = { role: 'user', text };
  } else if (type === 'message.completed') {
    if (d.role === 'assistant' && !d.parentToolId && typeof d.text === 'string' && d.text.trim()) doc = { role: 'assistant', text: d.text.trim() };
  }
  if (doc && doc.text.length > HISTORY_MAX_TEXT) doc.text = doc.text.slice(0, HISTORY_MAX_TEXT);
  return doc;
}

const HISTORY_TYPES = new Set(['turn.started', 'turn.steered', 'message.completed']);

export interface HistoryRow {
  ch: string;
  seq: number;
  ts: string;
  role: 'user' | 'assistant';
  snippet: string;
}

export interface HistoryQuery {
  /** Words (ANDed), "quoted phrases", `word*` prefixes and OR. */
  query: string;
  /** Limit to these channels. */
  channels?: string[];
  role?: 'user' | 'assistant';
  limit: number;
  offset: number;
}

export class Store {
  readonly path: string;
  /** SQLite here has FTS5; without it history search falls back to substring matching. */
  readonly ftsAvailable: boolean;
  /** Rows indexed by the one-time backfill at this open (0 when it had already run). */
  readonly historyBackfilled: number;
  readonly #insertHistory: StatementSync;
  readonly #db: DatabaseSync;
  readonly #insertEvent: StatementSync;
  readonly #replay: StatementSync;
  readonly #maxSeq: StatementSync;
  readonly #lastOfType: StatementSync;
  readonly #upsertSession: StatementSync;
  readonly #termTail: StatementSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.path = join(dataDir, 'node.db');
    this.#db = new DatabaseSync(this.path);
    this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
    this.#db.exec(SCHEMA);
    this.#db.exec(HISTORY_SCHEMA);
    let fts = true;
    try {
      this.#db.exec(HISTORY_FTS_SCHEMA);
    } catch {
      fts = false;
    }
    this.ftsAvailable = fts;
    this.#insertHistory = this.#db.prepare('INSERT OR IGNORE INTO history (ch, seq, ts, role, text) VALUES (?, ?, ?, ?, ?)');
    this.historyBackfilled = this.#backfillHistory();
    this.#insertEvent = this.#db.prepare('INSERT INTO events (ch, seq, ts, type, data) VALUES (?, ?, ?, ?, ?)');
    this.#replay = this.#db.prepare(
      'SELECT ch, seq, ts, type, data FROM events WHERE ch = ? AND seq > ? ORDER BY seq LIMIT ?',
    );
    this.#maxSeq = this.#db.prepare('SELECT MAX(seq) AS seq FROM events WHERE ch = ?');
    this.#lastOfType = this.#db.prepare('SELECT data FROM events WHERE ch = ? AND type = ? ORDER BY seq DESC LIMIT 1');
    this.#upsertSession = this.#db.prepare(
      `INSERT INTO sessions (id, workspace_id, info, state) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET workspace_id = excluded.workspace_id, info = excluded.info, state = excluded.state`,
    );
    this.#termTail = this.#db.prepare(
      "SELECT data FROM events WHERE ch = ? AND type = 'term.output' AND seq <= ? ORDER BY seq DESC",
    );
  }

  close(): void {
    if (this.#db.isOpen) this.#db.close();
  }

  get isOpen(): boolean {
    return this.#db.isOpen;
  }

  // --- meta -------------------------------------------------------------------------------------

  getMeta(key: string): string | undefined {
    const row = this.#db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.#db
      .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  deleteMeta(key: string): void {
    this.#db.prepare('DELETE FROM meta WHERE key = ?').run(key);
  }

  // --- events -----------------------------------------------------------------------------------

  insertEvent(ev: ChannelEvent): void {
    this.#insertEvent.run(ev.ch, ev.seq, ev.ts, ev.type, JSON.stringify(ev.data));
    if (!HISTORY_TYPES.has(ev.type)) return;
    const doc = historyDoc(ev.type, ev.data);
    if (doc) this.#insertHistory.run(ev.ch, ev.seq, ev.ts, doc.role, doc.text);
  }

  // --- history search ---------------------------------------------------------------------------

  /** Index the event log once (and again after a HISTORY_VERSION bump). One scan of `events`. */
  #backfillHistory(): number {
    if (this.getMeta(HISTORY_META) === HISTORY_VERSION) return 0;
    let n = 0;
    this.#db.exec('BEGIN');
    try {
      this.#db.exec('DELETE FROM history');
      const rows = this.#db
        .prepare(`SELECT ch, seq, ts, type, data FROM events WHERE type IN (${[...HISTORY_TYPES].map(() => '?').join(', ')})`)
        .iterate(...HISTORY_TYPES) as Iterable<{ ch: string; seq: number; ts: string; type: string; data: string }>;
      for (const r of rows) {
        let data: unknown;
        try {
          data = JSON.parse(r.data);
        } catch {
          continue;
        }
        const doc = historyDoc(r.type, data);
        if (!doc) continue;
        this.#insertHistory.run(r.ch, r.seq, r.ts, doc.role, doc.text);
        n++;
      }
      this.setMeta(HISTORY_META, HISTORY_VERSION);
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
    return n;
  }

  /**
   * Best matches first (bm25) with FTS5; without it, every term as a substring, newest first. Snippets
   * mark matches with [ ].
   */
  searchHistory(q: HistoryQuery): HistoryRow[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.channels) {
      if (q.channels.length === 0) return [];
      where.push('h.ch IN (SELECT value FROM json_each(?))');
      args.push(JSON.stringify(q.channels));
    }
    if (q.role) {
      where.push('h.role = ?');
      args.push(q.role);
    }
    if (this.ftsAvailable) {
      const match = ftsQuery(q.query);
      const sql =
        `SELECT h.ch, h.seq, h.ts, h.role, snippet(history_fts, 0, '[', ']', '…', 24) AS snippet
         FROM history_fts JOIN history h ON h.id = history_fts.rowid
         WHERE history_fts MATCH ?${where.length ? ` AND ${where.join(' AND ')}` : ''}
         ORDER BY bm25(history_fts), h.ts DESC LIMIT ? OFFSET ?`;
      return this.#db.prepare(sql).all(match, ...args, q.limit, q.offset) as unknown as HistoryRow[];
    }
    const terms = queryTerms(q.query).map((t) => t.text);
    for (const t of terms) {
      where.push("h.text LIKE ? ESCAPE '\\'");
      args.push(`%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    const sql = `SELECT h.ch, h.seq, h.ts, h.role, h.text FROM history h WHERE ${where.join(' AND ')} ORDER BY h.ts DESC LIMIT ? OFFSET ?`;
    const rows = this.#db.prepare(sql).all(...args, q.limit, q.offset) as unknown as (HistoryRow & { text: string })[];
    return rows.map(({ text, ...r }) => ({ ...r, snippet: likeSnippet(text, terms) }));
  }

  maxSeq(ch: string): number {
    const row = this.#maxSeq.get(ch) as { seq: number | null } | undefined;
    return row?.seq ?? 0;
  }

  /** The data of the newest event of `type` on a channel. */
  lastData(ch: string, type: string): unknown {
    const row = this.#lastOfType.get(ch, type) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }

  /**
   * Events of the given types on a channel, newest first, lazily: stop iterating to stop reading. Walks the
   * (ch, seq) key backwards, so finding the last few of a type costs a scan back to them, not the whole log.
   */
  *latestOfTypes(ch: string, types: readonly string[]): Generator<ChannelEvent> {
    const stmt = this.#db.prepare(
      `SELECT ch, seq, ts, type, data FROM events WHERE ch = ? AND type IN (${types.map(() => '?').join(', ')}) ORDER BY seq DESC`,
    );
    for (const r of stmt.iterate(ch, ...types) as Iterable<{ ch: string; seq: number; ts: string; type: string; data: string }>) {
      yield { ch: r.ch, seq: r.seq, ts: r.ts, type: r.type, data: JSON.parse(r.data) } as ChannelEvent;
    }
  }

  /** Events with seq > since, oldest first, at most `limit`. */
  replay(ch: string, since: number, limit: number): ChannelEvent[] {
    const rows = this.#replay.all(ch, since, limit) as unknown as {
      ch: string;
      seq: number;
      ts: string;
      type: string;
      data: string;
    }[];
    return rows.map((r) => ({ ch: r.ch, seq: r.seq, ts: r.ts, type: r.type, data: JSON.parse(r.data) }) as ChannelEvent);
  }

  /**
   * The last `maxBytes` bytes of `term.output` on a channel up to `uptoSeq` (inclusive), oldest first.
   * Reads newest-first and stops once enough output is collected.
   */
  terminalTail(ch: string, uptoSeq: number, maxBytes: number): Buffer {
    const chunks: Buffer[] = [];
    let total = 0;
    for (const row of this.#termTail.iterate(ch, uptoSeq) as Iterable<{ data: string }>) {
      let b64: unknown;
      try {
        b64 = (JSON.parse(row.data) as { dataBase64?: unknown }).dataBase64;
      } catch {
        continue;
      }
      if (typeof b64 !== 'string') continue;
      const buf = Buffer.from(b64, 'base64');
      chunks.push(buf);
      total += buf.length;
      if (total >= maxBytes) break;
    }
    const all = Buffer.concat(chunks.reverse());
    return all.length > maxBytes ? all.subarray(all.length - maxBytes) : all;
  }

  // --- workspaces -------------------------------------------------------------------------------

  listWorkspaces(): WorkspaceInfo[] {
    const rows = this.#db.prepare('SELECT data FROM workspaces ORDER BY id').all() as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as WorkspaceInfo);
  }

  putWorkspace(ws: WorkspaceInfo): void {
    this.#db
      .prepare(
        `INSERT INTO workspaces (id, path, data) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET path = excluded.path, data = excluded.data`,
      )
      .run(ws.id, ws.path, JSON.stringify(ws));
  }

  deleteWorkspace(id: string): void {
    this.#db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
  }

  // --- sessions ---------------------------------------------------------------------------------

  listSessions(): SessionRow[] {
    const rows = this.#db.prepare('SELECT info, state FROM sessions ORDER BY id').all() as {
      info: string;
      state: string;
    }[];
    return rows.map((r) => ({ info: JSON.parse(r.info) as SessionInfo, state: JSON.parse(r.state) as SessionState }));
  }

  putSession(row: SessionRow): void {
    this.#upsertSession.run(row.info.id, row.info.workspaceId, JSON.stringify(row.info), JSON.stringify(row.state));
  }

  /** Remove a session row and every event on its channel, atomically. */
  deleteSession(id: string, ch: string): void {
    this.#db.exec('BEGIN');
    try {
      this.#db.prepare('DELETE FROM events WHERE ch = ?').run(ch);
      this.#db.prepare('DELETE FROM history WHERE ch = ?').run(ch);
      this.#db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }
}

// --- history query parsing ----------------------------------------------------------------------

interface QueryTerm {
  text: string;
  phrase: boolean;
  prefix: boolean;
  or: boolean;
}

/** Words, "quoted phrases", `word*` prefixes and OR between terms; everything else is literal text. */
function queryTerms(query: string): QueryTerm[] {
  const out: QueryTerm[] = [];
  let or = false;
  for (const m of query.matchAll(/"([^"]*)"|(\S+)/g)) {
    if (m[1] !== undefined) {
      const text = m[1].trim();
      if (text) out.push({ text, phrase: true, prefix: false, or });
      or = false;
      continue;
    }
    const raw = m[2]!;
    if (raw === 'OR' && out.length > 0) {
      or = true;
      continue;
    }
    const prefix = raw.length > 1 && raw.endsWith('*');
    const text = (prefix ? raw.slice(0, -1) : raw).replace(/"/g, '');
    if (text) out.push({ text, phrase: false, prefix, or });
    or = false;
  }
  return out;
}

/** An FTS5 MATCH expression with every term quoted, so user text can't be a syntax error. */
export function ftsQuery(query: string): string {
  const terms = queryTerms(query);
  if (terms.length === 0) throw new BizziError('bad_request', 'query is empty');
  return terms
    .map((t, i) => `${i > 0 ? (t.or ? 'OR ' : 'AND ') : ''}"${t.text.replace(/"/g, '""')}"${t.prefix ? '*' : ''}`)
    .join(' ');
}

function likeSnippet(text: string, terms: string[]): string {
  const flat = text.replace(/\s+/g, ' ');
  const lower = flat.toLowerCase();
  const at = Math.max(0, lower.indexOf(terms[0]?.toLowerCase() ?? ''));
  const start = Math.max(0, at - 80);
  const end = Math.min(flat.length, at + 160);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}
