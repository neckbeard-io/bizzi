// SQLite persistence for the hub role: devices, pairing codes, nonces, tokens, machines, the replica of
// every node's session channels, the routing index (workspaces/sessions → machine), the hub's own
// re-sequenced global log and the knowledge replica (knowledge.md §9.4).

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { PrefsTable, ThemeTable } from '@bizzi/core';
import type {
  AccountUsage,
  AgentCapabilities,
  ChannelEvent,
  DeviceInfo,
  DeviceKind,
  Ed25519PublicJwk,
  GlobalEvent,
  GlobalEventBody,
  KnowledgeRecord,
  MachineInfo,
  SessionInfo,
  WidgetValue,
  WorkspaceInfo,
} from '@bizzi/protocol';
import { GLOBAL_CHANNEL } from '@bizzi/protocol';
import { WebPushTable } from './webpush-service.ts';
import { RouteStore } from '@bizzi/routing';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL,
  machine_id   TEXT,
  owner        INTEGER NOT NULL DEFAULT 0,
  public_key   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT,
  revoked      INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS pairing_codes (
  hash       TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  name       TEXT,
  setup      INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL,
  expires_at INTEGER,
  used_at    TEXT,
  used_by    TEXT
);
CREATE TABLE IF NOT EXISTS nonces (
  nonce      TEXT PRIMARY KEY,
  device_id  TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
  hash       TEXT PRIMARY KEY,
  device_id  TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS machines (
  id           TEXT PRIMARY KEY,
  info         TEXT NOT NULL,
  device_id    TEXT,
  last_seen_at TEXT
);
CREATE TABLE IF NOT EXISTS workspaces (
  id         TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL,
  info       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  machine_id   TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  info         TEXT NOT NULL,
  capabilities TEXT
);
CREATE TABLE IF NOT EXISTS events (
  ch   TEXT NOT NULL,
  seq  INTEGER NOT NULL,
  ts   TEXT NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (ch, seq)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS global_events (
  seq        INTEGER PRIMARY KEY,
  ts         TEXT NOT NULL,
  type       TEXT NOT NULL,
  data       TEXT NOT NULL,
  machine_id TEXT
);
CREATE TABLE IF NOT EXISTS node_cursors (
  machine_id TEXT PRIMARY KEY,
  global_seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS account_usage (
  agent       TEXT NOT NULL,
  account_id  TEXT NOT NULL,
  machine_id  TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  data        TEXT NOT NULL,
  PRIMARY KEY (agent, account_id, machine_id)
);
CREATE TABLE IF NOT EXISTS widgets (
  machine_id TEXT NOT NULL,
  widget_id  TEXT NOT NULL,
  data       TEXT NOT NULL,
  PRIMARY KEY (machine_id, widget_id)
);
CREATE TABLE IF NOT EXISTS knowledge_items (
  id         TEXT PRIMARY KEY,
  hlc        TEXT NOT NULL,
  rseq       INTEGER NOT NULL UNIQUE,
  from_machine TEXT NOT NULL,
  data       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS knowledge_cursors (
  machine_id TEXT PRIMARY KEY,
  store_id   TEXT,
  pulled_hlc TEXT,
  pushed_rseq INTEGER NOT NULL DEFAULT 0
);
`;

export interface DeviceRow extends DeviceInfo {
  publicKey: Ed25519PublicJwk;
}

export interface PairingCodeRow {
  hash: string;
  kind: DeviceKind;
  name?: string;
  setup: boolean;
  expiresAt?: number;
  usedAt?: string;
}

export interface KnowledgeCursor {
  storeId?: string;
  pulledHlc?: string;
  pushedRseq: number;
}

export interface MachineRow {
  info: MachineInfo;
  deviceId?: string;
  lastSeenAt?: string;
}

type Row = Record<string, unknown>;

function deviceFromRow(r: Row): DeviceRow {
  const d: DeviceRow = {
    id: r.id as string,
    name: r.name as string,
    kind: r.kind as DeviceKind,
    createdAt: r.created_at as string,
    publicKey: JSON.parse(r.public_key as string) as Ed25519PublicJwk,
  };
  if (r.machine_id) d.machineId = r.machine_id as string;
  if (r.owner) d.owner = true;
  if (r.last_seen_at) d.lastSeenAt = r.last_seen_at as string;
  if (r.revoked) d.revoked = true;
  return d;
}

/** The wire shape of a device (no public key). */
export function publicDevice(d: DeviceRow): DeviceInfo {
  const { publicKey: _publicKey, ...info } = d;
  return info;
}

export class HubStore {
  readonly path: string;
  /** Custom themes (theming.md §5), shared by every device. */
  readonly themes: ThemeTable;
  /** User-wide preferences (theme choice, density), shared by every device. */
  readonly prefs: PrefsTable;
  /** Web Push subscriptions and Approve / Deny action tokens. */
  readonly webPush: WebPushTable;
  /** One-pane routing rules and recorded decisions (spec §11.2). */
  readonly routes: RouteStore;
  readonly #db: DatabaseSync;
  readonly #insertEvent: StatementSync;
  readonly #replay: StatementSync;
  readonly #maxSeq: StatementSync;
  readonly #insertGlobal: StatementSync;
  readonly #replayGlobal: StatementSync;
  readonly #setCursor: StatementSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.path = join(dataDir, 'hub.db');
    this.#db = new DatabaseSync(this.path);
    this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
    this.#db.exec(SCHEMA);
    this.themes = new ThemeTable(this.#db);
    this.prefs = new PrefsTable(this.#db);
    this.webPush = new WebPushTable(this.#db);
    this.routes = new RouteStore(this.#db);
    this.#insertEvent = this.#db.prepare('INSERT OR IGNORE INTO events (ch, seq, ts, type, data) VALUES (?, ?, ?, ?, ?)');
    this.#replay = this.#db.prepare('SELECT ch, seq, ts, type, data FROM events WHERE ch = ? AND seq > ? ORDER BY seq LIMIT ?');
    this.#maxSeq = this.#db.prepare('SELECT MAX(seq) AS seq FROM events WHERE ch = ?');
    this.#insertGlobal = this.#db.prepare('INSERT INTO global_events (seq, ts, type, data, machine_id) VALUES (?, ?, ?, ?, ?)');
    this.#replayGlobal = this.#db.prepare('SELECT seq, ts, type, data FROM global_events WHERE seq > ? ORDER BY seq LIMIT ?');
    this.#setCursor = this.#db.prepare(
      `INSERT INTO node_cursors (machine_id, global_seq) VALUES (?, ?)
       ON CONFLICT(machine_id) DO UPDATE SET global_seq = excluded.global_seq`,
    );
  }

  close(): void {
    if (this.#db.isOpen) this.#db.close();
  }

  get isOpen(): boolean {
    return this.#db.isOpen;
  }

  /** Run `fn` in a transaction (nested calls join the outer one). */
  tx<T>(fn: () => T): T {
    if (this.#db.isTransaction) return fn();
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const v = fn();
      this.#db.exec('COMMIT');
      return v;
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
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

  // --- devices ----------------------------------------------------------------------------------

  insertDevice(d: DeviceRow): void {
    this.#db
      .prepare(
        `INSERT INTO devices (id, name, kind, machine_id, owner, public_key, created_at, last_seen_at, revoked)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(d.id, d.name, d.kind, d.machineId ?? null, d.owner ? 1 : 0, JSON.stringify(d.publicKey), d.createdAt, d.lastSeenAt ?? null);
  }

  getDevice(id: string): DeviceRow | undefined {
    const r = this.#db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as Row | undefined;
    return r ? deviceFromRow(r) : undefined;
  }

  listDevices(): DeviceRow[] {
    return (this.#db.prepare('SELECT * FROM devices ORDER BY created_at, id').all() as Row[]).map(deviceFromRow);
  }

  countDevices(): number {
    return (this.#db.prepare('SELECT COUNT(*) AS n FROM devices').get() as { n: number }).n;
  }

  /** Active node devices serving a machine. */
  nodeDevicesFor(machineId: string): DeviceRow[] {
    return (
      this.#db.prepare("SELECT * FROM devices WHERE kind = 'node' AND machine_id = ? AND revoked = 0").all(machineId) as Row[]
    ).map(deviceFromRow);
  }

  revokeDevice(id: string): void {
    this.tx(() => {
      this.#db.prepare('UPDATE devices SET revoked = 1 WHERE id = ?').run(id);
      this.#db.prepare('DELETE FROM tokens WHERE device_id = ?').run(id);
      this.#db.prepare('DELETE FROM nonces WHERE device_id = ?').run(id);
    });
  }

  touchDevice(id: string, at: string): void {
    this.#db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(at, id);
  }

  // --- pairing codes ----------------------------------------------------------------------------

  insertPairingCode(c: { hash: string; kind: DeviceKind; name?: string; setup: boolean; createdBy?: string; expiresAt?: number }): void {
    this.#db
      .prepare(
        'INSERT INTO pairing_codes (hash, kind, name, setup, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(c.hash, c.kind, c.name ?? null, c.setup ? 1 : 0, c.createdBy ?? null, new Date().toISOString(), c.expiresAt ?? null);
  }

  getPairingCode(hash: string): PairingCodeRow | undefined {
    const r = this.#db.prepare('SELECT * FROM pairing_codes WHERE hash = ?').get(hash) as Row | undefined;
    if (!r) return undefined;
    const c: PairingCodeRow = { hash: r.hash as string, kind: r.kind as DeviceKind, setup: Boolean(r.setup) };
    if (r.name) c.name = r.name as string;
    if (r.expires_at !== null && r.expires_at !== undefined) c.expiresAt = Number(r.expires_at);
    if (r.used_at) c.usedAt = r.used_at as string;
    return c;
  }

  /** Marks the code used; returns false if it was already used (lost a race). */
  usePairingCode(hash: string, deviceId: string): boolean {
    const res = this.#db
      .prepare('UPDATE pairing_codes SET used_at = ?, used_by = ? WHERE hash = ? AND used_at IS NULL')
      .run(new Date().toISOString(), deviceId, hash);
    return Number(res.changes) === 1;
  }

  /** Invalidate every unused setup code (a new one is about to be issued). */
  dropSetupCodes(): void {
    this.#db.prepare('DELETE FROM pairing_codes WHERE setup = 1 AND used_at IS NULL').run();
  }

  // --- nonces and tokens ------------------------------------------------------------------------

  insertNonce(nonce: string, deviceId: string, expiresAt: number): void {
    this.#db.prepare('INSERT INTO nonces (nonce, device_id, expires_at) VALUES (?, ?, ?)').run(nonce, deviceId, expiresAt);
  }

  /** Deletes and returns the nonce (single use). */
  takeNonce(nonce: string): { deviceId: string; expiresAt: number } | undefined {
    return this.tx(() => {
      const r = this.#db.prepare('SELECT device_id, expires_at FROM nonces WHERE nonce = ?').get(nonce) as Row | undefined;
      if (!r) return undefined;
      this.#db.prepare('DELETE FROM nonces WHERE nonce = ?').run(nonce);
      return { deviceId: r.device_id as string, expiresAt: Number(r.expires_at) };
    });
  }

  insertToken(hash: string, deviceId: string, expiresAt: number): void {
    this.#db.prepare('INSERT INTO tokens (hash, device_id, expires_at) VALUES (?, ?, ?)').run(hash, deviceId, expiresAt);
  }

  getToken(hash: string): { deviceId: string; expiresAt: number } | undefined {
    const r = this.#db.prepare('SELECT device_id, expires_at FROM tokens WHERE hash = ?').get(hash) as Row | undefined;
    return r ? { deviceId: r.device_id as string, expiresAt: Number(r.expires_at) } : undefined;
  }

  /** Drop expired nonces, tokens and pairing codes. */
  sweep(now: number): void {
    this.#db.prepare('DELETE FROM nonces WHERE expires_at < ?').run(now);
    this.#db.prepare('DELETE FROM tokens WHERE expires_at < ?').run(now);
    this.#db.prepare('DELETE FROM pairing_codes WHERE expires_at IS NOT NULL AND expires_at < ? AND used_at IS NULL').run(now);
  }

  // --- machines ---------------------------------------------------------------------------------

  putMachine(m: MachineRow): void {
    this.#db
      .prepare(
        `INSERT INTO machines (id, info, device_id, last_seen_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET info = excluded.info, device_id = excluded.device_id, last_seen_at = excluded.last_seen_at`,
      )
      .run(m.info.id, JSON.stringify(m.info), m.deviceId ?? null, m.lastSeenAt ?? null);
  }

  getMachine(id: string): MachineRow | undefined {
    const r = this.#db.prepare('SELECT * FROM machines WHERE id = ?').get(id) as Row | undefined;
    return r ? machineFromRow(r) : undefined;
  }

  listMachines(): MachineRow[] {
    return (this.#db.prepare('SELECT * FROM machines ORDER BY id').all() as Row[]).map(machineFromRow);
  }

  // --- routing index ----------------------------------------------------------------------------

  putWorkspace(ws: WorkspaceInfo): void {
    this.#db
      .prepare(
        `INSERT INTO workspaces (id, machine_id, info) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET machine_id = excluded.machine_id, info = excluded.info`,
      )
      .run(ws.id, ws.machineId, JSON.stringify(ws));
  }

  deleteWorkspace(id: string): void {
    this.#db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
  }

  workspaceMachine(id: string): string | undefined {
    const r = this.#db.prepare('SELECT machine_id FROM workspaces WHERE id = ?').get(id) as Row | undefined;
    return r?.machine_id as string | undefined;
  }

  listWorkspaces(machineId?: string): WorkspaceInfo[] {
    const rows = (
      machineId
        ? this.#db.prepare('SELECT info FROM workspaces WHERE machine_id = ? ORDER BY id').all(machineId)
        : this.#db.prepare('SELECT info FROM workspaces ORDER BY id').all()
    ) as { info: string }[];
    return rows.map((r) => JSON.parse(r.info) as WorkspaceInfo);
  }

  putSession(s: SessionInfo): void {
    this.#db
      .prepare(
        `INSERT INTO sessions (id, machine_id, workspace_id, info) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET machine_id = excluded.machine_id, workspace_id = excluded.workspace_id, info = excluded.info`,
      )
      .run(s.id, s.machineId, s.workspaceId, JSON.stringify(s));
  }

  setSessionCapabilities(id: string, caps: AgentCapabilities): void {
    this.#db.prepare('UPDATE sessions SET capabilities = ? WHERE id = ?').run(JSON.stringify(caps), id);
  }

  getSession(id: string): { info: SessionInfo; capabilities?: AgentCapabilities } | undefined {
    const r = this.#db.prepare('SELECT info, capabilities FROM sessions WHERE id = ?').get(id) as Row | undefined;
    if (!r) return undefined;
    const out: { info: SessionInfo; capabilities?: AgentCapabilities } = { info: JSON.parse(r.info as string) as SessionInfo };
    if (r.capabilities) out.capabilities = JSON.parse(r.capabilities as string) as AgentCapabilities;
    return out;
  }

  /** Removes the session from the index and drops its replicated events. */
  deleteSession(id: string, ch: string): void {
    this.tx(() => {
      this.#db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
      this.#db.prepare('DELETE FROM events WHERE ch = ?').run(ch);
    });
  }

  listSessions(filter: { machineId?: string; workspaceId?: string } = {}): SessionInfo[] {
    let rows: { info: string }[];
    if (filter.workspaceId) {
      rows = this.#db.prepare('SELECT info FROM sessions WHERE workspace_id = ? ORDER BY id').all(filter.workspaceId) as typeof rows;
    } else if (filter.machineId) {
      rows = this.#db.prepare('SELECT info FROM sessions WHERE machine_id = ? ORDER BY id').all(filter.machineId) as typeof rows;
    } else {
      rows = this.#db.prepare('SELECT info FROM sessions ORDER BY id').all() as typeof rows;
    }
    return rows.map((r) => JSON.parse(r.info) as SessionInfo);
  }

  // --- session channel replica ------------------------------------------------------------------

  /** Insert a replicated event; false if (ch, seq) was already stored. */
  insertEvent(ev: ChannelEvent): boolean {
    const res = this.#insertEvent.run(ev.ch, ev.seq, ev.ts, ev.type, JSON.stringify(ev.data));
    return Number(res.changes) === 1;
  }

  maxSeq(ch: string): number {
    const row = this.#maxSeq.get(ch) as { seq: number | null } | undefined;
    return row?.seq ?? 0;
  }

  replay(ch: string, since: number, limit: number): ChannelEvent[] {
    const rows = this.#replay.all(ch, since, limit) as unknown as { ch: string; seq: number; ts: string; type: string; data: string }[];
    return rows.map((r) => ({ ch: r.ch, seq: r.seq, ts: r.ts, type: r.type, data: JSON.parse(r.data) }) as ChannelEvent);
  }

  // --- hub global log ---------------------------------------------------------------------------

  maxGlobalSeq(): number {
    const row = this.#db.prepare('SELECT MAX(seq) AS seq FROM global_events').get() as { seq: number | null } | undefined;
    return row?.seq ?? 0;
  }

  insertGlobal(seq: number, ts: string, body: GlobalEventBody, machineId?: string): GlobalEvent {
    this.#insertGlobal.run(seq, ts, body.type, JSON.stringify(body.data), machineId ?? null);
    return { ch: GLOBAL_CHANNEL, seq, ts, type: body.type, data: body.data } as GlobalEvent;
  }

  replayGlobal(since: number, limit: number): GlobalEvent[] {
    const rows = this.#replayGlobal.all(since, limit) as unknown as { seq: number; ts: string; type: string; data: string }[];
    return rows.map((r) => ({ ch: GLOBAL_CHANNEL, seq: r.seq, ts: r.ts, type: r.type, data: JSON.parse(r.data) }) as GlobalEvent);
  }

  /** Last seq of a node's own global channel the hub has stored. */
  nodeCursor(machineId: string): number {
    const r = this.#db.prepare('SELECT global_seq FROM node_cursors WHERE machine_id = ?').get(machineId) as Row | undefined;
    return r ? Number(r.global_seq) : 0;
  }

  setNodeCursor(machineId: string, seq: number): void {
    this.#setCursor.run(machineId, seq);
  }

  // --- knowledge replica (knowledge.md §9.4) ---------------------------------------------------

  /**
   * Keep `rec` if it is newer (by HLC) than the copy the hub has. Each accepted change gets the next
   * `rseq`, the hub's own arrival order, which is what nodes are fed from: an item that reaches the hub
   * late with an old clock still goes out to everyone.
   */
  putKnowledge(rec: KnowledgeRecord, fromMachine: string): boolean {
    return this.tx(() => {
      const cur = this.#db.prepare('SELECT hlc FROM knowledge_items WHERE id = ?').get(rec.id) as { hlc: string } | undefined;
      if (cur && cur.hlc >= rec.hlc) return false;
      const next = ((this.#db.prepare('SELECT MAX(rseq) AS n FROM knowledge_items').get() as { n: number | null }).n ?? 0) + 1;
      this.#db
        .prepare(
          `INSERT INTO knowledge_items (id, hlc, rseq, from_machine, data) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET hlc = excluded.hlc, rseq = excluded.rseq, from_machine = excluded.from_machine, data = excluded.data`,
        )
        .run(rec.id, rec.hlc, next, fromMachine, JSON.stringify(rec));
      return true;
    });
  }

  /** Changes after `rseq`, in arrival order. */
  knowledgeAfter(rseq: number, limit: number): { rseq: number; fromMachine: string; record: KnowledgeRecord }[] {
    const rows = this.#db
      .prepare('SELECT rseq, from_machine, data FROM knowledge_items WHERE rseq > ? ORDER BY rseq LIMIT ?')
      .all(rseq, limit) as { rseq: number; from_machine: string; data: string }[];
    return rows.map((r) => ({ rseq: Number(r.rseq), fromMachine: r.from_machine, record: JSON.parse(r.data) as KnowledgeRecord }));
  }

  getKnowledge(id: string): KnowledgeRecord | undefined {
    const r = this.#db.prepare('SELECT data FROM knowledge_items WHERE id = ?').get(id) as { data: string } | undefined;
    return r ? (JSON.parse(r.data) as KnowledgeRecord) : undefined;
  }

  countKnowledge(): number {
    return (this.#db.prepare('SELECT COUNT(*) AS n FROM knowledge_items').get() as { n: number }).n;
  }

  /** Per machine: its knowledge store's id, the newest HLC pulled from it, the last hub `rseq` pushed to it. */
  knowledgeCursor(machineId: string): KnowledgeCursor {
    const r = this.#db.prepare('SELECT store_id, pulled_hlc, pushed_rseq FROM knowledge_cursors WHERE machine_id = ?').get(machineId) as
      | Row
      | undefined;
    const c: KnowledgeCursor = { pushedRseq: r ? Number(r.pushed_rseq) : 0 };
    if (typeof r?.store_id === 'string') c.storeId = r.store_id;
    if (typeof r?.pulled_hlc === 'string') c.pulledHlc = r.pulled_hlc;
    return c;
  }

  setKnowledgeCursor(machineId: string, c: KnowledgeCursor): void {
    this.#db
      .prepare(
        `INSERT INTO knowledge_cursors (machine_id, store_id, pulled_hlc, pushed_rseq) VALUES (?, ?, ?, ?)
         ON CONFLICT(machine_id) DO UPDATE SET store_id = excluded.store_id, pulled_hlc = excluded.pulled_hlc, pushed_rseq = excluded.pushed_rseq`,
      )
      .run(machineId, c.storeId ?? null, c.pulledHlc ?? null, c.pushedRseq);
  }

  // --- per-login usage (one row per machine that reported the login) ----------------------------

  putUsage(machineId: string, u: AccountUsage): void {
    this.#db
      .prepare(
        `INSERT INTO account_usage (agent, account_id, machine_id, observed_at, data) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(agent, account_id, machine_id) DO UPDATE SET observed_at = excluded.observed_at, data = excluded.data`,
      )
      .run(u.agent, u.accountId, machineId, u.observedAt, JSON.stringify(u));
  }

  /** Every machine's snapshot of one login, or of all logins. */
  listUsage(filter?: { agent: string; accountId: string }): AccountUsage[] {
    const rows = (
      filter
        ? this.#db.prepare('SELECT data FROM account_usage WHERE agent = ? AND account_id = ?').all(filter.agent, filter.accountId)
        : this.#db.prepare('SELECT data FROM account_usage ORDER BY agent, account_id, machine_id').all()
    ) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as AccountUsage);
  }

  // --- widget value cache -----------------------------------------------------------------------

  putWidget(w: WidgetValue): void {
    this.#db
      .prepare(
        `INSERT INTO widgets (machine_id, widget_id, data) VALUES (?, ?, ?)
         ON CONFLICT(machine_id, widget_id) DO UPDATE SET data = excluded.data`,
      )
      .run(w.machineId, w.id, JSON.stringify(w));
  }

  deleteWidget(machineId: string, widgetId: string): void {
    this.#db.prepare('DELETE FROM widgets WHERE machine_id = ? AND widget_id = ?').run(machineId, widgetId);
  }

  /** Replace a machine's cached widgets with what it reports now. */
  replaceWidgets(machineId: string, widgets: WidgetValue[]): void {
    this.tx(() => {
      this.#db.prepare('DELETE FROM widgets WHERE machine_id = ?').run(machineId);
      for (const w of widgets) if (w.machineId === machineId) this.putWidget(w);
    });
  }

  listWidgets(machineId?: string): WidgetValue[] {
    const rows = (
      machineId
        ? this.#db.prepare('SELECT data FROM widgets WHERE machine_id = ? ORDER BY widget_id').all(machineId)
        : this.#db.prepare('SELECT data FROM widgets ORDER BY machine_id, widget_id').all()
    ) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as WidgetValue);
  }
}

function machineFromRow(r: Row): MachineRow {
  const m: MachineRow = { info: JSON.parse(r.info as string) as MachineInfo };
  if (r.device_id) m.deviceId = r.device_id as string;
  if (r.last_seen_at) m.lastSeenAt = r.last_seen_at as string;
  return m;
}
