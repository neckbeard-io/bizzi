// Pipelines (docs/pipelines.md, spec §12.4) on one machine: stages run one after another, each a normal
// structured session started by the node (not a helper of another session), tagged `group: <pipeline id>`.
// A stage's prompt is a template filled from the task, the gate note and earlier stages' results and
// diffs. Gates stop the run before a stage until you approve it (`pipeline.gate`).
//
// The runner is event-driven: a bus tap re-evaluates the run whose current stage session changed. Runs
// are kept in their own table in node.db and survive restarts; a stage cut off by a restart fails (its
// turn completes as `interrupted`), a run waiting at a gate keeps waiting.

import { DatabaseSync } from 'node:sqlite';
import {
  AGENT_KINDS,
  BizziError,
  GLOBAL_CHANNEL,
  PIPELINE_ID_PREFIX,
  newId,
  sessionChannel,
  type AgentKind,
  type ChannelEvent,
  type Logger,
  type PipelineInfo,
  type PipelineSpec,
  type PipelineStageSpec,
  type WorkspaceInfo,
} from '@bizzi/protocol';
import type { AdapterRegistry } from './agents.ts';
import { parseBudget } from './budget.ts';
import type { EventBus } from './bus.ts';
import type { NodeExtension } from './node.ts';
import type { Orchestrator, ReadResult } from './orchestration.ts';
import { oneOf, optString, reqString, type Params } from './params.ts';
import type { Sessions } from './sessions.ts';
import { gitDiff } from './tools.ts';
import type { Workspaces } from './workspaces.ts';

export const MAX_PIPELINE_STAGES = 12;
export const MAX_STAGE_PROMPT = 20_000;
export const MAX_PIPELINE_TASK = 50_000;
/** Each placeholder expands to at most this many characters (~4k tokens, session_read's default). */
export const MAX_PLACEHOLDER_CHARS = 16_000;
const SUMMARY_CHARS = 300;
const STAGE_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;
const FIELDS = ['result', 'diff', 'files'] as const;
type Field = (typeof FIELDS)[number];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pipelines (
  id         TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

/** What's stored per run: the public info plus runner bookkeeping. */
interface Run {
  info: PipelineInfo;
  /** Per stage: the turn started with the stage's prompt (its completion ends the stage). */
  turnIds: (string | null)[];
  /** Per stage: the session channel's last seq before that turn (where to look for its completion). */
  seqs: number[];
  /** The note given when the pending gate was approved, for `{{gate.message}}` of the stage it opened. */
  gateMessage?: string;
  /** Stage indexes whose own gate was approved. */
  approved: number[];
  /** Stage indexes allowed to start over the run's budget cap. */
  overBudget: number[];
}

// --- definitions -----------------------------------------------------------------------------------

/** Validate a pipeline definition from the wire. Placeholders must name known fields and earlier stages. */
export function parsePipelineSpec(v: unknown): PipelineSpec {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new BizziError('bad_request', 'spec must be an object');
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!['stages', 'branch', 'budgetUsd'].includes(k)) throw new BizziError('bad_request', `unknown spec field ${k}`);
  if (!Array.isArray(o.stages) || o.stages.length === 0) throw new BizziError('bad_request', 'spec.stages must be a non-empty array');
  if (o.stages.length > MAX_PIPELINE_STAGES) throw new BizziError('bad_request', `a pipeline has at most ${MAX_PIPELINE_STAGES} stages`);
  const names: string[] = [];
  const stages = o.stages.map((raw, i) => {
    const s = parseStage(raw, i, names);
    names.push(s.name);
    return s;
  });
  const spec: PipelineSpec = { stages };
  if (o.branch !== undefined && o.branch !== null) {
    if (typeof o.branch !== 'string' || !o.branch.trim() || o.branch.length > 200) throw new BizziError('bad_request', 'spec.branch must be a branch name');
    spec.branch = o.branch.trim();
  }
  if (o.budgetUsd !== undefined && o.budgetUsd !== null) {
    if (typeof o.budgetUsd !== 'number' || !Number.isFinite(o.budgetUsd) || o.budgetUsd < 0) throw new BizziError('bad_request', 'spec.budgetUsd must be a non-negative number');
    spec.budgetUsd = o.budgetUsd;
  }
  return spec;
}

