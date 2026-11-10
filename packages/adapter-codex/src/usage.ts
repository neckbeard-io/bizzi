// Context occupancy and per-login usage (docs/usage.md §1, §3) from codex app-server data.

import type { AccountUsage, ContextCategory, ContextUsage, UsageWindow } from '@bizzi/protocol';
import type { Account } from './generated/v2/Account.ts';
import type { GetAccountRateLimitsResponse } from './generated/v2/GetAccountRateLimitsResponse.ts';
import type { ListMcpServerStatusResponse } from './generated/v2/ListMcpServerStatusResponse.ts';
import type { RateLimitSnapshot } from './generated/v2/RateLimitSnapshot.ts';
import type { RateLimitWindow } from './generated/v2/RateLimitWindow.ts';
import type { ThreadTokenUsage } from './generated/v2/ThreadTokenUsage.ts';

/** Approximate token count: UTF-8 bytes / 4. An approximation, not the model's tokenizer. */
export function approxTokens(text: string | undefined): number {
  return text ? Math.ceil(Buffer.byteLength(text, 'utf8') / 4) : 0;
}

/** Approximate tokens of the tool schemas Codex reports for bizzi's MCP servers (name, description, input schema). */
export function mcpToolTokens(resp: ListMcpServerStatusResponse | undefined, servers: Set<string>): number {
  let n = 0;
  for (const s of resp?.data ?? []) {
    if (!servers.has(s.name)) continue;
    for (const t of Object.values(s.tools ?? {})) {
      if (!t) continue;
      n += approxTokens(JSON.stringify({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema }));
    }
  }
  return n;
}

/**
 * `ThreadTokenUsage` → `context.updated`. `used` is `last.totalTokens`, Codex's own figure for the
 * latest request (the whole window it sent plus its output), never a sum of turns. Codex reports
 * no breakdown, so the rows are only bizzi's estimate, the rest, and the free space.
 */
export function contextFromCodex(u: ThreadTokenUsage, window: number | undefined, opts: { bizziTokens?: number; compactAt?: number } = {}): ContextUsage | undefined {
  const win = u.modelContextWindow ?? window;
  if (!win || !u.last) return undefined;
  const used = u.last.totalTokens;
  const out: ContextUsage = { used, window: win };
  if (opts.compactAt && opts.compactAt > 0 && opts.compactAt < win) {
    out.compactAt = opts.compactAt;
    out.usable = opts.compactAt;
  }
  const bizzi = Math.min(opts.bizziTokens ?? 0, used);
  if (bizzi > 0) {
    const categories: ContextCategory[] = [
      { id: 'bizzi', label: 'bizzi overhead', tokens: bizzi, kind: 'used' },
      { id: 'other', label: 'Everything else', tokens: used - bizzi, kind: 'used' },
    ];
    if (win > used) categories.push({ id: 'free_space', label: 'Free space', tokens: win - used, kind: 'free' });
    out.categories = categories;
  }
  return out;
}

// ---------------------------------------------------------------- accounts

export interface CodexAccount {
  accountId: string;
  email?: string;
  planType?: string;
}

/** ChatGPT logins only: API-key, Bedrock and GCP logins expose no windows or spend through app-server. */
export function codexAccount(a: Account | null | undefined): CodexAccount | undefined {
  if (!a || a.type !== 'chatgpt') return undefined;
  const out: CodexAccount = { accountId: a.email ?? '' };
  if (a.email) out.email = a.email;
  if (a.planType && a.planType !== 'unknown') out.planType = a.planType;
  return out;
}

/** Epoch seconds (Codex's unit) → ISO; tolerates milliseconds. */
function isoFrom(t: number | null | undefined): string | undefined {
  if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0) return undefined;
  return new Date(t > 1e12 ? t : t * 1000).toISOString();
}

function windowLabel(mins: number | null | undefined, fallback: string): string {
  if (!mins) return fallback;
  if (mins % 1440 === 0) return `${mins / 1440}d`;
  if (mins % 60 === 0) return `${mins / 60}h`;
  return `${mins}m`;
}

function toWindow(id: 'primary' | 'secondary', w: RateLimitWindow): UsageWindow {
  const out: UsageWindow = { id, label: windowLabel(w.windowDurationMins, id), usedPercent: Math.round(w.usedPercent * 10) / 10 };
  const resetsAt = isoFrom(w.resetsAt);
  if (resetsAt) out.resetsAt = resetsAt;
  if (w.windowDurationMins) out.windowMins = w.windowDurationMins;
  return out;
}

/** The latest rate-limit snapshot, merged from `account/rateLimits/read` and sparse `account/rateLimits/updated`. */
export class CodexRateLimits {
  #snap: RateLimitSnapshot | undefined;
  #ordinaryAllowed: boolean | null = null;
  #accountId: string | null = null;

  applyRead(r: GetAccountRateLimitsResponse): void {
    this.#snap = r.rateLimits ? { ...r.rateLimits } : this.#snap;
    this.#ordinaryAllowed = r.ordinaryUsageAllowed;
    if (r.accountId) this.#accountId = r.accountId;
  }

  /** Sparse update: non-null values replace; nulls never clear what was observed. */
  applyUpdate(s: RateLimitSnapshot): void {
    const prev = this.#snap;
    if (prev && s.limitId && prev.limitId && s.limitId !== prev.limitId) return; // another bucket
    if (!prev) {
      this.#snap = { ...s };
      return;
    }
    const next: RateLimitSnapshot = { ...prev };
    for (const k of Object.keys(s) as (keyof RateLimitSnapshot)[]) {
      if (s[k] !== null && s[k] !== undefined) (next as Record<string, unknown>)[k] = s[k];
    }
    // A reached type is only meaningful while it's reported; an update with windows but no reached type clears it.
    if ((s.primary || s.secondary) && s.rateLimitReachedType === null) next.rateLimitReachedType = null;
    this.#snap = next;
  }

  get known(): boolean {
    return !!this.#snap;
  }

  get accountId(): string | null {
    return this.#accountId;
  }

  get planType(): string | undefined {
    const p = this.#snap?.planType;
    return p && p !== 'unknown' ? p : undefined;
  }

  windows(): UsageWindow[] {
    const s = this.#snap;
    const out: UsageWindow[] = [];
    if (s?.primary) out.push(toWindow('primary', s.primary));
    if (s?.secondary) out.push(toWindow('secondary', s.secondary));
    return out;
  }

  status(now = Date.now()): AccountUsage['status'] {
    const s = this.#snap;
    if (!s) return 'unknown';
    if (s.rateLimitReachedType || s.spendControlReached === true || this.#ordinaryAllowed === false) return 'limited';
    let max: number | undefined;
    for (const w of this.windows()) {
      if (w.resetsAt && Date.parse(w.resetsAt) <= now) continue;
      max = Math.max(max ?? 0, w.usedPercent);
    }
    if (max === undefined) return 'unknown';
    return max >= 100 ? 'limited' : max >= 80 ? 'warning' : 'ok';
  }
}
