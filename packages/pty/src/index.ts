export {
  TerminalAdapter,
  TerminalSession,
  createAdapters,
  formatPtyRef,
  parseResumeRef,
  type CreateAdaptersOptions,
  type SupervisorOptions,
  type TerminalAdapterOptions,
} from './adapter.ts';
export {
  agySpec,
  claudeSpec,
  codexSpec,
  opencodeSpec,
  shellSpec,
  type LaunchPlan,
  type ShellCommand,
  type TerminalAgentSpec,
} from './agents.ts';
export {
  ActivityMonitor,
  DEFAULT_DETECTORS,
  DEFAULT_IDLE_MS,
  DEFAULT_SETTLE_MS,
  detectorsFor,
  regexDetector,
  type ActivityMonitorOptions,
  type IdleResult,
  type PromptDetector,
  type PromptKind,
} from './activity.ts';
export { stripAnsi } from './ansi.ts';
export { LocalPtyBackend, TERM_NAME, type ExitInfo, type PtyBackend, type PtySpawnOptions } from './backend.ts';
export { DEFAULT_COALESCE_BYTES, DEFAULT_COALESCE_MS, OutputCoalescer } from './coalescer.ts';
export { commonBinDirs, findBinary, readVersion, type VersionResult } from './probe.ts';
export { DEFAULT_SCROLLBACK_BYTES, ScrollbackBuffer } from './ring-buffer.ts';
export {
  SUPERVISOR_SCRIPT,
  attachSupervisor,
  defaultRuntimeDir,
  listSupervisors,
  spawnSupervisor,
  type SpawnSupervisorOptions,
  type SupervisorAttachment,
} from './supervisor-client.ts';
export type { SupervisorMeta } from './supervisor-protocol.ts';
export { TerminalHost, buildPtyEnv, type TerminalHostOptions, type TerminalHostTuning } from './terminal-host.ts';