function parseStage(raw: unknown, i: number, earlier: readonly string[]): PipelineStageSpec {
  const at = `spec.stages[${i}]`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BizziError('bad_request', `${at} must be an object`);
  const p = raw as Params;
  const allowed = ['name', 'agent', 'model', 'permissionMode', 'effort', 'prompt', 'where', 'gate', 'budget'];
  for (const k of Object.keys(p)) if (!allowed.includes(k)) throw new BizziError('bad_request', `unknown field ${at}.${k}`);
  const name = typeof p.name === 'string' ? p.name.trim() : '';
  if (!STAGE_NAME.test(name)) throw new BizziError('bad_request', `${at}.name must be lowercase letters, digits, - or _ (at most 32)`);
  if (earlier.includes(name)) throw new BizziError('bad_request', `stage name ${name} is used twice`);
  const agent = p.agent;
  if (typeof agent !== 'string' || !(AGENT_KINDS as readonly string[]).includes(agent)) throw new BizziError('bad_request', `${at}.agent must be one of ${AGENT_KINDS.join(', ')}`);
  const prompt = p.prompt;
  if (typeof prompt !== 'string' || !prompt.trim()) throw new BizziError('bad_request', `${at}.prompt is required`);
  if (prompt.length > MAX_STAGE_PROMPT) throw new BizziError('bad_request', `${at}.prompt is longer than ${MAX_STAGE_PROMPT} characters`);
  for (const ph of placeholders(prompt)) checkPlaceholder(ph, i, earlier, at);
  const stage: PipelineStageSpec = { name, agent: agent as AgentKind, prompt };
  for (const k of ['model', 'permissionMode', 'effort'] as const) {
    const v = optString(p, k)?.trim();
    if (v) stage[k] = v;
  }
  const where = oneOf(p, 'where', ['workspace', 'worktree'] as const);
  if (where) stage.where = where;
  if (p.gate !== undefined && p.gate !== null) {
    if (typeof p.gate !== 'boolean') throw new BizziError('bad_request', `${at}.gate must be a boolean`);
    if (p.gate) stage.gate = true;
  }
  const budget = parseBudget(p.budget, `${at}.budget`);
  if (budget) stage.budget = budget;
  return stage;
}

function placeholders(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((m) => m[1]!);
}

function checkPlaceholder(ph: string, index: number, earlier: readonly string[], at: string): void {
  if (ph === 'task' || ph === 'gate.message') return;
  const parts = ph.split('.');
  if (parts[0] === 'previous' && parts.length === 2) {
    if (index === 0) throw new BizziError('bad_request', `${at}: the first stage has no {{${ph}}}`);
    if (parts[1] === 'name' || (FIELDS as readonly string[]).includes(parts[1]!)) return;
  }
  if (parts[0] === 'stages' && parts.length === 3 && (FIELDS as readonly string[]).includes(parts[2]!)) {
    if (!earlier.includes(parts[1]!)) throw new BizziError('bad_request', `${at}: {{${ph}}} must name an earlier stage`);
    return;
  }
  throw new BizziError('bad_request', `${at}: unknown placeholder {{${ph}}} (use task, gate.message, previous.name|result|diff|files or stages.<name>.result|diff|files)`);
}

