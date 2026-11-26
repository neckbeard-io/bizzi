// One bizzi session ↔ one OpenCode v2 session on the shared private server.

import { basename, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BizziError,
  type AdapterSession,
  type ApprovalDecision,
  type EmitFn,
  type InputBlock,
  type Logger,
  type QuestionAnswers,
  type StopReason,
  type ToolKind,
  type Usage,
} from '@bizzi/protocol';
import { OpenCodeHttpError, type OpenCodeClient } from './client.ts';
import {
  addTokens,
  approvalKind,
  decisionToReply,
  formQuestion,
  formatModel,
  fromFormAnswer,
  isTodoTool,
  parseModel,
  replyToDecision,
  sumUsage,
  toFormAnswer,
  todoItems,
  toolKind,
  toolOutput,
  toolTitle,
  usageOf,
} from './mapping.ts';
import type { OpenCodeServer, ServerListener } from './server.ts';
import { contextFromStep } from './context.ts';
import {
  dataOf,
  eventSessionId,
  type FormInfo,
  type MessageInfo,
  type ModelRef,
  type OcEvent,
  type PromptFileAttachment,
  type TokenUsage,
} from './types.ts';

interface TurnState {
  id: string;
  startedAt: number;
  usage: Usage;
  /** An execution started on the server after this turn's prompt. */
  executing: boolean;
  interruptRequested: boolean;
  fallback?: NodeJS.Timeout;
}

interface TextState {
  text: string;
  emittedDelta: boolean;
  completed: boolean;
}

interface ToolState {
  id: string;
  name: string;
  kind: ToolKind;
  sessionID: string;
  input?: Record<string, unknown>;
  started: boolean;
  completed: boolean;
  parentToolId?: string;
  /** File diffs from the permission request (edit/write), used for file.changed. */
  files?: { file: string; patch?: string; status?: string }[];
}

/** Canceled requests to settle on the server: [sessionID, id]. */
interface Pending {
  approvals: [string, string][];
  questions: [string, string][];
}

interface ChildState {
  parentToolId?: string;
  agent?: string;
  title?: string;
  announced: boolean;
  completed: boolean;
}

export interface SessionInit {
  server: OpenCodeServer;
  ref: string;
  directory: string;
  emit: EmitFn;
  logger: Logger;
  model?: ModelRef;
  agent?: string;
  contextWindow?: number;
  /** Session-cumulative usage when the session was opened (resume). */
  initialUsage?: Usage;
  /** Estimated tokens bizzi injects (instructions, bytes / 4), for the "bizzi overhead" context row. */
  bizziTokens?: number;
  /** Re-applied after a server crash/restart (runtime state is lost with the process). */
  reapply: () => Promise<void>;
  onStop: () => Promise<void>;
  interruptFallbackMs: number;
}

const IGNORED = new Set([
  'session.created',
  'session.step.streamed',
  'session.tool.input.delta',
  'session.tool.input.ended',
  'session.instructions.updated',
  'session.inbox.enqueued',
  'session.inbox.delivered',
  'session.inbox.cancelled',
  'session.inbox.delivery.changed',
  'session.message.content.updated',
  'session.metadata.updated',
  'session.viewed',
  'session.permissions',
  'shell.created',
  'shell.exited',
  'shell.deleted',
]);

export class OpenCodeSession implements AdapterSession, ServerListener {
  readonly #server: OpenCodeServer;
  readonly #ref: string;
  readonly #dir: string;
  readonly #emit: EmitFn;
  readonly #log: Logger;
  readonly #reapply: () => Promise<void>;
  readonly #onStop: () => Promise<void>;
  readonly #interruptFallbackMs: number;
  #model: ModelRef | undefined;
  #agent: string | undefined;
  #contextWindow: number | undefined;
  #turn: TurnState | undefined;
  #texts = new Map<string, TextState>();
  #reasoning = new Map<string, TextState>();
  #tools = new Map<string, ToolState>();
  #children = new Map<string, ChildState>();
  #approvals = new Map<string, { sessionID: string; resolved: boolean }>();
  /** Pending forms (question tool, elicitation), keyed by form id = bizzi questionId. */
  #questions = new Map<string, { sessionID: string; form: FormInfo; resolved: boolean }>();
  /** Session-cumulative usage: this session plus every subagent session seen. */
  #ownUsage: Usage = {};
  #childUsage = new Map<string, Usage>();
  #needsReconcile = false;
  /** Tokens of the latest own assistant step (context occupancy) and the last emitted context. */
  #lastStepTokens: TokenUsage | undefined;
  #lastContext: string | undefined;
  #bizziTokens = 0;
  #crashed = false;
  #stopped = false;
  #unsubscribe: () => void;

