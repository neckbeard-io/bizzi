// Context occupancy and per-login usage (docs/usage.md §1, §3) from Claude Agent SDK data.

import { createHash } from 'node:crypto';
import type { AccountUsage, BillingClass, ContextCategory, ContextUsage, UsageWindow } from '@bizzi/protocol';
import type {
  AccountInfo,
  SDKControlGetContextUsageResponse,
  SDKControlGetUsageResponse,
  SDKRateLimitInfo,
} from '@anthropic-ai/claude-agent-sdk';

/** What bizzi injected into a session, for the "bizzi overhead" row. */
export interface BizziInjection {
  /** `StartSessionOptions.systemPromptAppend`. */
  systemPromptAppend?: string;
  /** Names of the MCP servers bizzi injected (`StartSessionOptions.mcpServers` keys). */
  mcpServers?: string[];
}

/** Approximate token count: UTF-8 bytes / 4. An approximation, not the model's tokenizer. */
export function approxTokens(text: string | undefined): number {
  return text ? Math.ceil(Buffer.byteLength(text, 'utf8') / 4) : 0;
}

/** Claude Code's MCP server-name normalization (as used in `mcp__<server>__<tool>` wire names). */
function normServer(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

type SdkCategory = SDKControlGetContextUsageResponse['categories'][number];

function categoryKind(c: SdkCategory): ContextCategory['kind'] {
  if (c.kind) return c.kind;
  if (c.isDeferred) return 'deferred';
  if (c.id === 'free_space') return 'free';
  if (c.id === 'autocompact_buffer' || c.id === 'compact_buffer') return 'buffer';
  return 'used';
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'other';
}

/**
 * `getContextUsage()` → `context.updated`. `used` is the CLI's own `totalTokens`. bizzi's share is
 * carved out of the rows it belongs to (system prompt, MCP tools, MCP instructions) so the stacked
 * breakdown still adds up: MCP figures are the CLI's own per-server counts, the system-prompt
 * append is approximated as bytes / 4.
 */
export function contextFromSdk(r: SDKControlGetContextUsageResponse, inj: BizziInjection = {}): ContextUsage | undefined {
  const window = r.rawMaxTokens || r.maxTokens;
  if (!window || typeof r.totalTokens !== 'number') return undefined;
  const ours = new Set((inj.mcpServers ?? []).map(normServer));
  const rawOurs = new Set(inj.mcpServers ?? []);
  let mcpTools = 0;
  let mcpToolsDeferred = 0;
  for (const t of r.mcpTools ?? []) {
    if (!ours.has(normServer(t.serverName))) continue;
    if (t.isLoaded === false) mcpToolsDeferred += t.tokens;
    else mcpTools += t.tokens;
  }
  let mcpInstr = 0;
  for (const i of r.mcpInstructions ?? []) if (rawOurs.has(i.serverName) || ours.has(normServer(i.serverName))) mcpInstr += i.tokens;
  let prompt = approxTokens(inj.systemPromptAppend);

  const categories: ContextCategory[] = [];
  let buffer = 0;
  let autocompact = false;
  for (const c of r.categories ?? []) {
    const kind = categoryKind(c);
    const id = c.id ?? slug(c.name);
    let tokens = c.tokens;
    // Carve bizzi's share out of the row it was counted in.
    const take = (n: number): number => {
      const t = Math.min(n, tokens);
      tokens -= t;
      return t;
    };
    if (id === 'system_prompt') prompt = take(prompt);
    else if (id === 'mcp_tools') mcpTools = take(mcpTools);
    else if (id === 'mcp_instructions') mcpInstr = take(mcpInstr);
    else if (id === 'mcp_tools_deferred') mcpToolsDeferred = take(mcpToolsDeferred);
    if (kind === 'buffer') {
      buffer += tokens;
      if (id === 'autocompact_buffer') autocompact = true;
    }
    if (tokens > 0 || kind === 'free') categories.push({ id, label: c.name, tokens, kind });
  }
  if (!r.categories?.length) {
    prompt = 0;
    mcpTools = 0;
    mcpInstr = 0;
    mcpToolsDeferred = 0;
  }
  const bizzi = prompt + mcpTools + mcpInstr;
  if (bizzi > 0) categories.push({ id: 'bizzi', label: 'bizzi overhead', tokens: bizzi, kind: 'used' });
  if (mcpToolsDeferred > 0) categories.push({ id: 'bizzi_deferred', label: 'bizzi overhead (deferred)', tokens: mcpToolsDeferred, kind: 'deferred' });

  const out: ContextUsage = { used: r.totalTokens, window };
  if (buffer > 0 && buffer < window) {
    out.usable = window - buffer;
    if (autocompact) out.compactAt = out.usable;
  }
  if (categories.length) out.categories = categories;
  return out;
}

// ---------------------------------------------------------------- accounts

export interface ClaudeAccount {
  accountId: string;
  label: string;
  billing: BillingClass;
}

/**
 * Identity of the logged-in account, from the CLI's `accountInfo()`: the email for claude.ai
 * subscription logins; for API keys (or a gateway token) a fingerprint of the key and base URL.
 * Anything else (no accountInfo, Bedrock/Vertex, an apiKeyHelper key bizzi can't see): undefined,
 * and nothing is emitted.
 */
export function claudeAccount(info: AccountInfo | undefined, keyFingerprint: string | undefined): ClaudeAccount | undefined {
  if (!info) return undefined;
  const provider = info.apiProvider;
  const firstParty = !provider || provider === 'firstParty';
  const sub = info.subscriptionType || undefined;
  const usesKey = !!info.apiKeySource && info.apiKeySource !== 'none';
  if (firstParty && sub && !usesKey && info.email) {
    return { accountId: info.email, label: `claude · ${sub} · ${info.email}`, billing: 'plan' };
  }
  if ((usesKey || provider === 'gateway') && keyFingerprint) {
    const via = provider && provider !== 'firstParty' ? provider : 'api key';
    return { accountId: keyFingerprint, label: `claude · ${via} · ${keyFingerprint.slice(4, 12)}`, billing: 'metered' };
  }
  return undefined;
}

/** Stable fingerprint of an API key (never the key itself): `key:` + 16 hex of sha256(baseUrl \0 key). */
export function keyFingerprint(env: Record<string, string | undefined>): string | undefined {
  const key = env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN;
  if (!key) return undefined;
  const base = env.ANTHROPIC_BASE_URL ?? '';
  return `key:${createHash('sha256').update(`${base}\0${key}`).digest('hex').slice(0, 16)}`;
}

const WINDOW_META: Record<string, { label: string; mins?: number }> = {
  five_hour: { label: '5h', mins: 300 },
  seven_day: { label: '7d', mins: 10080 },
  seven_day_opus: { label: '7d Opus', mins: 10080 },
  seven_day_sonnet: { label: '7d Sonnet', mins: 10080 },
  seven_day_oauth_apps: { label: '7d apps', mins: 10080 },
  seven_day_overage_included: { label: '7d (overage included)', mins: 10080 },
  overage: { label: 'extra usage' },
};

function window(id: string, usedPercent: number, resetsAt: string | undefined): UsageWindow {
  const meta = WINDOW_META[id];
  const w: UsageWindow = { id, label: meta?.label ?? id, usedPercent: Math.round(usedPercent * 10) / 10 };
  if (resetsAt) w.resetsAt = resetsAt;
  if (meta?.mins) w.windowMins = meta.mins;
  return w;
}

type WindowStatus = 'ok' | 'warning' | 'limited';

function statusOf(s: string | undefined): WindowStatus | undefined {
  return s === 'rejected' ? 'limited' : s === 'allowed_warning' ? 'warning' : s === 'allowed' ? 'ok' : undefined;
}

/** Rolling per-login state fed by `rate_limit_event` messages and the experimental usage query. */
export class PlanUsage {
  readonly #windows = new Map<string, { w: UsageWindow; status?: WindowStatus }>();
  #status: WindowStatus | undefined;

  /**
   * `rate_limit_event`. `utilization` is a fraction (the CLI renders `Math.round(utilization*100)%`)
   * and `resetsAt` is epoch seconds.
   */
  applyRateLimit(info: SDKRateLimitInfo): void {
    const status = statusOf(info.status);
    if (status) this.#status = status;
    const id = info.rateLimitType;
    if (!id) return;
    const prev = this.#windows.get(id);
    const resetsAt = typeof info.resetsAt === 'number' ? new Date(info.resetsAt * 1000).toISOString() : prev?.w.resetsAt;
    const used = typeof info.utilization === 'number' ? info.utilization * 100 : prev?.w.usedPercent;
    if (used === undefined) {
      if (status) this.#windows.set(id, { w: prev?.w ?? window(id, status === 'limited' ? 100 : 0, resetsAt), status });
      return;
    }
    this.#windows.set(id, { w: window(id, used, resetsAt), ...(status ? { status } : {}) });
  }

  /** The experimental `/usage` query's plan windows (`utilization` 0-100, `resets_at` ISO). */
  applyPlanQuery(r: SDKControlGetUsageResponse): boolean {
    if (!r.rate_limits_available || !r.rate_limits) return false;
    const rl = r.rate_limits;
    let any = false;
    for (const id of ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_oauth_apps'] as const) {
      const v = rl[id];
      if (!v || typeof v.utilization !== 'number') continue;
      const prev = this.#windows.get(id);
      this.#windows.set(id, { w: window(id, v.utilization, v.resets_at ?? undefined), ...(prev?.status ? { status: prev.status } : {}) });
      any = true;
    }
    for (const m of rl.model_scoped ?? []) {
      if (typeof m.utilization !== 'number') continue;
      const id = `model:${m.display_name}`;
      const w = window(id, m.utilization, m.resets_at ?? undefined);
      w.label = `7d ${m.display_name}`;
      w.windowMins = 10080;
      this.#windows.set(id, { w });
      any = true;
    }
    return any;
  }

  get empty(): boolean {
    return !this.#windows.size && !this.#status;
  }

  windows(): UsageWindow[] {
    return [...this.#windows.values()].map((v) => ({ ...v.w }));
  }

  status(now = Date.now()): AccountUsage['status'] {
    let worst: WindowStatus | undefined;
    const rank = { ok: 0, warning: 1, limited: 2 } as const;
    for (const { w, status } of this.#windows.values()) {
      if (w.resetsAt && Date.parse(w.resetsAt) <= now) continue; // window has reset since
      const s = status ?? (w.usedPercent >= 100 ? 'limited' : w.usedPercent >= 80 ? 'warning' : 'ok');
      if (!worst || rank[s] > rank[worst]) worst = s;
    }
    // Only a status-only event (no rateLimitType) speaks for the login as a whole.
    return worst ?? (this.#windows.size ? 'unknown' : (this.#status ?? 'unknown'));
  }
}

/** The experimental usage query, isolated: tolerates the method being renamed or removed. */
export async function readPlanUsage(q: object): Promise<SDKControlGetUsageResponse | undefined> {
  const fn = (q as Record<string, unknown>).usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
  if (typeof fn !== 'function') return undefined;
  try {
    const r = (await fn.call(q, { skipBehaviors: true })) as SDKControlGetUsageResponse | undefined;
    return r && typeof r === 'object' ? r : undefined;
  } catch {
    return undefined;
  }
}
