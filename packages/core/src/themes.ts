// Custom themes (docs/theming.md §5). The hub stores them so every device sees them; a node stores its
// own so the desktop app works offline. Both use this table over their own SQLite database.

import { DatabaseSync } from 'node:sqlite';
import { BizziError, ulid, type ThemeFile } from '@bizzi/protocol';
import type { NodeExtension } from './node.ts';
import { asParams, optString, type Params } from './params.ts';

/** Largest accepted theme JSON (`data`, serialized). */
export const MAX_THEME_BYTES = 256 * 1024;
export const MAX_THEME_NAME = 200;
export const MAX_THEMES = 1000;
const THEME_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS themes (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  data       TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export interface ThemeSave {
  id?: string;
  name: string;
  /** Serialized `data`. */
  json: string;
}

/** Validate `theme.save` params. Throws bad_request. */
export function parseThemeSave(params: unknown): ThemeSave {
  const p: Params = asParams(params);
  const id = optString(p, 'id');
  if (id !== undefined && !THEME_ID_RE.test(id)) {
    throw new BizziError('bad_request', 'id must be 1-128 characters of letters, digits, _ . - (starting with a letter or digit)');
  }
  const name = typeof p.name === 'string' ? p.name.trim() : '';
  if (!name) throw new BizziError('bad_request', 'name must be a non-empty string');
  if (name.length > MAX_THEME_NAME) throw new BizziError('bad_request', `name is longer than ${MAX_THEME_NAME} characters`);
  if (p.data === undefined) throw new BizziError('bad_request', 'data is required');
  let json: string | undefined;
  try {
    json = JSON.stringify(p.data);
  } catch {
    json = undefined;
  }
  if (json === undefined) throw new BizziError('bad_request', 'data must be JSON');
  if (Buffer.byteLength(json) > MAX_THEME_BYTES) {
    throw new BizziError('bad_request', `theme data is larger than ${MAX_THEME_BYTES / 1024} KiB`);
  }
  return id === undefined ? { name, json } : { id, name, json };
}

export class ThemeTable {
  readonly #db: DatabaseSync;
  readonly #now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#now = now;
    db.exec(SCHEMA);
  }

  list(): ThemeFile[] {
    const rows = this.#db.prepare('SELECT id, name, data, updated_at FROM themes ORDER BY name COLLATE NOCASE, id').all() as {
      id: string;
      name: string;
      data: string;
      updated_at: string;
    }[];
    return rows.map((r) => ({ id: r.id, name: r.name, data: JSON.parse(r.data) as unknown, updatedAt: r.updated_at }));
  }

  /** Insert or replace; a new id (`th_<ULID>`) when params carry none. */
  save(params: unknown): ThemeFile {
    const t = parseThemeSave(params);
    const id = t.id ?? `th_${ulid()}`;
    const exists = this.#db.prepare('SELECT 1 FROM themes WHERE id = ?').get(id) !== undefined;
    if (!exists) {
      const { n } = this.#db.prepare('SELECT COUNT(*) AS n FROM themes').get() as { n: number };
      if (n >= MAX_THEMES) throw new BizziError('conflict', `at most ${MAX_THEMES} custom themes`);
    }
    const updatedAt = this.#now().toISOString();
    this.#db
      .prepare(
        `INSERT INTO themes (id, name, data, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, data = excluded.data, updated_at = excluded.updated_at`,
      )
      .run(id, t.name, t.json, updatedAt);
    return { id, name: t.name, data: JSON.parse(t.json) as unknown, updatedAt };
  }

  /** Throws not_found for an unknown id. */
  delete(params: unknown): void {
    const p = asParams(params);
    const id = p.id;
    if (typeof id !== 'string' || !id) throw new BizziError('bad_request', 'id must be a non-empty string');
    const res = this.#db.prepare('DELETE FROM themes WHERE id = ?').run(id);
    if (Number(res.changes) === 0) throw new BizziError('not_found', `theme ${id} not found`);
  }
}

/** The core's built-in `themes.*` handlers (local mode); a separate connection to `dbPath`. */
export function themesExtension(dbPath: string): NodeExtension {
  let db: DatabaseSync | undefined;
  let table: ThemeTable | undefined;
  const t = (): ThemeTable => {
    if (!table) throw new BizziError('machine_offline', 'node is shut down');
    return table;
  };
  return {
    methods: {
      'themes.list': () => ({ themes: t().list() }),
      'theme.save': (p: unknown) => ({ theme: t().save(p) }),
      'theme.delete': (p: unknown) => {
        t().delete(p);
        return {};
      },
    },
    start: () => {
      db = new DatabaseSync(dbPath);
      db.exec('PRAGMA busy_timeout = 5000;');
      table = new ThemeTable(db);
    },
    stop: () => {
      table = undefined;
      if (db?.isOpen) db.close();
      db = undefined;
    },
  };
}
