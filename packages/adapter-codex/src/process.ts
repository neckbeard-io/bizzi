// Spawns `codex app-server` and wires its stdio to a JsonRpcConnection.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Logger } from '@bizzi/protocol';
import { JsonRpcConnection, type RpcHandlers } from './rpc.ts';

const STDERR_KEEP = 16 * 1024;

export interface SpawnSpec {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Set when the process could not be spawned at all. */
  error?: Error;
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI, '');
}

export class AppServerProcess {
  readonly rpc: JsonRpcConnection;
  readonly exited: Promise<ExitInfo>;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #logger: Logger;
  #stderr = '';
  #stderrLine = '';
  #exit: ExitInfo | undefined;

  constructor(spec: SpawnSpec, handlers: RpcHandlers, logger: Logger) {
    this.#logger = logger;
    this.#child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.rpc = new JsonRpcConnection(this.#child.stdout, this.#child.stdin, handlers, logger);
    this.#child.stderr.setEncoding('utf8');
    this.#child.stderr.on('data', (d: string) => this.#onStderr(d));
    this.exited = new Promise<ExitInfo>((resolve) => {
      let settled = false;
      const done = (info: ExitInfo): void => {
        if (settled) return;
        settled = true;
        this.#exit = info;
        this.rpc.close(describeExit(info, this.stderrTail()));
        resolve(info);
      };
      this.#child.on('error', (error) => done({ code: null, signal: null, error }));
      // 'close' fires after stdio is drained, so every stdout line has been dispatched.
      this.#child.on('close', (code, signal) => done({ code, signal }));
    });
  }

  get pid(): number | undefined {
    return this.#child.pid;
  }

  get exitInfo(): ExitInfo | undefined {
    return this.#exit;
  }

  /** Last ~16 KiB of stderr, ANSI codes stripped. */
  stderrTail(maxChars = 2000): string {
    const s = stripAnsi(this.#stderr).trim();
    return s.length > maxChars ? s.slice(s.length - maxChars) : s;
  }

  /** SIGTERM, then SIGKILL after graceMs. Resolves when the process is gone. */
  async kill(graceMs = 3000): Promise<ExitInfo> {
    if (this.#exit) return this.#exit;
    try {
      this.#child.stdin.end();
    } catch {
      // ignore
    }
    this.#child.kill('SIGTERM');
    const timer = setTimeout(() => {
      if (!this.#exit) this.#child.kill('SIGKILL');
    }, graceMs);
    try {
      return await this.exited;
    } finally {
      clearTimeout(timer);
    }
  }

  #onStderr(d: string): void {
    this.#stderr += d;
    if (this.#stderr.length > STDERR_KEEP) this.#stderr = this.#stderr.slice(this.#stderr.length - STDERR_KEEP);
    this.#stderrLine += d;
    let nl: number;
    while ((nl = this.#stderrLine.indexOf('\n')) >= 0) {
      const line = stripAnsi(this.#stderrLine.slice(0, nl)).trimEnd();
      this.#stderrLine = this.#stderrLine.slice(nl + 1);
      if (line) this.#logger.log('debug', 'codex stderr', { line });
    }
  }
}

export function describeExit(info: ExitInfo, stderrTail: string): string {
  let msg: string;
  if (info.error) msg = `failed to start codex app-server: ${info.error.message}`;
  else if (info.signal) msg = `codex app-server was killed by ${info.signal}`;
  else msg = `codex app-server exited with code ${info.code}`;
  if (stderrTail) {
    const lastLines = stderrTail.split('\n').slice(-5).join('\n');
    msg += `: ${lastLines}`;
  }
  return msg;
}
