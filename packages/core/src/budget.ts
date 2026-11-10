// Session budgets (docs/usage.md §2): what a session and its helpers have spent, and caps on it.

import { BizziError, type BillingClass, type SessionBudget, type Usage } from '@bizzi/protocol';

/** Running totals for one session (its own turns only; trees are summed on demand). */
export interface Spent {
  /** Metered spend only: sessions whose billing isn't 'metered' never add to this. */
  usd: number;
  tokens: number;
  turns: number;
}

export function zeroSpent(): Spent {
  return { usd: 0, tokens: 0, turns: 0 };
}

/** Add one completed turn. Tokens and turns always count; usd only on metered billing. */
export function addTurn(spent: Spent, usage: Usage | undefined, billing: BillingClass | undefined): Spent {
  const out = { ...spent, turns: spent.turns + 1 };
  if (usage) {
    out.tokens += nonNeg(usage.inputTokens) + nonNeg(usage.outputTokens);
    if (billing === 'metered') out.usd += nonNeg(usage.costUsd);
  }
  return out;
}

export function sumSpent(items: Iterable<Spent>): Spent {
  const out = zeroSpent();
  for (const s of items) {
    out.usd += s.usd;
    out.tokens += s.tokens;
    out.turns += s.turns;
  }
  return out;
}

/** The first cap `spent` has reached, as text ("3/3 turns"), or undefined while within budget. */
export function budgetReached(budget: SessionBudget, spent: Spent): string | undefined {
  if (budget.usd !== undefined && spent.usd >= budget.usd) return `${usd(spent.usd)} of ${usd(budget.usd)} metered spend`;
  if (budget.tokens !== undefined && spent.tokens >= budget.tokens) return `${spent.tokens}/${budget.tokens} tokens`;
  if (budget.turns !== undefined && spent.turns >= budget.turns) return `${spent.turns}/${budget.turns} turns`;
  return undefined;
}

export function usd(n: number): string {
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

/** Validate a budget from the wire. Empty budgets are dropped (undefined). */
export function parseBudget(v: unknown, key = 'budget'): SessionBudget | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v)) throw new BizziError('bad_request', `${key} must be an object`);
  const o = v as Record<string, unknown>;
  const out: SessionBudget = {};
  for (const k of Object.keys(o)) {
    if (k !== 'usd' && k !== 'tokens' && k !== 'turns') throw new BizziError('bad_request', `unknown ${key} field ${k}`);
    const n = o[k];
    if (n === undefined || n === null) continue;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) throw new BizziError('bad_request', `${key}.${k} must be a non-negative number`);
    if (k !== 'usd' && !Number.isInteger(n)) throw new BizziError('bad_request', `${key}.${k} must be an integer`);
    out[k] = n;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function nonNeg(n: number | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}