/** Fill a template. `value` answers `<stage index>.<field>`; unknown names were refused by parsePipelineSpec. */
export async function renderTemplate(
  template: string,
  o: { task: string; gateMessage?: string; stageIndex: number; names: readonly string[]; value: (stage: number, field: Field) => Promise<string> },
): Promise<string> {
  const cache = new Map<string, string>();
  const resolve = async (ph: string): Promise<string> => {
    if (ph === 'task') return o.task;
    if (ph === 'gate.message') return o.gateMessage ?? '';
    const parts = ph.split('.');
    const stage = parts[0] === 'previous' ? o.stageIndex - 1 : o.names.indexOf(parts[1]!);
    const field = (parts[0] === 'previous' ? parts[1] : parts[2]) as Field | 'name';
    if (stage < 0) return '';
    if (field === 'name') return o.names[stage] ?? '';
    const key = `${stage}.${field}`;
    let v = cache.get(key);
    if (v === undefined) {
      v = clip(await o.value(stage, field), MAX_PLACEHOLDER_CHARS);
      cache.set(key, v);
    }
    return v;
  };
  let out = '';
  let last = 0;
  for (const m of template.matchAll(PLACEHOLDER)) {
    out += template.slice(last, m.index) + (await resolve(m[1]!));
    last = m.index! + m[0].length;
  }
  out += template.slice(last);
  // A note given at the gate always reaches the stage, even when the template doesn't place it.
  if (o.gateMessage?.trim() && !placeholders(template).includes('gate.message')) out += `\n\nNote from the user: ${o.gateMessage.trim()}`;
  return out;
}

// --- runner ----------------------------------------------------------------------------------------

export interface PipelinesDeps {
  dbPath: string;
  bus: EventBus;
  sessions: Sessions;
  workspaces: Workspaces;
  registry: AdapterRegistry;
  orchestration: Orchestrator;
  machineId: string;
  logger: Logger;
}

export class Pipelines {
  readonly #d: PipelinesDeps;
  readonly #log: Logger;
  readonly #runs = new Map<string, Run>();
  /** Current stage session id → run id, for the bus tap. */
  readonly #watching = new Map<string, string>();
  /** Per run: the tail of its serialized operations. */
  readonly #chains = new Map<string, Promise<void>>();
  #db?: DatabaseSync;
  #untap?: () => void;
  #closed = false;

  constructor(deps: PipelinesDeps) {
    this.#d = deps;
    this.#log = deps.logger.child({ component: 'pipelines' });
  }

