// What the mock feature modules (knowledge, provisioning) may use from the MockCore.
import type { AgentKind, GlobalEventBody, MachineInfo, SessionEventBody, SessionInfo, SessionMode, SessionStatus, WorkspaceInfo } from '@bizzi/protocol';

export interface MockHost {
  /** Delay multiplier (0 in tests). */
  readonly speed: number;
  /** Scripted demo switches from the URL (`?mock=1&demo=install,login`). */
  readonly demo: ReadonlySet<string>;
  emit(ch: string, body: SessionEventBody | GlobalEventBody): void;
  emitSession(sessionId: string, body: SessionEventBody): void;
  /** Resolves after `ms × speed`. */
  sleep(ms: number): Promise<void>;
  /** The machine a MachineTarget call goes to; throws `machine_offline` / `not_found` like a hub would. */
  requireOnline(machineId: unknown): MachineInfo;
  machines(): MachineInfo[];
  workspaces(): WorkspaceInfo[];
  sessions(): SessionInfo[];
  createSession(init: { id?: string; machineId: string; workspaceId: string; agent: AgentKind; mode: SessionMode; title: string; status?: SessionStatus }): SessionInfo;
  setSessionStatus(sessionId: string, status: SessionStatus): void;
  /** Write text to a terminal session (as term.output). */
  termWrite(sessionId: string, text: string): void;
  /** Route term.input of a session to `handler` instead of the default shell echo. */
  onTermInput(sessionId: string, handler: (data: string) => void): void;
}

/** A mock feature module: handles the methods it owns, returns `undefined` for the others. */
export interface MockModule {
  handles(method: string): boolean;
  handle(method: string, params: Record<string, unknown>): Promise<unknown> | unknown;
}
