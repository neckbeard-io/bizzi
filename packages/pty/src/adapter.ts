// Terminal-mode AgentAdapter: runs an agent's TUI (or a shell) in a PTY and maps the adapter
// contract onto it. Structured features are absent; `send` types text + Enter and completes the
// turn when output goes idle (best effort).
//
// Status sources, in precedence order:
// 1. OSC 7501 reports from the program itself (program-status.ts), while it has live records that
//    were reported since bizzi last typed a prompt;
// 2. prompt detectors (detectors.ts, data/detectors.json) on the quiet timer;
// 3. the plain quiet timer.
// Every `session.status` carries `source`; `TerminalSession.statusProvenance()` has the details.

import { isAbsolute, resolve as resolvePath } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {
  BizziError,
  NO_CAPABILITIES,
  type AdapterContext,
  type AdapterSession,
  type AgentAdapter,
  type AgentCapabilities,
  type AgentKind,
  type AgentProbe,
  type ApprovalDecision,
  type EmitFn,
  type InputBlock,
  type Logger,
  type SessionMode,
  type SessionStatus,
  type StartSessionOptions,
  type StopReason,
} from '@bizzi/protocol';
import { ActivityMonitor, detectorsFor, type IdleResult } from './activity.ts';
import { loadDetectorSet, type DetectorSet, type PromptDetector } from './detectors.ts';
import type { StatusPrompt, StatusProvenance } from './explain.ts';
import { OscScanner, type OscEvent } from './osc.ts';
import { ProgramStatusTracker, parseProgramStatus, type ProgramStatusRecord } from './program-status.ts';
import {
  agySpec,
  claudeSpec,
  codexSpec,
  opencodeSpec,
  shellSpec,
  type LaunchPlan,
  type ShellCommand,
  type TerminalAgentSpec,
} from './agents.ts';
import { lastBracketedPasteState } from './ansi.ts';
import { DEFAULT_COLS, DEFAULT_ROWS, clampSize, type ExitInfo } from './backend.ts';
import { DEFAULT_COALESCE_BYTES, chunkBuffer } from './coalescer.ts';
import { findBinary, readVersion } from './probe.ts';
import { DEFAULT_SCROLLBACK_BYTES } from './ring-buffer.ts';
import {
  attachSupervisor,
  defaultRuntimeDir,
  readSupervisorMeta,
  removeSupervisorFiles,
  spawnSupervisor,
  type SupervisorAttachment,
} from './supervisor-client.ts';
import { SUPERVISOR_ID_RE } from './supervisor-protocol.ts';
import { TerminalHost, buildPtyEnv } from './terminal-host.ts';

export interface SupervisorOptions {
  /** Where sockets and status files live. Default: $XDG_RUNTIME_DIR/bizzi-pty or <tmpdir>/bizzi-pty-<uid>. */
  runtimeDir?: string;
  /** Keep an exited, uncollected PTY's supervisor around this long. Default 10 min. */
  lingerMs?: number;
  /** Kill the PTY after this long with no attached node (0 = never, the default). */
  orphanTimeoutMs?: number;
  /** Node binary used to run the supervisor. Default: process.execPath. */
  nodePath?: string;
  /** Override the supervisor script path (e.g. when bundled). */
  script?: string;
}

