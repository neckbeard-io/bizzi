import { statSync } from 'node:fs';
import type { Logger } from '@bizzi/protocol';
import { execCapture } from './exec.ts';
import { augmentedEnv, homeDir } from './path.ts';
import type { InstallPlan, InstallProgress, PlannedStep, RunResult, StepResult } from './types.ts';

export interface RunOptions {
  /** Print the commands as progress events; run nothing. */
  dryRun?: boolean;
  /** Receives events shaped exactly like the protocol's `install.progress` data. */
  onProgress?: (p: InstallProgress) => void;
  /** Base environment (default process.env). PATH is augmented; step env is layered on top. */
  env?: NodeJS.ProcessEnv;
  /** Working directory for steps without their own cwd (default: home). */
  cwd?: string;
  /** Allow steps marked requiresSudo (default false: such plans fail before running anything). */
  allowSudo?: boolean;
  /** Emit each output line as a progress event (default true). */
  streamOutput?: boolean;
  signal?: AbortSignal;
  logger?: Logger;
}

const MAX_LINE = 2000;

/**
 * Run a plan step by step in PTY-less child processes (stdin is /dev/null, so installers that
 * prompt get EOF). Stops at the first failing step unless it allows failure. Never throws.
 *
 * Progress stages: `plan`, `step` (one per step, message = description + command), `output`
 * (one per output line), `warning`, and a final `done` event with `done: true` and `ok`.
 */
export async function runPlan(plan: InstallPlan, opts: RunOptions = {}): Promise<RunResult> {
  const emit = (stage: string, message?: string, extra: { done?: boolean; ok?: boolean } = {}) => {
    const p: InstallProgress = { agent: plan.agent, stage, ...(message !== undefined ? { message } : {}), ...extra };
    try {
      opts.onProgress?.(p);
    } catch (e) {
      opts.logger?.log('warn', 'onProgress threw', { error: String(e) });
    }
  };
  const dryRun = opts.dryRun ?? false;
  const results: StepResult[] = [];
  const finish = (ok: boolean, error?: string): RunResult => {
    emit('done', error ?? (ok ? `${plan.action} ${plan.recipe}: ok` : `${plan.action} ${plan.recipe}: failed`), { done: true, ok });
    return { ok, dryRun, steps: results, ...(error ? { error } : {}) };
  };

  emit(
    'plan',
    `${dryRun ? '[dry-run] ' : ''}${plan.action} ${plan.recipe} via ${plan.methodLabel} on ${plan.platformKey}` +
      `${plan.version ? ` (version ${plan.version})` : ''}: ${plan.steps.length} step(s)`,
  );
  for (const w of plan.warnings) emit('warning', w);

  if (plan.requiresSudo && !opts.allowSudo && !dryRun) {
    return finish(false, 'plan has steps that require sudo; refusing (pass allowSudo to override)');
  }

  const baseEnv = opts.env ?? process.env;
  const env = augmentedEnv({ env: baseEnv, prepend: plan.extraPath });
  const cwd = opts.cwd ?? homeDir({ env: baseEnv });
  const total = plan.steps.length;

  for (const [i, step] of plan.steps.entries()) {
    const label = `[${i + 1}/${total}] ${step.description}`;
    emit('step', `${label}\n$ ${step.command}${step.cwd ? `   (in ${step.cwd})` : ''}`);
    if (dryRun) {
      results.push(stepResult(step, { skipped: true, exitCode: null, ok: true, durationMs: 0, timedOut: false }));
      continue;
    }
    if (opts.signal?.aborted) return finish(false, 'aborted');
    const stepCwd = step.cwd ?? cwd;
    if (!isDir(stepCwd)) {
      results.push(stepResult(step, { skipped: false, exitCode: null, ok: false, durationMs: 0, timedOut: false }));
      return finish(false, `${label}: working directory ${stepCwd} does not exist`);
    }

    const r = await runStep(step, { ...env, ...step.env }, stepCwd, opts, (line) => {
      if (opts.streamOutput !== false) emit('output', line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line);
    });
    const ok = r.code === 0 && !r.timedOut && !r.aborted && !r.error;
    results.push(
      stepResult(step, {
        skipped: false,
        exitCode: r.code,
        ok,
        durationMs: r.durationMs,
        timedOut: r.timedOut,
        ...(r.signal ? { signal: r.signal } : {}),
      }),
    );
    if (!ok) {
      const why = r.error
        ? `could not start: ${r.error}`
        : r.timedOut
          ? `timed out after ${step.timeoutMs} ms`
          : r.aborted
            ? 'aborted'
            : `exit ${r.code ?? r.signal}`;
      if (step.allowFailure) {
        emit('warning', `${label}: ${why} (allowed to fail)`);
        continue;
      }
      return finish(false, `${label}: ${why}`);
    }
  }
  return finish(true);
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function runStep(step: PlannedStep, env: NodeJS.ProcessEnv, cwd: string, opts: RunOptions, onLine: (l: string) => void) {
  const common = {
    env,
    cwd,
    timeoutMs: step.timeoutMs,
    onLine,
    ...(opts.signal ? { signal: opts.signal } : {}),
  };
  if (step.run !== undefined) return execCapture('/bin/sh', ['-c', step.run], common);
  const [file, ...args] = step.argv ?? [];
  return execCapture(file ?? 'false', args, common);
}

function stepResult(
  step: PlannedStep,
  r: { skipped: boolean; exitCode: number | null; ok: boolean; durationMs: number; timedOut: boolean; signal?: string },
): StepResult {
  return { id: step.id, description: step.description, command: step.command, ...r };
}
