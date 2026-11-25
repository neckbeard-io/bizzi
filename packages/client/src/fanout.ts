// Fan-out (spec §12): N sessions on the same task, each in its own worktree, tied together by
// SessionInfo.group; the preflight shown before starting them (docs/usage.md §2); the compare view's
// model. Pure helpers plus `startFanout`, which only uses public store methods. No UI dependencies.

import { BizziError, PIPELINE_ID_PREFIX } from '@bizzi/protocol';
import type {
  AccountUsage,
  AgentKind,
  AgentListing,
  BillingClass,
  ContextBaseline,
  SessionBudget,
  SessionInfo,
  UsageWindow,
  WidgetValue,
  WorkspaceInfo,
} from '@bizzi/protocol';
import { sessionMarkState, type MarkState } from './sidebar.ts';
import type { BizziState, BizziStore } from './store.ts';
import type { FileChange, MessageItem } from './timeline.ts';
import { contextView, primaryWindow } from './usage.ts';

// ---------------------------------------------------------------- prices (estimates only)

/**
 * A model's list price in USD per million tokens. Built into bizzi for the preflight's estimate only:
 * it is never used for budgets (those count what the agent reports) and it goes stale.
 */
export interface ModelPrice {
  /** What the price is for, e.g. "Claude Opus 5.5". */
  label: string;
  inputPerMTok: number;
  outputPerMTok: number;
}

/** Where the built-in prices come from, shown next to every estimate. */
export const PRICE_TABLE_NOTE = 'Anthropic list prices as of 2026-10; an estimate, not a bill';

interface PriceRule {
  test: RegExp;
  price: ModelPrice;
}

// First match wins, so specific versions come before the bare aliases (which Claude Code maps to the
// current generation). Models without a rule have no estimate; bizzi doesn't guess prices.
const PRICE_RULES: readonly PriceRule[] = [
  { test: /fable/, price: { label: 'Claude Fable 5.1', inputPerMTok: 10, outputPerMTok: 50 } },
  { test: /opus-5-5|opus-5\.5/, price: { label: 'Claude Opus 5.5', inputPerMTok: 4, outputPerMTok: 20 } },
  { test: /opus-(5|4-[678])\b|opus-(5|4\.[678])\b/, price: { label: 'Claude Opus 5 / 4.x', inputPerMTok: 5, outputPerMTok: 25 } },
  { test: /opus/, price: { label: 'Claude Opus 5.5', inputPerMTok: 4, outputPerMTok: 20 } },
  { test: /sonnet-4-6|sonnet-4\.6/, price: { label: 'Claude Sonnet 4.6', inputPerMTok: 3, outputPerMTok: 15 } },
  { test: /sonnet/, price: { label: 'Claude Sonnet 5.5', inputPerMTok: 2, outputPerMTok: 10 } },
  { test: /haiku-4-5|haiku-4\.5/, price: { label: 'Claude Haiku 4.5', inputPerMTok: 1, outputPerMTok: 5 } },
  { test: /haiku/, price: { label: 'Claude Haiku 5.5', inputPerMTok: 0.1, outputPerMTok: 0.5 } },
];

/** The built-in price for a model name ("opus", "claude-sonnet-5-5", …), or null when unknown. */
export function modelPrice(model: string | undefined): ModelPrice | null {
  if (!model) return null;
  const m = model.toLowerCase();
  return PRICE_RULES.find((r) => r.test.test(m))?.price ?? null;
}

// ---------------------------------------------------------------- baselines

/**
 * The baseline for a run: the same agent and model in this workspace (a worktree uses its repo's); without
 * a model, the agent's best-sampled baseline there. Falls back to the same agent and model in another
 * workspace on the machine (`elsewhere`). Null when bizzi hasn't seen this agent start yet.
 */