export interface TerminalAdapterOptions {
  /** Quiet period after output before `session.status waiting_input` / turn completion. Default 3000 ms. */
  idleMs?: number;
  /** Quiet period when a prompt detector matches. Default 500 ms. */
  settleMs?: number;
  /**
   * Prompt detectors (filtered per agent). Default: the shipped set (data/detectors.json) merged
   * with the node override file (see `detectorsFile`). Passing a list skips file loading.
   */
  detectors?: readonly PromptDetector[];
  /** false = run no detectors (OSC 7501 and the quiet timer only). Default: env BIZZI_DETECTORS != "off". */
  detectorsEnabled?: boolean;
  /** Detector override file. Default: env BIZZI_DETECTORS_FILE, else <dataDir>/detectors.json. */
  detectorsFile?: string;
  /** Node data dir (for the detector override). Default: env BIZZI_DATA_DIR, else ~/.bizzi. */
  dataDir?: string;
  /** Parse OSC 7501 program status reports. Default true. */
  programStatus?: boolean;
  scrollbackBytes?: number;
  coalesceMs?: number;
  coalesceBytes?: number;
  /** Grace period before SIGKILL when stopping. Default 3000 ms. */
  killTimeoutMs?: number;
  /** Delay between typing the text and pressing Enter in `send`. Default 80 ms. */
  submitDelayMs?: number;
  /**
   * Run PTYs under detached supervisors so they survive node restarts. Default true (POSIX only).
   * Pass false for in-process PTYs.
   */
  supervisor?: boolean | SupervisorOptions;
  /**
   * What to emit as `term.output` when reattaching to a supervisor: only output the previous node
   * never delivered ('missed', default), a terminal reset plus the whole scrollback ('full'), or
   * nothing ('none').
   */
  replayOnReattach?: 'missed' | 'full' | 'none';
  /** Binary lookup: PATH override and extra directories. */
  path?: string;
  extraDirs?: string[];
  /** Base environment for children. Default: process.env. */
  baseEnv?: Record<string, string | undefined>;
}

/** Reference format with a supervisor: `pty:<supervisorId>` or `pty:<supervisorId>:<nativeRef>`. */
export function formatPtyRef(supervisorId: string, nativeRef?: string): string {
  return nativeRef ? `pty:${supervisorId}:${nativeRef}` : `pty:${supervisorId}`;
}

export function parseResumeRef(ref: string | undefined): { supervisorId?: string; nativeRef?: string } {
  if (!ref) return {};
  if (ref.startsWith('pty:')) {
    const rest = ref.slice(4);
    const colon = rest.indexOf(':');
    const id = colon < 0 ? rest : rest.slice(0, colon);
    const native = colon < 0 ? undefined : rest.slice(colon + 1) || undefined;
    if (SUPERVISOR_ID_RE.test(id)) return { supervisorId: id, nativeRef: native };
    return { nativeRef: native };
  }
  return { nativeRef: ref };
}

/** Full terminal reset (RIS): clients replaying the log start from a clean screen before a snapshot. */
const RESET = Buffer.from('\x1bc');

const NOOP_LOGGER: Logger = { log() {}, child: () => NOOP_LOGGER };

/** The detector set a session should run, from the adapter options (explicit list, off switch, files). */
export function resolveDetectorSet(opts: TerminalAdapterOptions): DetectorSet {
  if (opts.detectors) {
    const enabled = opts.detectorsEnabled ?? true;
    return { detectors: enabled ? [...opts.detectors] : [], enabled, version: 'custom', warnings: [] };
  }
  return loadDetectorSet({ enabled: opts.detectorsEnabled, file: opts.detectorsFile, dataDir: opts.dataDir });
}

export class TerminalAdapter implements AgentAdapter {
  readonly agent: AgentKind;
  readonly spec: TerminalAgentSpec;
  readonly #opts: TerminalAdapterOptions;
  #detectorSet: DetectorSet | undefined;

  constructor(spec: TerminalAgentSpec, opts: TerminalAdapterOptions = {}) {
    this.spec = spec;
    this.agent = spec.agent;
    this.#opts = opts;
  }

  /** Detectors for this agent, loaded once per adapter (override problems are logged, not fatal). */
  #detectors(logger: Logger): PromptDetector[] {
    if (!this.#detectorSet) {
      const set = resolveDetectorSet(this.#opts);
      this.#detectorSet = set;
      for (const w of set.warnings) logger.log('warn', 'prompt detector override problem', { problem: w });
      logger.log('debug', 'prompt detectors loaded', {
        enabled: set.enabled,
        version: set.version,
        override: set.override?.path,
        count: set.detectors.length,
      });
    }
    return detectorsFor(this.agent, this.#detectorSet.detectors);
  }

  get #supervisor(): SupervisorOptions | undefined {
    const s = this.#opts.supervisor ?? true;
    if (s === false || process.platform === 'win32') return undefined;
    return s === true ? {} : s;
  }

