// One bizzi session = one `codex app-server` process with one thread.

import { extname } from 'node:path';
import {
  BizziError,
  newId,
  type AccountUsage,
  type AdapterSession,
  type ApprovalDecision,
  type ApprovalDecisionKind,
  type ApprovalKind,
  type ApprovalRequest,
  type ContextUsage,
  type EmitFn,
  type InputBlock,
  type Logger,
  type McpServerSpec,
  type PlanItem,
  type QuestionAnswers,
  type StartSessionOptions,
  type StopReason,
  type ToolKind,
  type Usage,
} from '@bizzi/protocol';
import type {
  ApplyPatchApprovalParams,
  CommandExecutionApprovalDecision,
  CommandExecutionRequestApprovalParams,
  ExecCommandApprovalParams,
  FileChangeApprovalDecision,
  FileChangeRequestApprovalParams,
  FileUpdateChange,
  InitializeParams,
  McpServerElicitationRequestParams,
  NotificationMethod,
  NotificationParams,
  PermissionsRequestApprovalParams,
  PermissionsRequestApprovalResponse,
  ReviewDecision,
  SandboxPolicy,
  ThreadForkParams,
  ThreadItem,
  ThreadResumeParams,
  ThreadStartParams,
  ThreadStartResponse,
  TokenUsageBreakdown,
  TurnStartParams,
  TurnStartResponse,
  TurnSteerParams,
  ToolRequestUserInputParams,
  UserInput,
} from './codex-types.ts';
import {
  assertAnswers,
  elicitationQuestions,
  elicitationResponse,
  userInputQuestions,
  userInputResponse,
  type ElicitationPlan,
  type QuestionForm,
} from './questions.ts';
import { AppServerProcess, describeExit, type SpawnSpec } from './process.ts';
import { isPermissionMode, PERMISSION_MODE_NAMES, PERMISSION_MODES, permissionModeFor, sandboxPolicyFor } from './permissions.ts';
import { RpcClosedError, RpcError, type IncomingNotification, type IncomingRequest, type RpcId } from './rpc.ts';
import { approxTokens, CodexRateLimits, codexAccount, contextFromCodex, mcpToolTokens, type CodexAccount } from './usage.ts';
import type { ConfigReadResponse } from './generated/v2/ConfigReadResponse.ts';
import type { GetAccountResponse } from './generated/v2/GetAccountResponse.ts';
import type { GetAccountRateLimitsResponse } from './generated/v2/GetAccountRateLimitsResponse.ts';
import type { ListMcpServerStatusResponse } from './generated/v2/ListMcpServerStatusResponse.ts';
import type { ThreadTokenUsage } from './generated/v2/ThreadTokenUsage.ts';

export interface CodexSessionConfig {
  spawn: SpawnSpec;
  clientInfo: { name: string; version: string };
  requestTimeoutMs: number;
  interruptTimeoutMs: number;
}

interface ActiveTurn {
  bizziTurnId: string;
  codexTurnId?: string;
  /** Notifications for a turn that arrived before turn/start answered with the turn id. */
  buffer: IncomingNotification[];
  idWaiters: { resolve(id: string): void; reject(e: Error): void }[];
  interruptRequested: boolean;
  interruptTimer?: ReturnType<typeof setTimeout>;
  usageAtStart?: TokenUsageBreakdown;
  /** False on the first turn after resume/fork, when the thread total before the turn is unknown. */
  baselineKnown: boolean;
  /** Sum of per-request (`last`) usage seen during the turn; used when the baseline is unknown. */
  lastSum?: TokenUsageBreakdown;
  sawUsage: boolean;
  openTools: Set<string>;
}

type ApprovalMethod =
  | 'item/commandExecution/requestApproval'
  | 'item/fileChange/requestApproval'
  | 'item/permissions/requestApproval'
  | 'execCommandApproval'
  | 'applyPatchApproval';

interface PendingApproval {
  rpcId: RpcId;
  method: ApprovalMethod;
  params: unknown;
}

type PendingQuestion =
  | { rpcId: RpcId; kind: 'userInput' }
  | { rpcId: RpcId; kind: 'elicitation'; plan: ElicitationPlan };

interface Overrides {
  model?: string;
  effort?: string;
  approvalPolicy?: TurnStartParams['approvalPolicy'];
  sandboxPolicy?: SandboxPolicy;
}

/** Notifications that carry nothing bizzi needs (status is derived by the core). */
const IGNORED_NOTIFICATIONS = new Set<string>([
  'thread/started',
  'thread/status/changed',
  'thread/readState/changed',
  'thread/settings/updated',
  'turn/started',
  'turn/diff/updated',
  'item/fileChange/outputDelta',
  'item/fileChange/patchUpdated',
  'remoteControl/status/changed',
]);

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function toBizziError(e: unknown, what: string): BizziError {
  if (e instanceof BizziError) return e;
  if (e instanceof RpcClosedError) return new BizziError('agent_unavailable', `${what}: ${e.message}`);
  if (e instanceof RpcError) return new BizziError('internal', `${what}: ${e.message}`, { rpcCode: e.code, data: e.data });
  return new BizziError('internal', `${what}: ${errMessage(e)}`);
}

export function mcpConfigOverrides(servers: Record<string, McpServerSpec> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(servers ?? {})) {
    const key = name.replace(/[^A-Za-z0-9_-]/g, '_');
    if (spec.type === 'stdio') {
      const entry: Record<string, unknown> = { command: spec.command };
      if (spec.args) entry.args = spec.args;
      if (spec.env) entry.env = spec.env;
      out[`mcp_servers.${key}`] = entry;
    } else {
      const entry: Record<string, unknown> = { url: spec.url };
      if (spec.headers) entry.http_headers = spec.headers;
      out[`mcp_servers.${key}`] = entry;
    }
  }
  return out;
}

export function toUserInput(input: InputBlock[]): UserInput[] {
  const out: UserInput[] = [];
  for (const b of input) {
    switch (b.type) {
      case 'text':
        out.push({ type: 'text', text: b.text, text_elements: [] });
        break;
      case 'image':
        out.push({ type: 'image', url: `data:${b.mediaType};base64,${b.dataBase64}` });
        break;
      case 'file':
        if (IMAGE_EXTS.has(extname(b.path).toLowerCase())) out.push({ type: 'localImage', path: b.path });
        else out.push({ type: 'text', text: `[attached file: ${b.path}]`, text_elements: [] });
        break;
    }
  }
  return out;
}

