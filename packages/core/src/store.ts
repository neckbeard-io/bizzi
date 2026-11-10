// SQLite persistence for the node role: machine identity, workspaces, sessions and the event log.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { ChannelEvent, SessionInfo, WorkspaceInfo } from '@bizzi/protocol';
import type { Spent } from './budget.ts';

/** Core-private per-session state persisted next to the public SessionInfo. */
export interface SessionState {
  /** The turn in flight, if any (between turn.started and turn.completed). */
  currentTurnId?: string;
  /** Terminal mode: argv to run instead of the agent's TUI (session.create `command`). */
  command?: string[];
  /** Forked session not started yet: the source's agentSessionRef to fork from on first start. */
  forkOf?: string;
  /** Approvals / questions awaiting an answer; cancelled after a node restart. */
  pendingApprovals?: string[];
  pendingQuestions?: string[];
  /** Terminal size. */
  cols?: number;
  rows?: number;
  /** What this session's own turns have used (budgets, usage.md §2). */
  spent?: Spent;
  /** Set while the session is held at a turn boundary because a budget was reached (the reason text). */
  budgetBlocked?: string;
  /** A helper waiting for a concurrency slot (spec §12.2); not started yet. */
  queued?: boolean;
  /**
   * Real path of the executable the running agent process was launched from (updates.md §2), when
   * it existed at spawn. Gone from disk later = the process is stale.
   */
  agentPath?: string;
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

export class Store {
  readonly path: string;
  readonly #db: DatabaseSync;
  readonly #insertEvent: StatementSync;
  readonly #replay: StatementSync;
  readonly #maxSeq: StatementSync;
  readonly #upsertSession: StatementSync;
  readonly #termTail: StatementSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.path = join(dataDir, 'node.db');
    this.#db = new DatabaseSync(this.path);
    this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
    this.#db.exec(SCHEMA);
    this.#insertEvent = this.#db.prepare('INSERT INTO events (ch, seq, ts, type, data) VALUES (?, ?, ?, ?, ?)');
    this.#replay = this.#db.prepare(
      'SELECT ch, seq, ts, type, data FROM events WHERE ch = ? AND seq > ? ORDER BY seq LIMIT ?',
    );
    this.#maxSeq = this.#db.prepare('SELECT MAX(seq) AS seq FROM events WHERE ch = ?');
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
  }

  maxSeq(ch: string): number {
    const row = this.#maxSeq.get(ch) as { seq: number | null } | undefined;
    return row?.seq ?? 0;
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
      this.#db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }
}
