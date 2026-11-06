// Restart backoff for the supervised core: exponential with jitter, capped, and reset once a
// process has stayed up long enough to count as healthy.

export interface BackoffOptions {
  /** First restart delay. */
  initialMs?: number;
  factor?: number;
  maxMs?: number;
  /** A process that ran at least this long resets the sequence. */
  stableAfterMs?: number;
  /** Relative jitter, 0..1: the delay is scaled by a factor in [1 - jitter, 1 + jitter]. */
  jitter?: number;
  random?: () => number;
}

const DEFAULTS = {
  initialMs: 500,
  factor: 2,
  maxMs: 30_000,
  stableAfterMs: 60_000,
  jitter: 0.2,
};

/** Delay before restart number `attempt` (0-based), without jitter. */
export function backoffDelay(attempt: number, opts: BackoffOptions = {}): number {
  const initialMs = opts.initialMs ?? DEFAULTS.initialMs;
  const factor = opts.factor ?? DEFAULTS.factor;
  const maxMs = opts.maxMs ?? DEFAULTS.maxMs;
  return Math.min(maxMs, initialMs * factor ** Math.max(0, attempt));
}

export class Backoff {
  readonly #opts: BackoffOptions;
  #attempt = 0;

  constructor(opts: BackoffOptions = {}) {
    this.#opts = opts;
  }

  /** Number of restarts since the last reset. */
  get attempt(): number {
    return this.#attempt;
  }

  /** Returns the delay for the next restart and advances the sequence. */
  next(): number {
    const base = backoffDelay(this.#attempt, this.#opts);
    this.#attempt++;
    const jitter = this.#opts.jitter ?? DEFAULTS.jitter;
    const random = this.#opts.random ?? Math.random;
    const scaled = base * (1 - jitter + 2 * jitter * random());
    return Math.round(Math.min(this.#opts.maxMs ?? DEFAULTS.maxMs, Math.max(0, scaled)));
  }

  reset(): void {
    this.#attempt = 0;
  }

  /** Record that a process exited after `uptimeMs`; a long-lived one resets the sequence. */
  onExit(uptimeMs: number): void {
    if (uptimeMs >= (this.#opts.stableAfterMs ?? DEFAULTS.stableAfterMs)) this.reset();
  }
}
