// Pipelines (docs/pipelines.md): selectors for the pipeline view, the inbox's gates and the workspace
// list, plus the built-in planner → implementer → reviewer template. No UI dependencies.

import { PIPELINE_ID_PREFIX } from '@bizzi/protocol';
import type { AgentKind, PipelineInfo, PipelineSpec, PipelineStageRun, SessionInfo } from '@bizzi/protocol';
import { sessionMarkState, type MarkState } from './sidebar.ts';
import type { BizziState } from './store.ts';

/** Whether a session group id belongs to a pipeline (stage sessions carry `group: <pipeline id>`). */
export function isPipelineGroup(group: string | undefined): boolean {
  return Boolean(group?.startsWith(PIPELINE_ID_PREFIX));
}

/** Pipeline runs, newest first; with `workspaceId`, those started there (a worktree's runs show under its repo too). */
export function selectPipelines(s: BizziState, workspaceId?: string): PipelineInfo[] {
  const out: PipelineInfo[] = [];
  for (const p of Object.values(s.pipelines)) {
    if (workspaceId !== undefined && p.workspaceId !== workspaceId && s.workspaces?.[p.workspaceId]?.parentWorkspaceId !== workspaceId) continue;
    out.push(p);
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Runs stopped at a gate, oldest gate first: inbox items. */
export function selectPipelineGates(s: BizziState): PipelineInfo[] {
  return Object.values(s.pipelines)
    .filter((p) => p.status === 'waiting' && p.gate)
    .sort((a, b) => a.gate!.since.localeCompare(b.gate!.since));
}

export function pipelinesEqual(a: readonly PipelineInfo[], b: readonly PipelineInfo[]): boolean {
  return a.length === b.length && a.every((p, i) => p === b[i]);
}

export interface PipelineStageModel {
  index: number;
  run: PipelineStageRun;
  session: SessionInfo | null;
  /** The stage session's sidebar mark, while it lives. */
  mark: MarkState | null;
  /** The gate is open in front of this stage. */
  gated: boolean;
  gate?: boolean;
  where: 'workspace' | 'worktree';
}

export interface PipelineModel {
  pipeline: PipelineInfo;
  stages: PipelineStageModel[];
}

export function selectPipeline(s: BizziState, id: string): PipelineModel | null {
  const p = s.pipelines[id];
  if (!p) return null;
  const stages = p.stages.map((run, index): PipelineStageModel => {
    const session = (run.sessionId && s.sessions[run.sessionId]) || null;
    const spec = p.spec.stages[index];
    const m: PipelineStageModel = { index, run, session, mark: session ? sessionMarkState(s, session) : null, gated: p.status === 'waiting' && p.gate?.stage === index, where: spec?.where ?? 'workspace' };
    if (spec?.gate) m.gate = true;
    return m;
  });
  return { pipeline: p, stages };
}

/** Re-render key for the pipeline view. */
export function pipelineModelSignature(m: PipelineModel | null): string {
  if (!m) return '';
  return [m.pipeline.updatedAt, m.pipeline.status, ...m.stages.map((x) => `${x.run.status}|${x.session?.status ?? ''}|${x.mark ?? ''}`)].join('\n');
}

// ---------------------------------------------------------------- templates

export interface ReviewPipelineOptions {
  planner: AgentKind;
  implementer: AgentKind;
  reviewer: AgentKind;
  /** Stop for approval of the plan before implementing (default true). */
  gateImplement?: boolean;
  /** Stop before the review (default false). */
  gateReview?: boolean;
  plannerModel?: string;
  implementerModel?: string;
  reviewerModel?: string;
}

/** Read-only permission mode per agent, for the planner and reviewer (spec §12.5 level 0). */
const READ_ONLY: Partial<Record<AgentKind, string>> = { claude: 'plan', codex: 'read-only', opencode: 'plan' };

/**
 * Planner → implementer → reviewer: the planner reads the workspace and writes a plan, the implementer
 * follows it in the pipeline's worktree, the reviewer reads the plan and the worktree's diff.
 */
export function reviewPipeline(o: ReviewPipelineOptions): PipelineSpec {
  const ro = (agent: AgentKind) => (READ_ONLY[agent] ? { permissionMode: READ_ONLY[agent] } : {});
  const model = (m: string | undefined) => (m?.trim() ? { model: m.trim() } : {});
  return {
    stages: [
      {
        name: 'plan',
        agent: o.planner,
        ...ro(o.planner),
        ...model(o.plannerModel),
        prompt: 'Plan this task; do not change any files.\n\nTask:\n{{task}}\n\nReply with a short, numbered implementation plan: the files to change, what to change in each, and how to test it.',
      },
      {
        name: 'implement',
        agent: o.implementer,
        where: 'worktree',
        ...model(o.implementerModel),
        ...(o.gateImplement === false ? {} : { gate: true }),
        prompt: 'Implement this task by following the plan. Keep the change focused, run the relevant tests, and finish with a summary of what you changed.\n\nTask:\n{{task}}\n\nPlan:\n{{previous.result}}',
      },
      {
        name: 'review',
        agent: o.reviewer,
        where: 'worktree',
        ...ro(o.reviewer),
        ...model(o.reviewerModel),
        ...(o.gateReview ? { gate: true } : {}),
        prompt:
          'Review this change; do not edit files. Check it against the task and the plan, look for bugs, missing tests and anything the plan asked for that is missing. List findings by severity, or say it looks good.\n\nTask:\n{{task}}\n\nPlan:\n{{stages.plan.result}}\n\nImplementer summary:\n{{previous.result}}\n\nChanged files:\n{{previous.files}}\n\nDiff:\n{{previous.diff}}',
      },
    ],
  };
}

export const PIPELINE_STATUS_LABEL: Record<PipelineInfo['status'], string> = {
  running: 'running',
  waiting: 'waiting for you',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
};
