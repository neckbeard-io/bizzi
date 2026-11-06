// PTY backends: where the pseudo-terminal actually lives. `LocalPtyBackend` owns a node-pty
// process in this Node process; `SupervisorBackend` (supervisor-client.ts) talks to a detached
// supervisor that owns it.

import { constants as osConstants } from 'node:os';
import * as nodePty from '@lydell/node-pty';

export interface ExitInfo {
  /** Process exit code, or null when it was killed by a signal. */
  exitCode: number | null;
  /** Signal name (e.g. "SIGHUP") when the process was killed by a signal. */
  signal?: string;
}

export interface PtySpawnOptions {
  command: string;
  args?: string[];
  cwd: string;
  /** Complete environment for the child (not merged here). */
  env: Record<string, string>;
  cols?: number;
  rows?: number;
}

export interface PtyBackend {
  readonly pid: number;
  write(data: Buffer): void;
  resize(cols: number, rows: number): void;
  /** Send a signal to the child (default SIGHUP). */
  kill(signal?: string): void;
  onData(cb: (data: Buffer) => void): void;
  onExit(cb: (info: ExitInfo) => void): void;
  /** Tell the backend that output up to absolute offset `offset` has been delivered downstream. */
  ack?(offset: number): void;
  /** Release local resources without killing the child (supervisor: just disconnect). */
  detach?(): void;
}

export const DEFAULT_COLS = 120;
export const DEFAULT_ROWS = 32;
export const TERM_NAME = 'xterm-256color';

const SIGNAL_NAMES = new Map<number, string>(
  Object.entries(osConstants.signals).map(([name, num]) => [num as number, name]),
);

export function signalName(sig: number | undefined | null): string | undefined {
  if (!sig) return undefined;
  return SIGNAL_NAMES.get(sig) ?? `SIG${sig}`;
}

export function clampSize(n: number | undefined, fallback: number): number {
  if (n === undefined || !Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), 1), 10_000);
}

export class LocalPtyBackend implements PtyBackend {
  readonly #pty: nodePty.IPty;
  #exited = false;

  constructor(opts: PtySpawnOptions) {
    this.#pty = nodePty.spawn(opts.command, opts.args ?? [], {
      name: opts.env.TERM ?? TERM_NAME,
      cols: clampSize(opts.cols, DEFAULT_COLS),
      rows: clampSize(opts.rows, DEFAULT_ROWS),
      cwd: opts.cwd,
      env: opts.env,
      // Raw bytes: base64 on the wire, no UTF-8 decoding surprises at chunk boundaries.
      encoding: null,
    });
    this.#pty.onExit(() => {
      this.#exited = true;
    });
  }

  get pid(): number {
    return this.#pty.pid;
  }

  write(data: Buffer): void {
    if (this.#exited) return;
    // node-pty's typings say string, but the underlying socket takes bytes.
    this.#pty.write(data as unknown as string);
  }

  resize(cols: number, rows: number): void {
    if (this.#exited) return;
    try {
      this.#pty.resize(clampSize(cols, DEFAULT_COLS), clampSize(rows, DEFAULT_ROWS));
    } catch {
      // The pty can close between the check and the ioctl.
    }
  }

  kill(signal?: string): void {
    if (this.#exited) return;
    try {
      this.#pty.kill(signal);
    } catch {
      // Already gone.
    }
  }

  onData(cb: (data: Buffer) => void): void {
    this.#pty.onData((d: string | Buffer) => cb(typeof d === 'string' ? Buffer.from(d, 'utf8') : d));
  }

  onExit(cb: (info: ExitInfo) => void): void {
    this.#pty.onExit(({ exitCode, signal }) => {
      const name = signalName(signal);
      cb(name ? { exitCode: null, signal: name } : { exitCode });
    });
  }
}
