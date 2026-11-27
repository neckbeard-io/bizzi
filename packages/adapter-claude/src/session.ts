// One bizzi structured session = one SDK query in streaming-input mode.

import { randomUUID } from 'node:crypto';
import { BizziError, newId } from '@bizzi/protocol';
import type {
  AccountUsage,
  AdapterSession,
  ApprovalDecision,
  ApprovalResolution,
  EmitFn,
  InputBlock,
  Logger,
  PlanItem,
  QuestionAnswers,
  QuestionItem,
  SessionEventBody,
  StopReason,
  Usage,
} from '@bizzi/protocol';
import type {
  CanUseTool,
  ElicitationResult,
  OnElicitation,
  PermissionResult,
  PermissionUpdate,
  SDKMessage,
  SDKRateLimitInfo,
  SDKResultMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import {
  addUsage,
  approvalKind,
  backgroundTasks,
  askUserQuestionAnswers,
  askUserQuestionItems,
  elicitationForm,
  isEffort,
  isPermissionMode,
  normStatus,
  resultTokens,
  serverToolResult,
  sessionUsage,
  stopReasonOf,
  todoItems,
  toolKind,
  toolResultText,
  toolTitle,
  toUserContent,
  trimOutput,
  unifiedDiff,
} from './mapping.ts';
import type { PatchHunk } from './mapping.ts';
import { PushQueue } from './queue.ts';
import type { ClaudeQuery } from './types.ts';
import { claudeAccount, contextFromSdk, PlanUsage, readPlanUsage } from './usage.ts';
import type { BizziInjection, ClaudeAccount } from './usage.ts';

interface ActiveTurn {
  turnId: string;
  /** uuids of every SDK user message sent for this bizzi turn (the send + any steers). */
  uuids: Set<string>;
  consumed: Set<string>;
  interrupted: boolean;
  usage?: Usage;
  graceTimer?: ReturnType<typeof setTimeout>;
}

interface PendingApproval {
  toolName: string;
  toolId: string;
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
  resolve: (r: PermissionResult) => void;
}

type QuestionOutcome = 'answered' | 'declined' | 'cancelled';

interface PendingQuestion {
  /** Settle the native request (AskUserQuestion permission or MCP elicitation). */
  settle: (answers: QuestionAnswers | undefined, outcome: QuestionOutcome) => void;
}

interface BlockOrdinals {
  text: number;
  thinking: number;
  doneText: number;
  doneThinking: number;
  /** stream content-block index -> bizzi messageId */
  byIndex: Map<number, string>;
}

export interface SessionConfig {
  maxToolOutputChars: number;
  interruptGraceMs: number;
  /**
   * Resumed or forked: the CLI restores the conversation's cumulative cost, so the cost of the
   * first turn can't be told apart from the history's and is left out of that turn's usage.
   */
  resumed?: boolean;
  allowBypassPermissions: boolean;
  /** What bizzi injected (system-prompt append, MCP servers), for the "bizzi overhead" context row. */
  injection?: BizziInjection;
  /** API-key fingerprint (usage.ts `keyFingerprint`), the account id for key logins. */
  keyFingerprint?: string;
  /** Minimum interval between experimental plan-usage queries. Default 5 min. */
  planQueryIntervalMs?: number;
  /** Minimum interval between mid-turn context refreshes. Default 1.5 s. */
  contextRefreshMs?: number;
}

type AnyMsg = SDKMessage & Record<string, unknown>;

const DROP_SYSTEM = new Set(['thinking_tokens', 'hook_progress']);

export class ClaudeSession implements AdapterSession {
  readonly #emit: EmitFn;
  readonly #log: Logger;
  readonly #cfg: SessionConfig;
  readonly #input = new PushQueue<SDKUserMessage>();
  #q: ClaudeQuery | undefined;
  #ref: string | undefined;
  /** The last `background.updated` sent, so an unchanged set (an ambient task coming or going) isn't resent. */
  #backgroundKey = '';
  #state: 'running' | 'stopping' | 'stopped' | 'dead' = 'running';
  #active: ActiveTurn | null = null;
  #waiting: { turnId: string; msg: SDKUserMessage }[] = [];
  #orphaned = new Set<string>();
  #approvals = new Map<string, PendingApproval>();
  #questions = new Map<string, PendingQuestion>();
  #blocks = new Map<string, BlockOrdinals>();
  /** Current streamed API message id per parent tool ('' = main loop). */
  #streamMsgIds = new Map<string, string>();
  #tools = new Map<string, { name: string; input: unknown }>();
  #denied = new Set<string>();
  #cancelled = new Set<string>();
  #plan: (PlanItem & { id?: string })[] = [];
  #subagents = new Set<string>();
  #info: { model?: string; permissionMode?: string; effort?: string } = {};
  #lastCost = 0;
  #costBaselineKnown = true;
  #stampsUuids = false;
  #sentUuids = new Set<string>();
  #stderr: string[] = [];
  #done: Promise<void> | undefined;
  /** undefined = not resolved yet · null = no usable identity (nothing is emitted). */
  #account: ClaudeAccount | null | undefined;
  #planUsage = new PlanUsage();
  #sessionCost: number | undefined;
  #lastPlanQuery = 0;
  #ctxBusy = false;
  #ctxAgain = false;
  #ctxTimer: ReturnType<typeof setTimeout> | undefined;
  #ctxLast = 0;
  #ctxKey: string | undefined;
  /** The main thread's latest API message id: a new one means the window grew. */
  #ctxMsgId: string | undefined;

  constructor(emit: EmitFn, log: Logger, cfg: SessionConfig, ref: string | undefined) {
    this.#emit = emit;
    this.#log = log;
    this.#cfg = cfg;
    this.#ref = ref;
    this.#costBaselineKnown = !cfg.resumed;
  }

  /** The prompt iterable handed to the SDK. */
  get input(): AsyncIterable<SDKUserMessage> {
    return this.#input;
  }

  /** Called by the adapter once the query exists; starts pumping SDK messages. */
  attach(q: ClaudeQuery, initial: { model?: string; permissionMode?: string; effort?: string }): void {
    this.#q = q;
    this.#info = { ...initial };
    this.#emit({ type: 'session.info', data: { agentSessionRef: this.#ref, ...initial } });
    this.#done = this.#pump(q);
    void this.#loadCommands(q);
  }

  /** Resolves when the SDK stream has ended (tests). */
  get done(): Promise<void> {
    return this.#done ?? Promise.resolve();
  }

  onStderr(data: string): void {
    for (const line of data.split('\n')) {
      if (!line.trim()) continue;
      this.#stderr.push(line);
      if (this.#stderr.length > 30) this.#stderr.shift();
    }
    this.#log.log('debug', 'claude stderr', { data: data.slice(0, 2000) });
  }

  agentSessionRef(): string | undefined {
    return this.#ref;
  }

  // ---------------------------------------------------------------- turns

  async send(turnId: string, input: InputBlock[]): Promise<void> {
    this.#assertRunning();
    const msg = this.#userMessage(input);
    if (this.#active) {
      this.#waiting.push({ turnId, msg });
      return;
    }
    this.#begin(turnId, msg);
  }

  async steer(input: InputBlock[]): Promise<void> {
    this.#assertRunning();
    const turn = this.#active;
    if (!turn) throw new BizziError('conflict', 'no turn in flight to steer');
    // 'next' folds the message into the running turn at the next tool boundary.
    const msg = this.#userMessage(input, 'next');
    turn.uuids.add(msg.uuid as string);
    this.#input.push(msg);
  }

  async interrupt(): Promise<void> {
    this.#cancelPending('Interrupted by the user.');
    const turn = this.#active;
    if (!turn || this.#state !== 'running') return;
    turn.interrupted = true;
    try {
      await this.#q?.interrupt();
    } catch (e) {
      this.#log.log('warn', 'interrupt failed', { error: String(e) });
    }
    if (this.#active === turn && !turn.graceTimer) {
      turn.graceTimer = setTimeout(() => {
        if (this.#active !== turn) return;
        for (const u of turn.uuids) this.#orphaned.add(u);
        this.#complete(turn, 'interrupted');
      }, this.#cfg.interruptGraceMs);
      turn.graceTimer.unref?.();
    }
  }

  async set(opts: { model?: string; permissionMode?: string; effort?: string }): Promise<void> {
    this.#assertRunning();
    const q = this.#q!;
    const changed: { model?: string; permissionMode?: string; effort?: string } = {};
    if (opts.permissionMode !== undefined) {
      if (!isPermissionMode(opts.permissionMode)) {
        throw new BizziError('bad_request', `unknown permission mode: ${opts.permissionMode}`);
      }
      if (opts.permissionMode === 'bypassPermissions' && !this.#cfg.allowBypassPermissions) {
        throw new BizziError('unsupported', 'bypassPermissions is disabled for this adapter');
      }
      await q.setPermissionMode(opts.permissionMode);
      changed.permissionMode = opts.permissionMode;
    }
    if (opts.model !== undefined) {
      await q.setModel(opts.model || undefined);
      changed.model = opts.model;
    }
    if (opts.effort !== undefined) {
      if (!isEffort(opts.effort)) throw new BizziError('bad_request', `unknown effort level: ${opts.effort}`);
      await q.applyFlagSettings({ effortLevel: opts.effort });
      changed.effort = opts.effort;
    }
    if (Object.keys(changed).length) {
      Object.assign(this.#info, changed);
      this.#emit({ type: 'session.info', data: changed });
    }
  }

  async stop(): Promise<void> {
    if (this.#state === 'stopped' || this.#state === 'stopping') return this.#done;
    if (this.#state === 'dead') {
      this.#state = 'stopped';
      return;
    }
    this.#state = 'stopping';
    this.#clearContextTimer();
    this.#cancelPending('Session stopped.');
    this.#failAllTurns('interrupted');
    this.#input.end();
    try {
      this.#q?.close();
    } catch (e) {
      this.#log.log('debug', 'close failed', { error: String(e) });
    }
    this.#emit({ type: 'session.status', data: { status: 'ended' } });
    this.#state = 'stopped';
  }

  #assertRunning(): void {
    if (this.#state === 'dead') throw new BizziError('agent_unavailable', 'Claude Code process has exited');
    if (this.#state !== 'running') throw new BizziError('conflict', 'session is stopped');
  }

  #userMessage(input: InputBlock[], priority?: 'next'): SDKUserMessage {
    const uuid = randomUUID();
    this.#sentUuids.add(uuid);
    const msg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: toUserContent(input) },
      parent_tool_use_id: null,
      uuid: uuid as SDKUserMessage['uuid'],
    };
    if (priority) msg.priority = priority;
    return msg;
  }

  #begin(turnId: string, msg: SDKUserMessage): void {
    this.#active = { turnId, uuids: new Set([msg.uuid as string]), consumed: new Set(), interrupted: false };
    this.#input.push(msg);
  }

  #complete(turn: ActiveTurn, stopReason: StopReason, error?: string): void {
    if (turn.graceTimer) clearTimeout(turn.graceTimer);
    if (this.#active === turn) this.#active = null;
    const data: { turnId: string; stopReason: StopReason; usage?: Usage; error?: string } = {
      turnId: turn.turnId,
      stopReason,
    };
    if (turn.usage) data.usage = turn.usage;
    if (error) data.error = error;
    this.#emit({ type: 'turn.completed', data });
    const next = this.#state === 'running' ? this.#waiting.shift() : undefined;
    if (next) this.#begin(next.turnId, next.msg);
  }

  #failAllTurns(stopReason: StopReason, error?: string): void {
    const waiting = this.#waiting.splice(0);
    if (this.#active) this.#complete(this.#active, stopReason, error);
    for (const w of waiting) {
      this.#emit({ type: 'turn.completed', data: error ? { turnId: w.turnId, stopReason, error } : { turnId: w.turnId, stopReason } });
    }
  }

  // ---------------------------------------------------------------- approvals

  readonly canUseTool: CanUseTool = (toolName, input, o) => {
    if (this.#state !== 'running') {
      return Promise.resolve({ behavior: 'deny', message: 'Session is not running.', interrupt: true });
    }
    const toolId = o.toolUseID;
    this.#ensureToolStarted(toolId, toolName, input, undefined);
    if (toolName === 'AskUserQuestion') return this.#askUserQuestion(toolId, input, o.signal);
    const approvalId = newId('ap');
    return new Promise<PermissionResult>((resolve) => {
      this.#approvals.set(approvalId, { toolName, toolId, input, suggestions: o.suggestions, resolve });
      o.signal?.addEventListener(
        'abort',
        () => this.#settle(approvalId, 'cancelled', { behavior: 'deny', message: 'Permission request cancelled.' }, 'agent'),
        { once: true },
      );
      const description = o.description ?? o.decisionReason;
      this.#emit({
        type: 'approval.requested',
        data: {
          approvalId,
          toolId,
          kind: approvalKind(toolName),
          title: o.title ?? toolTitle(toolName, input),
          ...(description ? { description } : {}),
          input,
          editable: true,
          options: o.suppressAlwaysAllowRule ? ['allow', 'deny'] : ['allow', 'allow_always', 'deny'],
        },
      });
    });
  };

  async respondApproval(approvalId: string, decision: ApprovalDecision): Promise<void> {
    const p = this.#approvals.get(approvalId);
    if (!p) throw new BizziError('not_found', `no pending approval ${approvalId}`);
    if (decision.editedInput !== undefined && (typeof decision.editedInput !== 'object' || decision.editedInput === null || Array.isArray(decision.editedInput))) {
      throw new BizziError('bad_request', 'editedInput must be an object');
    }
    if (decision.decision === 'deny') {
      this.#settle(approvalId, 'deny', { behavior: 'deny', message: decision.message || 'The user denied this action.' });
      return;
    }
    const updatedInput = (decision.editedInput as Record<string, unknown> | undefined) ?? p.input;
    const result: PermissionResult = { behavior: 'allow', updatedInput };
    if (decision.decision === 'allow_always') {
      result.updatedPermissions = p.suggestions?.length ? p.suggestions : fallbackRule(p.toolName, p.input);
    }
    this.#settle(approvalId, decision.decision, result);
  }

  #settle(approvalId: string, decision: ApprovalResolution, result: PermissionResult, by?: string): void {
    const p = this.#approvals.get(approvalId);
    if (!p) return;
    this.#approvals.delete(approvalId);
    if (decision === 'cancelled') this.#cancelled.add(p.toolId);
    else if (result.behavior === 'deny') this.#denied.add(p.toolId);
    p.resolve(result);
    this.#emit({ type: 'approval.resolved', data: by ? { approvalId, decision, by } : { approvalId, decision } });
  }

  /** Interrupt / stop / process death: every pending approval and question ends as canceled. */
  #cancelPending(message: string): void {
    for (const id of [...this.#approvals.keys()]) {
      this.#settle(id, 'cancelled', { behavior: 'deny', message, interrupt: true }, 'bizzi');
    }
    for (const id of [...this.#questions.keys()]) this.#resolveQuestion(id, undefined, 'cancelled');
  }

  // ---------------------------------------------------------------- questions

  /** AskUserQuestion: a structured question; the answers go back in the tool's updatedInput. */
  #askUserQuestion(toolId: string, input: Record<string, unknown>, signal: AbortSignal | undefined): Promise<PermissionResult> {
    const items = askUserQuestionItems(input);
    return new Promise<PermissionResult>((resolve) => {
      this.#openQuestion(items.length ? items : [{ id: 'answer', text: toolTitle('AskUserQuestion', input), allowText: true }], signal, (answers, outcome) => {
        if (answers) {
          resolve({ behavior: 'allow', updatedInput: { ...input, answers: askUserQuestionAnswers(input, answers) } });
        } else if (outcome === 'cancelled') {
          this.#cancelled.add(toolId);
          resolve({ behavior: 'deny', message: 'The question was cancelled.', interrupt: true });
        } else {
          this.#denied.add(toolId);
          resolve({ behavior: 'deny', message: 'The user declined to answer.' });
        }
      });
    });
  }

  /** MCP elicitation (form or URL mode) as a question. */
  readonly onElicitation: OnElicitation = (req, o) => {
    if (this.#state !== 'running') return Promise.resolve({ action: 'cancel' });
    const form = elicitationForm(req);
    return new Promise<ElicitationResult>((resolve) => {
      this.#openQuestion(form.items, o.signal, (answers, outcome) => {
        if (!answers) return resolve({ action: outcome === 'cancelled' ? 'cancel' : 'decline' });
        const content = form.content(answers);
        if (content === null) return resolve({ action: 'decline' });
        resolve(req.mode === 'url' ? { action: 'accept' } : { action: 'accept', content: content as ElicitationResult['content'] });
      });
    });
  };

  #openQuestion(items: QuestionItem[], signal: AbortSignal | undefined, settle: PendingQuestion['settle']): void {
    const questionId = newId('q');
    this.#questions.set(questionId, { settle });
    signal?.addEventListener('abort', () => this.#resolveQuestion(questionId, undefined, 'cancelled'), { once: true });
    const first = items[0];
    this.#emit({
      type: 'question.asked',
      data: {
        questionId,
        text: first?.text ?? 'Question',
        ...(first?.options?.length ? { options: first.options.map((o) => o.label) } : {}),
        questions: items,
      },
    });
    this.#emit({ type: 'session.status', data: { status: 'waiting_input', prompt: 'input' } });
  }

  async respondQuestion(questionId: string, answers: QuestionAnswers | undefined): Promise<void> {
    if (!this.#questions.has(questionId)) throw new BizziError('not_found', `no pending question ${questionId}`);
    if (answers !== undefined) {
      const ok =
        typeof answers === 'object' &&
        answers !== null &&
        !Array.isArray(answers) &&
        Object.values(answers).every((v) => typeof v === 'string' || (Array.isArray(v) && v.every((x) => typeof x === 'string')));
      if (!ok) throw new BizziError('bad_request', 'answers must map question ids to a string or string[]');
    }
    this.#resolveQuestion(questionId, answers, answers ? 'answered' : 'declined');
  }

  #resolveQuestion(questionId: string, answers: QuestionAnswers | undefined, outcome: QuestionOutcome): void {
    const q = this.#questions.get(questionId);
    if (!q) return;
    this.#questions.delete(questionId);
    q.settle(answers, outcome);
    this.#emit({ type: 'question.resolved', data: answers ? { questionId, answers } : { questionId, cancelled: true } });
    if (!this.#questions.size && this.#state === 'running') {
      // A question between turns (e.g. an MCP elicitation) leaves the session idle.
      const status = this.#approvals.size ? 'waiting_approval' : this.#active ? 'running' : 'idle';
      this.#emit({ type: 'session.status', data: { status } });
    }
  }

  // ---------------------------------------------------------------- SDK stream

  async #pump(q: ClaudeQuery): Promise<void> {
    let failure: string | undefined;
    try {
      for await (const m of q) {
        try {
          this.#handle(m as AnyMsg);
        } catch (e) {
          this.#log.log('error', 'failed to map SDK message', { error: String(e), type: m.type });
          this.#emit({ type: 'agent.raw', data: { agent: 'claude', payload: m } });
        }
      }
    } catch (e) {
      failure = (e as Error)?.message ?? String(e);
    }
    if (this.#state !== 'running') return;
    this.#die(failure ?? 'Claude Code process exited unexpectedly');
  }

  #die(reason: string): void {
    this.#state = 'dead';
    this.#clearContextTimer();
    const tail = this.#stderr.slice(-5).join('\n');
    const message = tail && !reason.includes(tail) ? `${reason}\n${tail}` : reason;
    this.#log.log('error', 'claude process died', { reason: message });
    this.#cancelPending('Claude Code process exited.');
    this.#input.end();
    this.#emit({ type: 'error', data: { message, code: 'agent_exited', fatal: true } });
    this.#failAllTurns('error', message);
    this.#emit({ type: 'session.status', data: { status: 'failed', reason: message } });
  }

  #raw(m: unknown): void {
    this.#emit({ type: 'agent.raw', data: { agent: 'claude', payload: m } });
  }

  #noteConsumed(m: AnyMsg): void {
    const list = Array.isArray(m.user_message_uuids)
      ? (m.user_message_uuids as string[])
      : typeof m.user_message_uuid === 'string'
        ? [m.user_message_uuid]
        : undefined;
    if (!list) return;
    this.#stampsUuids = true;
    if (this.#active) for (const u of list) if (this.#active.uuids.has(u)) this.#active.consumed.add(u);
  }

  #handle(m: AnyMsg): void {
    this.#noteConsumed(m);
    switch (m.type) {
      case 'system':
        return this.#onSystem(m);
      case 'stream_event':
        return this.#onStream(m);
      case 'assistant':
        return this.#onAssistant(m);
      case 'user':
        return this.#onUser(m);
      case 'result':
        return this.#onResult(m as unknown as SDKResultMessage);
      case 'tool_progress': {
        if (m.heartbeat) return;
        const secs = Math.round(Number(m.elapsed_time_seconds) || 0);
        this.#emit({ type: 'tool.updated', data: { toolId: String(m.tool_use_id), progress: `running ${secs}s` } });
        return;
      }
      case 'rate_limit_event':
        this.#planUsage.applyRateLimit(m.rate_limit_info as SDKRateLimitInfo);
        this.#emitAccount();
        return;
      case 'command_lifecycle' as string:
        return; // per-message queued/started/completed; turn tracking uses result uuids instead
      default:
        return this.#raw(m);
    }
  }

  #onSystem(m: AnyMsg): void {
    switch (m.subtype) {
      case 'init': {
        const info: SessionEventBody & { type: 'session.info' } = { type: 'session.info', data: {} };
        const sid = String(m.session_id);
        if (sid !== this.#ref) {
          this.#ref = sid;
          info.data.agentSessionRef = sid;
        }
        if (typeof m.model === 'string' && m.model !== this.#info.model) info.data.model = this.#info.model = m.model;
        if (typeof m.permissionMode === 'string' && m.permissionMode !== this.#info.permissionMode) {
          info.data.permissionMode = this.#info.permissionMode = m.permissionMode;
        }
        if (typeof m.effort === 'string' && m.effort !== this.#info.effort) info.data.effort = this.#info.effort = m.effort;
        if (Object.keys(info.data).length) this.#emit(info);
        return;
      }
      case 'status': {
        if (typeof m.permissionMode === 'string' && m.permissionMode !== this.#info.permissionMode) {
          this.#info.permissionMode = m.permissionMode;
          this.#emit({ type: 'session.info', data: { permissionMode: m.permissionMode } });
        }
        if (m.status === 'compacting' || m.compact_result) this.#raw(m);
        return;
      }
      case 'task_started': {
        if (m.task_type === 'local_agent' || typeof m.subagent_type === 'string') {
          const id = String(m.task_id);
          this.#subagents.add(id);
          this.#emit({
            type: 'subagent.started',
            data: {
              subagentId: id,
              ...(typeof m.subagent_type === 'string' ? { name: m.subagent_type } : {}),
              ...(typeof m.description === 'string' ? { description: m.description } : {}),
              ...(typeof m.tool_use_id === 'string' ? { parentToolId: m.tool_use_id } : {}),
            },
          });
          return;
        }
        return this.#raw(m);
      }
      case 'task_progress': {
        if (typeof m.tool_use_id === 'string' && (m.summary || m.description)) {
          const progress = [m.summary ?? m.description, m.last_tool_name ? `(${String(m.last_tool_name)})` : '']
            .filter(Boolean)
            .join(' ');
          this.#emit({ type: 'tool.updated', data: { toolId: m.tool_use_id, progress } });
          return;
        }
        return this.#raw(m);
      }
      case 'task_updated': {
        const status = (m.patch as { status?: string } | undefined)?.status;
        const id = String(m.task_id);
        if (this.#subagents.has(id) && (status === 'completed' || status === 'failed' || status === 'killed')) {
          this.#finishSubagent(id, status === 'completed' ? 'ok' : status === 'failed' ? 'error' : 'cancelled');
          return;
        }
        return this.#raw(m);
      }
      case 'task_notification': {
        const id = String(m.task_id);
        if (this.#subagents.has(id)) {
          this.#finishSubagent(id, m.status === 'completed' ? 'ok' : m.status === 'failed' ? 'error' : 'cancelled');
          return;
        }
        return this.#raw(m);
      }
      case 'compact_boundary': {
        const meta = m.compact_metadata as { pre_tokens?: unknown; post_tokens?: unknown } | undefined;
        const data: { before?: number; after?: number } = {};
        if (typeof meta?.pre_tokens === 'number') data.before = meta.pre_tokens;
        if (typeof meta?.post_tokens === 'number') data.after = meta.post_tokens;
        this.#emit({ type: 'context.compacted', data });
        this.#ctxKey = undefined; // the bar now shows `after`: always send the refreshed figure
        void this.#refreshContext();
        return;
      }
      case 'background_tasks_changed': {
        // A level signal (the whole set each time); the core keeps it on the session for lists.
        const tasks = backgroundTasks(m.tasks);
        const key = tasks.map((t) => `${t.id}\u0000${t.description}`).join('\u0001');
        if (key === this.#backgroundKey) return;
        this.#backgroundKey = key;
        this.#emit({ type: 'background.updated', data: { tasks } });
        return;
      }
      case 'permission_denied': {
        if (typeof m.tool_use_id === 'string') this.#denied.add(m.tool_use_id);
        return this.#raw(m);
      }
      default:
        if (DROP_SYSTEM.has(String(m.subtype))) return;
        return this.#raw(m);
    }
  }

  #finishSubagent(id: string, status: 'ok' | 'error' | 'cancelled'): void {
    if (!this.#subagents.delete(id)) return;
    this.#emit({ type: 'subagent.completed', data: { subagentId: id, status } });
  }

  #ordinals(apiMsgId: string): BlockOrdinals {
    let o = this.#blocks.get(apiMsgId);
    if (!o) {
      o = { text: 0, thinking: 0, doneText: 0, doneThinking: 0, byIndex: new Map() };
      this.#blocks.set(apiMsgId, o);
      if (this.#blocks.size > 200) this.#blocks.delete(this.#blocks.keys().next().value!);
    }
    return o;
  }

  #onStream(m: AnyMsg): void {
    const parent = typeof m.parent_tool_use_id === 'string' && m.parent_tool_use_id ? m.parent_tool_use_id : undefined;
    const key = parent ?? '';
    const pt = parent ? { parentToolId: parent } : {};
    const ev = m.event as { type: string; index?: number; message?: { id?: string }; content_block?: { type?: string }; delta?: Record<string, unknown> };
    const streamMsgId = this.#streamMsgIds.get(key);
    switch (ev.type) {
      case 'message_start':
        if (ev.message?.id) this.#streamMsgIds.set(key, ev.message.id);
        else this.#streamMsgIds.delete(key);
        return;
      case 'content_block_start': {
        if (!streamMsgId || ev.index === undefined) return;
        const o = this.#ordinals(streamMsgId);
        const t = ev.content_block?.type;
        if (t === 'text') o.byIndex.set(ev.index, `${streamMsgId}:t${o.text++}`);
        else if (t === 'thinking') o.byIndex.set(ev.index, `${streamMsgId}:r${o.thinking++}`);
        return;
      }
      case 'content_block_delta': {
        if (!streamMsgId || ev.index === undefined || !ev.delta) return;
        const messageId = this.#ordinals(streamMsgId).byIndex.get(ev.index);
        if (!messageId) return;
        if (ev.delta.type === 'text_delta' && typeof ev.delta.text === 'string' && ev.delta.text) {
          this.#emit({ type: 'message.delta', data: { messageId, role: 'assistant', text: ev.delta.text, ...pt } });
        } else if (ev.delta.type === 'thinking_delta' && typeof ev.delta.thinking === 'string' && ev.delta.thinking) {
          this.#emit({ type: 'reasoning.delta', data: { messageId, text: ev.delta.thinking, ...pt } });
        }
        return;
      }
      default:
        return;
    }
  }

  #onAssistant(m: AnyMsg): void {
    const msg = m.message as { id?: string; content?: unknown[] };
    const parent = typeof m.parent_tool_use_id === 'string' ? m.parent_tool_use_id : undefined;
    const apiId = msg.id ?? String(m.uuid);
    const pt = parent ? { parentToolId: parent } : {};
    const unmapped: unknown[] = [];
    for (const raw of msg.content ?? []) {
      const b = raw as { type?: string; [k: string]: unknown };
      switch (b.type) {
        case 'text': {
          const o = this.#ordinals(apiId);
          const messageId = `${apiId}:t${o.doneText++}`;
          this.#emit({ type: 'message.completed', data: { messageId, role: 'assistant', text: String(b.text ?? ''), ...pt } });
          break;
        }
        case 'thinking': {
          const o = this.#ordinals(apiId);
          const messageId = `${apiId}:r${o.doneThinking++}`;
          if (typeof b.thinking === 'string' && b.thinking) {
            this.#emit({ type: 'reasoning.completed', data: { messageId, text: b.thinking, ...pt } });
          }
          break;
        }
        case 'redacted_thinking':
          break;
        case 'tool_use':
        case 'server_tool_use':
        case 'mcp_tool_use':
          this.#ensureToolStarted(String(b.id), String(b.name), b.input, parent);
          break;
        default:
          if (typeof b.type === 'string' && b.type.endsWith('_tool_result') && typeof b.tool_use_id === 'string') {
            this.#onServerToolResult(b);
          } else unmapped.push(b);
      }
    }
    if (m.error) {
      this.#emit({ type: 'error', data: { message: assistantText(msg) || String(m.error), code: String(m.error), fatal: false } });
    }
    if (unmapped.length) this.#raw(m);
    // Each main-thread API response re-sends the whole conversation: refresh the bar mid-turn too.
    // Subagents run in their own window.
    if (!parent && apiId !== this.#ctxMsgId) {
      this.#ctxMsgId = apiId;
      this.#scheduleContext();
    }
  }

  #ensureToolStarted(toolId: string, name: string, input: unknown, parentToolId: string | undefined): void {
    if (this.#tools.has(toolId)) return;
    this.#tools.set(toolId, { name, input });
    if (this.#tools.size > 2000) this.#tools.delete(this.#tools.keys().next().value!);
    this.#emit({
      type: 'tool.started',
      data: {
        toolId,
        kind: toolKind(name),
        name,
        title: toolTitle(name, input),
        input,
        ...(parentToolId ? { parentToolId } : {}),
      },
    });
    if (name === 'TodoWrite') {
      const items = todoItems((input as { todos?: unknown } | undefined)?.todos);
      if (items) {
        this.#plan = items;
        this.#emitPlan();
      }
    }
  }

  #emitPlan(): void {
    this.#emit({ type: 'plan.updated', data: { items: this.#plan.map((p) => ({ ...p })) } });
  }

  /** Server-side tool results (web search, web fetch, code execution, MCP connector) arrive in assistant content. */
  #onServerToolResult(b: Record<string, unknown>): void {
    const toolId = String(b.tool_use_id);
    const { status, text } = serverToolResult(b);
    const trimmed = trimOutput(text, this.#cfg.maxToolOutputChars);
    this.#emit({ type: 'tool.completed', data: status === 'ok' ? { toolId, status, output: trimmed } : { toolId, status, error: trimmed } });
  }

  #onUser(m: AnyMsg): void {
    if (typeof m.uuid === 'string' && this.#sentUuids.has(m.uuid)) return; // echo of our own input
    const content = (m.message as { content?: unknown })?.content;
    const blocks = Array.isArray(content) ? (content as { type?: string; [k: string]: unknown }[]) : [];
    const results = blocks.filter((b) => b.type === 'tool_result');
    const parent = typeof m.parent_tool_use_id === 'string' && m.parent_tool_use_id ? m.parent_tool_use_id : undefined;
    if (!results.length) {
      // forwardSubagentText: the prompt a subagent received, shown nested under its Task/Agent call.
      const text = typeof content === 'string' ? content : blocks.filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('\n');
      if (parent && text && m.isSynthetic !== true) {
        this.#emit({ type: 'message.completed', data: { messageId: String(m.uuid ?? newId('msg')), role: 'user', text, parentToolId: parent } });
        return;
      }
      return this.#raw(m);
    }
    for (const b of results) {
      const toolId = String(b.tool_use_id);
      const tool = this.#tools.get(toolId);
      const text = toolResultText(b.content);
      const isError = b.is_error === true;
      let status: 'ok' | 'error' | 'denied' | 'cancelled' = 'ok';
      if (this.#cancelled.has(toolId)) status = 'cancelled';
      else if (this.#denied.has(toolId)) status = 'denied';
      else if (isError && this.#active?.interrupted) status = 'cancelled';
      else if (isError) status = 'error';
      this.#denied.delete(toolId);
      this.#cancelled.delete(toolId);
      const trimmed = trimOutput(text, this.#cfg.maxToolOutputChars);
      this.#emit({
        type: 'tool.completed',
        data: status === 'ok' ? { toolId, status, output: trimmed } : { toolId, status, error: trimmed },
      });
      if (status === 'ok' && tool) this.#afterToolOk(tool.name, tool.input, m.tool_use_result);
    }
    // A tool result (a file read, a long command output) lands in the window before the next response.
    if (!parent) this.#scheduleContext();
  }

  #afterToolOk(name: string, input: unknown, result: unknown): void {
    const r = (result && typeof result === 'object' ? result : {}) as Record<string, unknown>;
    const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    if ((name === 'Edit' || name === 'MultiEdit' || name === 'Write' || name === 'NotebookEdit') && typeof r.filePath === 'string') {
      const created = r.type === 'create' || (name === 'Write' && r.originalFile === null);
      const hunks = Array.isArray(r.structuredPatch) ? (r.structuredPatch as PatchHunk[]) : undefined;
      const gitPatch = (r.gitDiff as { patch?: unknown } | undefined)?.patch;
      const diff = typeof gitPatch === 'string' ? gitPatch : hunks?.length ? unifiedDiff(r.filePath, hunks, created) : undefined;
      this.#emit({
        type: 'file.changed',
        data: { path: r.filePath, change: created ? 'created' : 'modified', ...(diff ? { diff } : {}) },
      });
      return;
    }
    if (name === 'TaskCreate') {
      const task = r.task as { id?: unknown; subject?: unknown } | undefined;
      if (task && typeof task.id === 'string') {
        this.#plan.push({ id: task.id, text: String(task.subject ?? i.subject ?? ''), status: 'pending' });
        this.#emitPlan();
      }
      return;
    }
    if (name === 'TaskUpdate' && r.success !== false && typeof i.taskId === 'string') {
      const idx = this.#plan.findIndex((p) => p.id === i.taskId);
      if (idx < 0) return;
      if (i.status === 'deleted') this.#plan.splice(idx, 1);
      else {
        const item = this.#plan[idx]!;
        if (typeof i.subject === 'string') item.text = i.subject;
        if (i.status) item.status = normStatus(i.status);
      }
      this.#emitPlan();
      return;
    }
    if (name === 'TaskList' && Array.isArray(r.tasks)) {
      this.#plan = (r.tasks as { id: string; subject: string; status: string }[]).map((t) => ({
        id: t.id,
        text: t.subject,
        status: normStatus(t.status),
      }));
      this.#emitPlan();
    }
  }

  #onResult(r: SDKResultMessage): void {
    const cumulative = sessionUsage(r, this.#info.model);
    const cost = r.total_cost_usd;
    const turnCost = typeof cost === 'number' && this.#costBaselineKnown && cost >= this.#lastCost ? cost - this.#lastCost : undefined;
    if (typeof cost === 'number') {
      this.#lastCost = cost;
      this.#costBaselineKnown = true;
    }
    this.#emit({ type: 'usage.updated', data: cumulative });
    if (typeof cost === 'number') this.#sessionCost = cost;
    this.#afterResult();

    const turn = this.#active;
    const ids = r.user_message_uuids ?? (r.user_message_uuid ? [r.user_message_uuid] : []);
    if (ids.some((u) => this.#orphaned.has(u))) {
      for (const u of ids) this.#orphaned.delete(u);
      return; // late result of a turn we already force-completed
    }
    if (!turn) return this.#raw(r);
    const mine = !this.#stampsUuids || ids.some((u) => turn.uuids.has(u)) || turn.interrupted;
    if (!mine) return this.#raw(r); // e.g. a background-task turn the CLI ran on its own
    const tokens = resultTokens(r);
    if (turnCost !== undefined) tokens.costUsd = turnCost;
    if (cumulative.contextWindow) tokens.contextWindow = cumulative.contextWindow;
    turn.usage = addUsage(turn.usage, tokens);
    const allConsumed = [...turn.uuids].every((u) => turn.consumed.has(u));
    if (this.#stampsUuids && !allConsumed && !turn.interrupted) return; // a steer will run as a follow-up SDK turn
    const { stopReason, error } = stopReasonOf(r, turn.interrupted);
    this.#complete(turn, stopReason, error);
  }

  async #loadCommands(q: ClaudeQuery): Promise<void> {
    try {
      const init = await q.initializationResult?.();
      if (init && this.#state === 'running') {
        const commands = (init.commands ?? []).map((c) => (c.description ? { name: c.name, description: c.description } : { name: c.name }));
        this.#emit({ type: 'session.info', data: { commands } });
      }
    } catch (e) {
      this.#log.log('debug', 'initializationResult failed', { error: String(e) });
    }
    if (this.#state !== 'running') return;
    void this.#refreshContext();
    await this.#loadAccount(q);
  }

  // ---------------------------------------------------------------- context + account usage

  /** Mid-turn refresh: at most one per `contextRefreshMs`, and the last request always runs. */
  #scheduleContext(): void {
    if (this.#ctxTimer || this.#state !== 'running' || !this.#q?.getContextUsage) return;
    const wait = this.#ctxLast + (this.#cfg.contextRefreshMs ?? 1500) - Date.now();
    if (wait <= 0) return void this.#refreshContext();
    this.#ctxTimer = setTimeout(() => {
      this.#ctxTimer = undefined;
      void this.#refreshContext();
    }, wait);
    this.#ctxTimer.unref?.();
  }

  #clearContextTimer(): void {
    if (this.#ctxTimer) clearTimeout(this.#ctxTimer);
    this.#ctxTimer = undefined;
  }

  /** `getContextUsage()` → `context.updated`; coalesces overlapping refreshes. */
  async #refreshContext(): Promise<void> {
    const q = this.#q;
    if (!q?.getContextUsage || this.#state !== 'running') return;
    this.#clearContextTimer();
    if (this.#ctxBusy) {
      this.#ctxAgain = true;
      return;
    }
    this.#ctxBusy = true;
    try {
      do {
        this.#ctxAgain = false;
        this.#ctxLast = Date.now();
        // 'summary' answers from the last response and local estimates, without token-count API calls.
        const r = await q.getContextUsage({ detail: 'summary' });
        if (this.#state !== 'running') return;
        const ctx = r && contextFromSdk(r, this.#cfg.injection);
        const key = ctx && JSON.stringify(ctx);
        if (ctx && key !== this.#ctxKey) {
          this.#ctxKey = key;
          this.#emit({ type: 'context.updated', data: ctx });
        }
      } while (this.#ctxAgain);
    } catch (e) {
      this.#log.log('debug', 'getContextUsage failed', { error: String(e) });
    } finally {
      this.#ctxBusy = false;
    }
  }

  async #loadAccount(q: ClaudeQuery): Promise<void> {
    let info;
    try {
      info = await q.accountInfo?.();
    } catch (e) {
      this.#log.log('debug', 'accountInfo failed', { error: String(e) });
    }
    this.#account = claudeAccount(info, this.#cfg.keyFingerprint) ?? null;
    if (this.#account?.billing === 'plan') await this.#queryPlan(true);
    else this.#emitAccount();
  }

  async #queryPlan(force = false): Promise<void> {
    const q = this.#q;
    if (!q || this.#account?.billing !== 'plan' || this.#state !== 'running') return;
    const now = Date.now();
    if (!force && now - this.#lastPlanQuery < (this.#cfg.planQueryIntervalMs ?? 5 * 60_000)) return;
    this.#lastPlanQuery = now;
    const r = await readPlanUsage(q);
    if (r) this.#planUsage.applyPlanQuery(r);
    this.#emitAccount();
  }

  #afterResult(): void {
    void this.#refreshContext();
    if (this.#account?.billing === 'plan') void this.#queryPlan();
    else this.#emitAccount();
  }

  #emitAccount(): void {
    const a = this.#account;
    if (!a || this.#state !== 'running') return;
    const windows = this.#planUsage.windows();
    const spend = a.billing === 'metered' && this.#sessionCost !== undefined ? { usd: this.#sessionCost, period: 'session' } : undefined;
    let status = this.#planUsage.status();
    if (!windows.length && !spend && status === 'unknown') return;
    if (status === 'unknown' && spend) status = 'ok';
    const usage: AccountUsage = {
      agent: 'claude',
      accountId: a.accountId,
      label: a.label,
      billing: a.billing,
      machines: [],
      status,
      observedAt: new Date().toISOString(),
    };
    if (windows.length) usage.windows = windows;
    if (spend) usage.spend = spend;
    this.#emit({ type: 'account.usage', data: usage });
  }
}

function assistantText(msg: { content?: unknown[] }): string {
  return (msg.content ?? [])
    .map((b) => ((b as { type?: string }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : ''))
    .join('');
}

function fallbackRule(toolName: string, input: Record<string, unknown>): PermissionUpdate[] {
  const ruleContent = toolName === 'Bash' && typeof input.command === 'string' ? input.command : undefined;
  return [
    {
      type: 'addRules',
      rules: [ruleContent ? { toolName, ruleContent } : { toolName }],
      behavior: 'allow',
      destination: 'session',
    },
  ];
}
