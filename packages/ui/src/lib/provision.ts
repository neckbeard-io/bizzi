// Pure helpers for the provisioning UI (agent install / update / uninstall, login, API keys).
import type { InstallJob } from '@bizzi/client';
import type { AgentKind, AgentListing, InstallAction, InstallPlan } from '@bizzi/protocol';

export interface AgentActions {
  install: boolean;
  update: boolean;
  uninstall: boolean;
  login: boolean;
  /** Login is the main call to action (not signed in / expired). */
  loginProminent: boolean;
  secrets: boolean;
}

export function hasUpdate(a: AgentListing): boolean {
  if (!a.installed) return false;
  if (a.updateAvailable !== undefined) return a.updateAvailable;
  return Boolean(a.latestVersion && a.version && a.latestVersion !== a.version);
}

/** Which provisioning actions make sense for an agent listing. The built-in shell has none. */
export function agentActions(a: AgentListing): AgentActions {
  const managed = a.agent !== 'shell';
  return {
    install: managed && !a.installed,
    update: managed && hasUpdate(a),
    uninstall: managed && a.installed,
    login: managed && a.installed,
    loginProminent: managed && a.installed && (a.auth === 'missing' || a.auth === 'expired'),
    secrets: managed,
  };
}

const VERBS: Record<InstallAction, { present: string; progressive: string; past: string }> = {
  install: { present: 'Install', progressive: 'Installing', past: 'Installed' },
  update: { present: 'Update', progressive: 'Updating', past: 'Updated' },
  uninstall: { present: 'Uninstall', progressive: 'Uninstalling', past: 'Uninstalled' },
};

export function actionVerb(action: InstallAction | null, tense: 'present' | 'progressive' | 'past'): string {
  return VERBS[action ?? 'install'][tense];
}

export type JobState = 'running' | 'ok' | 'failed';

export function jobState(job: InstallJob): JobState {
  if (!job.done) return 'running';
  return job.ok === false ? 'failed' : 'ok';
}

/** 0..1 when the job reports steps (1 when finished), null for an indeterminate bar. */
export function jobProgress(job: InstallJob): number | null {
  if (job.done) return 1;
  if (job.total && job.total > 0 && job.step !== undefined) return Math.min(1, Math.max(0, job.step / job.total));
  return null;
}

/** "Installing agy · step 2 of 6", "Updated claude", "Uninstall of codex failed". */
export function jobLabel(job: InstallJob): string {
  const target = job.tool ?? job.agent;
  const state = jobState(job);
  if (state === 'ok') return `${actionVerb(job.action, 'past')} ${target}`;
  if (state === 'failed') return `${actionVerb(job.action, 'present')} of ${target} failed`;
  const step = job.total && job.step !== undefined ? ` · step ${job.step} of ${job.total}` : '';
  return `${actionVerb(job.action, 'progressive')} ${target}${step}`;
}

/** Environment variables each agent reads its API key from. */
export const SECRET_SUGGESTIONS: Record<AgentKind, readonly string[]> = {
  claude: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
  codex: ['OPENAI_API_KEY'],
  opencode: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY'],
  agy: ['GEMINI_API_KEY'],
  shell: [],
};

export function suggestedSecretNames(agent: AgentKind, existing: readonly string[] = []): string[] {
  return SECRET_SUGGESTIONS[agent].filter((n) => !existing.includes(n));
}

/** Environment variable names: letters, digits and underscores, not starting with a digit. */
export function isValidSecretName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

export interface PlanSummary {
  title: string;
  steps: number;
  commands: number;
  sudo: boolean;
}

export function planSummary(plan: InstallPlan): PlanSummary {
  return {
    title: `${actionVerb(plan.action, 'present')} ${plan.target} via ${plan.method}`,
    steps: plan.steps.length,
    commands: plan.steps.filter((s) => s.command).length,
    sudo: plan.steps.some((s) => s.requiresSudo),
  };
}

/** Status of plan step `index` (0-based) given a job's progress (`step` counts completed-or-current steps from 1). */
export function stepState(job: InstallJob | null, index: number): 'pending' | 'running' | 'done' | 'failed' {
  if (!job) return 'pending';
  const state = jobState(job);
  if (state === 'ok') return 'done';
  const current = (job.step ?? 0) - 1;
  if (index < current) return 'done';
  if (index === current) return state === 'failed' ? 'failed' : 'running';
  return 'pending';
}