export function findBaseline(
  baselines: readonly ContextBaseline[],
  q: { machineId: string; workspaceId: string; agent: AgentKind; model?: string | undefined },
): { baseline: ContextBaseline; elsewhere: boolean } | null {
  const mine = baselines.filter((b) => b.machineId === q.machineId && b.agent === q.agent && (!q.model || b.model === q.model));
  const best = (list: ContextBaseline[]): ContextBaseline | undefined => [...list].sort((a, b) => b.samples - a.samples || b.updatedAt.localeCompare(a.updatedAt))[0];
  const here = best(mine.filter((b) => b.workspaceId === q.workspaceId));
  if (here) return { baseline: here, elsewhere: false };
  const other = best(mine);
  return other ? { baseline: other, elsewhere: true } : null;
}

/** `baselines.list` for one machine (and workspace); [] from servers without the method. */
export async function loadBaselines(store: Pick<BizziStore, 'client'>, machineId: string, workspaceId?: string): Promise<ContextBaseline[]> {
  try {
    const params: { machineId: string; workspaceId?: string } = { machineId };
    if (workspaceId) params.workspaceId = workspaceId;
    const { baselines } = await store.client.request('baselines.list', params);
    return baselines;
  } catch (e) {
    if (e instanceof BizziError && (e.code === 'unsupported' || e.code === 'machine_offline')) return [];
    throw e;
  }
}

// ---------------------------------------------------------------- preflight (usage.md §2)

export interface FanoutRunSpec {
  agent: AgentKind;
  /** Empty or undefined: the agent's default. */
  model?: string;
  /** Optional metered spend cap for this run (session budget.usd). */
  budgetUsd?: number;
}

export type RunEstimate =
  /** Metered: input at the baseline × the built-in price, for one turn. */
  | { kind: 'metered'; usdPerTurn: number; price: ModelPrice }
  /** Metered, but no baseline yet or no price for the model. */
  | { kind: 'metered-unknown'; reason: string }
  /** Budgetless: free; the gateway's load when a widget reports it. */
  | { kind: 'free'; load: WidgetValue | null }
  /** Plan: the login's most constrained window. */
  | { kind: 'plan'; account: AccountUsage | null; window: UsageWindow | null }
  | { kind: 'unknown' };

export interface RunPreflight {
  billing: BillingClass | null;
  /** Where `billing` came from: the machine's agent probe, or a per-login usage snapshot. */
  billingSource: 'probe' | 'account' | null;
  baseline: ContextBaseline | null;
  /** The baseline comes from another workspace on the machine. */
  baselineElsewhere: boolean;
  estimate: RunEstimate;
  warnings: string[];
  /** A budgetless alternative to swap to in one click, when one is installed and this run isn't one. */
  swap: FanoutRunSpec | null;
}

export interface PreflightContext {
  machineId: string;
  /** The repo workspace the fan-out starts from. */
  workspaceId: string;
  agents: readonly AgentListing[];
  accounts: readonly AccountUsage[];
  baselines: readonly ContextBaseline[];
  widgets: readonly WidgetValue[];
  /** The machine's / workspace's effective `treeBudgetUsd`, when set. Each run is a tree root. */
  treeBudgetUsd?: number;
}

const GATEWAY_RE = /gateway|gpu|h[12]00|b[23]00|vllm|bifrost|queue|in-flight|inflight/i;

/** A widget reporting budgetless gateway load: this machine's first, then any. */
export function gatewayLoadWidget(widgets: readonly WidgetValue[], machineId: string): WidgetValue | null {
  const match = (w: WidgetValue): boolean => w.kind === 'meter' && GATEWAY_RE.test(`${w.id} ${w.label} ${w.tooltip ?? ''}`);
  return widgets.find((w) => w.machineId === machineId && match(w)) ?? widgets.find(match) ?? null;
}

/** The login of an agent as seen on a machine (a snapshot listing the machine first, then any). */
export function accountFor(accounts: readonly AccountUsage[], agent: AgentKind, machineId: string): AccountUsage | null {
  const own = accounts.filter((a) => a.agent === agent);
  return own.find((a) => a.machines.includes(machineId)) ?? own[0] ?? null;
}

