// Small child-process runner for the secret backends. Secrets travel on stdin, never on argv
// (argv is visible to every user via `ps`). Injectable so tests never touch a real keychain.

import { spawn } from 'node:child_process';

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** spawn error (e.g. ENOENT) */
  error?: string;
  timedOut?: boolean;
}

export interface RunOptions {
  /** Written to stdin, which is then closed. */
  input?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export type CommandRunner = (file: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

const MAX_OUTPUT = 256 * 1024;

export const runCommand: CommandRunner = (file, args, opts = {}) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], env: opts.env ?? process.env });
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: '', error: (e as Error).message });
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({ code: null, stdout, stderr, timedOut: true });
    }, opts.timeoutMs ?? 15_000);
    child.stdout!.setEncoding('utf8').on('data', (d: string) => {
      if (stdout.length < MAX_OUTPUT) stdout += d;
    });
    child.stderr!.setEncoding('utf8').on('data', (d: string) => {
      if (stderr.length < MAX_OUTPUT) stderr += d;
    });
    child.on('error', (e) => done({ code: null, stdout, stderr, error: e.message }));
    child.on('close', (code) => done({ code, stdout, stderr }));
    child.stdin!.on('error', () => {
      /* EPIPE when the child exits early; reported via the exit code */
    });
    child.stdin!.end(opts.input ?? '');
  });
