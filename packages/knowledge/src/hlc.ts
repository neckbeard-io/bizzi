// Hybrid logical clock (Kulkarni et al.): physical milliseconds + a logical counter + node id.
// Encoded as a fixed-width string so lexicographic order == causal/temporal order:
//   <15-digit wall ms>-<6-digit counter>-<node id>
// e.g. 001762380000000-000003-m_01J...

export interface HlcTimestamp {
  wallMs: number;
  counter: number;
  node: string;
}

const WALL_WIDTH = 15;
const COUNTER_WIDTH = 6;
const MAX_COUNTER = 10 ** COUNTER_WIDTH - 1;

export function formatHlc(ts: HlcTimestamp): string {
  if (!Number.isInteger(ts.wallMs) || ts.wallMs < 0) throw new RangeError(`bad HLC wall time: ${ts.wallMs}`);
  if (!Number.isInteger(ts.counter) || ts.counter < 0 || ts.counter > MAX_COUNTER) {
    throw new RangeError(`bad HLC counter: ${ts.counter}`);
  }
  return `${String(ts.wallMs).padStart(WALL_WIDTH, '0')}-${String(ts.counter).padStart(COUNTER_WIDTH, '0')}-${ts.node}`;
}

export function parseHlc(s: string): HlcTimestamp {
  const m = /^(\d{15})-(\d{6})-(.*)$/.exec(s);
  if (!m) throw new SyntaxError(`not an HLC timestamp: ${s}`);
  return { wallMs: Number(m[1]), counter: Number(m[2]), node: m[3] ?? '' };
}

/** Total order: wall time, then counter, then node id. */
export function compareHlc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export class HybridLogicalClock {
  readonly node: string;
  #wallMs = 0;
  #counter = 0;
  readonly #now: () => number;

  constructor(node: string, now: () => number = Date.now) {
    if (node.includes('\n')) throw new RangeError('HLC node id must be a single line');
    this.node = node;
    this.#now = now;
  }

  /** Timestamp for a local event (send). Strictly greater than every timestamp issued or observed. */
  now(): string {
    const pt = this.#now();
    if (pt > this.#wallMs) {
      this.#wallMs = pt;
      this.#counter = 0;
    } else {
      this.#bump();
    }
    return this.#emit();
  }

  /** Merge a remote (or persisted) timestamp (receive). Returns a timestamp greater than both. */
  update(remote: string): string {
    const r = parseHlc(remote);
    const pt = this.#now();
    const prevWall = this.#wallMs;
    const wall = Math.max(prevWall, r.wallMs, pt);
    if (wall === prevWall && wall === r.wallMs) {
      this.#counter = Math.max(this.#counter, r.counter) + 1;
    } else if (wall === prevWall) {
      this.#counter += 1;
    } else if (wall === r.wallMs) {
      this.#counter = r.counter + 1;
    } else {
      this.#counter = 0;
    }
    this.#wallMs = wall;
    if (this.#counter > MAX_COUNTER) {
      this.#wallMs += 1;
      this.#counter = 0;
    }
    return this.#emit();
  }

  /** Fast-forward to at least `seen` without issuing a new event timestamp. */
  observe(seen: string): void {
    const r = parseHlc(seen);
    if (r.wallMs > this.#wallMs || (r.wallMs === this.#wallMs && r.counter > this.#counter)) {
      this.#wallMs = r.wallMs;
      this.#counter = r.counter;
    }
  }

  #bump(): void {
    this.#counter += 1;
    if (this.#counter > MAX_COUNTER) {
      // Counter overflow: borrow from the future rather than break ordering.
      this.#wallMs += 1;
      this.#counter = 0;
    }
  }

  #emit(): string {
    return formatHlc({ wallMs: this.#wallMs, counter: this.#counter, node: this.node });
  }
}