/** Installed, supported agents whose login is budgetless (spec §12.3): candidates for the swap. */
export function budgetlessAgents(agents: readonly AgentListing[]): AgentListing[] {
  return agents.filter((a) => a.installed && a.billing === 'budgetless' && a.support !== 'unsupported' && a.agent !== 'shell');
}

export function preflightRun(spec: FanoutRunSpec, ctx: PreflightContext): RunPreflight {
  const listing = ctx.agents.find((a) => a.agent === spec.agent);
  const account = accountFor(ctx.accounts, spec.agent, ctx.machineId);
  const billing: BillingClass | null = listing?.billing ?? account?.billing ?? null;
  const billingSource = listing?.billing ? 'probe' : account?.billing ? 'account' : null;
  const model = spec.model?.trim() || undefined;
  const found = findBaseline(ctx.baselines, { machineId: ctx.machineId, workspaceId: ctx.workspaceId, agent: spec.agent, model });
  const baseline = found?.baseline ?? null;
  const warnings: string[] = [];

  if (!listing?.installed) warnings.push(`${spec.agent} is not installed on this machine`);
  else {
    if (listing.support === 'unsupported') warnings.push(listing.supportReason ?? `${spec.agent} ${listing.version ?? ''} is not supported`.trim());
    if (listing.auth !== 'ok') warnings.push(`${spec.agent} login: ${listing.auth}`);
  }

  let estimate: RunEstimate;
  switch (billing) {
    case 'metered': {
      const price = modelPrice(model ?? baseline?.model);
      if (!baseline) estimate = { kind: 'metered-unknown', reason: 'no baseline yet' };
      else if (!price) estimate = { kind: 'metered-unknown', reason: `no built-in price for ${model ?? baseline.model ?? 'the default model'}` };
      else {
        const usdPerTurn = (baseline.tokens * price.inputPerMTok) / 1_000_000;
        estimate = { kind: 'metered', usdPerTurn, price };
        if (ctx.treeBudgetUsd !== undefined && usdPerTurn > ctx.treeBudgetUsd) warnings.push(`estimated ${formatUsd(usdPerTurn)} per turn exceeds the tree budget of ${formatUsd(ctx.treeBudgetUsd)}`);
        if (spec.budgetUsd !== undefined && usdPerTurn > spec.budgetUsd) warnings.push(`estimated ${formatUsd(usdPerTurn)} per turn exceeds this run's budget of ${formatUsd(spec.budgetUsd)}`);
      }
      break;
    }
    case 'budgetless':
      estimate = { kind: 'free', load: gatewayLoadWidget(ctx.widgets, ctx.machineId) };
      break;
    case 'plan': {
      const plan = account?.billing === 'plan' ? account : null;
      const window = plan ? primaryWindow(plan) : null;
      estimate = { kind: 'plan', account: plan, window };
      if (plan?.status === 'limited') warnings.push(`${plan.label} is rate-limited`);
      else if (window && window.usedPercent > 80) warnings.push(`${plan?.label ?? spec.agent} ${window.label} window at ${Math.round(window.usedPercent)}%`);
      break;
    }
    default:
      estimate = { kind: 'unknown' };
  }

  let swap: FanoutRunSpec | null = null;
  if (billing !== 'budgetless') {
    const alt = budgetlessAgents(ctx.agents)[0];
    if (alt) {
      swap = { agent: alt.agent };
      const known = findBaseline(ctx.baselines, { machineId: ctx.machineId, workspaceId: ctx.workspaceId, agent: alt.agent });
      if (known?.baseline.model) swap.model = known.baseline.model;
    }
  }

  return { billing, billingSource, baseline, baselineElsewhere: found?.elsewhere ?? false, estimate, warnings, swap };
}

/** Sum of the metered per-turn estimates; `partial` when some metered run has no estimate. */
export function preflightTotal(runs: readonly RunPreflight[]): { usdPerTurn: number; partial: boolean } {
  let usdPerTurn = 0;
  let partial = false;
  for (const r of runs) {
    if (r.estimate.kind === 'metered') usdPerTurn += r.estimate.usdPerTurn;
    else if (r.estimate.kind === 'metered-unknown') partial = true;
  }
  return { usdPerTurn, partial };
}