  start(): void {
    if (this.#db) return;
    this.#db = new DatabaseSync(this.#d.dbPath);
    this.#db.exec('PRAGMA busy_timeout = 5000;');
    this.#db.exec(SCHEMA);
    for (const row of this.#db.prepare('SELECT data FROM pipelines ORDER BY created_at').all() as { data: string }[]) {
      try {
        const run = JSON.parse(row.data) as Run;
        this.#runs.set(run.info.id, run);
        this.#watch(run);
      } catch (err) {
        this.#log.log('warn', 'skipping an unreadable pipeline row', { err });
      }
    }
    this.#untap = this.#d.bus.tap((ev) => this.#onEvent(ev));
    // Stages that finished (or were cut off) while the node was down.
    for (const run of this.#runs.values()) if (run.info.status === 'running') this.#schedule(run.info.id);
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#untap?.();
    this.#untap = undefined;
    await Promise.allSettled([...this.#chains.values()]);
    if (this.#db?.isOpen) this.#db.close();
    this.#db = undefined;
  }

  list(filter: { workspaceId?: string } = {}): PipelineInfo[] {
    const out: PipelineInfo[] = [];
    for (const r of this.#runs.values()) if (!filter.workspaceId || r.info.workspaceId === filter.workspaceId) out.push(copy(r.info));
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): PipelineInfo {
    return copy(this.#run(id).info);
  }

  async create(p: { workspaceId: string; spec: unknown; task: unknown; title?: string }): Promise<PipelineInfo> {
    const ws = this.#d.workspaces.get(p.workspaceId);
    const spec = parsePipelineSpec(p.spec);
    if (typeof p.task !== 'string' || !p.task.trim()) throw new BizziError('bad_request', 'task is required');
    if (p.task.length > MAX_PIPELINE_TASK) throw new BizziError('bad_request', `task is longer than ${MAX_PIPELINE_TASK} characters`);
    if (ws.kind === 'dir' && spec.stages.some((s) => s.where === 'worktree')) {
      throw new BizziError('bad_request', `${ws.name} is not a git repository, so no stage can run in a worktree`);
    }
    for (const s of spec.stages) {
      if (!this.#d.registry.select(s.agent, 'structured')) throw new BizziError('agent_unavailable', `${s.agent} has no structured sessions on this machine (stage ${s.name})`);
      this.#d.registry.assertStartable(s.agent, 'structured');
    }
    const now = new Date().toISOString();
    const title = (p.title?.trim() || firstLine(p.task)).slice(0, 200);
    const info: PipelineInfo = {
      id: newId('pl'),
      machineId: this.#d.machineId,
      workspaceId: ws.id,
      title,
      task: p.task,
      spec,
      status: 'running',
      current: 0,
      stages: spec.stages.map((s) => ({ name: s.name, agent: s.agent, status: 'pending' })),
      createdAt: now,
      updatedAt: now,
    };
    if (!info.id.startsWith(PIPELINE_ID_PREFIX)) throw new BizziError('internal', 'pipeline id prefix mismatch');
    const run: Run = { info, turnIds: spec.stages.map(() => null), seqs: spec.stages.map(() => 0), approved: [], overBudget: [] };
    this.#runs.set(info.id, run);
    this.#save(run);
    this.#log.log('info', 'pipeline started', { pipelineId: info.id, stages: spec.stages.length, workspaceId: ws.id });
    await this.#serial(info.id, () => this.#advance(run));
    return copy(run.info);
  }

  /** Answer the pending gate. */
  async gate(id: string, decision: 'approve' | 'reject', message?: string): Promise<PipelineInfo> {
    const run = this.#run(id);
    await this.#serial(id, async () => {
      if (run.info.status !== 'waiting' || !run.info.gate) throw new BizziError('conflict', `pipeline is ${run.info.status}, not waiting at a gate`);
      const { stage, reason } = run.info.gate;
      delete run.info.gate;
      if (decision === 'reject') {
        this.#finish(run, 'cancelled', `rejected at the gate before ${run.info.stages[stage]!.name}${message?.trim() ? `: ${message.trim()}` : ''}`);
        for (let i = stage; i < run.info.stages.length; i++) run.info.stages[i]!.status = 'cancelled';
        this.#save(run);
        return;
      }
      run.info.status = 'running';
      const list = reason === 'budget' ? run.overBudget : run.approved;
      if (!list.includes(stage)) list.push(stage);
      const note = message?.trim();
      if (note) run.gateMessage = note;
      else delete run.gateMessage;
      this.#save(run);
      await this.#advance(run);
    });
    return copy(run.info);
  }

  async cancel(id: string): Promise<PipelineInfo> {
    const run = this.#run(id);
    let stop: string | undefined;
    await this.#serial(id, async () => {
      const st = run.info.status;
      if (st !== 'running' && st !== 'waiting') throw new BizziError('conflict', `pipeline is already ${st}`);
      delete run.info.gate;
      const cur = run.info.stages[run.info.current];
      if (cur?.status === 'running' && cur.sessionId) stop = cur.sessionId;
      for (const s of run.info.stages) if (s.status === 'pending' || s.status === 'running') s.status = 'cancelled';
      if (cur && cur.status === 'cancelled' && cur.startedAt) cur.endedAt = new Date().toISOString();
      this.#finish(run, 'cancelled', 'cancelled');
      this.#save(run);
    });
    if (stop && this.#d.sessions.has(stop)) {
      await this.#d.sessions.stop(stop).catch((err: unknown) => this.#log.log('warn', 'stopping a cancelled stage failed', { sessionId: stop, err }));
    }
    return copy(run.info);
  }

  delete(id: string): void {
    const run = this.#run(id);
    if (run.info.status === 'running' || run.info.status === 'waiting') throw new BizziError('conflict', 'cancel the pipeline first');
    this.#runs.delete(id);
    this.#db?.prepare('DELETE FROM pipelines WHERE id = ?').run(id);
    this.#d.bus.append(GLOBAL_CHANNEL, { type: 'pipeline.removed', data: { pipelineId: id, machineId: this.#d.machineId } });
  }

  // --- internals -------------------------------------------------------------------------------------

  #run(id: string): Run {
    if (typeof id !== 'string' || !id) throw new BizziError('bad_request', 'pipelineId is required');
    const run = this.#runs.get(id);
    if (!run) throw new BizziError('not_found', `pipeline ${id} not found`);
    return run;
  }

  /** Run `fn` after the run's earlier operations; errors propagate to this caller only. */
  #serial(id: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.#chains.get(id) ?? Promise.resolve();
    const next = prev.then(fn);
    const tail = next.catch(() => {});
    this.#chains.set(id, tail);
    void tail.then(() => {
      if (this.#chains.get(id) === tail) this.#chains.delete(id);
    });
    return next;
  }

  #schedule(id: string): void {
    if (this.#closed) return;
    setImmediate(() => {
      if (this.#closed) return;
      const run = this.#runs.get(id);
      if (!run) return;
      this.#serial(id, () => this.#evaluate(run)).catch((err: unknown) => this.#log.log('error', 'pipeline evaluation failed', { pipelineId: id, err }));
    });
  }

  #onEvent(ev: ChannelEvent): void {
    let sessionId: string | undefined;
    if (ev.ch === GLOBAL_CHANNEL) {
      if (ev.type === 'session.updated') sessionId = ev.data.session.id;
      else if (ev.type === 'session.removed') sessionId = ev.data.sessionId;
    } else if (ev.type === 'turn.completed' || ev.type === 'session.status') {
      sessionId = ev.ch.slice('session:'.length);
    }
    const runId = sessionId && this.#watching.get(sessionId);
    if (runId) this.#schedule(runId);
  }

  #watch(run: Run): void {
    for (const s of run.info.stages) if (s.sessionId && this.#watching.get(s.sessionId) === run.info.id) this.#watching.delete(s.sessionId);
    const cur = run.info.stages[run.info.current];
    if (run.info.status === 'running' && cur?.status === 'running' && cur.sessionId) this.#watching.set(cur.sessionId, run.info.id);
  }

  /** Start the current stage, or stop at its gate (or the run's budget). */
  async #advance(run: Run): Promise<void> {
    const info = run.info;
    const i = info.current;
    const spec = info.spec.stages[i]!;
    const spent = this.#spentUsd(run);
    if (info.spec.budgetUsd !== undefined && spent >= info.spec.budgetUsd && !run.overBudget.includes(i)) {
      this.#openGate(run, i, 'budget', `metered spend $${spent.toFixed(2)} reached the pipeline's cap of $${info.spec.budgetUsd.toFixed(2)}; start ${spec.name} anyway?`);
      return;
    }
    if (spec.gate && !run.approved.includes(i)) {
      const prev = i > 0 ? info.stages[i - 1] : undefined;
      this.#openGate(run, i, 'gate', `Start ${spec.name} (${spec.agent})${prev ? ` after ${prev.name}` : ''}?`);
      return;
    }
    await this.#startStage(run, i);
  }

  #openGate(run: Run, stage: number, reason: 'gate' | 'budget', message: string): void {
    run.info.status = 'waiting';
    run.info.gate = { stage, reason, message, since: new Date().toISOString() };
    this.#save(run);
  }

  async #startStage(run: Run, i: number): Promise<void> {
    const info = run.info;
    const spec = info.spec.stages[i]!;
    const stage = info.stages[i]!;
    stage.status = 'running';
    stage.startedAt = new Date().toISOString();
    try {
      const ws = await this.#stageWorkspace(run, spec);
      stage.workspaceId = ws.id;
      const prompt = await renderTemplate(spec.prompt, {
        task: info.task,
        ...(run.gateMessage ? { gateMessage: run.gateMessage } : {}),
        stageIndex: i,
        names: info.spec.stages.map((s) => s.name),
        value: (k, field) => this.#stageValue(run, k, field),
      });
      delete run.gateMessage;
      const params: Parameters<Sessions['create']>[0] = { workspaceId: ws.id, agent: spec.agent, mode: 'structured', title: `${info.title} · ${spec.name}`, group: info.id };
      if (spec.model) params.model = spec.model;
      if (spec.permissionMode) params.permissionMode = spec.permissionMode;
      if (spec.effort) params.effort = spec.effort;
      if (spec.budget) params.budget = spec.budget;
      const session = await this.#d.sessions.create(params);
      stage.sessionId = session.id;
      run.seqs[i] = this.#d.bus.lastSeq(sessionChannel(session.id));
      this.#save(run);
      const { turnId } = await this.#d.sessions.send(session.id, [{ type: 'text', text: prompt }]);
      run.turnIds[i] = turnId;
      this.#save(run);
      this.#log.log('info', 'pipeline stage started', { pipelineId: info.id, stage: spec.name, sessionId: session.id });
    } catch (err) {
      this.#failStage(run, i, err instanceof Error ? err.message : String(err));
      return;
    }
    await this.#evaluate(run);
  }

