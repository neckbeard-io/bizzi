export type TerminalListener = (chunk: Uint8Array) => void;

interface Stream {
  chunks: Uint8Array[];
  bytes: number;
  listeners: Set<TerminalListener>;
}

/**
 * Raw terminal output per session. Bypasses the store entirely (no React re-render per chunk):
 * listeners (an xterm.js instance) get bytes synchronously, and a bounded backlog lets a terminal
 * that mounts later catch up.
 */
export class TerminalStreams {
  private readonly streams = new Map<string, Stream>();
  private readonly maxBacklogBytes: number;

  constructor(opts: { maxBacklogBytes?: number } = {}) {
    this.maxBacklogBytes = opts.maxBacklogBytes ?? 2 * 1024 * 1024;
  }

  private stream(sessionId: string): Stream {
    let s = this.streams.get(sessionId);
    if (!s) {
      s = { chunks: [], bytes: 0, listeners: new Set() };
      this.streams.set(sessionId, s);
    }
    return s;
  }

  write(sessionId: string, chunk: Uint8Array): void {
    const s = this.stream(sessionId);
    s.chunks.push(chunk);
    s.bytes += chunk.byteLength;
    while (s.bytes > this.maxBacklogBytes && s.chunks.length > 1) {
      const dropped = s.chunks.shift();
      if (dropped) s.bytes -= dropped.byteLength;
    }
    for (const l of s.listeners) l(chunk);
  }

  /** Subscribe to output. With `replay` (default), the backlog is written to the listener first. */
  subscribe(sessionId: string, listener: TerminalListener, opts: { replay?: boolean } = {}): () => void {
    const s = this.stream(sessionId);
    if (opts.replay ?? true) for (const c of s.chunks) listener(c);
    s.listeners.add(listener);
    return () => {
      s.listeners.delete(listener);
    };
  }

  backlog(sessionId: string): readonly Uint8Array[] {
    return this.streams.get(sessionId)?.chunks ?? [];
  }

  clear(sessionId: string): void {
    const s = this.streams.get(sessionId);
    if (!s) return;
    s.chunks = [];
    s.bytes = 0;
  }
}
