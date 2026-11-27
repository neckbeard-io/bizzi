// Per-login usage (docs/usage.md §3): the node keeps the latest snapshot per (agent, accountId), fed by
// the `account.usage` session events adapters emit and by node extensions (billing widgets), persists
// it next to the event log, republishes it on the global channel and serves `usage.list`.

import { DatabaseSync } from 'node:sqlite';
import {
  AGENT_KINDS,
  GLOBAL_CHANNEL,
  type AccountUsage,
  type AgentKind,
  type BillingClass,
  type ChannelEvent,
  type Logger,
  type UsageWindow,
} from '@bizzi/protocol';
import type { EventBus } from './bus.ts';
import type { NodeExtension } from './node.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS account_usage (
  agent       TEXT NOT NULL,
  account_id  TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  data        TEXT NOT NULL,
  PRIMARY KEY (agent, account_id)
);
`;

const BILLING: readonly BillingClass[] = ['metered', 'plan', 'budgetless'];
const STATUS: readonly AccountUsage['status'][] = ['ok', 'warning', 'limited', 'unknown'];
const MAX_TEXT = 500;
const MAX_WINDOWS = 32;

/** An unchanged snapshot is republished at most this often (it only refreshes `observedAt`). */
export const USAGE_REPUBLISH_MS = 60_000;

export function usageKey(u: Pick<AccountUsage, 'agent' | 'accountId'>): string {
  return `${u.agent}\u0000${u.accountId}`;
}

function str(v: unknown, max = MAX_TEXT): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v.slice(0, max) : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function iso(v: unknown): string | undefined {
  const s = str(v, 64);
  return s !== undefined && Number.isFinite(Date.parse(s)) ? s : undefined;
}

/**
 * Validate an untrusted snapshot and copy only the protocol's fields. Returns undefined when the
 * identity (agent, accountId) or billing class is missing. A missing or unparseable `observedAt`
 * becomes `now` (the time bizzi observed it).
 */
export function normalizeAccountUsage(raw: unknown, now: Date = new Date()): AccountUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const agent = r.agent as AgentKind;
  if (!AGENT_KINDS.includes(agent)) return undefined;
  const accountId = str(r.accountId, 256);
  if (!accountId) return undefined;
  const billing = r.billing as BillingClass;
  if (!BILLING.includes(billing)) return undefined;
  const out: AccountUsage = {
    agent,
    accountId,
    label: str(r.label) ?? `${agent} · ${accountId}`,
    billing,
    machines: Array.isArray(r.machines) ? [...new Set(r.machines.filter((m): m is string => typeof m === 'string' && m.length > 0))].sort() : [],
    status: STATUS.includes(r.status as AccountUsage['status']) ? (r.status as AccountUsage['status']) : 'unknown',
    observedAt: iso(r.observedAt) ?? now.toISOString(),
  };
  if (Array.isArray(r.windows)) {
    const windows: UsageWindow[] = [];
    for (const w of r.windows.slice(0, MAX_WINDOWS)) {
      if (!w || typeof w !== 'object') continue;
      const ww = w as Record<string, unknown>;
      const id = str(ww.id, 64);
      const usedPercent = num(ww.usedPercent);
      if (!id || usedPercent === undefined) continue;
      const win: UsageWindow = { id, label: str(ww.label, 64) ?? id, usedPercent };
      const resetsAt = iso(ww.resetsAt);
      const windowMins = num(ww.windowMins);
      if (resetsAt) win.resetsAt = resetsAt;
      if (windowMins !== undefined) win.windowMins = windowMins;
      const group = str(ww.group, 64);
      if (group) win.group = group;
      windows.push(win);
    }
    out.windows = windows;
  }
  if (r.spend && typeof r.spend === 'object') {
    const s = r.spend as Record<string, unknown>;
    const usd = num(s.usd);
    if (usd !== undefined) {
      const spend: NonNullable<AccountUsage['spend']> = { usd };
      const capUsd = num(s.capUsd);
      const period = str(s.period, 64);
      const resetsAt = iso(s.resetsAt);
      if (capUsd !== undefined) spend.capUsd = capUsd;
      if (period) spend.period = period;
      if (resetsAt) spend.resetsAt = resetsAt;
      out.spend = spend;
    }
  }
  return out;
}

/** True when `a` was observed after `b` (ties go to `a`, the later report). */
export function newerOrSame(a: AccountUsage, b: AccountUsage): boolean {
  return Date.parse(a.observedAt) >= Date.parse(b.observedAt);
}

/**
 * Merge snapshots of one login seen on several machines: the newest observation wins, `machines` is the
 * union of every snapshot's machines (usage.md §3.1).
 */
export function mergeAccountUsage(snapshots: readonly AccountUsage[]): AccountUsage | undefined {
  let newest: AccountUsage | undefined;
  const machines = new Set<string>();
  for (const s of snapshots) {
    for (const m of s.machines) machines.add(m);
    if (!newest || newerOrSame(s, newest)) newest = s;
  }
  return newest ? { ...newest, machines: [...machines].sort() } : undefined;
}

/** Most constrained first: limited, warning, ok, unknown; then by highest window use; then by label. */
export function sortAccountUsage(list: AccountUsage[]): AccountUsage[] {
  const rank: Record<AccountUsage['status'], number> = { limited: 0, warning: 1, ok: 2, unknown: 3 };
  const peak = (u: AccountUsage) =>
    Math.max(
      ...(u.windows ?? []).map((w) => w.usedPercent),
      u.spend?.capUsd ? (100 * u.spend.usd) / u.spend.capUsd : 0,
      0,
    );
  return list.sort((a, b) => rank[a.status] - rank[b.status] || peak(b) - peak(a) || a.label.localeCompare(b.label));
}

export interface UsageTrackerOptions {
  /** SQLite file to keep snapshots in (the node's node.db; a separate connection and table). */
  dbPath: string;
  bus: EventBus;
  machineId: string;
  logger: Logger;
  now?: () => Date;
  /** Default USAGE_REPUBLISH_MS. */
  republishMs?: number;
}

interface Entry {
  usage: AccountUsage;
  /** JSON of the snapshot without observedAt, to skip republishing unchanged values. */
  sig: string;
  publishedAt: number;
}

function signature(u: AccountUsage): string {
  const { observedAt: _observedAt, ...rest } = u;
  return JSON.stringify(rest);
}

export class UsageTracker {
  readonly #o: UsageTrackerOptions;
  readonly #now: () => Date;
  readonly #entries = new Map<string, Entry>();
  #db?: DatabaseSync;
  #untap?: () => void;

  constructor(o: UsageTrackerOptions) {
    this.#o = o;
    this.#now = o.now ?? (() => new Date());
  }

  /** Open the table, load persisted snapshots and start watching session channels. Idempotent. */
  start(): void {
    if (this.#db) return;
    const db = new DatabaseSync(this.#o.dbPath);
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec(SCHEMA);
    this.#db = db;
    for (const row of db.prepare('SELECT data FROM account_usage').all() as { data: string }[]) {
      try {
        const u = normalizeAccountUsage(JSON.parse(row.data));
        if (u) this.#entries.set(usageKey(u), { usage: u, sig: signature(u), publishedAt: 0 });
      } catch {
        // A corrupt row is dropped on the next report for that login.
      }
    }
    this.#untap = this.#o.bus.tap((ev) => this.#onEvent(ev));
  }

  close(): void {
    this.#untap?.();
    this.#untap = undefined;
    if (this.#db?.isOpen) this.#db.close();
    this.#db = undefined;
  }

  /** Latest snapshot per login, most constrained first. */
  list(): AccountUsage[] {
    return sortAccountUsage([...this.#entries.values()].map((e) => ({ ...e.usage })));
  }

  get(agent: AgentKind, accountId: string): AccountUsage | undefined {
    return this.#entries.get(usageKey({ agent, accountId }))?.usage;
  }

  /**
   * Record a snapshot observed on this machine. Older observations than the stored one are ignored.
   * Returns the stored snapshot, or undefined when the input was invalid or the tracker is closed.
   */
  report(raw: unknown): AccountUsage | undefined {
    const db = this.#db;
    if (!db) return undefined;
    const now = this.#now();
    const u = normalizeAccountUsage(raw, now);
    if (!u) {
      this.#o.logger.log('debug', 'ignoring invalid account usage snapshot');
      return undefined;
    }
    u.machines = [this.#o.machineId];
    const key = usageKey(u);
    const prev = this.#entries.get(key);
    if (prev && !newerOrSame(u, prev.usage)) return prev.usage;
    db.prepare(
      `INSERT INTO account_usage (agent, account_id, observed_at, data) VALUES (?, ?, ?, ?)
       ON CONFLICT(agent, account_id) DO UPDATE SET observed_at = excluded.observed_at, data = excluded.data`,
    ).run(u.agent, u.accountId, u.observedAt, JSON.stringify(u));
    const sig = signature(u);
    const t = now.getTime();
    const republish = !prev || prev.sig !== sig || t - prev.publishedAt >= (this.#o.republishMs ?? USAGE_REPUBLISH_MS);
    this.#entries.set(key, { usage: u, sig, publishedAt: republish ? t : prev.publishedAt });
    if (republish) this.#o.bus.append(GLOBAL_CHANNEL, { type: 'account.usage', data: { usage: u } });
    return u;
  }

  #onEvent(ev: ChannelEvent): void {
    if (ev.type !== 'account.usage' || !ev.ch.startsWith('session:')) return;
    this.report(ev.data);
  }
}

/** The core's built-in `usage.list` handler, registered like an extension. */
export function usageExtension(tracker: UsageTracker): NodeExtension {
  return {
    methods: { 'usage.list': () => ({ accounts: tracker.list() }) },
    start: () => tracker.start(),
    stop: () => tracker.close(),
  };
}