export function formatUsd(n: number): string {
  if (n === 0) return '$0';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

/** "14k", "1.2M", "850" */
export function formatTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

// ---------------------------------------------------------------- starting a fan-out

/** A new group id, e.g. "fo_m3k9x2a7". */
export function newGroupId(): string {
  return `fo_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Default branch prefix: "<base>-fanout" (base = the repo's current branch, or "fanout" alone). */
export function defaultBranchPrefix(baseBranch: string | undefined): string {
  return baseBranch ? `${baseBranch}-fanout` : 'fanout';
}

/** "<prefix>-<n>-<agent>", n from 1. */
export function fanoutBranch(prefix: string, n: number, agent: AgentKind): string {
  return `${prefix.replace(/[-/]+$/, '')}-${n}-${agent}`;
}

export interface FanoutPlan {
  /** The repo (or worktree) workspace to branch from. */
  workspaceId: string;
  prompt: string;
  runs: FanoutRunSpec[];
  branchPrefix: string;
  /** Base for the new branches (default HEAD). */
  base?: string;
  /** Default: newGroupId(). */
  group?: string;
  /** Session title; default: the prompt's first line. */
  title?: string;
}

export interface FanoutRunResult {
  index: number;
  spec: FanoutRunSpec;
  branch: string;
  workspace?: WorkspaceInfo;
  session?: SessionInfo;
  error?: string;
}

/**
 * Create one worktree and one session per run, tagged with the group, and send each the prompt. Runs are
 * independent: one failing (branch exists, agent missing) doesn't stop the others.
 */
export async function startFanout(store: Pick<BizziStore, 'createWorktree' | 'createSession' | 'send'>, plan: FanoutPlan): Promise<{ group: string; runs: FanoutRunResult[] }> {
  const group = plan.group ?? newGroupId();
  const title = plan.title?.trim() || firstLine(plan.prompt);
  const runs = await Promise.all(
    plan.runs.map(async (spec, i): Promise<FanoutRunResult> => {
      const branch = fanoutBranch(plan.branchPrefix, i + 1, spec.agent);
      const out: FanoutRunResult = { index: i, spec, branch };
      try {
        const wt: Parameters<typeof store.createWorktree>[0] = { workspaceId: plan.workspaceId, branch };
        if (plan.base) wt.base = plan.base;
        out.workspace = await store.createWorktree(wt);
        const params: Parameters<typeof store.createSession>[0] = { workspaceId: out.workspace.id, agent: spec.agent, mode: 'structured', group, title: `${title} · ${i + 1}/${plan.runs.length}` };
        const model = spec.model?.trim();
        if (model) params.model = model;
        if (spec.budgetUsd !== undefined && spec.budgetUsd > 0) params.budget = { usd: spec.budgetUsd } satisfies SessionBudget;
        out.session = await store.createSession(params);
        await store.send(out.session.id, plan.prompt);
      } catch (e) {
        out.error = e instanceof Error ? e.message : String(e);
      }
      return out;
    }),
  );
  return { group, runs };
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 60 ? `${line.slice(0, 57)}…` : line || 'Fan-out';
}

// ---------------------------------------------------------------- groups and the compare view

export interface FanoutGroupSummary {
  group: string;
  title: string;
  workspaceId: string;
  sessions: SessionInfo[];
  /** Newest session start in the group. */
  createdAt: string;
}

/** Fan-out groups (sessions sharing `group`), newest first; optionally only those started from a workspace. */
export function selectFanoutGroups(s: BizziState, repoWorkspaceId?: string): FanoutGroupSummary[] {
  const by = new Map<string, SessionInfo[]>();
  for (const x of Object.values(s.sessions)) {
    // Pipeline stages share their pipeline's id as group; they have their own view (docs/pipelines.md).
    if (!x.group || x.group.startsWith(PIPELINE_ID_PREFIX)) continue;
    const l = by.get(x.group);
    if (l) l.push(x);
    else by.set(x.group, [x]);
  }
  const out: FanoutGroupSummary[] = [];
  for (const [group, list] of by) {
    list.sort(byCreatedThenTitle);
    const first = list[0]!;
    const ws = s.workspaces?.[first.workspaceId];
    const root = ws?.parentWorkspaceId ?? first.workspaceId;
    if (repoWorkspaceId !== undefined && root !== repoWorkspaceId) continue;
    out.push({ group, title: groupTitle(first.title), workspaceId: root, sessions: list, createdAt: list[list.length - 1]!.createdAt });
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function fanoutGroupsEqual(a: FanoutGroupSummary[], b: FanoutGroupSummary[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((g, i) => {
    const h = b[i]!;
    return g.group === h.group && g.sessions.length === h.sessions.length && g.sessions.every((x, j) => x === h.sessions[j]);
  });
}

export interface FanoutRunModel {
  session: SessionInfo;
  workspace: WorkspaceInfo | null;
  branch?: string;
  state: MarkState | 'ended';
  model?: string;
  billing?: BillingClass;
  /** The last assistant message (streaming text included). */
  finalMessage: string | null;
  /** Files the session changed (from `file.changed`), by path. */
  files: FileChange[];
  tokens?: number;
  /** Spend that counts (metered billing only). */
  meteredUsd?: number;
  /** used / usable, 0..1, when reported. */
  context?: number;
  contextLabel?: string;
}

export interface FanoutGroupModel {
  group: string;
  title: string;
  workspaceId: string;
  runs: FanoutRunModel[];
  /** Metered spend across runs (spec §12.3: only metered counts). */
  meteredUsd: number;
  tokens: number;
}

export function selectFanoutGroup(s: BizziState, group: string): FanoutGroupModel | null {
  const summary = selectFanoutGroups(s).find((g) => g.group === group);
  if (!summary) return null;
  let meteredUsd = 0;
  let tokens = 0;
  const runs = summary.sessions.map((session): FanoutRunModel => {
    const tl = s.timelines[session.id];
    const workspace = s.workspaces?.[session.workspaceId] ?? null;
    const run: FanoutRunModel = { session, workspace, state: sessionMarkState(s, session) ?? 'ended', finalMessage: null, files: [] };
    if (workspace?.branch) run.branch = workspace.branch;
    const model = tl?.info.model ?? session.model;
    if (model) run.model = model;
    if (session.billing) run.billing = session.billing;
    if (tl) {
      for (let i = tl.order.length - 1; i >= 0; i--) {
        const it = tl.items[tl.order[i]!];
        if (it?.kind === 'message' && (it as MessageItem).role === 'assistant' && (it as MessageItem).text.trim()) {
          run.finalMessage = (it as MessageItem).text;
          break;
        }
      }
      run.files = Object.values(tl.files).sort((a, b) => a.path.localeCompare(b.path));
      const u = tl.usage;
      if (u && (u.inputTokens !== undefined || u.outputTokens !== undefined)) {
        run.tokens = (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
        tokens += run.tokens;
      }
      if (session.billing === 'metered' && u?.costUsd !== undefined) {
        run.meteredUsd = u.costUsd;
        meteredUsd += u.costUsd;
      }
      const cv = contextView(tl.context);
      if (cv.known) {
        run.context = cv.fill;
        run.contextLabel = cv.label;
      }
    }
    return run;
  });
  return { group, title: summary.title, workspaceId: summary.workspaceId, runs, meteredUsd, tokens };
}

/** "Fix the flaky test · 2/3" → "Fix the flaky test" */
function groupTitle(title: string | undefined): string {
  return (title ?? 'Fan-out').replace(/\s·\s\d+\/\d+$/, '') || 'Fan-out';
}

function byCreatedThenTitle(a: SessionInfo, b: SessionInfo): number {
  return a.createdAt.localeCompare(b.createdAt) || (a.title ?? '').localeCompare(b.title ?? '');
}
