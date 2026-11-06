import { spawn } from 'node:child_process';

export interface ExecOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
  /** Written to stdin, then stdin is closed. Without it stdin is /dev/null. */
  input?: string;
  /** Called with each complete output line (stdout and stderr interleaved as they arrive). */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
  signal?: AbortSignal;
  /** Cap on captured output per stream (default 1 MiB). */
  maxBuffer?: number;
}

export interface ExecResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  /** Spawn failure (ENOENT, EACCES, …). */
  error?: string;
  durationMs: number;
}

/**
 * Run a program without a PTY and capture its output. Never rejects. The child gets its own process
 * group so timeouts and aborts kill the whole tree (e.g. `curl | bash`).
 */
export function execCapture(file: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  const started = Date.now();
  const max = opts.maxBuffer ?? 1024 * 1024;
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let spawnError: string | undefined;
    const partial = { stdout: '', stderr: '' };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, {
        env: opts.env,
        cwd: opts.cwd,
        stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (e) {
      resolve({
        code: null,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        aborted: false,
        error: (e as Error).message,
        durationMs: Date.now() - started,
      });
      return;
    }

    const killTree = (sig: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* already gone */
        }
      }
    };

    let timer: NodeJS.Timeout | undefined;
    let hardKill: NodeJS.Timeout | undefined;
    const terminate = () => {
      killTree('SIGTERM');
      hardKill = setTimeout(() => killTree('SIGKILL'), 2000);
      hardKill.unref();
    };
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, opts.timeoutMs);
    }
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    const handle = (stream: 'stdout' | 'stderr') => (buf: Buffer) => {
      const text = buf.toString('utf8');
      if (stream === 'stdout') {
        if (stdout.length < max) stdout += text.slice(0, max - stdout.length);
      } else if (stderr.length < max) stderr += text.slice(0, max - stderr.length);
      if (opts.onLine) {
        const lines = (partial[stream] + text).split(/\r?\n/);
        partial[stream] = lines.pop() ?? '';
        for (const line of lines) opts.onLine(line, stream);
      }
    };
    child.stdout?.on('data', handle('stdout'));
    child.stderr?.on('data', handle('stderr'));
    if (opts.input !== undefined && child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(opts.input);
    }

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (hardKill) clearTimeout(hardKill);
      opts.signal?.removeEventListener('abort', onAbort);
      if (opts.onLine) {
        if (partial.stdout) opts.onLine(partial.stdout, 'stdout');
        if (partial.stderr) opts.onLine(partial.stderr, 'stderr');
      }
      resolve({
        code,
        signal,
        stdout,
        stderr,
        timedOut,
        aborted,
        ...(spawnError ? { error: spawnError } : {}),
        durationMs: Date.now() - started,
      });
    };
    child.on('error', (e) => {
      spawnError = e.message;
      finish(null, null);
    });
    child.on('close', finish);
  });
}
