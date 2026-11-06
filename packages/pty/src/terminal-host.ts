// TerminalHost: one PTY process plus output coalescing, scrollback and kill escalation.
// Protocol-agnostic: the adapter turns its callbacks into `term.output` / `term.exited` events.

import type { Logger } from '@bizzi/protocol';
import {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  LocalPtyBackend,
  TERM_NAME,
  clampSize,
  type ExitInfo,
  type PtyBackend,
} from './backend.ts';
import { OutputCoalescer } from './coalescer.ts';
import { DEFAULT_SCROLLBACK_BYTES, ScrollbackBuffer } from './ring-buffer.ts';

export interface TerminalHostOptions {
  /** Executable (absolute path or name on PATH). */
  command: string;
  args?: string[];
  cwd: string;
  /** Extra environment, merged over `baseEnv`. */
  env?: Record<string, string>;
  /** Base environment. Default: process.env. */
  baseEnv?: Record<string, string | undefined>;
  /** Variables to remove from the merged environment. */
  unsetEnv?: string[];
  cols?: number;
  rows?: number;
  /** Scrollback ring size in bytes. Default 2 MiB. */
  scrollbackBytes?: number;
  /** Output coalescing window. Default 16 ms. */
  coalesceMs?: number;
  /** Flush as soon as this many bytes are buffered. Default 32 KiB. */
  coalesceBytes?: number;
  /** Grace period after the first kill signal before SIGKILL. Default 3000 ms. */
  killTimeoutMs?: number;
  logger?: Logger;
}

export type TerminalHostTuning = Pick<TerminalHostOptions, 'scrollbackBytes' | 'coalesceMs' | 'coalesceBytes' | 'killTimeoutMs' | 'logger'>;

/** Build the child environment: base + extra, TERM forced to xterm-256color, unset applied. */
export function buildPtyEnv(
  extra: Record<string, string> = {},
  base: Record<string, string | undefined> = process.env,
  unset: string[] = [],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  Object.assign(env, extra);
  env.TERM = TERM_NAME;
  env.COLORTERM ??= 'truecolor';
  for (const k of unset) delete env[k];
  return env;
}

export class TerminalHost {
  readonly #backend: PtyBackend;
  readonly #scrollback: ScrollbackBuffer;
  readonly #coalescer: OutputCoalescer;
  readonly #killTimeoutMs: number;
  readonly #logger: Logger | undefined;
  #outputListeners = new Set<(chunk: Buffer) => void>();
  #exitListeners = new Set<(info: ExitInfo) => void>();
  #exit: ExitInfo | undefined;
  #exitPromise: Promise<ExitInfo>;
  #resolveExit!: (info: ExitInfo) => void;
  #killTimer: NodeJS.Timeout | undefined;
  #cols: number;
  #rows: number;
  /** Absolute offset just past the last byte handed to output listeners. */
  #delivered: number;

  /** Spawn `opts.command` in a new in-process PTY. */
  static spawn(opts: TerminalHostOptions): TerminalHost {
    const cols = clampSize(opts.cols, DEFAULT_COLS);
    const rows = clampSize(opts.rows, DEFAULT_ROWS);
    const backend = new LocalPtyBackend({
      command: opts.command,
      args: opts.args,
      cwd: opts.cwd,
      env: buildPtyEnv(opts.env, opts.baseEnv, opts.unsetEnv),
      cols,
      rows,
    });
    return new TerminalHost(backend, { ...opts, cols, rows });
  }

