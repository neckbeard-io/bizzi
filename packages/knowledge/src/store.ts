// SQLite-backed knowledge store (node:sqlite). Append-friendly: items are never physically
// removed; forgetting writes a tombstone (status 'deleted') with a fresh HLC so it replicates.

import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { BizziError, newId } from '@bizzi/protocol';
import type { AgentKind, Logger } from '@bizzi/protocol';
import { HybridLogicalClock, compareHlc } from './hlc.ts';
import { normalizeScope } from './scope.ts';
import type {
  KnowledgeContext,
  KnowledgeItem,
  KnowledgeScope,
  KnowledgeSource,
  KnowledgeStatus,
  KnowledgeType,
  MemoryKind,
  ScopeLevel,
} from './types.ts';
import { KNOWLEDGE_STATUSES, KNOWLEDGE_TYPES, MEMORY_KINDS } from './types.ts';

export interface NewKnowledgeItem {
  id?: string;
  type: KnowledgeType;
  scope: KnowledgeScope;
  appliesTo?: AgentKind[];
  kind?: MemoryKind;
  title: string;
  body: string;
  tags?: string[];
  source: KnowledgeSource;
  status: KnowledgeStatus;
  supersedes?: string[];
  noticePending?: boolean;
  createdAt?: string;
}

export interface ItemPatch {
  title?: string;
  body?: string;
  kind?: MemoryKind | null;
  tags?: string[];
  scope?: KnowledgeScope;
  /** `null` or `[]` = all agents. */
  appliesTo?: AgentKind[] | null;
  status?: KnowledgeStatus;
  noticePending?: boolean;
  supersedes?: string[];
}

export interface ListFilter {
  type?: KnowledgeType;
  status?: KnowledgeStatus | KnowledgeStatus[];
  scopeLevel?: ScopeLevel;
  projectId?: string;
  /** Items written by this session (source.sessionId). */
  sourceSessionId?: string;
  noticePending?: boolean;
  limit?: number;
}

export interface SearchOptions {
  /** Only items visible to this context (status active, scope + appliesTo match). */
  context?: KnowledgeContext;
  type?: KnowledgeType;
  /** Ignored when `context` is given (visibility implies active). Default: active. */
  statuses?: KnowledgeStatus[];
  limit?: number;
}

export interface SearchHit {
  item: KnowledgeItem;
  /** Text relevance, > 0, higher is better (negated BM25 with FTS5; token hits with LIKE). */
  relevance: number;
}

export interface HarvestRecord {
  sourceKey: string;
  contentHash: string;
  itemId: string;
  harvestedAt: string;
}

export interface KnowledgeStoreOptions {
  /** SQLite file path, or ':memory:'. */
  path: string;
  /** This node's machine id; also the HLC node id. */
  machineId: string;
  logger?: Logger;
  /** Clock for timestamps (tests). */
  now?: () => number;
  /** Force the LIKE fallback even when FTS5 is available (tests). */
  disableFts?: boolean;
}

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  scope_level TEXT NOT NULL,
  machine_id TEXT,
  project_id TEXT,
  workspace_id TEXT,
  session_id TEXT,
  team_id TEXT,
  applies_to TEXT,
  kind TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL,
  source_session_id TEXT,
  status TEXT NOT NULL,
  supersedes TEXT,
  notice_pending INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  hlc TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS items_status_type ON items(status, type);
CREATE INDEX IF NOT EXISTS items_scope ON items(scope_level, project_id, workspace_id, machine_id, session_id);
CREATE INDEX IF NOT EXISTS items_hash ON items(content_hash);
CREATE INDEX IF NOT EXISTS items_hlc ON items(hlc);
CREATE INDEX IF NOT EXISTS items_source_session ON items(source_session_id);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS harvest_sources (
  source_key TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  item_id TEXT NOT NULL,
  harvested_at TEXT NOT NULL
);
`;

const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  title, body, tags, content='items', content_rowid='rowid', tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(rowid, title, body, tags) VALUES (new.rowid, new.title, new.body, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, body, tags) VALUES ('delete', old.rowid, old.title, old.body, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE OF title, body, tags ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, body, tags) VALUES ('delete', old.rowid, old.title, old.body, old.tags);
  INSERT INTO items_fts(rowid, title, body, tags) VALUES (new.rowid, new.title, new.body, new.tags);
END;
`;

