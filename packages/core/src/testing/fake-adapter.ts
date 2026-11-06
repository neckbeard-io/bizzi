// A scripted, dependency-free AgentAdapter for tests, demos (`bizzi serve --fake`) and other packages.
//
// Default script, driven by the first text block of the input:
//   /tool <command>     a shell tool call that runs without approval
//   /approve <command>  a shell tool call that asks for approval first
//   /slow <ms>          stream text for roughly <ms> milliseconds
//   /fail <message>     the turn ends with stopReason 'error'
//   /crash              the session fails (session.status failed)
//   /exit               the session ends (session.status ended)
//   anything else       echoed back as "echo: <text>"

import {
  NO_CAPABILITIES,
  newId,
  type AdapterContext,
  type AdapterSession,
  type AgentAdapter,
  type AgentCapabilities,
  type AgentKind,
  type AgentProbe,
  type ApprovalDecision,
  type ApprovalRequest,
  type EmitFn,
  type InputBlock,
  type SessionEventBody,
  type SessionMode,
  type SessionStatus,
  type StartSessionOptions,
  type StopReason,
  type ToolKind,
} from '@bizzi/protocol';

export type FakeStep =
  | { type: 'emit'; event: SessionEventBody }
  | { type: 'text'; text: string; chunks?: number }
  | {
      type: 'tool';
      title: string;
      kind?: ToolKind;
      name?: string;
      input?: unknown;
      output?: string;
      /** Ask for approval before "running" the tool. */
      approval?: boolean | Partial<Omit<ApprovalRequest, 'approvalId'>>;
    }
  | { type: 'sleep'; ms: number }
  | { type: 'fail'; error: string }
  | { type: 'status'; status: SessionStatus; reason?: string };

export interface FakeTurnContext {
  turnId: string;
  session: FakeSession;
}

export type FakeScript = (input: InputBlock[], ctx: FakeTurnContext) => FakeStep[];

export interface FakeAdapterOptions {
  agent?: AgentKind;
  /** Modes this adapter serves (default ['structured']). */
  modes?: SessionMode[];
  /** Overrides merged into the capabilities of every mode. */
  capabilities?: Partial<AgentCapabilities>;
  probe?: Partial<AgentProbe>;
  script?: FakeScript;
  /** Delay before start() resolves. */
  startDelayMs?: number;
  /** Make start() reject with this message. */
  failStart?: string;
  /** Delay between streamed chunks (default 2 ms). */
  chunkDelayMs?: number;
  /** Don't emit turn.completed on interrupt (to exercise the core's safety net). */
  ignoreInterrupt?: boolean;
}

const STRUCTURED_CAPS: AgentCapabilities = {
  ...NO_CAPABILITIES,
  modes: ['structured'],
  streaming: 'token',
  steer: true,
  interrupt: true,
  resume: true,
  resumeAfterNodeRestart: true,
  approvals: 'per-tool',
  editableApprovals: true,
  permissionModes: ['default', 'acceptEdits', 'plan', 'bypassPermissions'],
  models: ['fake-model', 'fake-model-large'],
  setModelMidSession: true,
  effort: ['low', 'medium', 'high'],
  usage: 'tokens',
};

const TERMINAL_CAPS: AgentCapabilities = {
  ...NO_CAPABILITIES,
  modes: ['terminal'],
  interrupt: true,
  terminal: true,
};

export class FakeAdapter implements AgentAdapter {
  readonly agent: AgentKind;
  readonly options: FakeAdapterOptions;
  /** Every StartSessionOptions passed to start(), in order. */
  readonly starts: StartSessionOptions[] = [];
  /** Every session created, in order. */
  readonly sessions: FakeSession[] = [];
  readonly #modes: SessionMode[];

  constructor(options: FakeAdapterOptions = {}) {
    this.options = options;
    this.agent = options.agent ?? 'claude';
    this.#modes = options.modes ?? ['structured'];
  }

  async probe(): Promise<AgentProbe> {
    return { agent: this.agent, installed: true, version: '0.0.0-fake', auth: 'ok', path: '/fake/bin', ...this.options.probe };
  }

  capabilities(mode: SessionMode): AgentCapabilities {
    if (!this.#modes.includes(mode)) return { ...NO_CAPABILITIES };
    const base = mode === 'terminal' ? TERMINAL_CAPS : STRUCTURED_CAPS;
    return { ...base, ...this.options.capabilities, modes: [mode] };
  }

  async start(opts: StartSessionOptions, emit: EmitFn, ctx: AdapterContext): Promise<AdapterSession> {
    this.starts.push(opts);
    if (this.options.startDelayMs) await sleep(this.options.startDelayMs);
    if (this.options.failStart) throw new Error(this.options.failStart);
    const session = new FakeSession(this, opts, emit, ctx);
    this.sessions.push(session);
    session.init();
    return session;
  }

  /** The most recently started session. */
  get last(): FakeSession | undefined {
    return this.sessions.at(-1);
  }
}

export class FakeSession implements AdapterSession {
  readonly opts: StartSessionOptions;
  readonly steered: InputBlock[][] = [];
  readonly terminalInput: Uint8Array[] = [];
  stopped = false;
  size?: { cols: number; rows: number };
  readonly #adapter: FakeAdapter;
  readonly #emit: EmitFn;
  readonly #ref: string;
  #model: string;
  #turn?: { id: string; abort: AbortController; done: boolean };
  readonly #approvals = new Map<string, (d: ApprovalDecision) => void>();