/** OpenAI-style input tokens include cached tokens; bizzi reports them separately. */
export function toUsage(b: TokenUsageBreakdown, contextWindow?: number | null): Usage {
  const u: Usage = {
    inputTokens: Math.max(0, b.inputTokens - b.cachedInputTokens),
    outputTokens: b.outputTokens,
    cacheReadTokens: b.cachedInputTokens,
  };
  if (b.cacheWriteInputTokens) u.cacheWriteTokens = b.cacheWriteInputTokens;
  if (contextWindow) u.contextWindow = contextWindow;
  return u;
}

function addBreakdown(a: TokenUsageBreakdown | undefined, b: TokenUsageBreakdown): TokenUsageBreakdown {
  if (!a) return { ...b };
  return {
    totalTokens: a.totalTokens + b.totalTokens,
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheWriteInputTokens: a.cacheWriteInputTokens + b.cacheWriteInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningOutputTokens: a.reasoningOutputTokens + b.reasoningOutputTokens,
  };
}

function sameBreakdown(a: TokenUsageBreakdown | undefined, b: TokenUsageBreakdown): boolean {
  return !!a && a.totalTokens === b.totalTokens && a.inputTokens === b.inputTokens && a.outputTokens === b.outputTokens;
}

function diffUsage(now: TokenUsageBreakdown, before: TokenUsageBreakdown | undefined): TokenUsageBreakdown {
  if (!before) return now;
  return {
    totalTokens: now.totalTokens - before.totalTokens,
    inputTokens: now.inputTokens - before.inputTokens,
    cachedInputTokens: now.cachedInputTokens - before.cachedInputTokens,
    cacheWriteInputTokens: now.cacheWriteInputTokens - before.cacheWriteInputTokens,
    outputTokens: now.outputTokens - before.outputTokens,
    reasoningOutputTokens: now.reasoningOutputTokens - before.reasoningOutputTokens,
  };
}

function summarizePaths(paths: string[]): string {
  if (paths.length === 0) return 'files';
  const first = paths[0] as string;
  return paths.length === 1 ? first : `${first} (+${paths.length - 1} more)`;
}

function fileChangeKind(changes: { kind: { type: string } }[]): 'edit' | 'write' {
  return changes.length > 0 && changes.every((c) => c.kind.type === 'add') ? 'write' : 'edit';
}

interface ToolStart {
  kind: ToolKind;
  name: string;
  title: string;
  input?: unknown;
}

function toolStartFor(item: ThreadItem): ToolStart | undefined {
  switch (item.type) {
    case 'commandExecution':
      return {
        kind: 'shell',
        name: 'commandExecution',
        title: item.command,
        input: { command: item.command, cwd: item.cwd, commandActions: item.commandActions },
      };
    case 'fileChange':
      return {
        kind: fileChangeKind(item.changes),
        name: 'fileChange',
        title: summarizePaths(item.changes.map((c) => c.path)),
        input: { changes: item.changes },
      };
    case 'mcpToolCall':
      return { kind: 'mcp', name: `${item.server}.${item.tool}`, title: `${item.server}: ${item.tool}`, input: item.arguments };
    case 'dynamicToolCall':
      return { kind: 'other', name: item.tool, title: item.tool, input: item.arguments };
    case 'webSearch':
      return { kind: 'web', name: 'webSearch', title: item.query || 'Web search', input: { query: item.query, action: item.action } };
    case 'imageView':
      return { kind: 'read', name: 'imageView', title: item.path, input: { path: item.path } };
    case 'collabAgentToolCall':
      return {
        kind: 'task',
        name: `collab.${item.tool}`,
        title: item.prompt ? item.prompt.slice(0, 120) : item.tool,
        input: { tool: item.tool, prompt: item.prompt, receiverThreadIds: item.receiverThreadIds, model: item.model },
      };
    default:
      return undefined;
  }
}

function mcpResultText(result: { content: unknown[]; structuredContent: unknown } | null): string | undefined {
  if (!result) return undefined;
  const texts: string[] = [];
  for (const c of result.content) {
    if (typeof c === 'object' && c !== null && (c as { type?: unknown }).type === 'text') {
      const t = (c as { text?: unknown }).text;
      if (typeof t === 'string') texts.push(t);
    }
  }
  if (texts.length > 0) return texts.join('\n');
  if (result.structuredContent != null) return JSON.stringify(result.structuredContent);
  return result.content.length > 0 ? JSON.stringify(result.content) : undefined;
}

type ToolEnd = { status: 'ok' | 'error' | 'denied' | 'cancelled'; output?: string; error?: string };

function toolEndFor(item: ThreadItem): ToolEnd {
  switch (item.type) {
    case 'commandExecution': {
      const output = item.aggregatedOutput ?? undefined;
      switch (item.status) {
        case 'completed':
          return item.exitCode === null || item.exitCode === 0
            ? { status: 'ok', output }
            : { status: 'error', output, error: `exit code ${item.exitCode}` };
        case 'failed':
          return { status: 'error', output, error: item.exitCode === null ? 'command failed' : `exit code ${item.exitCode}` };
        case 'declined':
          return { status: 'denied', output };
        default:
          return { status: 'cancelled', output };
      }
    }
    case 'fileChange': {
      const output = item.changes.map((c) => `${c.kind.type} ${c.path}`).join('\n') || undefined;
      switch (item.status) {
        case 'completed':
          return { status: 'ok', output };
        case 'failed':
          return { status: 'error', output, error: 'patch failed to apply' };
        case 'declined':
          return { status: 'denied', output };
        default:
          return { status: 'cancelled', output };
      }
    }
    case 'mcpToolCall':
      if (item.status === 'completed') return { status: 'ok', output: mcpResultText(item.result) };
      if (item.status === 'failed') return { status: 'error', error: item.error?.message ?? 'MCP tool call failed', output: mcpResultText(item.result) };
      return { status: 'cancelled' };
    case 'dynamicToolCall':
      if (item.status === 'completed' && item.success !== false) return { status: 'ok' };
      if (item.status === 'inProgress') return { status: 'cancelled' };
      return { status: 'error', error: 'tool call failed' };
    case 'collabAgentToolCall':
      if (item.status === 'completed') return { status: 'ok' };
      if (item.status === 'failed') return { status: 'error', error: 'agent call failed' };
      return { status: 'cancelled' };
    case 'webSearch':
      return { status: 'ok', output: item.results ? JSON.stringify(item.results) : undefined };
    default:
      return { status: 'ok' };
  }
}

