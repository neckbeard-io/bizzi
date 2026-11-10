// Context baselines (docs/usage.md §2): the starting context of a fresh session, learned per agent, model
// and workspace from the first `context.updated` each session reports. The node keeps the last
// BASELINE_SAMPLES samples per key in its own table in node.db and serves their median as `baselines.list`.
//
// Worktree sessions count toward their repo workspace: a worktree has the same files and rules as its
// repo, and a fan-out creates fresh worktrees that would otherwise never have a baseline.

import { DatabaseSync } from 'node:sqlite';
import type { ChannelEvent, ContextBaseline, Logger, SessionInfo, WorkspaceInfo } from '@bizzi/protocol';
import type { EventBus } from './bus.ts';
import type { NodeExtension } from './node.ts';
import { optString, type Params } from './params.ts';

/** Samples kept per (agent, model, workspace); the baseline is their median. */
export const BASELINE_SAMPLES = 10;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS context_baselines (
  agent        TEXT NOT NULL,
  model        TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  samples      TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (agent, model, workspace_id)
);
CREATE TABLE IF NOT EXISTS context_baseline_sessions (
  session_id TEXT PRIMARY KEY
);
`;

interface Sample {
  tokens: number;
  at: string;
}

interface Entry {
  agent: SessionInfo['agent'];
  /** '' when the session didn't report a model. */
  model: string;
  /** '' when unknown. */
  workspaceId: string;
  samples: Sample[];
}

/** Median of the values, rounded to a whole token; 0 for an empty list. */
export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return Math.round(s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2);
}

export interface BaselineTrackerOptions {
  /** SQLite file to keep samples in (the node's node.db; a separate connection and tables). */
  dbPath: string;
  bus: EventBus;
  machineId: string;
  logger: Logger;
  /** The session a `context.updated` belongs to (undefined when unknown). */
  session(id: string): SessionInfo | undefined;
  /** A workspace by id (undefined when unknown); used to attribute worktrees to their repo. */
  workspace(id: string): WorkspaceInfo | undefined;
  now?: () => Date;
}

export class BaselineTracker {
  readonly #o: BaselineTrackerOptions;
  readonly #now: () => Date;
  readonly #entries = new Map<string, Entry>();
  /** Sessions whose first context report has been taken (persisted, so restarts don't count twice). */
  readonly #seen = new Set<string>();
  #db?: DatabaseSync;
  #untap?: () => void;

  constructor(o: BaselineTrackerOptions) {
    this.#o = o;
    this.#now = o.now ?? (() => new Date());
  }

  /** Open the tables, load persisted samples and start watching session channels. Idempotent. */
  start(): void {
    if (this.#db) return;
    const db = new DatabaseSync(this.#o.dbPath);
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec(SCHEMA);
    this.#db = db;
    const rows = db.prepare('SELECT agent, model, workspace_id, samples FROM context_baselines').all() as {
      agent: string;
      model: string;
      workspace_id: string;
      samples: string;
    }[];
    for (const r of rows) {
      try {
        const samples = (JSON.parse(r.samples) as Sample[]).filter((x) => typeof x?.tokens === 'number' && x.tokens > 0 && typeof x.at === 'string');
        if (samples.length === 0) continue;
        const e: Entry = { agent: r.agent as Entry['agent'], model: r.model, workspaceId: r.workspace_id, samples: samples.slice(-BASELINE_SAMPLES) };
        this.#entries.set(key(e), e);
      } catch {
        // A corrupt row is replaced by the next sample for that key.
      }
    }
    for (const r of db.prepare('SELECT session_id FROM context_baseline_sessions').all() as { session_id: string }[]) this.#seen.add(r.session_id);
    this.#untap = this.#o.bus.tap((ev) => this.#onEvent(ev));
  }

  close(): void {
    this.#untap?.();
    this.#untap = undefined;
    if (this.#db?.isOpen) this.#db.close();
    this.#db = undefined;
  }

  /** Baselines on this machine, optionally only one workspace's (a worktree answers with its repo's). */
  list(filter: { workspaceId?: string } = {}): ContextBaseline[] {
    const ws = filter.workspaceId !== undefined ? this.#root(filter.workspaceId) : undefined;
    const out: ContextBaseline[] = [];
    for (const e of this.#entries.values()) {
      if (ws !== undefined && e.workspaceId !== ws) continue;
      const b: ContextBaseline = {
        machineId: this.#o.machineId,
        agent: e.agent,
        tokens: median(e.samples.map((s) => s.tokens)),
        samples: e.samples.length,
        updatedAt: e.samples[e.samples.length - 1]!.at,
      };
      if (e.model) b.model = e.model;
      if (e.workspaceId) b.workspaceId = e.workspaceId;
      out.push(b);
    }
    return out.sort((a, b) => a.agent.localeCompare(b.agent) || (a.model ?? '').localeCompare(b.model ?? '') || (a.workspaceId ?? '').localeCompare(b.workspaceId ?? ''));
  }

  /**
   * Take a session's first context report as a sample. Later reports, forks and resumed sessions (which
   * start with history) are ignored. Returns true when the sample was recorded.
   */
  observe(session: SessionInfo, used: number): boolean {
    const db = this.#db;
    if (!db || this.#seen.has(session.id)) return false;
    this.#seen.add(session.id);
    db.prepare('INSERT OR IGNORE INTO context_baseline_sessions (session_id) VALUES (?)').run(session.id);
    if (session.mode !== 'structured' || session.forkedFrom || !(used > 0) || !Number.isFinite(used)) return false;
    const e0: Entry = { agent: session.agent, model: session.model ?? '', workspaceId: this.#root(session.workspaceId), samples: [] };
    const k = key(e0);
    const e = this.#entries.get(k) ?? e0;
    const at = this.#now().toISOString();
    e.samples = [...e.samples, { tokens: Math.round(used), at }].slice(-BASELINE_SAMPLES);
    this.#entries.set(k, e);
    db.prepare(
      `INSERT INTO context_baselines (agent, model, workspace_id, samples, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(agent, model, workspace_id) DO UPDATE SET samples = excluded.samples, updated_at = excluded.updated_at`,
    ).run(e.agent, e.model, e.workspaceId, JSON.stringify(e.samples), at);
    return true;
  }

  /** Drop the "already sampled" mark of a deleted session (keeps the table from growing forever). */
  forgetSession(sessionId: string): void {
    if (!this.#seen.delete(sessionId)) return;
    this.#db?.prepare('DELETE FROM context_baseline_sessions WHERE session_id = ?').run(sessionId);
  }

  #root(workspaceId: string): string {
    const w = this.#o.workspace(workspaceId);
    return w?.kind === 'worktree' && w.parentWorkspaceId ? w.parentWorkspaceId : workspaceId;
  }

  #onEvent(ev: ChannelEvent): void {
    if (ev.type === 'session.removed') {
      this.forgetSession(ev.data.sessionId);
      return;
    }
    if (ev.type === 'session.created') {
      // Created to resume an agent-native session (resumeRef) or as a fork: it starts with history.
      const s = ev.data.session;
      if (s.agentSessionRef || s.forkedFrom) this.observe(s, 0);
      return;
    }
    if (ev.type !== 'context.updated' || !ev.ch.startsWith('session:')) return;
    const id = ev.ch.slice('session:'.length);
    if (this.#seen.has(id)) return;
    const session = this.#o.session(id);
    if (!session) return;
    try {
      this.observe(session, ev.data.used);
    } catch (err) {
      this.#o.logger.log('warn', 'recording a context baseline failed', { sessionId: id, err });
    }
  }
}

function key(e: Pick<Entry, 'agent' | 'model' | 'workspaceId'>): string {
  return `${e.agent}\u0000${e.model}\u0000${e.workspaceId}`;
}

/** The core's built-in `baselines.list` handler, registered like an extension. */
export function baselinesExtension(tracker: BaselineTracker): NodeExtension {
  return {
    methods: {
      'baselines.list': (p: Params) => {
        const workspaceId = optString(p, 'workspaceId');
        return { baselines: tracker.list(workspaceId ? { workspaceId } : {}) };
      },
    },
    start: () => tracker.start(),
    stop: () => tracker.close(),
  };
}