  constructor(adapter: FakeAdapter, opts: StartSessionOptions, emit: EmitFn, _ctx: AdapterContext) {
    this.#adapter = adapter;
    this.opts = opts;
    this.#emit = emit;
    this.#ref = opts.resumeRef ?? `fake_${newId('s').slice(2)}`;
    this.#model = opts.model ?? 'fake-model';
    if (opts.cols && opts.rows) this.size = { cols: opts.cols, rows: opts.rows };
  }

  init(): void {
    if (this.opts.mode === 'terminal') {
      this.#emit({ type: 'term.output', data: { dataBase64: b64(`fake terminal (${this.opts.cwd})\r\n$ `) } });
      return;
    }
    this.#emit({ type: 'session.info', data: { agentSessionRef: this.#ref, model: this.#model } });
  }

  get currentTurnId(): string | undefined {
    return this.#turn && !this.#turn.done ? this.#turn.id : undefined;
  }

  /** Approval ids waiting for a decision. */
  get pendingApprovals(): string[] {
    return [...this.#approvals.keys()];
  }

  agentSessionRef(): string | undefined {
    return this.opts.mode === 'terminal' ? undefined : this.#ref;
  }

  async send(turnId: string, input: InputBlock[]): Promise<void> {
    if (this.stopped) throw new Error('session stopped');
    if (this.currentTurnId) throw new Error('turn already running');
    const turn = { id: turnId, abort: new AbortController(), done: false };
    this.#turn = turn;
    const script = this.#adapter.options.script ?? defaultScript;
    const steps = this.opts.mode === 'terminal' ? terminalScript(input) : script(input, { turnId, session: this });
    // Run asynchronously: send() resolves once the input is accepted.
    setImmediate(() => void this.#run(turn, steps));
  }

  async steer(input: InputBlock[]): Promise<void> {
    this.steered.push(input);
    this.#emit({ type: 'message.completed', data: { messageId: newId('msg'), role: 'user', text: textOf(input) } });
  }

  async interrupt(): Promise<void> {
    const turn = this.#turn;
    if (!turn || turn.done) return;
    if (this.#adapter.options.ignoreInterrupt) return;
    turn.abort.abort();
  }

  async respondApproval(approvalId: string, decision: ApprovalDecision): Promise<void> {
    const resolve = this.#approvals.get(approvalId);
    if (!resolve) throw new Error(`unknown approval ${approvalId}`);
    this.#approvals.delete(approvalId);
    resolve(decision);
  }

  async set(opts: { model?: string; permissionMode?: string; effort?: string }): Promise<void> {
    if (opts.model) this.#model = opts.model;
    this.#emit({ type: 'session.info', data: { ...opts } });
  }

  writeTerminal(data: Uint8Array): void {
    this.terminalInput.push(data);
    this.#emit({ type: 'term.output', data: { dataBase64: Buffer.from(data).toString('base64') } });
  }

  resizeTerminal(cols: number, rows: number): void {
    this.size = { cols, rows };
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const turn = this.#turn;
    if (turn && !turn.done) {
      turn.abort.abort();
      this.#complete(turn, 'interrupted');
    }
    if (this.opts.mode === 'terminal') this.#emit({ type: 'term.exited', data: { exitCode: 0 } });
  }

  #complete(turn: { id: string; done: boolean }, stopReason: StopReason, error?: string): void {
    if (turn.done) return;
    turn.done = true;
    const data: { turnId: string; stopReason: StopReason; error?: string; usage?: { inputTokens: number; outputTokens: number } } = {
      turnId: turn.id,
      stopReason,
    };
    if (error) data.error = error;
    if (stopReason === 'end_turn') data.usage = { inputTokens: 10, outputTokens: 20 };
    this.#emit({ type: 'turn.completed', data });
  }

  async #run(turn: { id: string; abort: AbortController; done: boolean }, steps: FakeStep[]): Promise<void> {
    const signal = turn.abort.signal;
    const chunkDelay = this.#adapter.options.chunkDelayMs ?? 2;
    try {
      for (const step of steps) {
        if (signal.aborted || turn.done) break;
        switch (step.type) {
          case 'emit':
            this.#emit(step.event);
            break;
          case 'sleep':
            await sleep(step.ms, signal);
            break;
          case 'text': {
            const messageId = newId('msg');
            for (const chunk of chunkText(step.text, step.chunks ?? 3)) {
              if (signal.aborted) break;
              this.#emit({ type: 'message.delta', data: { messageId, role: 'assistant', text: chunk } });
              await sleep(chunkDelay, signal);
            }
            if (!signal.aborted) this.#emit({ type: 'message.completed', data: { messageId, role: 'assistant', text: step.text } });
            break;
          }
          case 'tool':
            await this.#tool(step, signal);
            break;
          case 'fail':
            this.#complete(turn, 'error', step.error);
            return;
          case 'status':
            this.#emit({ type: 'session.status', data: step.reason ? { status: step.status, reason: step.reason } : { status: step.status } });
            if (step.status === 'ended' || step.status === 'failed') {
              turn.done = true;
              return;
            }
            break;
        }
      }
    } catch (err) {
      if (!signal.aborted) {
        this.#complete(turn, 'error', (err as Error).message);
        return;
      }
    }
    this.#complete(turn, signal.aborted ? 'interrupted' : 'end_turn');
  }

  async #tool(step: Extract<FakeStep, { type: 'tool' }>, signal: AbortSignal): Promise<void> {
    const toolId = newId('tc');
    const kind = step.kind ?? 'shell';
    let input: unknown = step.input ?? { command: step.title };
    this.#emit({ type: 'tool.started', data: { toolId, kind, name: step.name ?? 'Bash', title: step.title, input } });
    if (step.approval) {
      const extra = typeof step.approval === 'object' ? step.approval : {};
      const approvalId = newId('ap');
      const req: ApprovalRequest = {
        approvalId,
        toolId,
        kind: kind === 'shell' ? 'shell' : kind === 'edit' ? 'edit' : kind === 'write' ? 'write' : 'other',
        title: `Run ${step.title}?`,
        input,
        editable: true,
        options: ['allow', 'allow_always', 'deny'],
        ...extra,
      };
      const decision = await new Promise<ApprovalDecision>((resolve, reject) => {
        this.#approvals.set(approvalId, resolve);
        signal.addEventListener('abort', () => {
          this.#approvals.delete(approvalId);
          reject(new Error('aborted'));
        });
        this.#emit({ type: 'approval.requested', data: req });
      });
      this.#emit({ type: 'approval.resolved', data: { approvalId, decision: decision.decision } });
      if (decision.decision === 'deny') {
        this.#emit({ type: 'tool.completed', data: { toolId, status: 'denied', error: decision.message ?? 'denied by user' } });
        return;
      }
      if (decision.editedInput !== undefined) input = decision.editedInput;
    }
    await sleep(1, signal);
    const output = step.output ?? `ran ${JSON.stringify(input)}`;
    this.#emit({ type: 'tool.updated', data: { toolId, output } });
    this.#emit({ type: 'tool.completed', data: { toolId, status: 'ok', output } });
  }
}

export const defaultScript: FakeScript = (input) => {
  const text = textOf(input).trim();
  const [cmd, ...rest] = text.split(/\s+/);
  const arg = rest.join(' ');
  switch (cmd) {
    case '/tool':
      return [{ type: 'tool', title: arg || 'true' }, { type: 'text', text: 'done' }];
    case '/approve':
      return [{ type: 'text', text: 'I need to run a command.' }, { type: 'tool', title: arg || 'true', approval: true }, { type: 'text', text: 'done' }];
    case '/slow': {
      const ms = Number(arg) || 1000;
      const steps: FakeStep[] = [];
      const n = Math.max(1, Math.round(ms / 50));
      for (let i = 0; i < n; i++) steps.push({ type: 'text', text: `step ${i + 1}/${n}`, chunks: 1 }, { type: 'sleep', ms: 50 });
      return steps;
    }
    case '/fail':
      return [{ type: 'fail', error: arg || 'scripted failure' }];
    case '/crash':
      return [{ type: 'status', status: 'failed', reason: arg || 'scripted crash' }];
    case '/exit':
      return [{ type: 'status', status: 'ended', reason: arg || 'scripted exit' }];
    default:
      return [{ type: 'text', text: `echo: ${text}` }];
  }
};

function terminalScript(input: InputBlock[]): FakeStep[] {
  return [{ type: 'emit', event: { type: 'term.output', data: { dataBase64: b64(textOf(input) + '\r\n$ ') } } }];
}

export function textOf(input: InputBlock[]): string {
  return input
    .filter((b): b is Extract<InputBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function chunkText(text: string, n: number): string[] {
  if (n <= 1 || text.length <= n) return [text];
  const size = Math.ceil(text.length / n);
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