  async #stageWorkspace(run: Run, spec: PipelineStageSpec): Promise<WorkspaceInfo> {
    const info = run.info;
    if (spec.where !== 'worktree') return this.#d.workspaces.get(info.workspaceId);
    if (info.worktreeId) {
      try {
        return this.#d.workspaces.get(info.worktreeId);
      } catch {
        throw new BizziError('not_found', "the pipeline's worktree was removed");
      }
    }
    const branch = info.spec.branch ?? `pipeline/${slug(info.title)}-${info.id.slice(-6).toLowerCase()}`;
    const ws = await this.#d.workspaces.createWorktree({ workspaceId: info.workspaceId, branch });
    info.worktreeId = ws.id;
    return ws;
  }

  /** Check the current stage: finished, failed, or still going. */
  async #evaluate(run: Run): Promise<void> {
    const info = run.info;
    if (info.status !== 'running') return;
    const i = info.current;
    const stage = info.stages[i]!;
    const turnId = run.turnIds[i];
    if (stage.status !== 'running' || !stage.sessionId || !turnId) return;
    const sessions = this.#d.sessions;
    if (!sessions.has(stage.sessionId)) {
      this.#failStage(run, i, 'the stage session was deleted');
      return;
    }
    const s = sessions.get(stage.sessionId).session;
    const completed = this.#turnCompleted(stage.sessionId, turnId, run.seqs[i] ?? 0);
    if (!completed) {
      if (s.status === 'ended' || s.status === 'failed') this.#failStage(run, i, `the stage session ${s.status} before finishing its turn`);
      return;
    }
    if (sessions.isBusy(stage.sessionId) && s.status !== 'ended' && s.status !== 'failed') return;
    if (completed.stopReason !== 'end_turn') {
      const why = completed.stopReason === 'interrupted' ? 'the turn was interrupted' : `the turn ended with ${completed.stopReason}`;
      this.#failStage(run, i, `${why}${completed.error ? `: ${completed.error}` : ''}`);
      return;
    }
    const summary = await this.#d.orchestration.summarize(stage.sessionId).catch(() => undefined);
    stage.status = 'done';
    stage.endedAt = new Date().toISOString();
    if (summary?.finalMessage) stage.summary = clip(summary.finalMessage.trim(), SUMMARY_CHARS);
    stage.changedFiles = summary?.changedFiles.length ?? 0;
    this.#log.log('info', 'pipeline stage done', { pipelineId: info.id, stage: stage.name });
    if (i + 1 >= info.stages.length) {
      this.#finish(run, 'done');
      this.#save(run);
      return;
    }
    info.current = i + 1;
    this.#save(run);
    await this.#advance(run);
  }

  #turnCompleted(sessionId: string, turnId: string, since: number): { stopReason: string; error?: string } | undefined {
    for (const ev of this.#d.bus.replay(sessionChannel(sessionId), since)) {
      if (ev.type === 'turn.completed' && ev.data.turnId === turnId) return ev.data.error ? { stopReason: ev.data.stopReason, error: ev.data.error } : { stopReason: ev.data.stopReason };
    }
    return undefined;
  }

  #failStage(run: Run, i: number, error: string): void {
    const stage = run.info.stages[i]!;
    stage.status = 'failed';
    stage.error = error;
    stage.endedAt = new Date().toISOString();
    for (let k = i + 1; k < run.info.stages.length; k++) run.info.stages[k]!.status = 'cancelled';
    this.#finish(run, 'failed', `stage ${stage.name}: ${error}`);
    this.#save(run);
    this.#log.log('warn', 'pipeline stage failed', { pipelineId: run.info.id, stage: stage.name, error });
  }

  #finish(run: Run, status: 'done' | 'failed' | 'cancelled', error?: string): void {
    run.info.status = status;
    if (error && status !== 'done') run.info.error = error;
    delete run.info.gate;
  }

  /** A placeholder's value from an earlier stage, read now (so talk at a gate counts). */
  async #stageValue(run: Run, k: number, field: Field): Promise<string> {
    const stage = run.info.stages[k];
    if (!stage?.sessionId || !this.#d.sessions.has(stage.sessionId)) return '';
    const read: ReadResult = await this.#d.orchestration.summarize(stage.sessionId, { maxTokens: MAX_PLACEHOLDER_CHARS / 4 });
    if (field === 'result') return read.finalMessage ?? '';
    if (field === 'files') return read.changedFiles.map((f) => `${f.change} ${f.path}`).join('\n');
    // diff: the stage workspace's working tree against HEAD, plus new files git diff doesn't show.
    let ws: WorkspaceInfo;
    try {
      ws = this.#d.workspaces.get(stage.workspaceId ?? '');
    } catch {
      return '';
    }
    let diff = '';
    if (ws.kind !== 'dir') diff = (await gitDiff(ws, {}).catch(() => ({ diff: '' }))).diff;
    for (const f of read.changedFiles.filter((x) => x.change === 'created').slice(0, 20)) {
      if (diff.includes(`b/${f.path}\n`)) continue;
      const one = await this.#d.orchestration.summarize(stage.sessionId, { detail: 'diff', path: f.diffRef, maxTokens: 1000 }).catch(() => undefined);
      diff += one?.diff ? (one.diff.endsWith('\n') ? one.diff : `${one.diff}\n`) : `new file: ${f.path}\n`;
    }
    return diff;
  }

  #spentUsd(run: Run): number {
    let usd = 0;
    for (const s of run.info.stages) if (s.sessionId && this.#d.sessions.has(s.sessionId)) usd += this.#d.sessions.spent(s.sessionId).tree.usd;
    return usd;
  }

  #save(run: Run): void {
    run.info.updatedAt = new Date().toISOString();
    this.#db?.prepare('INSERT INTO pipelines (id, data, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').run(run.info.id, JSON.stringify(run), run.info.createdAt);
    this.#watch(run);
    this.#d.bus.append(GLOBAL_CHANNEL, { type: 'pipeline.updated', data: { pipeline: copy(run.info) } });
  }
}