function fileChangedEvents(changes: FileUpdateChange[]): { path: string; change: 'created' | 'modified' | 'deleted'; diff?: string }[] {
  return changes.map((c) => {
    const change = c.kind.type === 'add' ? 'created' : c.kind.type === 'delete' ? 'deleted' : 'modified';
    const path = c.kind.type === 'update' && c.kind.move_path ? c.kind.move_path : c.path;
    return c.diff ? { path, change, diff: c.diff } : { path, change };
  });
}

function stopReasonFor(status: string): StopReason {
  switch (status) {
    case 'completed':
      return 'end_turn';
    case 'interrupted':
      return 'interrupted';
    case 'failed':
      return 'error';
    default:
      return 'other';
  }
}

export class CodexSession implements AdapterSession {
  readonly #emit: EmitFn;
  readonly #logger: Logger;
  readonly #cfg: CodexSessionConfig;
  readonly #proc: AppServerProcess;
  #threadId: string | undefined;
  #ready = false;
  #stopped = false;
  #failed: string | undefined;
  #turn: ActiveTurn | undefined;
  #overrides: Overrides = {};
  #items = new Map<string, ThreadItem>();
  #reasoningSummaryItems = new Set<string>();
  #approvals = new Map<string, PendingApproval>();
  #questions = new Map<string, PendingQuestion>();
  /** Resumed or forked: the thread total may include turns from before this session. */
  #inherited = false;
  #threadUsage: TokenUsageBreakdown | undefined;
  #contextWindow: number | undefined;
  /** Notifications received during the handshake (e.g. MCP startup status), replayed once the thread id is known. */
  #preReady: IncomingNotification[] = [];
  // ---- context + account usage (docs/usage.md)
  /** Estimated tokens of bizzi's developer instructions (bytes / 4). */
  #bizziPromptTokens = 0;
  /** Estimated tokens of bizzi's MCP tool schemas, once Codex has listed them. */
  #bizziMcpTokens = 0;
  #bizziServers = new Set<string>();
  #compactAt: number | undefined;
  #lastTokenUsage: ThreadTokenUsage | undefined;
  #lastContext: ContextUsage | undefined;
  #compactedTurns = new Set<string>();
  /** undefined = not read yet · null = no plan login (nothing is emitted). */
  #account: CodexAccount | null | undefined;
  #rateLimits = new CodexRateLimits();

  private constructor(cfg: CodexSessionConfig, emit: EmitFn, logger: Logger) {
    this.#cfg = cfg;
    this.#emit = emit;
    this.#logger = logger;
    this.#proc = new AppServerProcess(
      cfg.spawn,
      { onNotification: (n) => this.#onNotification(n), onRequest: (r) => this.#onRequest(r) },
      logger,
    );
    void this.#proc.exited.then(() => this.#onExit());
  }

