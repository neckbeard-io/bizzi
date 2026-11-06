// Batches small PTY reads into larger chunks: flush after `delayMs` from the first buffered byte,
// or immediately once `maxBytes` are buffered. Keeps event volume sane for chatty TUIs (spinners
// redraw at 10–60 Hz) without adding visible latency.

export const DEFAULT_COALESCE_MS = 16;
export const DEFAULT_COALESCE_BYTES = 32 * 1024;

export class OutputCoalescer {
  readonly delayMs: number;
  readonly maxBytes: number;
  #chunks: Buffer[] = [];
  #size = 0;
  #timer: NodeJS.Timeout | undefined;
  #onFlush: (chunk: Buffer) => void;

  constructor(onFlush: (chunk: Buffer) => void, opts: { delayMs?: number; maxBytes?: number } = {}) {
    this.#onFlush = onFlush;
    this.delayMs = opts.delayMs ?? DEFAULT_COALESCE_MS;
    this.maxBytes = opts.maxBytes ?? DEFAULT_COALESCE_BYTES;
  }

  push(data: Buffer): void {
    let rest = data;
    while (rest.length > 0) {
      const room = this.maxBytes - this.#size;
      const part = rest.length > room ? rest.subarray(0, room) : rest;
      rest = rest.subarray(part.length);
      this.#chunks.push(part);
      this.#size += part.length;
      if (this.#size >= this.maxBytes) this.flush();
    }
    if (this.#size > 0 && this.#timer === undefined) {
      this.#timer = setTimeout(() => this.flush(), this.delayMs);
    }
  }

  flush(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    if (this.#size === 0) return;
    const chunk = this.#chunks.length === 1 ? this.#chunks[0]! : Buffer.concat(this.#chunks, this.#size);
    this.#chunks = [];
    this.#size = 0;
    this.#onFlush(chunk);
  }

  /** Drop the timer without flushing (flush first if you want the data). */
  dispose(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}

/** Split a buffer into pieces of at most `size` bytes. */
export function chunkBuffer(data: Buffer, size: number = DEFAULT_COALESCE_BYTES): Buffer[] {
  const out: Buffer[] = [];
  for (let i = 0; i < data.length; i += size) out.push(data.subarray(i, i + size));
  return out;
}