  #lookup(): { path?: string; extraDirs?: string[] } {
    return { path: this.#opts.path, extraDirs: this.#opts.extraDirs };
  }

  async probe(): Promise<AgentProbe> {
    const agent = this.spec.agent;
    try {
      const path = this.spec.resolveBinary(this.#lookup());
      if (!path) {
        return { agent, installed: false, auth: 'unknown', notes: [`${this.spec.binaryName} not found on PATH or in common bin dirs`] };
      }
      const v = await readVersion(path, this.spec.versionArgs);
      const notes = [...(this.spec.notes ?? [])];
      if (v.exitCode === 127) {
        // A wrapper/shim that cannot find the real binary.
        return { agent, installed: false, path, auth: 'unknown', notes: [...notes, `${path} --version: ${v.error ?? 'exit 127'}`] };
      }
      if (v.error) notes.push(`version check failed: ${v.error}`);
      return { agent, installed: true, path, version: v.version, auth: 'unknown', notes };
    } catch (e) {
      return { agent, installed: false, auth: 'unknown', notes: [`probe failed: ${String(e)}`] };
    }
  }

  capabilities(_mode: SessionMode): AgentCapabilities {
    return {
      ...NO_CAPABILITIES,
      modes: ['terminal'],
      interrupt: true,
      terminal: true,
      resumeAfterNodeRestart: this.#supervisor !== undefined,
      ...this.spec.capabilities,
    };
  }

  async start(opts: StartSessionOptions, emit: EmitFn, ctx: AdapterContext): Promise<AdapterSession> {
    if (opts.mode !== 'terminal') {
      throw new BizziError('unsupported', `${this.agent}: this adapter supports terminal mode only`);
    }
    const logger = (ctx?.logger ?? NOOP_LOGGER).child({ agent: this.agent, sessionId: opts.sessionId });
    const sup = this.#supervisor;
    const { supervisorId, nativeRef } = parseResumeRef(opts.resumeRef);

    if (supervisorId && sup) {
      const runtimeDir = sup.runtimeDir ?? defaultRuntimeDir();
      try {
        const att = await attachSupervisor(runtimeDir, supervisorId);
        logger.log('info', 'reattached to PTY supervisor', { supervisorId, pid: att.hello.pid });
        return this.#sessionFromAttachment(att, formatPtyRef(supervisorId, nativeRef), emit, logger, true);
      } catch (e) {
        if (!(e instanceof BizziError) || e.code !== 'not_found') throw e;
        const meta = readSupervisorMeta(runtimeDir, supervisorId);
        if (meta?.exit) {
          // It finished while no node was attached; report the exit, nothing to run.
          removeSupervisorFiles(runtimeDir, supervisorId);
          return new ExitedSession(opts.resumeRef!, meta.exit, emit);
        }
        removeSupervisorFiles(runtimeDir, supervisorId);
        logger.log('warn', 'PTY supervisor is gone; starting a new process', { supervisorId });
        emit({
          type: 'error',
          data: {
            message: `The previous terminal process is gone; started a new one${nativeRef ? ' resuming the agent session' : ''}.`,
            code: 'pty_lost',
            fatal: false,
          },
        });
      }
    } else if (opts.resumeRef && !nativeRef && !supervisorId) {
      logger.log('warn', 'ignoring unrecognised resumeRef', { resumeRef: opts.resumeRef });
    }

    const launch = this.#resolveLaunch(opts, nativeRef);
    const { plan } = launch;
    if (plan.ignored?.length) logger.log('info', 'start options not supported in terminal mode', { ignored: plan.ignored });
    let binary = launch.binary;
    let args = plan.args;
    let cwd = opts.cwd;
    let env = buildPtyEnv(opts.env, this.#opts.baseEnv, this.spec.unsetEnv);
    if (opts.launcher) {
      // Container workspaces (topology.md §7): e.g. `docker exec -it … <container> <binary> <args>`.
      const run = opts.launcher.wrap({ command: binary, args, cwd, env, tty: true });
      binary = run.command;
      args = run.args;
      cwd = run.cwd;
      env = Object.fromEntries(Object.entries(run.env).filter((e): e is [string, string] => e[1] !== undefined));
    }
    const cols = clampSize(opts.cols, DEFAULT_COLS);
    const rows = clampSize(opts.rows, DEFAULT_ROWS);
    logger.log('info', 'starting terminal session', {
      binary,
      args,
      cwd,
      supervised: !!sup,
      ...(opts.launcher ? { launcher: opts.launcher.label } : {}),
    });

    if (sup) {
      const runtimeDir = sup.runtimeDir ?? defaultRuntimeDir();
      const id = await spawnSupervisor({
        runtimeDir,
        command: binary,
        args,
        cwd,
        env,
        cols,
        rows,
        scrollbackBytes: this.#opts.scrollbackBytes ?? DEFAULT_SCROLLBACK_BYTES,
        lingerMs: sup.lingerMs,
        orphanTimeoutMs: sup.orphanTimeoutMs,
        killTimeoutMs: this.#opts.killTimeoutMs,
        labels: { agent: this.agent, sessionId: opts.sessionId },
        nodePath: sup.nodePath,
        script: sup.script,
      });
      let att: SupervisorAttachment;
      try {
        att = await attachSupervisor(runtimeDir, id);
      } catch (e) {
        // Don't leave an unreachable supervisor behind.
        const meta = readSupervisorMeta(runtimeDir, id);
        if (meta) {
          try {
            process.kill(meta.supervisorPid, 'SIGTERM');
          } catch {}
        }
        throw e;
      }
      return this.#sessionFromAttachment(att, formatPtyRef(id, plan.nativeRef), emit, logger, false);
    }

    let host: TerminalHost;
    try {
      host = TerminalHost.spawn({
        command: binary,
        args,
        cwd,
        env,
        baseEnv: {},
        cols,
        rows,
        scrollbackBytes: this.#opts.scrollbackBytes,
        coalesceMs: this.#opts.coalesceMs,
        coalesceBytes: this.#opts.coalesceBytes,
        killTimeoutMs: this.#opts.killTimeoutMs,
        logger,
      });
    } catch (e) {
      throw new BizziError('agent_unavailable', `cannot start ${this.spec.binaryName}: ${(e as Error).message}`);
    }
    const session = new TerminalSession(host, this.spec, this.#opts, emit, logger, plan.nativeRef, this.#detectors(logger));
    session.announce();
    return session;
  }

  /**
   * What to run: the agent's TUI built from the start options, or `opts.command` (e.g. a login
   * command) verbatim. A custom command keeps cwd/env/size; agent launch flags don't apply to it.
   */
  #resolveLaunch(opts: StartSessionOptions, nativeRef: string | undefined): { binary: string; plan: LaunchPlan } {
    const command = opts.command?.length ? opts.command : undefined;
    if (!command) {
      // Through a launcher the binary is looked up inside the target, by name.
      if (opts.launcher && this.spec.launcherCommand) {
        const lc = this.spec.launcherCommand;
        return { binary: lc.command, plan: { ...this.spec.buildLaunch(opts, nativeRef), args: [...lc.args] } };
      }
      const binary = opts.launcher ? this.spec.binaryName : this.spec.resolveBinary(this.#lookup());
      if (!binary) throw new BizziError('agent_unavailable', `${this.spec.binaryName} not found`);
      return { binary, plan: this.spec.buildLaunch(opts, nativeRef) };
    }
    const [name, ...args] = command as [string, ...string[]];
    if (typeof name !== 'string' || name === '' || args.some((a) => typeof a !== 'string')) {
      throw new BizziError('bad_request', 'command must be a non-empty array of strings');
    }
    const lookup = { path: opts.env?.PATH ?? this.#opts.path, extraDirs: this.#opts.extraDirs };
    // `./bin/x` or `sub/x` are relative to the session's cwd; bare names are looked up on PATH.
    const target = !isAbsolute(name) && name.includes('/') ? resolvePath(opts.cwd, name) : name;
    const binary = opts.launcher ? target : findBinary(target, lookup);
    if (!binary) throw new BizziError('agent_unavailable', `${name} not found`);
    const ignored = (['model', 'permissionMode', 'effort', 'systemPromptAppend', 'mcpServers'] as const).filter((k) => {
      const v = opts[k];
      return v !== undefined && !(typeof v === 'object' && Object.keys(v).length === 0);
    }) as string[];
    if (nativeRef) ignored.push('resumeRef');
    return { binary, plan: { args, ignored } };
  }

  #sessionFromAttachment(
    att: SupervisorAttachment,
    ref: string,
    emit: EmitFn,
    logger: Logger,
    reattached: boolean,
  ): TerminalSession {
    const { hello, scrollback, backend } = att;
    const host = new TerminalHost(backend, {
      cols: hello.cols,
      rows: hello.rows,
      initialScrollback: scrollback,
      initialOffset: hello.end,
      scrollbackBytes: this.#opts.scrollbackBytes,
      coalesceMs: this.#opts.coalesceMs,
      coalesceBytes: this.#opts.coalesceBytes,
      killTimeoutMs: this.#opts.killTimeoutMs,
      logger,
    });
    const session = new TerminalSession(host, this.spec, this.#opts, emit, logger, ref, this.#detectors(logger));
    session.announce();

    // Output produced before this attach: on a fresh start that is the startup output (acked = 0);
    // on reattach, what the previous node never delivered.
    const mode = reattached ? (this.#opts.replayOnReattach ?? 'missed') : 'missed';
    let replay: Buffer | undefined;
    if (mode === 'full') {
      replay = hello.acked > 0 || hello.start > 0 ? Buffer.concat([RESET, scrollback]) : scrollback;
    } else if (mode === 'missed') {
      replay =
        hello.acked >= hello.start
          ? scrollback.subarray(hello.acked - hello.start)
          : Buffer.concat([RESET, scrollback]); // gap: the missed bytes fell out of the ring
    }
    if (replay && replay.length > 0) session.replay(replay);
    backend.ack(hello.end);
    return session;
  }
}

/** One terminal-mode session. */
export class TerminalSession implements AdapterSession {
  readonly host: TerminalHost;
  readonly #spec: TerminalAgentSpec;
  readonly #emit: EmitFn;
  readonly #logger: Logger;
  readonly #ref: string | undefined;
  readonly #monitor: ActivityMonitor;
  readonly #decoder = new StringDecoder('utf8');
  readonly #submitDelayMs: number;
  readonly #coalesceBytes: number;
  readonly #scanner: OscScanner | undefined;
  readonly #program = new ProgramStatusTracker();
  #turnId: string | undefined;
  #status: SessionStatus | undefined;
  #provenance: StatusProvenance | undefined;
  /** When bizzi last typed a prompt (send); OSC records older than this don't override the heuristics. */
  #sentAt = -Infinity;
  #bracketedPaste = false;
  #stopping = false;
  #stopPromise: Promise<void> | undefined;
  #detached = false;

  constructor(
    host: TerminalHost,
    spec: TerminalAgentSpec,
    opts: TerminalAdapterOptions,
    emit: EmitFn,
    logger: Logger,
    ref: string | undefined,
    /** Detectors to run (already filtered for the agent). Default: resolved from `opts`. */
    detectors?: readonly PromptDetector[],
  ) {
    this.host = host;
    this.#spec = spec;
    this.#emit = emit;
    this.#logger = logger;
    this.#ref = ref;
    this.#submitDelayMs = opts.submitDelayMs ?? 80;
    this.#coalesceBytes = opts.coalesceBytes ?? DEFAULT_COALESCE_BYTES;
    this.#scanner = opts.programStatus === false ? undefined : new OscScanner();
    this.#monitor = new ActivityMonitor({
      idleMs: opts.idleMs,
      settleMs: opts.settleMs,
      detectors: detectors ?? detectorsFor(spec.agent, resolveDetectorSet(opts).detectors),
      onActive: () => this.#onActive(),
      onIdle: (r) => this.#onIdle(r),
    });
    host.onOutput((chunk) => this.#onOutput(chunk));
    host.onExit((info) => this.#onExit(info));
  }

  /** @internal Emit session.info with the agent session ref. */
  announce(): void {
    if (this.#ref) this.#emit({ type: 'session.info', data: { agentSessionRef: this.#ref } });
  }

  /** @internal Emit pre-existing output (supervisor replay) as term.output events. */
  replay(data: Buffer): void {
    for (const chunk of chunkBuffer(data, this.#coalesceBytes)) this.#onOutput(chunk);
  }

  agentSessionRef(): string | undefined {
    return this.#ref;
  }

  /** What produced the current status (OSC 7501 record, detector + excerpt, timer), and when. */
  statusProvenance(): StatusProvenance | undefined {
    return this.#provenance ? structuredClone(this.#provenance) : undefined;
  }

  /** Live OSC 7501 records reported by the program (empty when it doesn't speak the protocol). */
  programStatusRecords(): ProgramStatusRecord[] {
    return this.#program.records();
  }

  async send(turnId: string, input: InputBlock[]): Promise<void> {
    if (this.host.exited) throw new BizziError('conflict', 'the terminal process has exited');
    const parts: string[] = [];
    let skippedImages = 0;
    for (const block of input) {
      if (block.type === 'text') parts.push(block.text);
      else if (block.type === 'file') parts.push(this.#spec.formatFile ? this.#spec.formatFile(block.path) : block.path);
      else skippedImages++;
    }
    if (parts.length === 0 && skippedImages > 0) {
      throw new BizziError('unsupported', 'images cannot be sent to a terminal-mode session');
    }
    if (this.#turnId) this.#completeTurn('other');
    this.#turnId = turnId;
    this.#status = 'running';
    this.#sentAt = Date.now();
    // The core reports running from turn.started; only the provenance is recorded here.
    this.#provenance = { status: 'running', source: 'turn', reason: 'prompt sent', at: new Date(this.#sentAt).toISOString() };
    this.#monitor.kick();

    const text = parts.join(' ');
    if (text.length > 0) {
      if (this.#bracketedPaste) {
        this.host.write(`\x1b[200~${text}\x1b[201~`);
      } else {
        this.host.write(text.replace(/\r?\n/g, '\r'));
      }
      if (this.#submitDelayMs > 0) await new Promise((r) => setTimeout(r, this.#submitDelayMs));
    }
    this.host.write('\r');
  }

  async interrupt(): Promise<void> {
    if (this.host.exited) return;
    this.#monitor.input();
    this.host.write(this.#spec.interruptSequence ?? '\x03');
    if (this.#turnId) this.#completeTurn('interrupted');
  }

  async respondApproval(_approvalId: string, _decision: ApprovalDecision): Promise<void> {
    throw new BizziError('unsupported', 'terminal-mode sessions have no structured approvals; answer in the terminal');
  }

  writeTerminal(data: Uint8Array): void {
    this.#monitor.input();
    this.host.write(data);
  }

  resizeTerminal(cols: number, rows: number): void {
    this.host.resize(cols, rows);
  }

  stop(): Promise<void> {
    this.#stopPromise ??= (async () => {
      this.#stopping = true;
      if (!this.host.exited && !this.#detached) {
        this.host.kill('SIGHUP');
        await this.host.exitPromise;
      }
      this.#monitor.dispose();
    })();
    return this.#stopPromise;
  }

  /**
   * Disconnect without killing the process (supervised sessions keep running and can be
   * reattached with `agentSessionRef()`). For in-process PTYs this is the same as stop().
   */
  async detach(): Promise<void> {
    if (this.#detached) return;
    this.#detached = true;
    this.#monitor.dispose();
    this.host.detach();
  }

  #onOutput(chunk: Buffer): void {
    this.#emit({ type: 'term.output', data: { dataBase64: chunk.toString('base64') } });
    const text = this.#decoder.write(chunk);
    const paste = lastBracketedPasteState(text);
    if (paste !== undefined) this.#bracketedPaste = paste;
    // OSC first, so a report in this chunk is authoritative before the heuristics see the output.
    if (this.#scanner) for (const ev of this.#scanner.push(text)) this.#onOsc(ev);
    this.#monitor.output(text, chunk.length);
  }

  /** OSC 7501 records exist and were reported since bizzi last typed a prompt: they win over heuristics. */
  #programAuthoritative(): boolean {
    return this.#program.size > 0 && this.#program.lastReportAt >= this.#sentAt;
  }

  #onOsc(ev: OscEvent): void {
    if (this.host.exited || this.#detached) return;
    if (ev.type === 'prompt-start') {
      if (!this.#program.dropTransient()) return;
      if (this.#program.size > 0) {
        this.#applyProgramStatus();
      } else {
        // The program dropped its working/blocked record by drawing a new prompt: it wants input.
        if (this.#turnId) this.#completeTurn('end_turn');
        this.#setStatus({ status: 'waiting_input', prompt: 'input', reason: 'new prompt', source: 'osc133' });
      }
      return;
    }
    const parsed = parseProgramStatus(ev.payload, ev.overflow);
    if (!parsed.ok) {
      this.#logger.log('debug', 'discarded OSC 7501 report', { error: parsed.error });
      return;
    }
    if (parsed.report.type === 'query') {
      // Capability query: not answered (writing to the program's stdin unasked is not safe here).
      this.#logger.log('debug', 'ignored OSC 7501 capability query');
      return;
    }
    if (this.#program.apply(parsed.report) && this.#program.size > 0) this.#applyProgramStatus();
    // All records cleared: nothing to report; the heuristics take over from the next burst.
  }

  #applyProgramStatus(): void {
    const summary = this.#program.summary();
    if (!summary) return;
    const { record } = summary;
    if (this.#turnId && (record.state === 'idle' || record.state === 'done' || record.state === 'error')) {
      if (record.state === 'error') this.#completeTurn('error', record.msg ?? record.title ?? 'the program reported an error');
      else this.#completeTurn('end_turn');
    }
    const osc: NonNullable<StatusProvenance['osc']> = { id: record.id, state: record.state, records: this.#program.size };
    if (record.kind) osc.kind = record.kind;
    if (record.app) osc.app = record.app;
    if (record.title !== undefined) osc.title = record.title;
    if (record.msg !== undefined) osc.msg = record.msg;
    if (record.progress !== undefined) osc.progress = record.progress;
    this.#setStatus({ status: summary.status, prompt: summary.prompt, reason: summary.reason, source: 'osc7501', osc });
  }

  /** Emit session.status (with its source) and remember the provenance. Unchanged statuses aren't re-emitted. */
  #setStatus(p: {
    status: SessionStatus;
    prompt?: StatusPrompt;
    reason?: string;
    source: string;
    osc?: StatusProvenance['osc'];
    detector?: StatusProvenance['detector'];
  }): void {
    const prev = this.#provenance;
    const same =
      prev !== undefined &&
      this.#status === p.status &&
      prev.prompt === p.prompt &&
      prev.reason === p.reason &&
      prev.source === p.source;
    const provenance: StatusProvenance = { status: p.status, source: p.source, at: new Date().toISOString() };
    if (p.prompt) provenance.prompt = p.prompt;
    if (p.reason !== undefined) provenance.reason = p.reason;
    if (p.osc) provenance.osc = p.osc;
    if (p.detector) provenance.detector = p.detector;
    this.#provenance = provenance;
    if (same) return;
    this.#status = p.status;
    const data: { status: SessionStatus; reason?: string; prompt?: StatusPrompt; source: string } = { status: p.status, source: p.source };
    if (p.reason !== undefined) data.reason = p.reason;
    if (p.prompt) data.prompt = p.prompt;
    this.#emit({ type: 'session.status', data });
  }

  #onActive(): void {
    if (this.#programAuthoritative()) return;
    if (this.#status === 'waiting_input' && !this.#turnId) {
      this.#setStatus({ status: 'running', reason: 'terminal output', source: 'activity:output' });
    }
  }

  #onIdle(r: IdleResult): void {
    if (this.host.exited) return;
    if (this.#programAuthoritative()) return;
    if (this.#turnId) this.#completeTurn('end_turn');
    const d = r.detector;
    if (d) {
      const detector: NonNullable<StatusProvenance['detector']> = { id: d.id, kind: d.kind };
      if (d.note) detector.note = d.note;
      if (d.origin) detector.origin = d.origin;
      if (r.excerpt) detector.excerpt = r.excerpt;
      this.#setStatus({ status: 'waiting_input', prompt: d.kind, reason: r.reason, source: `detector:${d.id}`, detector });
    } else {
      this.#setStatus({ status: 'waiting_input', reason: r.reason, source: 'activity:idle' });
    }
  }

  #completeTurn(stopReason: StopReason, error?: string): void {
    const turnId = this.#turnId;
    if (!turnId) return;
    this.#turnId = undefined;
    this.#emit({ type: 'turn.completed', data: error ? { turnId, stopReason, error } : { turnId, stopReason } });
  }

  #onExit(info: ExitInfo): void {
    this.#monitor.dispose();
    // Process exit drops every OSC 7501 record (working/blocked by the protocol, the rest with the process).
    this.#program.clearAll();
    this.#scanner?.reset();
    if (this.#detached) return;
    this.#emit({ type: 'term.exited', data: info.signal ? { exitCode: null, signal: info.signal } : { exitCode: info.exitCode } });
    const how = info.signal ? `signal ${info.signal}` : `exit code ${info.exitCode}`;
    const clean = this.#stopping || info.exitCode === 0;
    if (this.#turnId) this.#completeTurn(this.#stopping ? 'interrupted' : clean ? 'end_turn' : 'error', clean ? undefined : `process ended (${how})`);
    this.#setStatus({ status: clean ? 'ended' : 'failed', reason: this.#stopping ? 'stopped' : how, source: 'process' });
    this.#logger.log('info', 'terminal process exited', { ...info });
  }
}

/** A supervised session whose process finished while no node was attached. */
class ExitedSession implements AdapterSession {
  readonly #ref: string;
  constructor(ref: string, exit: ExitInfo, emit: EmitFn) {
    this.#ref = ref;
    emit({ type: 'session.info', data: { agentSessionRef: ref } });
    emit({ type: 'term.exited', data: exit.signal ? { exitCode: null, signal: exit.signal } : { exitCode: exit.exitCode } });
    const clean = exit.exitCode === 0;
    emit({
      type: 'session.status',
      data: {
        status: clean ? 'ended' : 'failed',
        reason: `exited while detached (${exit.signal ?? `exit code ${exit.exitCode}`})`,
        source: 'process',
      },
    });
  }
  agentSessionRef(): string {
    return this.#ref;
  }
  async send(): Promise<void> {
    throw new BizziError('conflict', 'the terminal process has exited');
  }
  async interrupt(): Promise<void> {}
  async respondApproval(): Promise<void> {
    throw new BizziError('unsupported', 'terminal-mode sessions have no structured approvals');
  }
  writeTerminal(): void {}
  resizeTerminal(): void {}
  async stop(): Promise<void> {}
}

export interface CreateAdaptersOptions extends TerminalAdapterOptions {
  /** Command for the `shell` adapter instead of the login shell. */
  shell?: ShellCommand;
}

/** The terminal-mode adapters: shell, agy, claude, codex, opencode. */
export function createAdapters(options: CreateAdaptersOptions = {}): AgentAdapter[] {
  const { shell, ...opts } = options;
  return [shellSpec(shell), agySpec(), claudeSpec(), codexSpec(), opencodeSpec()].map((spec) => new TerminalAdapter(spec, opts));
}
