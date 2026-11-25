// Durable one-pane state (spec §11.2): routing rules and recorded decisions, in a SQLite database of the
// caller's (the hub's hub.db, a node's routing.db). The decisions are the labelled set for comparing
// classifiers: prompt → machine · workspace · agent, with what was offered and whether the user overrode it.

import type { DatabaseSync } from 'node:sqlite';
import { AGENT_KINDS, BizziError, ulid, type AgentKind, type RouteCandidate, type RouteDecision, type RouteDecisionInput, type RoutingRule } from '@bizzi/protocol';
import { parseRules } from './rules.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS route_decisions (
  id          TEXT PRIMARY KEY,
  at          TEXT NOT NULL,
  overridden  INTEGER NOT NULL,
  data        TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS route_rules (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  data        TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
`;

/** Oldest decisions are dropped beyond this many. */
export const MAX_DECISIONS = 10_000;
const MAX_TEXT = 4000;
const SOURCES: readonly RouteDecision['source'][] = ['explicit', 'single', 'classifier', 'none', 'rule'];
const VIAS: readonly RouteDecision['via'][] = ['suggested', 'picked', 'other'];

export class RouteStore {
  readonly #db: DatabaseSync;
  readonly #now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#now = now;
    db.exec(SCHEMA);
  }

  rules(): RoutingRule[] {
    const row = this.#db.prepare('SELECT data FROM route_rules WHERE id = 1').get() as { data: string } | undefined;
    if (!row) return [];
    try {
      // Re-validated so a hand-edited row can't break routing.
      return parseRules({ rules: JSON.parse(row.data) as unknown });
    } catch {
      return [];
    }
  }

  setRules(params: unknown): RoutingRule[] {
    const rules = parseRules(params);
    this.#db
      .prepare(
        `INSERT INTO route_rules (id, data, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify(rules), this.#now().toISOString());
    return rules;
  }

  record(params: unknown): RouteDecision {
    const input = parseDecision(params);
    // ULIDs sort by time, so ids page newest first.
    const decision: RouteDecision = { id: `rd_${ulid(this.#now().getTime())}`, at: this.#now().toISOString(), ...input };
    this.#db.prepare('INSERT INTO route_decisions (id, at, overridden, data) VALUES (?, ?, ?, ?)').run(decision.id, decision.at, decision.overridden ? 1 : 0, JSON.stringify(decision));
    this.#db.prepare(`DELETE FROM route_decisions WHERE id NOT IN (SELECT id FROM route_decisions ORDER BY id DESC LIMIT ${MAX_DECISIONS})`).run();
    return decision;
  }

  list(params: unknown = {}): { decisions: RouteDecision[]; total: number } {
    const p = (params && typeof params === 'object' ? params : {}) as { limit?: unknown; before?: unknown; overridden?: unknown };
    const limit = p.limit === undefined ? 100 : p.limit;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new BizziError('bad_request', 'limit must be an integer in [1, 1000]');
    if (p.before !== undefined && typeof p.before !== 'string') throw new BizziError('bad_request', 'before must be a decision id');
    if (p.overridden !== undefined && typeof p.overridden !== 'boolean') throw new BizziError('bad_request', 'overridden must be a boolean');
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (p.overridden !== undefined) {
      where.push('overridden = ?');
      args.push(p.overridden ? 1 : 0);
    }
    const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const { n } = this.#db.prepare(`SELECT COUNT(*) AS n FROM route_decisions ${filter}`).get(...args) as { n: number };
    if (p.before !== undefined) {
      where.push('id < ?');
      args.push(p.before);
    }
    const rows = this.#db.prepare(`SELECT data FROM route_decisions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`).all(...args, limit) as { data: string }[];
    return { decisions: rows.map((r) => JSON.parse(r.data) as RouteDecision), total: Number(n) };
  }
}

function str(v: unknown, name: string, max = 200): string {
  if (typeof v !== 'string' || v.length === 0 || v.length > max) throw new BizziError('bad_request', `${name} must be a non-empty string of at most ${max} characters`);
  return v;
}

function num01(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) throw new BizziError('bad_request', `${name} must be a number between 0 and 1`);
  return v;
}

function agentOf(v: unknown, name: string): AgentKind | undefined {
  if (v === undefined) return undefined;
  if (!(AGENT_KINDS as readonly unknown[]).includes(v)) throw new BizziError('bad_request', `${name} must be one of ${AGENT_KINDS.join(', ')}`);
  return v as AgentKind;
}

/** Validate `route.record` params; unknown fields are dropped. Throws bad_request. */
export function parseDecision(params: unknown): RouteDecisionInput {
  const d = params && typeof params === 'object' ? (params as { decision?: unknown }).decision : undefined;
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new BizziError('bad_request', 'decision must be an object');
  const o = d as Record<string, unknown>;
  const text = str(o.text, 'decision.text', MAX_TEXT);
  if (!SOURCES.includes(o.source as RouteDecision['source'])) throw new BizziError('bad_request', `decision.source must be one of ${SOURCES.join(', ')}`);
  if (!VIAS.includes(o.via as RouteDecision['via'])) throw new BizziError('bad_request', `decision.via must be one of ${VIAS.join(', ')}`);
  if (!Array.isArray(o.candidates) || o.candidates.length > 20) throw new BizziError('bad_request', 'decision.candidates must be an array of at most 20');
  const candidates: RouteCandidate[] = o.candidates.map((c, i) => {
    const x = (c ?? {}) as Record<string, unknown>;
    return {
      machineId: str(x.machineId, `decision.candidates[${i}].machineId`),
      workspaceId: str(x.workspaceId, `decision.candidates[${i}].workspaceId`),
      label: str(x.label, `decision.candidates[${i}].label`, 400),
      probability: num01(x.probability, `decision.candidates[${i}].probability`),
    };
  });
  const c = (o.chosen ?? {}) as Record<string, unknown>;
  const chosen: RouteDecision['chosen'] = { machineId: str(c.machineId, 'decision.chosen.machineId'), workspaceId: str(c.workspaceId, 'decision.chosen.workspaceId'), label: str(c.label, 'decision.chosen.label', 400) };
  const agent = agentOf(c.agent, 'decision.chosen.agent');
  if (agent) chosen.agent = agent;
  if (typeof o.overridden !== 'boolean') throw new BizziError('bad_request', 'decision.overridden must be a boolean');
  const out: RouteDecisionInput = {
    text,
    source: o.source as RouteDecision['source'],
    candidates,
    confidence: num01(o.confidence, 'decision.confidence'),
    chosen,
    via: o.via as RouteDecision['via'],
    overridden: o.overridden,
  };
  if (o.classifier !== undefined) {
    const k = (o.classifier ?? {}) as Record<string, unknown>;
    out.classifier = { model: str(k.model, 'decision.classifier.model') };
    if (k.via !== undefined) out.classifier.via = str(k.via, 'decision.classifier.via');
  }
  if (o.rule !== undefined) {
    const r = (o.rule ?? {}) as Record<string, unknown>;
    out.rule = { id: str(r.id, 'decision.rule.id', 64), label: str(r.label, 'decision.rule.label', 2000) };
  }
  if (o.sessionId !== undefined) out.sessionId = str(o.sessionId, 'decision.sessionId');
  return out;
}