  static async start(cfg: CodexSessionConfig, opts: StartSessionOptions, emit: EmitFn, logger: Logger): Promise<CodexSession> {
    const s = new CodexSession(cfg, emit, logger);
    try {
      await s.#handshake(opts);
    } catch (e) {
      await s.#proc.kill(500);
      const exit = s.#proc.exitInfo;
      if (e instanceof RpcClosedError && exit) {
        throw new BizziError('agent_unavailable', describeExit(exit, s.#proc.stderrTail()));
      }
      if (e instanceof RpcError && opts.resumeRef) {
        const what = opts.fork ? 'fork' : 'resume';
        throw new BizziError('not_found', `cannot ${what} codex thread ${opts.resumeRef}: ${e.message}`, { rpcCode: e.code });
      }
      throw toBizziError(e, 'codex app-server start failed');
    }
    void s.#collectUsage(opts);
    return s;
  }

  async #handshake(opts: StartSessionOptions): Promise<void> {
    const rpc = this.#proc.rpc;
    const t = this.#cfg.requestTimeoutMs;
    const init: InitializeParams = {
      clientInfo: { name: this.#cfg.clientInfo.name, title: 'bizzi', version: this.#cfg.clientInfo.version },
      capabilities: { experimentalApi: false, requestAttestation: false },
    };
    await rpc.request('initialize', init, t);
    rpc.notify('initialized');

    let permissionMode = opts.permissionMode;
    if (permissionMode !== undefined && !isPermissionMode(permissionMode)) {
      throw new BizziError(
        'bad_request',
        `unknown codex permission mode '${permissionMode}' (expected one of ${PERMISSION_MODE_NAMES.join(', ')})`,
      );
    }
    const preset = permissionMode !== undefined && isPermissionMode(permissionMode) ? PERMISSION_MODES[permissionMode] : undefined;
    const config: Record<string, unknown> = { ...mcpConfigOverrides(opts.mcpServers) };
    if (opts.effort) config.model_reasoning_effort = opts.effort;
    const common = {
      cwd: opts.cwd,
      ...(opts.model ? { model: opts.model } : {}),
      ...(preset ? { approvalPolicy: preset.approvalPolicy, sandbox: preset.sandbox } : {}),
      ...(Object.keys(config).length > 0 ? { config: config as ThreadStartParams['config'] } : {}),
      ...(opts.systemPromptAppend ? { developerInstructions: opts.systemPromptAppend } : {}),
    };

    let resp: ThreadStartResponse;
    this.#inherited = !!opts.resumeRef;
    if (opts.resumeRef && opts.fork) {
      // ThreadForkResponse has the same shape as ThreadStartResponse for the fields used below.
      const params: ThreadForkParams = { threadId: opts.resumeRef, ...common, excludeTurns: true };
      resp = await rpc.request<ThreadStartResponse>('thread/fork', params, t);
    } else if (opts.resumeRef) {
      const params: ThreadResumeParams = { threadId: opts.resumeRef, ...common, excludeTurns: true };
      resp = await rpc.request<ThreadStartResponse>('thread/resume', params, t);
    } else {
      const params: ThreadStartParams = { ...common, serviceName: 'bizzi' };
      resp = await rpc.request<ThreadStartResponse>('thread/start', params, t);
    }
    this.#threadId = resp.thread.id;
    permissionMode ??= permissionModeFor(resp.approvalPolicy, resp.sandbox);
    this.#ready = true;
    this.#emit({
      type: 'session.info',
      data: {
        agentSessionRef: resp.thread.id,
        ...(resp.model ? { model: resp.model } : {}),
        ...(permissionMode ? { permissionMode } : {}),
        ...(resp.reasoningEffort ? { effort: resp.reasoningEffort } : {}),
        ...(resp.thread.name ? { title: resp.thread.name } : {}),
      },
    });
    for (const n of this.#preReady.splice(0)) this.#onNotification(n);
  }

  agentSessionRef(): string | undefined {
    return this.#threadId;
  }

  /** Resolves once the app-server process has exited (stopped or died). */
  get exited(): Promise<void> {
    return this.#proc.exited.then(() => undefined);
  }

  async send(turnId: string, input: InputBlock[]): Promise<void> {
    this.#assertAlive();
    if (this.#turn) throw new BizziError('conflict', 'a codex turn is already in progress');
    const turn: ActiveTurn = {
      bizziTurnId: turnId,
      buffer: [],
      idWaiters: [],
      interruptRequested: false,
      usageAtStart: this.#threadUsage,
      baselineKnown: this.#threadUsage !== undefined || !this.#inherited,
      sawUsage: false,
      openTools: new Set(),
    };
    this.#turn = turn;
    const overrides = this.#overrides;
    const params: TurnStartParams = {
      threadId: this.#threadId as string,
      input: toUserInput(input),
      ...(overrides.model ? { model: overrides.model } : {}),
      ...(overrides.effort ? { effort: overrides.effort } : {}),
      ...(overrides.approvalPolicy ? { approvalPolicy: overrides.approvalPolicy } : {}),
      ...(overrides.sandboxPolicy ? { sandboxPolicy: overrides.sandboxPolicy } : {}),
    };
    let resp: TurnStartResponse;
    try {
      resp = await this.#proc.rpc.request<TurnStartResponse>('turn/start', params, this.#cfg.requestTimeoutMs);
    } catch (e) {
      const err = toBizziError(e, 'turn/start failed');
      if (this.#turn === turn) this.#finishTurn('error', err.message);
      throw err;
    }
    // Overrides persist on the Codex thread once a turn accepted them.
    if (this.#overrides === overrides) this.#overrides = {};
    if (this.#turn !== turn) return; // already finished (process died, or stop())
    this.#adoptTurnId(turn, resp.turn.id);
  }

  async steer(input: InputBlock[]): Promise<void> {
    this.#assertAlive();
    const turn = this.#turn;
    if (!turn) throw new BizziError('conflict', 'no codex turn in progress to steer');
    const expectedTurnId = turn.codexTurnId ?? (await this.#waitForTurnId(turn));
    const params: TurnSteerParams = { threadId: this.#threadId as string, input: toUserInput(input), expectedTurnId };
    try {
      await this.#proc.rpc.request('turn/steer', params, this.#cfg.requestTimeoutMs);
    } catch (e) {
      if (e instanceof RpcError) throw new BizziError('conflict', `turn/steer rejected: ${e.message}`, { rpcCode: e.code });
      throw toBizziError(e, 'turn/steer failed');
    }
  }

  async interrupt(): Promise<void> {
    const turn = this.#turn;
    if (!turn || turn.interruptRequested || this.#stopped || this.#failed) return;
    turn.interruptRequested = true;
    // Don't leave prompts open while the turn winds down.
    this.#cancelApprovals('turn interrupted');
    this.#cancelQuestions();
    turn.interruptTimer = setTimeout(() => {
      if (this.#turn === turn) {
        this.#logger.log('warn', 'codex did not confirm the interrupt; completing the turn locally', {
          turnId: turn.codexTurnId,
        });
        this.#finishTurn('interrupted');
      }
    }, this.#cfg.interruptTimeoutMs);
    if (turn.codexTurnId) await this.#sendInterrupt(turn);
    // Otherwise sent as soon as turn/start reports the turn id.
  }

  async respondApproval(approvalId: string, decision: ApprovalDecision): Promise<void> {
    const pending = this.#approvals.get(approvalId);
    if (!pending) throw new BizziError('not_found', `no pending codex approval ${approvalId}`);
    this.#approvals.delete(approvalId);
    this.#proc.rpc.respond(pending.rpcId, approvalResponse(pending, decision));
    this.#emit({ type: 'approval.resolved', data: { approvalId, decision: decision.decision } });
  }

  async respondQuestion(questionId: string, answers: QuestionAnswers | undefined): Promise<void> {
    const pending = this.#questions.get(questionId);
    if (!pending) throw new BizziError('not_found', `no pending codex question ${questionId}`);
    assertAnswers(answers);
    const reply = pending.kind === 'userInput' ? userInputResponse(answers) : elicitationResponse(pending.plan, answers);
    this.#questions.delete(questionId);
    this.#proc.rpc.respond(pending.rpcId, reply);
    this.#resolveQuestion(questionId, answers);
  }

  async set(opts: { model?: string; permissionMode?: string; effort?: string }): Promise<void> {
    this.#assertAlive();
    const next: Overrides = { ...this.#overrides };
    if (opts.permissionMode !== undefined) {
      if (!isPermissionMode(opts.permissionMode)) {
        throw new BizziError(
          'bad_request',
          `unknown codex permission mode '${opts.permissionMode}' (expected one of ${PERMISSION_MODE_NAMES.join(', ')})`,
        );
      }
      const preset = PERMISSION_MODES[opts.permissionMode];
      next.approvalPolicy = preset.approvalPolicy;
      next.sandboxPolicy = sandboxPolicyFor(preset.sandbox);
    }
    if (opts.model !== undefined) next.model = opts.model;
    if (opts.effort !== undefined) next.effort = opts.effort;
    // app-server has no "update thread settings" request; overrides ride on the next turn/start.
    this.#overrides = next;
    this.#emit({
      type: 'session.info',
      data: {
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
        ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
      },
    });
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#turn) this.#finishTurn('interrupted');
    this.#cancelApprovals('session stopped');
    this.#cancelQuestions();
    await this.#proc.kill();
    if (!this.#failed) this.#emit({ type: 'session.status', data: { status: 'ended' } });
  }

  // ---- internals ----

  #assertAlive(): void {
    if (this.#failed) throw new BizziError('agent_unavailable', this.#failed);
    if (this.#stopped || !this.#ready) throw new BizziError('agent_unavailable', 'codex session is not running');
  }

  #waitForTurnId(turn: ActiveTurn): Promise<string> {
    return new Promise((resolve, reject) => turn.idWaiters.push({ resolve, reject }));
  }

  #adoptTurnId(turn: ActiveTurn, codexTurnId: string): void {
    turn.codexTurnId = codexTurnId;
    const buffered = turn.buffer;
    turn.buffer = [];
    for (const n of buffered) {
      if (this.#turn !== turn) break;
      if (turnIdOf(n.params) === codexTurnId) this.#dispatch(n);
      else this.#logger.log('debug', 'dropping buffered notification for another turn', { method: n.method });
    }
    for (const w of turn.idWaiters.splice(0)) w.resolve(codexTurnId);
    if (turn.interruptRequested && this.#turn === turn) void this.#sendInterrupt(turn);
  }

  async #sendInterrupt(turn: ActiveTurn): Promise<void> {
    try {
      await this.#proc.rpc.request(
        'turn/interrupt',
        { threadId: this.#threadId as string, turnId: turn.codexTurnId as string },
        this.#cfg.requestTimeoutMs,
      );
    } catch (e) {
      this.#logger.log('warn', 'turn/interrupt failed', { error: errMessage(e) });
      // The turn may already be over on the Codex side; don't leave bizzi waiting.
      if (this.#turn === turn && e instanceof RpcError) this.#finishTurn('interrupted');
    }
  }

  #finishTurn(stopReason: StopReason, error?: string, usage?: Usage): void {
    const turn = this.#turn;
    if (!turn) return;
    this.#turn = undefined;
    if (turn.interruptTimer) clearTimeout(turn.interruptTimer);
    for (const toolId of turn.openTools) {
      this.#emit({ type: 'tool.completed', data: { toolId, status: 'cancelled' } });
    }
    for (const w of turn.idWaiters.splice(0)) w.reject(new BizziError('conflict', 'the codex turn ended'));
    this.#cancelApprovals('turn ended');
    this.#cancelQuestions();
    this.#items.clear();
    this.#reasoningSummaryItems.clear();
    this.#emit({
      type: 'turn.completed',
      data: {
        turnId: turn.bizziTurnId,
        stopReason,
        ...(usage ? { usage } : {}),
        ...(error ? { error } : {}),
      },
    });
  }

  /** Per-turn usage: the change in the thread total, or the sum of per-request usage when the start total is unknown. */
  #turnUsage(turn: ActiveTurn): Usage | undefined {
    if (!turn.sawUsage || !this.#threadUsage) return undefined;
    if (!turn.baselineKnown) return turn.lastSum ? toUsage(turn.lastSum, this.#contextWindow) : undefined;
    return toUsage(diffUsage(this.#threadUsage, turn.usageAtStart), this.#contextWindow);
  }

  /** Answer every pending approval `cancel` (a no-op once the process is gone) and report it cancelled. */
  #cancelApprovals(reason: string): void {
    for (const [approvalId, p] of this.#approvals) {
      this.#approvals.delete(approvalId);
      this.#proc.rpc.respond(p.rpcId, approvalResponse(p, { decision: 'deny', message: reason }, true));
      this.#emit({ type: 'approval.resolved', data: { approvalId, decision: 'cancelled', by: 'bizzi' } });
    }
  }

  /** Decline / cancel every pending question (a no-op once the process is gone) and report it cancelled. */
  #cancelQuestions(): void {
    for (const [questionId, q] of this.#questions) {
      this.#questions.delete(questionId);
      this.#proc.rpc.respond(q.rpcId, q.kind === 'userInput' ? userInputResponse(undefined) : elicitationResponse(q.plan, undefined, true));
      this.#emit({ type: 'question.resolved', data: { questionId, cancelled: true } });
    }
  }

  #askQuestion(form: QuestionForm, pending: PendingQuestion): void {
    const questionId = newId('q');
    this.#questions.set(questionId, pending);
    this.#emit({
      type: 'question.asked',
      data: { questionId, text: form.text, ...(form.options ? { options: form.options } : {}), questions: form.questions },
    });
    this.#emit({ type: 'session.status', data: { status: 'waiting_input', prompt: 'input' } });
  }

  #resolveQuestion(questionId: string, answers: QuestionAnswers | undefined): void {
    this.#emit({ type: 'question.resolved', data: answers === undefined ? { questionId, cancelled: true } : { questionId, answers } });
    if (this.#questions.size > 0 || this.#stopped || this.#failed) return;
    const status = this.#approvals.size > 0 ? 'waiting_approval' : this.#turn ? 'running' : 'idle';
    this.#emit({ type: 'session.status', data: { status } });
  }

  #onExit(): void {
    if (this.#stopped || !this.#ready) return;
    const exit = this.#proc.exitInfo;
    const msg = exit ? describeExit(exit, this.#proc.stderrTail()) : 'codex app-server exited';
    this.#failed = msg;
    this.#emit({ type: 'error', data: { message: msg, code: 'process_exited', fatal: true } });
    if (this.#turn) this.#finishTurn('error', msg);
    // Usually already cancelled by #finishTurn; this covers requests that arrived between turns.
    this.#cancelApprovals('codex app-server exited');
    this.#cancelQuestions();
    this.#emit({ type: 'session.status', data: { status: 'failed', reason: msg } });
  }

  #onNotification(n: IncomingNotification): void {
    if (this.#stopped) return;
    if (!this.#ready) {
      if (this.#preReady.length < 1000) this.#preReady.push(n);
      return;
    }
    const params = n.params as Record<string, unknown> | undefined;
    const threadId = params && typeof params.threadId === 'string' ? params.threadId : undefined;
    if (threadId !== undefined && threadId !== this.#threadId) {
      this.#logger.log('debug', 'ignoring notification for another thread', { method: n.method, threadId });
      return;
    }
    const turnId = turnIdOf(params);
    if (turnId !== undefined) {
      const turn = this.#turn;
      if (turn && turn.codexTurnId === undefined) {
        turn.buffer.push(n);
        return;
      }
      if (!turn || turn.codexTurnId !== turnId) {
        this.#logger.log('debug', 'ignoring notification for an inactive turn', { method: n.method, turnId });
        return;
      }
    }
    this.#dispatch(n);
  }

  #dispatch(n: IncomingNotification): void {
    const method = n.method as NotificationMethod;
    if (IGNORED_NOTIFICATIONS.has(method)) return;
    switch (method) {
      case 'turn/completed': {
        const p = n.params as NotificationParams<'turn/completed'>;
        const turn = this.#turn;
        if (!turn) return;
        const reason = stopReasonFor(p.turn.status);
        this.#finishTurn(reason, p.turn.error?.message ?? undefined, this.#turnUsage(turn));
        return;
      }
      case 'item/started':
        return this.#onItemStarted((n.params as NotificationParams<'item/started'>).item);
      case 'item/completed':
        return this.#onItemCompleted((n.params as NotificationParams<'item/completed'>).item);
      case 'item/agentMessage/delta': {
        const p = n.params as NotificationParams<'item/agentMessage/delta'>;
        this.#emit({ type: 'message.delta', data: { messageId: p.itemId, role: 'assistant', text: p.delta } });
        return;
      }
      case 'item/reasoning/summaryTextDelta': {
        const p = n.params as NotificationParams<'item/reasoning/summaryTextDelta'>;
        this.#reasoningSummaryItems.add(p.itemId);
        this.#emit({ type: 'reasoning.delta', data: { messageId: p.itemId, text: p.delta } });
        return;
      }
      case 'item/reasoning/summaryPartAdded': {
        const p = n.params as NotificationParams<'item/reasoning/summaryPartAdded'>;
        if (p.summaryIndex > 0) this.#emit({ type: 'reasoning.delta', data: { messageId: p.itemId, text: '\n\n' } });
        return;
      }
      case 'item/reasoning/textDelta': {
        // Raw reasoning (e.g. open-weight models). Only shown when there is no summary stream.
        const p = n.params as NotificationParams<'item/reasoning/textDelta'>;
        if (!this.#reasoningSummaryItems.has(p.itemId)) {
          this.#emit({ type: 'reasoning.delta', data: { messageId: p.itemId, text: p.delta } });
        }
        return;
      }
      case 'item/commandExecution/outputDelta': {
        const p = n.params as NotificationParams<'item/commandExecution/outputDelta'>;
        this.#emit({ type: 'tool.updated', data: { toolId: p.itemId, output: p.delta } });
        return;
      }
      case 'item/mcpToolCall/progress': {
        const p = n.params as NotificationParams<'item/mcpToolCall/progress'>;
        this.#emit({ type: 'tool.updated', data: { toolId: p.itemId, progress: p.message } });
        return;
      }
      case 'turn/plan/updated': {
        const p = n.params as NotificationParams<'turn/plan/updated'>;
        const items: PlanItem[] = p.plan.map((s) => ({
          text: s.step,
          status: s.status === 'inProgress' ? 'in_progress' : s.status,
        }));
        this.#emit({ type: 'plan.updated', data: { items } });
        return;
      }
      case 'account/rateLimits/updated': {
        const p = n.params as NotificationParams<'account/rateLimits/updated'>;
        this.#rateLimits.applyUpdate(p.rateLimits);
        this.#emitAccount();
        return;
      }
      case 'account/updated': {
        const p = n.params as NotificationParams<'account/updated'>;
        if (this.#account && p.planType && p.planType !== 'unknown') {
          this.#account.planType = p.planType;
          this.#emitAccount();
        }
        return;
      }
      case 'thread/compacted': {
        const p = n.params as NotificationParams<'thread/compacted'>;
        this.#noteCompaction(p.turnId);
        return;
      }
      case 'thread/tokenUsage/updated': {
        const p = n.params as NotificationParams<'thread/tokenUsage/updated'>;
        this.#lastTokenUsage = p.tokenUsage;
        const changed = !sameBreakdown(this.#threadUsage, p.tokenUsage.total);
        this.#threadUsage = p.tokenUsage.total;
        if (p.tokenUsage.modelContextWindow) this.#contextWindow = p.tokenUsage.modelContextWindow;
        if (this.#turn) {
          this.#turn.sawUsage = true;
          if (changed) this.#turn.lastSum = addBreakdown(this.#turn.lastSum, p.tokenUsage.last);
        }
        this.#emit({ type: 'usage.updated', data: toUsage(p.tokenUsage.total, this.#contextWindow) });
        this.#emitContext();
        return;
      }
      case 'error': {
        const p = n.params as NotificationParams<'error'>;
        const info = p.error.codexErrorInfo;
        const code = typeof info === 'string' ? info : info && typeof info === 'object' ? Object.keys(info)[0] : undefined;
        const message = p.willRetry ? `${p.error.message} (retrying)` : p.error.message;
        this.#emit({ type: 'error', data: { message, ...(code ? { code } : {}), fatal: false } });
        return;
      }
      case 'thread/name/updated': {
        const p = n.params as NotificationParams<'thread/name/updated'>;
        if (p.threadName) this.#emit({ type: 'session.info', data: { title: p.threadName } });
        return;
      }
      case 'model/rerouted': {
        const p = n.params as NotificationParams<'model/rerouted'>;
        this.#emit({ type: 'session.info', data: { model: p.toModel } });
        return;
      }
      case 'serverRequest/resolved': {
        const p = n.params as NotificationParams<'serverRequest/resolved'>;
        // Codex withdrew a request before bizzi answered (e.g. a non-blocking question that auto-resolved).
        for (const [approvalId, a] of this.#approvals) {
          if (a.rpcId === p.requestId) {
            this.#approvals.delete(approvalId);
            this.#emit({ type: 'approval.resolved', data: { approvalId, decision: 'cancelled', by: 'agent' } });
          }
        }
        for (const [questionId, q] of this.#questions) {
          if (q.rpcId === p.requestId) {
            this.#questions.delete(questionId);
            this.#resolveQuestion(questionId, undefined);
          }
        }
        return;
      }
      default:
        this.#emit({ type: 'agent.raw', data: { agent: 'codex', payload: { method: n.method, params: n.params } } });
    }
  }

  // ---- context + account usage

  /** Background reads after start: compaction limit, bizzi's MCP tool schemas, the ChatGPT account and its rate limits. */
  async #collectUsage(opts: StartSessionOptions): Promise<void> {
    this.#bizziPromptTokens = approxTokens(opts.systemPromptAppend);
    for (const name of Object.keys(opts.mcpServers ?? {})) this.#bizziServers.add(name.replace(/[^A-Za-z0-9_-]/g, '_'));
    const rpc = this.#proc.rpc;
    const t = this.#cfg.requestTimeoutMs;
    const quiet = (what: string) => (e: unknown) => {
      this.#logger.log('debug', `${what} failed`, { error: errMessage(e) });
      return undefined;
    };
    const config = rpc.request<ConfigReadResponse>('config/read', { cwd: opts.cwd }, t).catch(quiet('config/read'));
    const mcp = this.#bizziServers.size
      ? rpc
          .request<ListMcpServerStatusResponse>('mcpServerStatus/list', { threadId: this.#threadId, detail: 'toolsAndAuthOnly', limit: 100 }, t)
          .catch(quiet('mcpServerStatus/list'))
      : Promise.resolve(undefined);
    const account = rpc.request<GetAccountResponse>('account/read', { refreshToken: false }, t).catch(quiet('account/read'));

    const limit = (await config)?.config?.model_auto_compact_token_limit;
    if (limit !== null && limit !== undefined && Number(limit) > 0) this.#compactAt = Number(limit);
    void mcp.then((r) => {
      const n = mcpToolTokens(r, this.#bizziServers);
      if (n === this.#bizziMcpTokens) return;
      this.#bizziMcpTokens = n;
      this.#emitContext();
    });

    const a = codexAccount((await account)?.account);
    if (!a) {
      this.#account = null;
      return;
    }
    const limits = await rpc
      .request<GetAccountRateLimitsResponse>('account/rateLimits/read', { excludeResetCreditDetails: true }, t)
      .catch(quiet('account/rateLimits/read'));
    if (limits) this.#rateLimits.applyRead(limits);
    if (!a.accountId) a.accountId = this.#rateLimits.accountId ?? '';
    this.#account = a.accountId ? a : null;
    this.#emitAccount();
  }

  #emitContext(): void {
    const u = this.#lastTokenUsage;
    if (!u || this.#stopped) return;
    const ctx = contextFromCodex(u, this.#contextWindow, {
      bizziTokens: this.#bizziPromptTokens + this.#bizziMcpTokens,
      ...(this.#compactAt ? { compactAt: this.#compactAt } : {}),
    });
    if (!ctx) return;
    if (this.#lastContext && JSON.stringify(this.#lastContext) === JSON.stringify(ctx)) return;
    this.#lastContext = ctx;
    this.#emit({ type: 'context.updated', data: ctx });
  }

  /** Codex reports compaction both as a (deprecated) `thread/compacted` and a `contextCompaction` item: once per turn. */
  #noteCompaction(key: string): void {
    if (this.#compactedTurns.has(key)) return;
    this.#compactedTurns.add(key);
    if (this.#compactedTurns.size > 100) this.#compactedTurns.delete(this.#compactedTurns.values().next().value!);
    const before = this.#lastContext?.used;
    this.#lastContext = undefined; // the next token-usage update reports the post-compaction size
    this.#emit({ type: 'context.compacted', data: before !== undefined ? { before } : {} });
  }

  #emitAccount(): void {
    const a = this.#account;
    if (!a || this.#stopped || !this.#rateLimits.known) return;
    const plan = a.planType ?? this.#rateLimits.planType;
    const usage: AccountUsage = {
      agent: 'codex',
      accountId: a.accountId,
      label: `codex · ${plan ?? 'chatgpt'} · ${a.email ?? a.accountId}`,
      billing: 'plan',
      machines: [],
      status: this.#rateLimits.status(),
      observedAt: new Date().toISOString(),
    };
    const windows = this.#rateLimits.windows();
    if (windows.length) usage.windows = windows;
    this.#emit({ type: 'account.usage', data: usage });
  }

  #onItemStarted(item: ThreadItem): void {
    this.#items.set(item.id, item);
    const tool = toolStartFor(item);
    if (tool) this.#startTool(item.id, tool);
  }

  #startTool(id: string, tool: ToolStart): void {
    const turn = this.#turn;
    if (turn?.openTools.has(id)) return;
    turn?.openTools.add(id);
    this.#emit({ type: 'tool.started', data: { toolId: id, ...tool } });
  }

  #onItemCompleted(item: ThreadItem): void {
    this.#items.set(item.id, item);
    switch (item.type) {
      case 'agentMessage':
        this.#emit({ type: 'message.completed', data: { messageId: item.id, role: 'assistant', text: item.text } });
        return;
      case 'reasoning': {
        const summary = item.summary.join('\n\n');
        const text = summary || item.content.join('');
        if (text) this.#emit({ type: 'reasoning.completed', data: { messageId: item.id, text, summary: summary.length > 0 } });
        return;
      }
      case 'userMessage':
        return;
      case 'contextCompaction':
        this.#noteCompaction(this.#turn?.codexTurnId ?? `item:${item.id}`);
        return;
    }
    const tool = toolStartFor(item);
    if (!tool) {
      this.#emit({ type: 'agent.raw', data: { agent: 'codex', payload: { method: 'item/completed', params: { item } } } });
      return;
    }
    this.#startTool(item.id, tool); // no-op unless item/started was missed
    if (item.type === 'fileChange' && item.status === 'completed') {
      for (const fc of fileChangedEvents(item.changes)) this.#emit({ type: 'file.changed', data: fc });
    }
    this.#turn?.openTools.delete(item.id);
    const end = toolEndFor(item);
    this.#emit({
      type: 'tool.completed',
      data: {
        toolId: item.id,
        status: end.status,
        ...(end.output !== undefined ? { output: end.output } : {}),
        ...(end.error !== undefined ? { error: end.error } : {}),
      },
    });
  }

  #onRequest(r: IncomingRequest): void {
    const rpc = this.#proc.rpc;
    if (!this.#ready || this.#stopped) {
      rpc.respondError(r.id, { code: -32000, message: 'bizzi session is not running' });
      return;
    }
    const params = r.params as Record<string, unknown> | undefined;
    const threadId = params && typeof params.threadId === 'string' ? params.threadId : undefined;
    if (threadId !== undefined && threadId !== this.#threadId) {
      this.#logger.log('warn', 'approval request for another thread', { method: r.method, threadId });
    }
    let req: Omit<ApprovalRequest, 'approvalId' | 'editable' | 'options'> | undefined;
    switch (r.method) {
      case 'item/commandExecution/requestApproval': {
        const p = r.params as CommandExecutionRequestApprovalParams;
        const item = this.#items.get(p.itemId);
        const command = p.command ?? (item?.type === 'commandExecution' ? item.command : undefined);
        req = {
          toolId: p.itemId,
          kind: 'shell',
          title: command ?? (p.kind === 'writeStdin' ? 'Write to a running command' : 'Run a command'),
          ...(p.reason ? { description: p.reason } : {}),
          input: {
            command,
            cwd: p.cwd,
            commandActions: p.commandActions,
            approvalKind: p.kind,
            networkApprovalContext: p.networkApprovalContext,
          },
        };
        break;
      }
      case 'item/fileChange/requestApproval': {
        const p = r.params as FileChangeRequestApprovalParams;
        const item = this.#items.get(p.itemId);
        const changes = item?.type === 'fileChange' ? item.changes : [];
        req = {
          toolId: p.itemId,
          kind: fileChangeKind(changes) as ApprovalKind,
          title: changes.length > 0 ? `Change ${summarizePaths(changes.map((c) => c.path))}` : 'Apply file changes',
          ...(p.reason ? { description: p.reason } : {}),
          input: { changes, grantRoot: p.grantRoot },
        };
        break;
      }
      case 'item/permissions/requestApproval': {
        const p = r.params as PermissionsRequestApprovalParams;
        req = {
          toolId: p.itemId,
          kind: 'other',
          title: 'Grant additional permissions',
          ...(p.reason ? { description: p.reason } : {}),
          input: { permissions: p.permissions, cwd: p.cwd },
        };
        break;
      }
      case 'execCommandApproval': {
        const p = r.params as ExecCommandApprovalParams;
        req = {
          toolId: p.callId,
          kind: 'shell',
          title: p.command.join(' '),
          ...(p.reason ? { description: p.reason } : {}),
          input: { command: p.command, cwd: p.cwd },
        };
        break;
      }
      case 'applyPatchApproval': {
        const p = r.params as ApplyPatchApprovalParams;
        const paths = Object.keys(p.fileChanges);
        req = {
          toolId: p.callId,
          kind: 'edit',
          title: `Change ${summarizePaths(paths)}`,
          ...(p.reason ? { description: p.reason } : {}),
          input: { fileChanges: p.fileChanges, grantRoot: p.grantRoot },
        };
        break;
      }
      case 'item/tool/requestUserInput': {
        const p = r.params as ToolRequestUserInputParams;
        this.#askQuestion(userInputQuestions(p), { rpcId: r.id, kind: 'userInput' });
        return;
      }
      case 'mcpServer/elicitation/request': {
        const p = r.params as McpServerElicitationRequestParams;
        const { form, plan } = elicitationQuestions(p);
        this.#askQuestion(form, { rpcId: r.id, kind: 'elicitation', plan });
        return;
      }
      default:
        this.#logger.log('warn', 'unsupported codex server request', { method: r.method });
        rpc.respondError(r.id, { code: -32601, message: `bizzi does not support ${r.method}` });
        this.#emit({ type: 'agent.raw', data: { agent: 'codex', payload: { method: r.method, params: r.params, unsupported: true } } });
        return;
    }
    const approvalId = newId('ap');
    this.#approvals.set(approvalId, { rpcId: r.id, method: r.method as ApprovalMethod, params: r.params });
    this.#emit({
      type: 'approval.requested',
      data: { approvalId, ...req, editable: false, options: ['allow', 'allow_always', 'deny'] },
    });
  }
}

function turnIdOf(params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null) return undefined;
  const p = params as { turnId?: unknown; turn?: { id?: unknown } };
  if (typeof p.turnId === 'string') return p.turnId;
  if (typeof p.turn === 'object' && p.turn !== null && typeof p.turn.id === 'string') return p.turn.id;
  return undefined;
}

/** Translate a bizzi decision into the response shape the given Codex request expects. */
export function approvalResponse(p: PendingApproval, decision: ApprovalDecision, cancel = false): unknown {
  const d: ApprovalDecisionKind = decision.decision;
  switch (p.method) {
    case 'item/commandExecution/requestApproval': {
      const out: CommandExecutionApprovalDecision =
        d === 'allow' ? 'accept' : d === 'allow_always' ? 'acceptForSession' : cancel ? 'cancel' : 'decline';
      return { decision: out };
    }
    case 'item/fileChange/requestApproval': {
      const out: FileChangeApprovalDecision =
        d === 'allow' ? 'accept' : d === 'allow_always' ? 'acceptForSession' : cancel ? 'cancel' : 'decline';
      return { decision: out };
    }
    case 'item/permissions/requestApproval': {
      const req = (p.params as PermissionsRequestApprovalParams).permissions;
      const resp: PermissionsRequestApprovalResponse =
        d === 'deny'
          ? { permissions: {}, scope: 'turn' }
          : {
              permissions: {
                ...(req.network ? { network: req.network } : {}),
                ...(req.fileSystem ? { fileSystem: req.fileSystem } : {}),
              },
              scope: d === 'allow_always' ? 'session' : 'turn',
            };
      return resp;
    }
    case 'execCommandApproval':
    case 'applyPatchApproval': {
      const out: ReviewDecision =
        d === 'allow'
          ? 'approved'
          : d === 'allow_always'
            ? 'approved_for_session'
            : cancel
              ? 'abort'
              : { denied: { rejection: decision.message ?? 'Denied by the user' } };
      return { decision: out };
    }
  }
}