/** Does this Node's bundled SQLite have FTS5? */
export function detectFts5(): boolean {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE VIRTUAL TABLE t USING fts5(a)');
    return true;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

export function contentHash(type: KnowledgeType, title: string, body: string): string {
  const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(`${type}\n${norm(title)}\n${norm(body)}`).digest('hex');
}

/**
 * Split free text into search terms: one per whitespace-separated word, each a list of
 * lowercase letter/digit tokens (`server-a` → ['server', 'a'], matched as a phrase). Deduped, capped.
 */
export function queryTerms(query: string, max = 16): string[][] {
  const out: string[][] = [];
  const seen = new Set<string>();
  for (const word of query.toLowerCase().split(/\s+/)) {
    const tokens = [...word.matchAll(/[\p{L}\p{N}_]+/gu)].map((m) => m[0]);
    if (tokens.length === 0) continue;
    const key = tokens.join(' ');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tokens);
    if (out.length >= max) break;
  }
  return out;
}

/** Flat list of query tokens (see `queryTerms`). */
export function queryTokens(query: string, max = 16): string[] {
  return [...new Set(queryTerms(query, max).flat())];
}

function ftsTerm(tokens: string[]): string {
  const phrase = `"${tokens.join(' ').replaceAll('"', '""')}"`;
  // Prefix-match the last token unless it is too short to be meaningful.
  return (tokens[tokens.length - 1] ?? '').length >= 3 ? `${phrase}*` : phrase;
}

type Row = Record<string, unknown>;

export class KnowledgeStore {
  readonly path: string;
  readonly machineId: string;
  readonly ftsAvailable: boolean;
  readonly #db: DatabaseSync;
  readonly #clock: HybridLogicalClock;
  readonly #now: () => number;
  readonly #logger: Logger | undefined;
  #txDepth = 0;

  constructor(opts: KnowledgeStoreOptions) {
    this.path = opts.path;
    this.machineId = opts.machineId;
    this.#now = opts.now ?? Date.now;
    this.#logger = opts.logger;
    this.#clock = new HybridLogicalClock(opts.machineId, this.#now);
    this.#db = new DatabaseSync(opts.path);
    this.#db.exec('PRAGMA busy_timeout = 5000');
    if (opts.path !== ':memory:') this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA foreign_keys = ON');
    this.#db.exec(SCHEMA);
    let fts = false;
    if (!opts.disableFts) {
      try {
        this.#db.exec(FTS_SCHEMA);
        fts = true;
      } catch (err) {
        this.#logger?.log('warn', 'FTS5 unavailable; falling back to LIKE search', { error: String(err) });
      }
    }
    this.ftsAvailable = fts;
    this.#db.prepare('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
    this.#syncClock();
  }

  static open(path: string, machineId: string, opts: Omit<KnowledgeStoreOptions, 'path' | 'machineId'> = {}): KnowledgeStore {
    return new KnowledgeStore({ ...opts, path, machineId });
  }

  close(): void {
    this.#db.close();
  }

