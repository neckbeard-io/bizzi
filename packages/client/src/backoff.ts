export interface BackoffOptions {
  /** Delay before the first retry, in ms. */
  baseMs: number;
  /** Upper bound for any delay, in ms. */
  maxMs: number;
  /** Growth per attempt. */
  factor: number;
  /** 0..1: fraction of the delay that is randomized (0.5 → delay in [d/2, d]). */
  jitter: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 500, maxMs: 30_000, factor: 2, jitter: 0.5 };

/** Jittered exponential backoff. `attempt` starts at 0. */
export function backoffDelay(attempt: number, opts: BackoffOptions = DEFAULT_BACKOFF, random: () => number = Math.random): number {
  const exp = Math.min(opts.maxMs, opts.baseMs * opts.factor ** Math.max(0, attempt));
  const spread = exp * Math.min(1, Math.max(0, opts.jitter));
  return Math.round(exp - spread + random() * spread);
}
