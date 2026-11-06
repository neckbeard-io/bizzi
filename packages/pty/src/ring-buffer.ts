// Fixed-capacity byte ring buffer for terminal scrollback.
//
// Positions are absolute byte offsets into the terminal's output stream (0 = first byte ever
// written), so a client that remembers "I have everything up to offset N" can ask for just the
// bytes after N, as long as they are still in the buffer.

export const DEFAULT_SCROLLBACK_BYTES = 2 * 1024 * 1024;

export class ScrollbackBuffer {
  readonly capacity: number;
  #buf: Buffer;
  /** Total bytes ever written (absolute offset of the next byte). */
  #end = 0;
  /** Bytes before this offset were cleared. */
  #floor = 0;

  constructor(capacity: number = DEFAULT_SCROLLBACK_BYTES) {
    if (!Number.isInteger(capacity) || capacity <= 0) throw new RangeError('capacity must be a positive integer');
    this.capacity = capacity;
    this.#buf = Buffer.alloc(capacity);
  }

  /** Absolute offset just past the last byte written. */
  get end(): number {
    return this.#end;
  }

  /** Absolute offset of the oldest byte still held. */
  get start(): number {
    return Math.max(this.#floor, this.#end - this.capacity);
  }

  /** Bytes currently held. */
  get size(): number {
    return this.#end - this.start;
  }

  write(data: Uint8Array): void {
    let src = data;
    if (src.length >= this.capacity) {
      // Only the tail fits; skip ahead.
      this.#end += src.length - this.capacity;
      src = src.subarray(src.length - this.capacity);
    }
    const pos = this.#end % this.capacity;
    const first = Math.min(src.length, this.capacity - pos);
    this.#buf.set(src.subarray(0, first), pos);
    if (first < src.length) this.#buf.set(src.subarray(first), 0);
    this.#end += src.length;
  }

  /**
   * Copy of the held bytes from absolute offset `from` (clamped to what is still held) to the end.
   * Default: everything held.
   */
  read(from: number = this.start): Buffer {
    const begin = Math.min(Math.max(from, this.start), this.#end);
    const len = this.#end - begin;
    const out = Buffer.allocUnsafe(len);
    if (len === 0) return out;
    const pos = begin % this.capacity;
    const first = Math.min(len, this.capacity - pos);
    this.#buf.copy(out, 0, pos, pos + first);
    if (first < len) this.#buf.copy(out, first, 0, len - first);
    return out;
  }

  /** True when every byte from absolute offset `from` onwards is still held. */
  has(from: number): boolean {
    return from >= this.start && from <= this.#end;
  }

  /** Drop everything held; offsets keep counting. */
  clear(): void {
    this.#floor = this.#end;
  }

  /** Empty the buffer and continue at absolute offset `offset` (used to mirror a remote buffer). */
  resetAt(offset: number): void {
    this.#end = offset;
    this.#floor = offset;
  }
}