  nowIso(): string {
    return new Date(this.#now()).toISOString();
  }

  nowMs(): number {
    return this.#now();
  }

  /** Run `fn` in a transaction (nested calls join the outer one). */
  transaction<T>(fn: () => T): T {
    if (this.#txDepth > 0) return fn();
    this.#db.exec('BEGIN IMMEDIATE');
    this.#txDepth++;
    try {
      const out = fn();
      this.#db.exec('COMMIT');
      return out;
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    } finally {
      this.#txDepth--;
    }
  }

  // ---- items ---------------------------------------------------------------------------------

  insert(input: NewKnowledgeItem): KnowledgeItem {
    validateNew(input);
    return this.transaction(() => {
      const now = this.nowIso();
      const item: KnowledgeItem = {
        id: input.id ?? newId('k'),
        type: input.type,
        scope: normalizeScope(input.scope),
        ...(input.appliesTo && input.appliesTo.length > 0 ? { appliesTo: [...new Set(input.appliesTo)] } : {}),
        ...(input.type === 'memory' && input.kind ? { kind: input.kind } : {}),
        title: input.title.trim(),
        body: input.body.trim(),
        tags: normalizeTags(input.tags ?? []),
        source: input.source,
        status: input.status,
        ...(input.supersedes && input.supersedes.length > 0 ? { supersedes: [...input.supersedes] } : {}),
        ...(input.noticePending ? { noticePending: true } : {}),
        contentHash: contentHash(input.type, input.title, input.body),
        createdAt: input.createdAt ?? now,
        updatedAt: now,
        hlc: this.#tick(),
      };
      this.#write(item, 'insert');
      return item;
    });
  }

  get(id: string): KnowledgeItem | undefined {
    const row = this.#db.prepare('SELECT * FROM items WHERE id = ?').get(id) as Row | undefined;
    return row ? rowToItem(row) : undefined;
  }

  require(id: string): KnowledgeItem {
    const item = this.get(id);
    if (!item) throw new BizziError('not_found', `knowledge item not found: ${id}`);
    return item;
  }

  /** In-place change (status transitions, scope edits on accept, notice acks). Bumps hlc/updatedAt. */
  patch(id: string, patch: ItemPatch): KnowledgeItem {
    return this.transaction(() => {
      const cur = this.require(id);
      const next: KnowledgeItem = { ...cur };
      if (patch.title !== undefined) next.title = patch.title.trim();
      if (patch.body !== undefined) next.body = patch.body.trim();
      if (patch.tags !== undefined) next.tags = normalizeTags(patch.tags);
      if (patch.scope !== undefined) next.scope = normalizeScope(patch.scope);
      if (patch.kind !== undefined) {
        if (patch.kind === null || next.type !== 'memory') delete next.kind;
        else next.kind = patch.kind;
      }
      if (patch.appliesTo !== undefined) {
        if (patch.appliesTo === null || patch.appliesTo.length === 0) delete next.appliesTo;
        else next.appliesTo = [...new Set(patch.appliesTo)];
      }
      if (patch.status !== undefined) next.status = patch.status;
      if (patch.noticePending !== undefined) {
        if (patch.noticePending) next.noticePending = true;
        else delete next.noticePending;
      }
      if (patch.supersedes !== undefined) {
        if (patch.supersedes.length === 0) delete next.supersedes;
        else next.supersedes = [...patch.supersedes];
      }
      validateNew(next);
      next.contentHash = contentHash(next.type, next.title, next.body);
      next.updatedAt = this.nowIso();
      next.hlc = this.#tick();
      this.#write(next, 'update');
      return next;
    });
  }

  setStatus(id: string, status: KnowledgeStatus): KnowledgeItem {
    return this.patch(id, { status });
  }

  list(filter: ListFilter = {}): KnowledgeItem[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter.type) {
      where.push('type = ?');
      params.push(filter.type);
    }
    if (filter.status) {
      const sts = Array.isArray(filter.status) ? filter.status : [filter.status];
      where.push(`status IN (${sts.map(() => '?').join(',')})`);
      params.push(...sts);
    }
    if (filter.scopeLevel) {
      where.push('scope_level = ?');
      params.push(filter.scopeLevel);
    }
    if (filter.projectId) {
      where.push('project_id = ?');
      params.push(filter.projectId);
    }
    if (filter.sourceSessionId) {
      where.push('source_session_id = ?');
      params.push(filter.sourceSessionId);
    }
    if (filter.noticePending !== undefined) {
      where.push('notice_pending = ?');
      params.push(filter.noticePending ? 1 : 0);
    }
    let sql = 'SELECT * FROM items';
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
    sql += ' ORDER BY hlc ASC';
    if (filter.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(filter.limit);
    }
    return (this.#db.prepare(sql).all(...params) as Row[]).map(rowToItem);
  }

  /** Items visible to a context (§2.2), in HLC order. */
  visible(ctx: KnowledgeContext, type?: KnowledgeType): KnowledgeItem[] {
    const vis = visibleClause(ctx, 'items');
    let sql = `SELECT * FROM items WHERE ${vis.sql}`;
    const params = [...vis.params];
    if (type) {
      sql += ' AND type = ?';
      params.push(type);
    }
    sql += ' ORDER BY hlc ASC';
    return (this.#db.prepare(sql).all(...params) as Row[]).map(rowToItem);
  }

  /** Full-text search. Only matching items are returned, best first. */
  search(query: string, opts: SearchOptions = {}): SearchHit[] {
    const terms = queryTerms(query);
    if (terms.length === 0) return [];
    const limit = opts.limit ?? 50;
    const filters: string[] = [];
    const params: SQLInputValue[] = [];
    if (opts.context) {
      const vis = visibleClause(opts.context, 'i');
      filters.push(vis.sql);
      params.push(...vis.params);
    } else {
      const sts = opts.statuses ?? ['active'];
      filters.push(`i.status IN (${sts.map(() => '?').join(',')})`);
      params.push(...sts);
    }
    if (opts.type) {
      filters.push('i.type = ?');
      params.push(opts.type);
    }
    if (this.ftsAvailable) {
      const match = terms.map(ftsTerm).join(' OR ');
      const sql = `SELECT i.*, -bm25(items_fts, 3.0, 1.0, 2.0) AS relevance
        FROM items_fts JOIN items i ON i.rowid = items_fts.rowid
        WHERE items_fts MATCH ? AND ${filters.join(' AND ')}
        ORDER BY relevance DESC LIMIT ?`;
      const rows = this.#db.prepare(sql).all(match, ...params, limit) as Row[];
      // bm25 can be ~0 for terms present in every row; keep matches strictly positive.
      return rows.map((r) => ({ item: rowToItem(r), relevance: Math.max(Number(r.relevance), 1e-6) }));
    }
    // LIKE fallback: any term in title/body/tags; score weighted like the FTS columns.
    const likeParts: string[] = [];
    const likeParams: string[] = [];
    const esc = (t: string) => t.replace(/[\\%_]/g, (c) => `\\${c}`);
    for (const term of terms) {
      const pat = `%${term.map(esc).join('%')}%`;
      likeParts.push("(i.title LIKE ? ESCAPE '\\' OR i.body LIKE ? ESCAPE '\\' OR i.tags LIKE ? ESCAPE '\\')");
      likeParams.push(pat, pat, pat);
    }
    const sql = `SELECT i.* FROM items i WHERE (${likeParts.join(' OR ')}) AND ${filters.join(' AND ')}`;
    const rows = this.#db.prepare(sql).all(...likeParams, ...params) as Row[];
    const hits = rows.map((r) => {
      const item = rowToItem(r);
      const title = item.title.toLowerCase();
      const body = item.body.toLowerCase();
      const tags = item.tags.join(' ').toLowerCase();
      let relevance = 0;
      for (const term of terms) {
        const re = new RegExp(term.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*'), 'u');
        if (re.test(title)) relevance += 3;
        if (re.test(body)) relevance += 1;
        if (re.test(tags)) relevance += 2;
      }
      return { item, relevance };
    });
    hits.sort((a, b) => b.relevance - a.relevance);
    return hits.slice(0, limit);
  }

  /** Items with this content hash, any status (deleted included, so forgotten items aren't revived). */
  findByContentHash(hash: string, statuses?: KnowledgeStatus[]): KnowledgeItem[] {
    let sql = 'SELECT * FROM items WHERE content_hash = ?';
    const params: SQLInputValue[] = [hash];
    if (statuses) {
      sql += ` AND status IN (${statuses.map(() => '?').join(',')})`;
      params.push(...statuses);
    }
    return (this.#db.prepare(`${sql} ORDER BY hlc ASC`).all(...params) as Row[]).map(rowToItem);
  }

  // ---- replication ---------------------------------------------------------------------------

  /** Every item changed after `hlc` (exclusive), oldest first. Tombstones included. */
  changesSince(hlc?: string, limit = 1000): KnowledgeItem[] {
    const rows = (
      hlc === undefined
        ? this.#db.prepare('SELECT * FROM items ORDER BY hlc ASC LIMIT ?').all(limit)
        : this.#db.prepare('SELECT * FROM items WHERE hlc > ? ORDER BY hlc ASC LIMIT ?').all(hlc, limit)
    ) as Row[];
    return rows.map(rowToItem);
  }

  /** Merge an item from another node: last writer (by HLC) wins. Returns true if applied. */
  applyRemote(item: KnowledgeItem): boolean {
    validateNew(item);
    return this.transaction(() => {
      this.#clock.update(item.hlc);
      const cur = this.get(item.id);
      if (cur && compareHlc(cur.hlc, item.hlc) >= 0) return false;
      this.#write({ ...item, scope: normalizeScope(item.scope) }, cur ? 'update' : 'insert');
      return true;
    });
  }

  /** Highest HLC in the store (replication cursor). */
  maxHlc(): string | undefined {
    const row = this.#db.prepare('SELECT MAX(hlc) AS h FROM items').get() as Row | undefined;
    return typeof row?.h === 'string' ? row.h : undefined;
  }

  // ---- settings & harvest bookkeeping --------------------------------------------------------

  getSetting<T>(key: string): T | undefined {
    const row = this.#db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as Row | undefined;
    return row ? (JSON.parse(String(row.value)) as T) : undefined;
  }

  setSetting(key: string, value: unknown): void {
    this.#db
      .prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  getHarvestRecord(sourceKey: string): HarvestRecord | undefined {
    const row = this.#db.prepare('SELECT * FROM harvest_sources WHERE source_key = ?').get(sourceKey) as Row | undefined;
    if (!row) return undefined;
    return {
      sourceKey: String(row.source_key),
      contentHash: String(row.content_hash),
      itemId: String(row.item_id),
      harvestedAt: String(row.harvested_at),
    };
  }

  putHarvestRecord(rec: HarvestRecord): void {
    this.#db
      .prepare(
        `INSERT INTO harvest_sources(source_key, content_hash, item_id, harvested_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(source_key) DO UPDATE SET content_hash = excluded.content_hash, item_id = excluded.item_id,
           harvested_at = excluded.harvested_at`,
      )
      .run(rec.sourceKey, rec.contentHash, rec.itemId, rec.harvestedAt);
  }

  // ---- internals -----------------------------------------------------------------------------

  #syncClock(): void {
    const h = this.maxHlc();
    if (h) this.#clock.observe(h);
  }

  /** Next HLC, monotonic across processes sharing this database file. */
  #tick(): string {
    this.#syncClock();
    return this.#clock.now();
  }

  #write(item: KnowledgeItem, mode: 'insert' | 'update'): void {
    const s = item.scope;
    const values: SQLInputValue[] = [
      item.type,
      s.level,
      s.machineId ?? null,
      s.projectId ?? null,
      s.workspaceId ?? null,
      s.sessionId ?? null,
      s.teamId ?? null,
      item.appliesTo && item.appliesTo.length > 0 ? JSON.stringify(item.appliesTo) : null,
      item.kind ?? null,
      item.title,
      item.body,
      JSON.stringify(item.tags),
      JSON.stringify(item.source),
      item.source.sessionId ?? null,
      item.status,
      item.supersedes && item.supersedes.length > 0 ? JSON.stringify(item.supersedes) : null,
      item.noticePending ? 1 : 0,
      item.contentHash,
      item.createdAt,
      item.updatedAt,
      item.hlc,
    ];
    if (mode === 'insert') {
      this.#db
        .prepare(
          `INSERT INTO items(type, scope_level, machine_id, project_id, workspace_id, session_id, team_id, applies_to,
             kind, title, body, tags, source, source_session_id, status, supersedes, notice_pending, content_hash,
             created_at, updated_at, hlc, id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(...values, item.id);
    } else {
      this.#db
        .prepare(
          `UPDATE items SET type = ?, scope_level = ?, machine_id = ?, project_id = ?, workspace_id = ?, session_id = ?,
             team_id = ?, applies_to = ?, kind = ?, title = ?, body = ?, tags = ?, source = ?, source_session_id = ?,
             status = ?, supersedes = ?, notice_pending = ?, content_hash = ?, created_at = ?, updated_at = ?, hlc = ?
           WHERE id = ?`,
        )
        .run(...values, item.id);
    }
  }
}

function visibleClause(ctx: KnowledgeContext, t: string): { sql: string; params: SQLInputValue[] } {
  const sql = `${t}.status = 'active'
    AND (${t}.applies_to IS NULL OR EXISTS (SELECT 1 FROM json_each(${t}.applies_to) WHERE json_each.value = ?))
    AND (${t}.scope_level = 'global'
      OR (${t}.scope_level = 'machine' AND ${t}.machine_id = ?)
      OR (${t}.scope_level = 'project' AND ${t}.project_id = ?)
      OR (${t}.scope_level = 'workspace' AND ${t}.workspace_id = ?)
      OR (${t}.scope_level = 'session' AND ${t}.session_id = ?))`;
  return {
    sql,
    params: [ctx.agent, ctx.machineId, ctx.projectId ?? null, ctx.workspaceId ?? null, ctx.sessionId ?? null],
  };
}

function normalizeTags(tags: string[]): string[] {
  const out: string[] = [];
  for (const t of tags) {
    const v = t.trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

function validateNew(item: Pick<NewKnowledgeItem, 'type' | 'title' | 'body' | 'status' | 'kind' | 'source'>): void {
  if (!(KNOWLEDGE_TYPES as readonly string[]).includes(item.type)) {
    throw new BizziError('bad_request', `unknown knowledge type: ${String(item.type)}`);
  }
  if (!(KNOWLEDGE_STATUSES as readonly string[]).includes(item.status)) {
    throw new BizziError('bad_request', `unknown status: ${String(item.status)}`);
  }
  if (item.kind !== undefined && !(MEMORY_KINDS as readonly string[]).includes(item.kind)) {
    throw new BizziError('bad_request', `unknown memory kind: ${String(item.kind)}`);
  }
  if (typeof item.title !== 'string' || item.title.trim() === '') throw new BizziError('bad_request', 'title is required');
  if (item.title.includes('\n')) throw new BizziError('bad_request', 'title must be one line');
  if (typeof item.body !== 'string') throw new BizziError('bad_request', 'body must be a string');
  if (!item.source || typeof item.source.machineId !== 'string') {
    throw new BizziError('bad_request', 'source.machineId is required');
  }
}

function rowToItem(r: Row): KnowledgeItem {
  const scope: KnowledgeScope = { level: String(r.scope_level) as ScopeLevel };
  if (r.machine_id != null) scope.machineId = String(r.machine_id);
  if (r.project_id != null) scope.projectId = String(r.project_id);
  if (r.workspace_id != null) scope.workspaceId = String(r.workspace_id);
  if (r.session_id != null) scope.sessionId = String(r.session_id);
  if (r.team_id != null) scope.teamId = String(r.team_id);
  const item: KnowledgeItem = {
    id: String(r.id),
    type: String(r.type) as KnowledgeType,
    scope,
    title: String(r.title),
    body: String(r.body),
    tags: JSON.parse(String(r.tags)) as string[],
    source: JSON.parse(String(r.source)) as KnowledgeSource,
    status: String(r.status) as KnowledgeStatus,
    contentHash: String(r.content_hash),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    hlc: String(r.hlc),
  };
  if (r.applies_to != null) item.appliesTo = JSON.parse(String(r.applies_to)) as AgentKind[];
  if (r.kind != null) item.kind = String(r.kind) as MemoryKind;
  if (r.supersedes != null) item.supersedes = JSON.parse(String(r.supersedes)) as string[];
  if (Number(r.notice_pending) === 1) item.noticePending = true;
  return item;
}