function copy(info: PipelineInfo): PipelineInfo {
  return structuredClone(info);
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 16))}\n… [truncated]`;
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0]!.trim();
  return line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line || 'Pipeline';
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'run'
  );
}

/** The core's built-in `pipeline*` handlers, registered like an extension. */
export function pipelinesExtension(pipelines: Pipelines): NodeExtension {
  return {
    methods: {
      'pipelines.list': (p: Params) => {
        const workspaceId = optString(p, 'workspaceId');
        return { pipelines: pipelines.list(workspaceId ? { workspaceId } : {}) };
      },
      'pipeline.start': async (p: Params) => {
        const title = optString(p, 'title');
        return { pipeline: await pipelines.create({ workspaceId: reqString(p, 'workspaceId'), spec: p.spec, task: p.task, ...(title ? { title } : {}) }) };
      },
      'pipeline.get': (p: Params) => ({ pipeline: pipelines.get(reqString(p, 'pipelineId')) }),
      'pipeline.gate': async (p: Params) => {
        const decision = oneOf(p, 'decision', ['approve', 'reject'] as const);
        if (!decision) throw new BizziError('bad_request', 'decision is required');
        return { pipeline: await pipelines.gate(reqString(p, 'pipelineId'), decision, optString(p, 'message')) };
      },
      'pipeline.cancel': async (p: Params) => ({ pipeline: await pipelines.cancel(reqString(p, 'pipelineId')) }),
      'pipeline.delete': (p: Params) => {
        pipelines.delete(reqString(p, 'pipelineId'));
        return {};
      },
    },
    start: () => pipelines.start(),
    stop: () => pipelines.close(),
  };
}