  /**
   * Wrap an existing backend. `initialScrollback`/`initialOffset` seed the ring (e.g. with what a
   * supervisor replayed), so `scrollback()` and offsets match the backend's stream.
   */
  constructor(
    backend: PtyBackend,
    opts: TerminalHostTuning & { cols?: number; rows?: number; initialScrollback?: Buffer; initialOffset?: number } = {},
  ) {
    this.#backend = backend;
    this.#scrollback = new ScrollbackBuffer(opts.scrollbackBytes ?? DEFAULT_SCROLLBACK_BYTES);
    if (opts.initialOffset !== undefined || opts.initialScrollback) {
      const seed = opts.initialScrollback ?? Buffer.alloc(0);
      this.#scrollback.resetAt((opts.initialOffset ?? seed.length) - seed.length);
      this.#scrollback.write(seed);
    }
    this.#delivered = this.#scrollback.end;
    this.#killTimeoutMs = opts.killTimeoutMs ?? 3000;
    this.#logger = opts.logger;
    this.#cols = clampSize(opts.cols, DEFAULT_COLS);
    this.#rows = clampSize(opts.rows, DEFAULT_ROWS);
    this.#exitPromise = new Promise((resolve) => (this.#resolveExit = resolve));
    this.#coalescer = new OutputCoalescer((chunk) => this.#deliver(chunk), {
      delayMs: opts.coalesceMs,
      maxBytes: opts.coalesceBytes,
    });
    backend.onData((data) => {
      this.#scrollback.write(data);
      this.#coalescer.push(data);
    });
    backend.onExit((info) => this.#handleExit(info));
  }

  get pid(): number {
    return this.#backend.pid;
  }
  get cols(): number {
    return this.#cols;
  }
  get rows(): number {
    return this.#rows;
  }
  get exited(): boolean {
    return this.#exit !== undefined;
  }
  get exitInfo(): ExitInfo | undefined {
    return this.#exit;
  }
  /** Absolute offset of the next output byte (total bytes produced so far). */
  get outputOffset(): number {
    return this.#scrollback.end;
  }
  /** Resolves when the process exits. */
  get exitPromise(): Promise<ExitInfo> {
    return this.#exitPromise;
  }

  /** Coalesced output chunks. Returns an unsubscribe function. */
  onOutput(cb: (chunk: Buffer) => void): () => void {
    this.#outputListeners.add(cb);
    return () => this.#outputListeners.delete(cb);
  }

  /** Fires once on exit (immediately if already exited). Returns an unsubscribe function. */
  onExit(cb: (info: ExitInfo) => void): () => void {
    if (this.#exit) {
      const info = this.#exit;
      queueMicrotask(() => cb(info));
      return () => {};
    }
    this.#exitListeners.add(cb);
    return () => this.#exitListeners.delete(cb);
  }

  write(data: string | Uint8Array): void {
    if (this.#exit) return;
    this.#backend.write(typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data));
  }

  resize(cols: number, rows: number): void {
    if (this.#exit) return;
    this.#cols = clampSize(cols, this.#cols);
    this.#rows = clampSize(rows, this.#rows);
    this.#backend.resize(this.#cols, this.#rows);
  }

  /**
   * Send `signal` (default SIGHUP, like closing a terminal window); escalate to SIGKILL if the
   * process is still alive after the kill timeout.
   */
  kill(signal: string = 'SIGHUP'): void {
    if (this.#exit) return;
    this.#backend.kill(signal);
    if (this.#killTimer === undefined && signal !== 'SIGKILL') {
      this.#killTimer = setTimeout(() => {
        if (!this.#exit) {
          this.#logger?.log('warn', 'pty did not exit; sending SIGKILL', { pid: this.pid });
          this.#backend.kill('SIGKILL');
        }
      }, this.#killTimeoutMs);
      this.#killTimer.unref();
    }
  }

  /** Recent output (up to the scrollback size), optionally only bytes after absolute `from`. */
  scrollback(from?: number): Buffer {
    this.#coalescer.flush();
    return this.#scrollback.read(from);
  }

  /** Whether every byte after absolute offset `from` is still in scrollback. */
  hasScrollbackFrom(from: number): boolean {
    return this.#scrollback.has(from);
  }

  /** Deliver buffered output now. */
  flush(): void {
    this.#coalescer.flush();
  }

  /** Disconnect from the backend without killing the process (supervisor backends only). */
  detach(): void {
    this.#coalescer.flush();
    this.#coalescer.dispose();
    if (this.#killTimer) clearTimeout(this.#killTimer);
    this.#outputListeners.clear();
    this.#exitListeners.clear();
    this.#backend.detach?.();
  }

  #deliver(chunk: Buffer): void {
    for (const cb of this.#outputListeners) {
      try {
        cb(chunk);
      } catch (err) {
        this.#logger?.log('error', 'terminal output listener threw', { err: String(err) });
      }
    }
    this.#delivered += chunk.length;
    this.#backend.ack?.(this.#delivered);
  }

  #handleExit(info: ExitInfo): void {
    if (this.#exit) return;
    this.#coalescer.flush();
    this.#coalescer.dispose();
    if (this.#killTimer) clearTimeout(this.#killTimer);
    this.#exit = info;
    for (const cb of this.#exitListeners) {
      try {
        cb(info);
      } catch (err) {
        this.#logger?.log('error', 'terminal exit listener threw', { err: String(err) });
      }
    }
    this.#exitListeners.clear();
    this.#resolveExit(info);
  }
}