  constructor(init: SessionInit) {
    this.#server = init.server;
    this.#ref = init.ref;
    this.#dir = init.directory;
    this.#emit = init.emit;
    this.#log = init.logger;
    this.#model = init.model;
    this.#agent = init.agent;
    this.#contextWindow = init.contextWindow;
    if (init.initialUsage) this.#ownUsage = init.initialUsage;
    this.#bizziTokens = init.bizziTokens ?? 0;
    this.#reapply = init.reapply;
    this.#onStop = init.onStop;
    this.#interruptFallbackMs = init.interruptFallbackMs;
    this.#unsubscribe = init.server.subscribe(this);
  }

  agentSessionRef(): string | undefined {
    return this.#ref;
  }

  /** What the shared server reports it runs (`/api/info`), which can lag the installed CLI. */
  agentVersion(): string | undefined {
    return this.#server.version;
  }

  get directory(): string {
    return this.#dir;
  }

  async #client(): Promise<OpenCodeClient> {
    try {
      return await this.#server.ensure();
    } catch (err) {
      throw new BizziError('agent_unavailable', `opencode server unavailable: ${String(err)}`);
    }
  }

  // --- AdapterSession -------------------------------------------------------------------------

  async send(turnId: string, input: InputBlock[]): Promise<void> {
    if (this.#stopped) throw new BizziError('conflict', 'session is stopped');
    if (this.#turn) throw new BizziError('conflict', `turn ${this.#turn.id} is still in progress`);
    const body = this.#promptBody(input);
    this.#turn = { id: turnId, startedAt: Date.now(), usage: {}, executing: false, interruptRequested: false };
    try {
      const client = await this.#client();
      await client.prompt(this.#ref, body);
    } catch (err) {
      const message = `opencode rejected the prompt: ${err instanceof Error ? err.message : String(err)}`;
      this.#emit({ type: 'error', data: { message, code: errorCode(err) } });
      this.#completeTurn('error', message);
      throw err instanceof BizziError ? err : new BizziError('internal', message);
    }
  }

  async steer(input: InputBlock[]): Promise<void> {
    if (this.#stopped) throw new BizziError('conflict', 'session is stopped');
    if (!this.#turn) throw new BizziError('conflict', 'no turn in progress to steer');
    const client = await this.#client();
    await client.prompt(this.#ref, { ...this.#promptBody(input), delivery: 'steer' });
  }

  async interrupt(): Promise<void> {
    const turn = this.#turn;
    // Pending approvals/questions end as canceled now; the server cancels them too.
    const pending = this.#cancelPending();
    if (!turn) {
      await this.#rejectOnServer(pending);
      return;
    }
    turn.interruptRequested = true;
    let interrupted = false;
    try {
      const client = await this.#client();
      interrupted = (await client.interrupt(this.#ref)).interrupted;
    } catch (err) {
      this.#log.log('warn', 'opencode interrupt failed', { err: String(err) });
    }
    await this.#rejectOnServer(pending);
    if (this.#turn !== turn) return;
    if (!interrupted && !turn.executing) {
      // Nothing running server-side (yet / any more): close the turn ourselves.
      this.#completeTurn('interrupted');
      return;
    }
    // The server reports session.execution.interrupted; don't hang if that event is lost.
    clearTimeout(turn.fallback);
    turn.fallback = setTimeout(() => {
      if (this.#turn === turn) this.#completeTurn('interrupted');
    }, this.#interruptFallbackMs);
    turn.fallback.unref();
  }

  async respondApproval(approvalId: string, decision: ApprovalDecision): Promise<void> {
    const ap = this.#approvals.get(approvalId);
    if (!ap) throw new BizziError('not_found', `unknown approval ${approvalId}`);
    if (ap.resolved) return;
    const client = await this.#client();
    try {
      await client.replyPermission(ap.sessionID, approvalId, decisionToReply(decision.decision), decision.message);
    } catch (err) {
      if (err instanceof OpenCodeHttpError && err.status === 404) {
        ap.resolved = true;
        throw new BizziError('not_found', `approval ${approvalId} is no longer pending`);
      }
      throw err;
    }
    if (!ap.resolved) {
      ap.resolved = true;
      this.#emit({ type: 'approval.resolved', data: { approvalId, decision: decision.decision } });
    }
  }

  async respondQuestion(questionId: string, answers: QuestionAnswers | undefined): Promise<void> {
    const q = this.#questions.get(questionId);
    if (!q) throw new BizziError('not_found', `unknown question ${questionId}`);
    if (q.resolved) return;
    const answer = answers === undefined ? undefined : toFormAnswer(q.form, answers);
    const client = await this.#client();
    try {
      if (answer) await client.replyForm(q.sessionID, questionId, answer);
      else await client.cancelForm(q.sessionID, questionId, 'The user declined to answer.');
    } catch (err) {
      if (err instanceof OpenCodeHttpError && (err.status === 404 || err.status === 409)) {
        throw new BizziError('not_found', `question ${questionId} is no longer pending`);
      }
      if (err instanceof OpenCodeHttpError && err.status === 400) {
        throw new BizziError('bad_request', `OpenCode rejected the answer: ${err.message}`);
      }
      throw err;
    }
    // The server's form.replied / form.cancelled may already have resolved it.
    this.#resolveQuestion(questionId, answers === undefined ? { cancelled: true } : { answers });
  }

  async set(opts: { model?: string; permissionMode?: string; effort?: string }): Promise<void> {
    if (this.#stopped) throw new BizziError('conflict', 'session is stopped');
    const client = await this.#client();
    if (opts.permissionMode !== undefined && opts.permissionMode !== this.#agent) {
      const agents = await client.agents({ directory: this.#dir }).catch(() => undefined);
      if (agents && !agents.some((a) => a.id === opts.permissionMode && a.mode !== 'subagent')) {
        throw new BizziError('bad_request', `unknown OpenCode agent "${opts.permissionMode}"`, {
          available: agents.filter((a) => a.mode !== 'subagent' && !a.hidden).map((a) => a.id),
        });
      }
      await client.switchAgent(this.#ref, opts.permissionMode);
      this.#agent = opts.permissionMode;
    }
    if (opts.model !== undefined || opts.effort !== undefined) {
      let ref: ModelRef;
      try {
        if (opts.model !== undefined) ref = parseModel(opts.model, opts.effort);
        else if (this.#model) ref = { ...this.#model, variant: opts.effort };
        else throw new Error('set a model ("provider/model") before choosing an effort');
      } catch (err) {
        throw new BizziError('bad_request', String(err instanceof Error ? err.message : err));
      }
      const models = await client.models({ directory: this.#dir }).catch(() => undefined);
      if (models) {
        const m = models.find((x) => x.providerID === ref.providerID && x.id === ref.id);
        if (!m) throw new BizziError('bad_request', `unknown OpenCode model "${formatModel(ref)}"`);
        if (ref.variant && ref.variant !== 'default' && m.variants.length && !m.variants.some((v) => v.id === ref.variant)) {
          throw new BizziError('bad_request', `model ${formatModel(ref)} has no effort "${ref.variant}"`, {
            available: m.variants.map((v) => v.id),
          });
        }
        if (m.limit?.context) this.#contextWindow = m.limit.context;
      }
      this.#lastContext = undefined;
      await client.switchModel(this.#ref, ref);
      this.#model = ref;
    }
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    const pending = this.#cancelPending();
    if (this.#turn) {
      const client = this.#server.client;
      if (client) await client.interrupt(this.#ref).catch(() => undefined);
      this.#completeTurn('interrupted');
    }
    await this.#rejectOnServer(pending);
    this.#unsubscribe();
    await this.#onStop();
  }

  // --- ServerListener -------------------------------------------------------------------------

  onGap(info: { crashed: boolean; reason: string }): void {
    if (this.#stopped) return;
    if (info.crashed) {
      this.#crashed = true;
      this.#cancelPending(); // the process is gone, and with it every pending request
      if (this.#turn) {
        this.#emit({ type: 'error', data: { message: info.reason, code: 'server_exited' } });
        this.#completeTurn('error', info.reason);
      }
    } else {
      this.#needsReconcile = true;
    }
  }

  onResync(): void {
    if (this.#stopped) return;
    if (this.#crashed) {
      this.#crashed = false;
      void this.#reapply().catch((err: unknown) => this.#log.log('warn', 'opencode session re-apply failed', { err: String(err) }));
    }
    if (this.#needsReconcile) {
      this.#needsReconcile = false;
      void this.#syncForms().catch((err: unknown) => this.#log.log('warn', 'opencode form sync failed', { err: String(err) }));
      void this.#reconcile().catch((err: unknown) => this.#log.log('warn', 'opencode reconcile failed', { err: String(err) }));
    }
  }

  onEvent(ev: OcEvent): void {
    if (this.#stopped) return;
    const sid = eventSessionId(ev);
    if (!sid) return;
    if (ev.type === 'session.created') {
      const d = dataOf(ev, 'session.created');
      if (d.parentID && (d.parentID === this.#ref || this.#children.has(d.parentID)) && !this.#children.has(sid)) {
        this.#children.set(sid, { agent: d.agent, title: d.title, announced: false, completed: false });
      }
      return;
    }
    if (sid === this.#ref) this.#onOwnEvent(ev);
    else if (this.#children.has(sid)) this.#onChildEvent(sid, ev);
  }

  // --- event mapping --------------------------------------------------------------------------

  #onOwnEvent(ev: OcEvent): void {
    switch (ev.type) {
      case 'session.execution.started':
        if (this.#turn) this.#turn.executing = true;
        return;
      case 'session.execution.succeeded':
        if (this.#turn?.executing) this.#completeTurn('end_turn');
        return;
      case 'session.execution.interrupted':
        if (this.#turn?.executing || this.#turn?.interruptRequested) this.#completeTurn('interrupted');
        return;
      case 'session.execution.failed': {
        const err = dataOf(ev, 'session.execution.failed').error;
        const message = err?.message ?? 'OpenCode execution failed';
        this.#emit({ type: 'error', data: { message, code: err?.type } });
        if (this.#turn?.executing) this.#completeTurn('error', message);
        return;
      }
      case 'session.step.started': {
        const m = dataOf(ev, 'session.step.started').model;
        const changed = !!m && (m.providerID !== this.#model?.providerID || m.id !== this.#model?.id);
        this.#model = m ?? this.#model;
        if (m && (changed || !this.#contextWindow)) void this.#refreshWindow(m);
        return;
      }
      case 'session.step.ended': {
        const d = dataOf(ev, 'session.step.ended');
        if (this.#turn) addTokens(this.#turn.usage, d.tokens, d.cost);
        if (d.tokens) {
          this.#lastStepTokens = d.tokens;
          this.#emitContext();
        }
        return;
      }
      case 'session.step.failed':
        return; // followed by session.execution.failed / .interrupted
      case 'session.text.started':
        this.#open(this.#texts, textKey(ev));
        return;
      case 'session.text.delta': {
        const d = dataOf(ev, 'session.text.delta');
        const key = textKey(ev);
        const st = this.#open(this.#texts, key);
        st.text += d.delta;
        st.emittedDelta = true;
        this.#emit({ type: 'message.delta', data: { messageId: key, role: 'assistant', text: d.delta } });
        return;
      }
      case 'session.text.ended': {
        const key = textKey(ev);
        this.#closeText(key, dataOf(ev, 'session.text.ended').text);
        return;
      }
      case 'session.reasoning.started':
        this.#open(this.#reasoning, reasoningKey(ev));
        return;
      case 'session.reasoning.delta': {
        const d = dataOf(ev, 'session.reasoning.delta');
        const key = reasoningKey(ev);
        const st = this.#open(this.#reasoning, key);
        st.text += d.delta;
        st.emittedDelta = true;
        this.#emit({ type: 'reasoning.delta', data: { messageId: key, text: d.delta } });
        return;
      }
      case 'session.reasoning.ended':
        this.#closeReasoning(reasoningKey(ev), dataOf(ev, 'session.reasoning.ended').text);
        return;
      case 'session.agent.selected':
        this.#agent = dataOf(ev, 'session.agent.selected').agent;
        this.#emit({ type: 'session.info', data: { permissionMode: this.#agent } });
        return;
      case 'session.model.selected': {
        const m = dataOf(ev, 'session.model.selected').model;
        this.#model = m;
        const info: { model: string; effort?: string } = { model: formatModel(m) };
        if (m.variant && m.variant !== 'default') info.effort = m.variant;
        this.#emit({ type: 'session.info', data: info });
        return;
      }
      case 'session.renamed':
        this.#emit({ type: 'session.info', data: { title: dataOf(ev, 'session.renamed').title } });
        return;
      case 'session.usage.updated': {
        const d = dataOf(ev, 'session.usage.updated');
        this.#ownUsage = usageOf(d.tokens, d.cost);
        this.#emitUsage();
        return;
      }
      default:
        if (this.#onToolOrPermission(this.#ref, ev, undefined)) return;
        if (IGNORED.has(ev.type)) return;
        this.#emit({ type: 'agent.raw', data: { agent: 'opencode', payload: ev } });
    }
  }

  #onChildEvent(sid: string, ev: OcEvent): void {
    const child = this.#children.get(sid)!;
    switch (ev.type) {
      case 'session.execution.succeeded':
      case 'session.execution.failed':
      case 'session.execution.interrupted': {
        if (child.completed) return;
        child.completed = true;
        this.#announceChild(sid, child);
        const status = ev.type.endsWith('succeeded') ? 'ok' : ev.type.endsWith('failed') ? 'error' : 'cancelled';
        this.#emit({ type: 'subagent.completed', data: { subagentId: sid, status } });
        return;
      }
      case 'session.step.ended': {
        const d = dataOf(ev, 'session.step.ended');
        if (this.#turn) addTokens(this.#turn.usage, d.tokens, d.cost);
        return;
      }
      case 'session.usage.updated': {
        const d = dataOf(ev, 'session.usage.updated');
        this.#childUsage.set(sid, usageOf(d.tokens, d.cost));
        this.#emitUsage();
        return;
      }
      default:
        this.#onToolOrPermission(sid, ev, child.parentToolId);
    }
  }

  /** Tool and permission events, shared by the main session and its subagent sessions. */
  #onToolOrPermission(sid: string, ev: OcEvent, parentToolId: string | undefined): boolean {
    switch (ev.type) {
      case 'session.tool.input.started': {
        const d = dataOf(ev, 'session.tool.input.started');
        this.#tool(d.id, sid, d.name, parentToolId);
        return true;
      }
      case 'session.tool.called': {
        const d = dataOf(ev, 'session.tool.called');
        const t = this.#tool(d.id, sid, undefined, parentToolId);
        t.input = d.input;
        if (isTodoTool(t.name)) {
          const items = todoItems(d.input);
          if (items) this.#emit({ type: 'plan.updated', data: { items } });
        }
        this.#startTool(t);
        return true;
      }
      case 'session.tool.progress': {
        const d = dataOf(ev, 'session.tool.progress');
        const t = this.#tool(d.id, sid, undefined, parentToolId);
        const childId = typeof d.metadata?.sessionID === 'string' ? d.metadata.sessionID : undefined;
        if (childId) {
          const child = this.#children.get(childId) ?? { announced: false, completed: false };
          this.#children.set(childId, child);
          child.parentToolId = t.id;
          this.#announceChild(childId, child);
          return true;
        }
        const output = typeof d.metadata?.output === 'string' ? d.metadata.output : undefined;
        const progress = typeof d.metadata?.title === 'string' ? d.metadata.title : undefined;
        if (output !== undefined || progress !== undefined) {
          this.#startTool(t);
          const data: { toolId: string; output?: string; progress?: string } = { toolId: t.id };
          if (output !== undefined) data.output = output;
          if (progress !== undefined) data.progress = progress;
          this.#emit({ type: 'tool.updated', data });
        }
        return true;
      }
      case 'session.tool.success': {
        const d = dataOf(ev, 'session.tool.success');
        const t = this.#tool(d.id, sid, undefined, parentToolId);
        this.#finishTool(t, 'ok', toolOutput(d.content));
        return true;
      }
      case 'session.tool.failed': {
        const d = dataOf(ev, 'session.tool.failed');
        const t = this.#tool(d.id, sid, undefined, parentToolId);
        const type = d.error?.type ?? '';
        const status = type === 'permission.rejected' ? 'denied' : type === 'aborted' || type === 'interrupted' ? 'cancelled' : 'error';
        this.#finishTool(t, status, toolOutput(d.content), d.error?.message);
        return true;
      }
      case 'permission.asked': {
        const d = dataOf(ev, 'permission.asked');
        if (this.#approvals.has(d.id)) return true;
        this.#approvals.set(d.id, { sessionID: d.sessionID, resolved: false });
        const tool = d.source?.id ? this.#tools.get(d.source.id) : undefined;
        const files = Array.isArray(d.metadata?.files) ? (d.metadata.files as ToolState['files']) : undefined;
        if (tool && files) tool.files = files;
        const resources = d.resources ?? [];
        const patch = files?.map((f) => f.patch).filter(Boolean).join('\n');
        const req = {
          approvalId: d.id,
          kind: approvalKind(d.action),
          title: permissionTitle(d.action, resources),
          input: tool?.input ?? { action: d.action, resources },
          editable: false,
          options: ['allow', 'allow_always', 'deny'] as ('allow' | 'allow_always' | 'deny')[],
        } as const;
        const description = [d.message, patch || (resources.length > 1 ? resources.join('\n') : undefined)]
          .filter(Boolean)
          .join('\n\n');
        this.#emit({
          type: 'approval.requested',
          data: {
            ...req,
            ...(d.source?.id ? { toolId: d.source.id } : {}),
            ...(description ? { description } : {}),
          },
        });
        return true;
      }
      case 'form.created':
        this.#onForm(dataOf(ev, 'form.created').form);
        return true;
      case 'form.replied': {
        const d = dataOf(ev, 'form.replied');
        const q = this.#questions.get(d.id);
        if (q) this.#resolveQuestion(d.id, d.answer ? { answers: fromFormAnswer(q.form, d.answer) } : {});
        return true;
      }
      case 'form.cancelled':
        this.#resolveQuestion(dataOf(ev, 'form.cancelled').id, { cancelled: true });
        return true;
      case 'permission.replied': {
        const d = dataOf(ev, 'permission.replied');
        const ap = this.#approvals.get(d.requestID);
        if (ap && !ap.resolved) {
          ap.resolved = true;
          this.#emit({ type: 'approval.resolved', data: { approvalId: d.requestID, decision: replyToDecision(d.reply), by: 'opencode' } });
        }
        return true;
      }
      default:
        return false;
    }
  }

  // --- context -------------------------------------------------------------------------------

  async #refreshWindow(model: ModelRef): Promise<void> {
    const client = this.#server.client;
    if (!client) return;
    const models = await client.models({ directory: this.#dir }).catch(() => undefined);
    const m = models?.find((x) => x.providerID === model.providerID && x.id === model.id);
    if (this.#stopped || !m?.limit?.context || this.#model?.providerID !== model.providerID || this.#model?.id !== model.id) return;
    if (m.limit.context === this.#contextWindow) return;
    this.#contextWindow = m.limit.context;
    this.#emitContext();
  }

  #emitContext(): void {
    if (this.#stopped) return;
    const ctx = contextFromStep(this.#lastStepTokens, this.#contextWindow, this.#bizziTokens);
    if (!ctx) return;
    const key = JSON.stringify(ctx);
    if (key === this.#lastContext) return;
    this.#lastContext = key;
    this.#emit({ type: 'context.updated', data: ctx });
  }

  // --- questions, cancellation, usage ---------------------------------------------------------

  #onForm(form: FormInfo): void {
    if (this.#questions.has(form.id)) return;
    this.#questions.set(form.id, { sessionID: form.sessionID, form, resolved: false });
    this.#emit({ type: 'question.asked', data: formQuestion(form) });
    this.#emit({ type: 'session.status', data: { status: 'waiting_input', prompt: 'input' } });
  }

  #resolveQuestion(id: string, how: { answers?: QuestionAnswers; cancelled?: boolean }): void {
    const q = this.#questions.get(id);
    if (!q || q.resolved) return;
    q.resolved = true;
    this.#emit({ type: 'question.resolved', data: { questionId: id, ...how } });
    // The last open question resolved: report what the session is back to.
    if (this.#stopped || this.#crashed || [...this.#questions.values()].some((x) => !x.resolved)) return;
    const approvals = [...this.#approvals.values()].some((a) => !a.resolved);
    this.#emit({ type: 'session.status', data: { status: approvals ? 'waiting_approval' : this.#turn ? 'running' : 'idle' } });
  }

  /** Every unresolved approval / question ends as canceled (turn ended, session stopped, server died). */
  #cancelPending(): Pending {
    const out: Pending = { approvals: [], questions: [] };
    for (const [id, ap] of this.#approvals) {
      if (ap.resolved) continue;
      ap.resolved = true;
      out.approvals.push([ap.sessionID, id]);
      this.#emit({ type: 'approval.resolved', data: { approvalId: id, decision: 'cancelled', by: 'bizzi' } });
    }
    for (const [id, q] of this.#questions) {
      if (q.resolved) continue;
      q.resolved = true;
      out.questions.push([q.sessionID, id]);
      this.#emit({ type: 'question.resolved', data: { questionId: id, cancelled: true } });
    }
    return out;
  }

  /** Best effort: settle canceled requests on the server too (an interrupt usually did already). */
  async #rejectOnServer(p: Pending): Promise<void> {
    if (!p.approvals.length && !p.questions.length) return;
    const client = this.#server.client;
    if (!client) return;
    await Promise.all([
      ...p.approvals.map(([sid, id]) => client.replyPermission(sid, id, 'reject', 'Cancelled.').catch(() => undefined)),
      ...p.questions.map(([sid, id]) => client.cancelForm(sid, id, 'Cancelled.').catch(() => undefined)),
    ]);
  }

  #emitUsage(): void {
    const total = sumUsage([this.#ownUsage, ...this.#childUsage.values()]);
    if (this.#contextWindow) total.contextWindow = this.#contextWindow;
    this.#emit({ type: 'usage.updated', data: total });
  }

  /** After a stream gap: pick up forms created meanwhile and settle the ones answered elsewhere. */
  async #syncForms(): Promise<void> {
    const client = await this.#client();
    const pending = await client.forms(this.#ref);
    if (this.#stopped) return;
    const live = new Set(pending.map((f) => f.id));
    for (const form of pending) this.#onForm(form);
    for (const [id, q] of this.#questions) {
      if (q.resolved || live.has(id) || q.sessionID !== this.#ref) continue;
      const detail = await client.form(q.sessionID, id).catch(() => undefined);
      if (detail?.state.status === 'answered') this.#resolveQuestion(id, { answers: fromFormAnswer(q.form, detail.state.answer) });
      else if (detail?.state.status !== 'pending') this.#resolveQuestion(id, { cancelled: true });
    }
  }

  // --- helpers --------------------------------------------------------------------------------

  #tool(id: string, sid: string, name: string | undefined, parentToolId: string | undefined): ToolState {
    let t = this.#tools.get(id);
    if (!t) {
      t = { id, name: name ?? 'tool', kind: toolKind(name ?? ''), sessionID: sid, started: false, completed: false };
      if (parentToolId) t.parentToolId = parentToolId;
      this.#tools.set(id, t);
    } else if (name && t.name === 'tool') {
      t.name = name;
      t.kind = toolKind(name);
    }
    return t;
  }

  #startTool(t: ToolState): void {
    if (t.started) return;
    t.started = true;
    const data: {
      toolId: string;
      kind: ToolKind;
      name: string;
      title: string;
      input?: unknown;
      parentToolId?: string;
    } = { toolId: t.id, kind: t.kind, name: t.name, title: toolTitle(t.name, t.input) };
    if (t.input !== undefined) data.input = t.input;
    if (t.parentToolId) data.parentToolId = t.parentToolId;
    this.#emit({ type: 'tool.started', data });
  }

  #finishTool(t: ToolState, status: 'ok' | 'error' | 'denied' | 'cancelled', output?: string, error?: string): void {
    if (t.completed) return;
    this.#startTool(t);
    t.completed = true;
    const data: { toolId: string; status: typeof status; output?: string; error?: string } = { toolId: t.id, status };
    if (output !== undefined) data.output = output;
    if (error !== undefined) data.error = error;
    this.#emit({ type: 'tool.completed', data });
    if (status === 'ok' && (t.kind === 'edit' || t.kind === 'write')) this.#fileChanged(t);
  }

  #fileChanged(t: ToolState): void {
    if (t.files?.length) {
      for (const f of t.files) {
        const change = f.status === 'added' ? 'created' : f.status === 'deleted' ? 'deleted' : 'modified';
        const data: { path: string; change: typeof change; diff?: string } = { path: this.#abs(f.file), change };
        if (f.patch) data.diff = f.patch;
        this.#emit({ type: 'file.changed', data });
      }
      return;
    }
    const p = t.input?.path ?? t.input?.filePath;
    if (typeof p === 'string') {
      this.#emit({ type: 'file.changed', data: { path: this.#abs(p), change: 'modified' } });
    }
  }

  #abs(p: string): string {
    return isAbsolute(p) ? p : resolve(this.#dir, p);
  }

  #announceChild(id: string, child: ChildState): void {
    if (child.announced) return;
    child.announced = true;
    const data: { subagentId: string; name?: string; description?: string; parentToolId?: string } = { subagentId: id };
    if (child.agent) data.name = child.agent;
    if (child.title) data.description = child.title;
    if (child.parentToolId) data.parentToolId = child.parentToolId;
    this.#emit({ type: 'subagent.started', data });
  }

  #open(map: Map<string, TextState>, key: string): TextState {
    let st = map.get(key);
    if (!st) {
      st = { text: '', emittedDelta: false, completed: false };
      map.set(key, st);
    }
    return st;
  }

  #closeText(key: string, finalText: string | undefined): void {
    const st = this.#open(this.#texts, key);
    if (st.completed) return;
    st.completed = true;
    const text = finalText ?? st.text;
    if (!st.emittedDelta && !text.trim()) return;
    this.#emit({ type: 'message.completed', data: { messageId: key, role: 'assistant', text } });
  }

  #closeReasoning(key: string, finalText: string | undefined): void {
    const st = this.#open(this.#reasoning, key);
    if (st.completed) return;
    st.completed = true;
    const text = finalText ?? st.text;
    if (!st.emittedDelta && !text.trim()) return;
    this.#emit({ type: 'reasoning.completed', data: { messageId: key, text } });
  }

  #completeTurn(stopReason: StopReason, error?: string): void {
    const turn = this.#turn;
    if (!turn) return;
    this.#turn = undefined;
    clearTimeout(turn.fallback);
    // Close anything still open so clients never see dangling streams.
    for (const [key, st] of this.#reasoning) if (!st.completed) this.#closeReasoning(key, undefined);
    for (const [key, st] of this.#texts) if (!st.completed) this.#closeText(key, undefined);
    for (const t of this.#tools.values()) {
      if (t.started && !t.completed) this.#finishTool(t, stopReason === 'interrupted' ? 'cancelled' : 'error', undefined, error);
    }
    this.#cancelPending();
    for (const [id, child] of this.#children) {
      if (child.announced && !child.completed) {
        child.completed = true;
        this.#emit({ type: 'subagent.completed', data: { subagentId: id, status: stopReason === 'interrupted' ? 'cancelled' : 'error' } });
      }
    }
    this.#texts.clear();
    this.#reasoning.clear();
    this.#tools.clear();
    this.#approvals.clear();
    this.#questions.clear();
    this.#children.clear();
    const usage = turn.usage;
    if (this.#contextWindow) usage.contextWindow = this.#contextWindow;
    const data: { turnId: string; stopReason: StopReason; usage?: Usage; error?: string } = { turnId: turn.id, stopReason };
    if (Object.keys(usage).length) data.usage = usage;
    if (error !== undefined) data.error = error;
    this.#emit({ type: 'turn.completed', data });
  }

  /** After an event-stream gap: recover the turn's outcome from the stored message history. */
  async #reconcile(): Promise<void> {
    const turn = this.#turn;
    if (!turn) return;
    const client = await this.#client();
    const [active, history] = await Promise.all([client.activeSessions(), client.messages(this.#ref, { limit: 50, order: 'desc' })]);
    if (this.#turn !== turn) return;
    const msgs = history.filter((m) => m.time.created >= turn.startedAt - 1_000).reverse();
    let outcome: 'succeeded' | 'failed' | 'interrupted' | undefined;
    let failure: string | undefined;
    const usage: Usage = {};
    for (const m of msgs) {
      if (m.type === 'idle') outcome = (m as Extract<MessageInfo, { type: 'idle' }>).outcome;
      if (m.type !== 'assistant') continue;
      const a = m as Extract<MessageInfo, { type: 'assistant' }>;
      addTokens(usage, a.tokens, a.cost);
      if (a.error) failure = a.error.message;
      let textIdx = 0;
      let reasoningIdx = 0;
      for (const part of a.content) {
        if (part.type === 'text') this.#closeText(`${a.id}:t${textIdx++}`, part.text);
        else if (part.type === 'reasoning') this.#closeReasoning(`${a.id}:r${reasoningIdx++}`, part.text);
        else if (part.type === 'tool') {
          const t = this.#tool(part.id, this.#ref, part.name, undefined);
          if (part.state.status !== 'streaming') t.input = part.state.input;
          if (part.state.status === 'completed') this.#finishTool(t, 'ok', toolOutput(part.state.content));
          else if (part.state.status === 'error') {
            const st = part.state.error.type === 'permission.rejected' ? 'denied' : 'error';
            this.#finishTool(t, st, toolOutput(part.state.content), part.state.error.message);
          } else this.#startTool(t);
        }
      }
    }
    if (Object.keys(usage).length) turn.usage = usage;
    if (outcome === 'succeeded') this.#completeTurn('end_turn');
    else if (outcome === 'interrupted') this.#completeTurn('interrupted');
    else if (outcome === 'failed') this.#completeTurn('error', failure ?? 'OpenCode execution failed');
    else if (!(this.#ref in active)) {
      // Not running and no recorded outcome: the execution was lost.
      this.#completeTurn('error', 'OpenCode execution ended while the event stream was disconnected');
    } else {
      turn.executing = true;
    }
  }

  #promptBody(input: InputBlock[]): { text: string; files?: PromptFileAttachment[] } {
    const texts: string[] = [];
    const files: PromptFileAttachment[] = [];
    for (const b of input) {
      if (b.type === 'text') texts.push(b.text);
      else if (b.type === 'image') files.push({ uri: `data:${b.mediaType};base64,${b.dataBase64}`, name: 'image' });
      else if (b.type === 'file') {
        const abs = this.#abs(b.path);
        files.push({ uri: pathToFileURL(abs).href, name: basename(abs) });
      }
    }
    const body: { text: string; files?: PromptFileAttachment[] } = { text: texts.join('\n\n') };
    if (files.length) body.files = files;
    return body;
  }
}

function textKey(ev: OcEvent): string {
  const d = ev.data as { assistantMessageID: string; ordinal?: number };
  return `${d.assistantMessageID}:t${d.ordinal ?? 0}`;
}

function reasoningKey(ev: OcEvent): string {
  const d = ev.data as { assistantMessageID: string; ordinal?: number };
  return `${d.assistantMessageID}:r${d.ordinal ?? 0}`;
}

function permissionTitle(action: string, resources: string[]): string {
  const first = resources[0] ?? '';
  const more = resources.length > 1 ? ` (+${resources.length - 1})` : '';
  switch (toolKind(action)) {
    case 'shell':
      return `Run ${first}${more}`.trim();
    case 'edit':
      return `Edit ${first}${more}`.trim();
    case 'write':
      return `Write ${first}${more}`.trim();
    case 'read':
      return `Read ${first}${more}`.trim();
    default:
      return `${action}${first ? `: ${first}` : ''}${more}`;
  }
}

function errorCode(err: unknown): string | undefined {
  if (err instanceof BizziError) return err.code;
  if (err instanceof OpenCodeHttpError) return err.tag ?? `http_${err.status}`;
  return undefined;
}
