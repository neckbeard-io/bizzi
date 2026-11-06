/** Runs a callback "soon" (next animation frame in browsers). Returns a cancel function. */
export interface FrameScheduler {
  schedule(cb: () => void): () => void;
}

type RafFn = (cb: (t: number) => void) => number;
type CafFn = (handle: number) => void;

/**
 * At most one flush per animation frame. Uses requestAnimationFrame when available, with a timer
 * fallback so a hidden tab (where rAF is paused) still drains its buffer. Without rAF (Node, workers)
 * a ~16 ms timer is used.
 */
export function createFrameScheduler(opts: { fallbackMs?: number; frameMs?: number } = {}): FrameScheduler {
  const g = globalThis as unknown as { requestAnimationFrame?: RafFn; cancelAnimationFrame?: CafFn };
  const raf = typeof g.requestAnimationFrame === 'function' ? g.requestAnimationFrame.bind(globalThis) : null;
  const caf = typeof g.cancelAnimationFrame === 'function' ? g.cancelAnimationFrame.bind(globalThis) : null;
  const fallbackMs = opts.fallbackMs ?? 250;
  const frameMs = opts.frameMs ?? 16;
  return {
    schedule(cb) {
      let done = false;
      let rafHandle: number | null = null;
      const run = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (rafHandle !== null && caf) caf(rafHandle);
        cb();
      };
      const timer = setTimeout(run, raf ? fallbackMs : frameMs);
      if (raf) rafHandle = raf(run);
      return () => {
        done = true;
        clearTimeout(timer);
        if (rafHandle !== null && caf) caf(rafHandle);
      };
    },
  };
}

/** Test helper: callbacks run only when `flush()` is called. */
export function createManualScheduler(): FrameScheduler & { flush(): void; readonly pending: number } {
  let queue: (() => void)[] = [];
  return {
    schedule(cb) {
      let cancelled = false;
      queue.push(() => {
        if (!cancelled) cb();
      });
      return () => {
        cancelled = true;
      };
    },
    flush() {
      const q = queue;
      queue = [];
      for (const cb of q) cb();
    },
    get pending() {
      return queue.length;
    },
  };
}
