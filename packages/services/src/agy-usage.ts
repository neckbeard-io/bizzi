// agy per-login usage (docs/usage.md §3.2). agy runs in terminal mode, so no session stream carries its
// quota; instead the node asks `agy -p /usage --output-format json`, a read-only slash command that
// answers without starting a turn or spending quota, and reports the windows as an account snapshot.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccountUsage, Logger, UsageWindow } from '@bizzi/protocol';
import type { ExtensionContext, NodeExtension } from './types.ts';

/** Poll this often while an agy session is live on this node. */
export const AGY_USAGE_ACTIVE_MS = 3 * 60_000;
/** And this often otherwise (an idle login's windows only drain). */
export const AGY_USAGE_IDLE_MS = 15 * 60_000;

export type AgyRunner = (file: string, args: string[]) => Promise<string>;

export interface AgyUsageOptions {
  /** Runs agy and resolves its stdout; tests inject one. */
  run?: AgyRunner;
  /** ~/.gemini/google_accounts.json: the active Google account is the login's identity. */
  accountsFile?: string;
  activeIntervalMs?: number;
  idleIntervalMs?: number;
  /** Delay before the first poll after the node starts (default 5 s). */
  firstDelayMs?: number;
  now?: () => Date;
}

export interface AgyUsageExtension extends NodeExtension {
  /** Poll now; resolves to the reported snapshot (undefined when agy is missing or gave nothing). */
  poll(): Promise<AccountUsage | undefined>;
}

const defaultRun: AgyRunner = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { cwd: tmpdir(), timeout: 30_000, maxBuffer: 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

const WINDOW_MINS: Record<string, number> = { '5h': 300, weekly: 10080, daily: 1440 };
const WINDOW_LABEL: Record<string, string> = { '5h': '5h', weekly: 'weekly', daily: 'daily' };

interface Bucket {
  id?: unknown;
  name?: unknown;
  window?: unknown;
  remaining_fraction?: unknown;
  reset_time?: unknown;
}

/** "Gemini Models" → "Gemini", "Claude and GPT models" → "Claude and GPT". */
export function agyGroupName(name: string): string {
  return name.replace(/\s+models?$/i, '').trim() || name;
}

/** The `/usage` print-mode JSON → usage windows (used = 1 − remaining). Unknown shapes give []. */
export function parseAgyUsage(stdout: string): UsageWindow[] {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return [];
  }
  const groups = (doc as { command?: { data?: { groups?: unknown } } })?.command?.data?.groups;
  if (!Array.isArray(groups)) return [];
  const out: UsageWindow[] = [];
  for (const g of groups as { name?: unknown; buckets?: unknown }[]) {
    if (!g || !Array.isArray(g.buckets)) continue;
    const group = typeof g.name === 'string' && g.name ? agyGroupName(g.name) : undefined;
    for (const b of g.buckets as Bucket[]) {
      if (!b || typeof b.remaining_fraction !== 'number' || !Number.isFinite(b.remaining_fraction)) continue;
      const win = typeof b.window === 'string' ? b.window : '';
      const id = typeof b.id === 'string' && b.id ? b.id : `${group ?? 'agy'}-${win || out.length}`;
      const short = WINDOW_LABEL[win] ?? (typeof b.name === 'string' && b.name ? b.name : win || id);
      const used = Math.min(100, Math.max(0, (1 - b.remaining_fraction) * 100));
      const w: UsageWindow = { id, label: group ? `${group} · ${short}` : short, usedPercent: Math.round(used * 10) / 10 };
      if (typeof b.reset_time === 'string' && Number.isFinite(Date.parse(b.reset_time))) w.resetsAt = b.reset_time;
      if (WINDOW_MINS[win]) w.windowMins = WINDOW_MINS[win];
      if (group) w.group = group;
      out.push(w);
    }
  }
  return out;
}

/** Limited only when every pool is exhausted; one exhausted pool (the others still work) is a warning. */
export function agyStatus(windows: readonly UsageWindow[]): AccountUsage['status'] {
  const pools = new Map<string, boolean>();
  let near = false;
  for (const w of windows) {
    const key = w.group ?? '';
    pools.set(key, (pools.get(key) ?? false) || w.usedPercent >= 100);
    if (w.usedPercent >= 80) near = true;
  }
  if (pools.size === 0) return 'unknown';
  const exhausted = [...pools.values()].filter(Boolean).length;
  if (exhausted === pools.size) return 'limited';
  return exhausted > 0 || near ? 'warning' : 'ok';
}

async function activeAccount(file: string): Promise<string | undefined> {
  try {
    const doc = JSON.parse(await readFile(file, 'utf8')) as { active?: unknown };
    return typeof doc.active === 'string' && doc.active ? doc.active : undefined;
  } catch {
    return undefined;
  }
}

export function createAgyUsageExtension(opts: AgyUsageOptions = {}): AgyUsageExtension {
  const run = opts.run ?? defaultRun;
  const accountsFile = opts.accountsFile ?? join(homedir(), '.gemini', 'google_accounts.json');
  const now = opts.now ?? (() => new Date());
  let ctx: ExtensionContext | undefined;
  let log: Logger | undefined;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let running: Promise<AccountUsage | undefined> | undefined;
  let failures = 0;

  const agyLive = (): boolean => {
    try {
      return ctx!.node.sessions.list().some((s) => s.agent === 'agy' && s.status !== 'ended' && s.status !== 'failed');
    } catch {
      return false;
    }
  };

  const schedule = (ms: number): void => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => void ext.poll().finally(() => schedule(agyLive() ? (opts.activeIntervalMs ?? AGY_USAGE_ACTIVE_MS) : (opts.idleIntervalMs ?? AGY_USAGE_IDLE_MS))), ms);
    timer.unref();
  };

  const pollOnce = async (): Promise<AccountUsage | undefined> => {
    if (!ctx) return undefined;
    const probe = (await ctx.node.registry.list()).find((a) => a.agent === 'agy');
    if (!probe?.installed || !probe.path) return undefined;
    let stdout: string;
    try {
      stdout = await run(probe.path, ['-p', '/usage', '--output-format', 'json']);
    } catch (err) {
      // Exit 2 = an API-key login (no account quota) or not signed in; log once, then quietly.
      if (failures++ === 0) log?.log('info', 'agy usage unavailable', { err: String((err as Error).message ?? err).slice(0, 200) });
      return undefined;
    }
    const windows = parseAgyUsage(stdout);
    if (windows.length === 0) return undefined;
    failures = 0;
    const email = (await activeAccount(accountsFile)) ?? probe.account;
    const usage: AccountUsage = {
      agent: 'agy',
      accountId: email ?? 'default',
      label: `agy · google${email ? ` · ${email}` : ''}`,
      billing: 'plan',
      machines: [ctx.node.machine.id],
      windows,
      status: agyStatus(windows),
      observedAt: now().toISOString(),
    };
    ctx.node.usage.report(usage);
    return usage;
  };

  const ext: AgyUsageExtension = {
    methods: {},
    start(c) {
      ctx = c;
      log = c.logger.child({ component: 'agy-usage' });
      schedule(opts.firstDelayMs ?? 5_000);
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
    poll() {
      running ??= pollOnce()
        .catch((err) => {
          log?.log('warn', 'agy usage poll failed', { err: String(err) });
          return undefined;
        })
        .finally(() => {
          running = undefined;
        });
      return running;
    },
  };
  return ext;
}
