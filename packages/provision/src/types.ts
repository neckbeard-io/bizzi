// Recipe data model. Recipes are YAML files in `recipes/<name>.yaml`, validated against
// `recipeSchema` (schema.ts) at load time. Strings may contain `{{var}}` / `{{var|default}}`
// templates (see template.ts for the variable list) and a leading `~/` for the home dir.

import type { AgentKind, AgentRemedy, GlobalEventMap } from '@bizzi/protocol';

export type OsName = 'darwin' | 'linux';
export type ArchName = 'arm64' | 'x64';
export type Libc = 'glibc' | 'musl';

export interface Platform {
  os: OsName;
  arch: ArchName;
  /** Linux only. */
  libc?: Libc;
}

export type RecipeKind = 'agent' | 'tool';
export type MethodKind = 'script' | 'brew' | 'npm' | 'binary';
export type StepCondition = 'pinned' | 'unpinned';

export interface StepSpec {
  description: string;
  /** Shell command, run with `sh -c`. Template values are shell-quoted when needed. Exactly one of run/argv. */
  run?: string;
  /** Program + args, run without a shell. */
  argv?: string[];
  /** Should be false wherever possible. Steps that need sudo are refused unless the caller allows it. */
  requiresSudo: boolean;
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
  allowFailure?: boolean;
  /** Only include the step when a version is pinned (`pinned`) or not (`unpinned`). */
  when?: StepCondition;
}

export interface Requirement {
  /** A command that must be on the (augmented) PATH. */
  command: string;
  /** A bizzi tool recipe that provides the command when it is missing (e.g. `node` for `npm`). */
  tool?: string;
}

export interface MethodSpec {
  id: string;
  kind: MethodKind;
  label: string;
  /** Platform filters: `darwin`, `linux`, `linux-x64`, `linux-arm64-musl`, … Default: every recipe platform. */
  platforms?: string[];
  requires?: Requirement[];
  /** Where the install lands, e.g. `~/.local/bin` or `{{toolsDir}}/node/{{version}}`. */
  targetDir: string;
  /** Directory containing the binary afterwards (default: targetDir). */
  binDir?: string;
  /** The method accepts a pinned version. */
  pinnable: boolean;
  /** The installed binary updates itself in the background. */
  selfUpdates?: boolean;
  /** Substrings of the binary's real path that indicate this method was used. */
  pathHints?: string[];
  /**
   * Paths that change when this install is updated (updates.md §2), watched by the node. A directory
   * is watched for entries; a file or symlink through its parent directory. Missing paths are fine.
   * Homebrew and npm installs add their package directories automatically.
   */
  watch?: string[];
  verified: boolean;
  sources?: string[];
  notes?: string[];
  install: StepSpec[];
  update?: StepSpec[];
  uninstall?: StepSpec[];
}

export interface VersionDetect {
  args: string[];
  /** First capture group (or whole match) is the version. Matched against stdout + stderr. */
  regex: string;
  timeoutMs?: number;
}

export interface DetectSpec {
  binaries: string[];
  /** Extra directories searched after the augmented PATH. */
  searchPaths?: string[];
  version: VersionDetect;
}

export type LatestSource =
  | { type: 'npm'; package: string; distTag?: string; registry?: string; verified: boolean; notes?: string[] }
  | { type: 'github'; repo: string; tagPrefix?: string; verified: boolean; notes?: string[] }
  | {
      type: 'url';
      url: string;
      format: 'text' | 'json';
      /** Dot path into the JSON body. */
      jsonPath?: string;
      /** Applied to the text (or the jsonPath value); first capture group wins. */
      regex?: string;
      verified: boolean;
      notes?: string[];
    }
  | { type: 'node-dist'; lts: boolean; url?: string; verified: boolean; notes?: string[] };

export type HeadlessLoginKind =
  | 'api-key-env'
  | 'token-env'
  | 'token-command'
  | 'device-code'
  | 'stdin-secret'
  | 'config'
  | 'copy-credentials'
  /** A non-interactive command (argv is the prefix; see notes for the arguments to add). */
  | 'command';

export interface HeadlessLogin {
  kind: HeadlessLoginKind;
  description: string;
  /** Env var the agent reads (api-key-env, token-env, token-command output, config). */
  env?: string;
  /** Command to run (token-command, device-code, stdin-secret). */
  argv?: string[];
  /** stdin-secret: pipe the value of this env var into argv. */
  stdinFromEnv?: string;
  /** config: a JSON settings file and the keys to merge in. */
  settingsFile?: string;
  settings?: Record<string, string>;
  /** copy-credentials: files to copy from an already-logged-in machine. */
  files?: string[];
  verified: boolean;
  notes?: string[];
}

export interface InteractiveLogin {
  /** Run in a PTY; output goes through detectLoginPrompts. */
  argv: string[];
  description: string;
  /** Known localhost OAuth callback port that needs forwarding on remote machines. */
  callbackPort?: number;
  /** The flow asks the user to paste a code back into the terminal. */
  pastesCode?: boolean;
  verified: boolean;
  notes?: string[];
}

export interface LoginSpec {
  interactive: InteractiveLogin;
  headless: HeadlessLogin[];
  logout?: { argv?: string[]; description: string; verified: boolean };
}

export interface AuthCommand {
  argv: string[];
  /** Only side-effect-free commands run during probes (unless the caller opts in). */
  sideEffectFree: boolean;
  timeoutMs?: number;
  format: 'json' | 'text';
  okExitCodes?: number[];
  missingExitCodes?: number[];
  /** json: boolean field meaning "logged in". */
  loggedInField?: string;
  /** json: field holding the account (email, plan). */
  accountField?: string;
  /** json: field holding the auth method. */
  methodField?: string;
  /** json: a non-empty array/object means logged in. */
  nonEmptyMeansOk?: boolean;
  okRegex?: string;
  missingRegex?: string;
  expiredRegex?: string;
  /** text: first capture group is the account / auth mode. */
  accountRegex?: string;
  verified: boolean;
  notes?: string[];
}

export interface AuthRule {
  /** All listed env vars must be non-empty. */
  env?: string[];
  /** File must exist and be non-empty. */
  file?: string;
  /** With `file`: JSON field that must equal `equals`. */
  jsonField?: string;
  equals?: string;
  /** Reported as the account when the rule matches. */
  account?: string;
}

export interface AuthSpec {
  command?: AuthCommand;
  /** Heuristics, in order; the first match means `ok`. Used when the command can't run. */
  rules?: AuthRule[];
  /** State when nothing matched. */
  absent: 'missing' | 'unknown';
  notes?: string[];
}

export interface PlatformSpec {
  vars?: Record<string, string>;
  notes?: string[];
}

/** A confirmable fix shown with a probe (protocol `AgentRemedy`). */
export type RemedySpec = AgentRemedy;

/** Which installed versions bizzi supports (spec §7 "Supported versions"). */
export interface SupportSpec {
  /** Version range bizzi can drive at all, e.g. `>=2.0.0`. Outside it the install is `unsupported`. */
  versions: string;
  /** The adapter's tested range. Inside `versions` but outside this, the install is `untested`. */
  tested?: string;
  /** What to tell the user about an unsupported version, and how to fix it. */
  unsupported?: { reason: string; remedies?: RemedySpec[] };
  /** Methods that update worse than the preferred one; installs using them get a 'migrate' remedy. */
  migrate?: { from: string[]; title: string; reason?: string };
  notes?: string[];
}

export interface Recipe {
  schema: 1;
  name: string;
  kind: RecipeKind;
  displayName: string;
  homepage: string;
  docs: string[];
  /** Every command in the recipe was checked against current vendor docs. */
  verified: boolean;
  notes?: string[];
  /** Supported platforms, keyed `os-arch` or `os-arch-musl`. */
  platforms: Record<string, PlatformSpec>;
  /** Tools only: version installed when none is requested. */
  defaultVersion?: string;
  detect: DetectSpec;
  latest: LatestSource[];
  methods: MethodSpec[];
  /** Agents only: supported and tested versions. Absent = not checked. */
  support?: SupportSpec;
  login?: LoginSpec;
  auth?: AuthSpec;
}

// ---- engine types ----

export type InstallAction = 'install' | 'update' | 'uninstall';

/** Exactly the protocol's `install.progress` event data. */
export type InstallProgress = GlobalEventMap['install.progress'];

export interface PlannedStep {
  id: string;
  recipe: string;
  phase: 'dependency' | 'main' | 'verify';
  description: string;
  /** Human-readable command (what dry-run prints). */
  command: string;
  run?: string;
  argv?: string[];
  env: Record<string, string>;
  cwd?: string;
  requiresSudo: boolean;
  timeoutMs: number;
  allowFailure: boolean;
}

export interface InstallPlan {
  /** Agent reported in progress events (for tool recipes: the agent that needs the tool). */
  agent: AgentKind;
  recipe: string;
  action: InstallAction;
  method: string;
  methodLabel: string;
  platform: Platform;
  platformKey: string;
  version?: string;
  targetDir: string;
  /** Directories prepended to PATH while the plan runs (e.g. a freshly installed managed Node). */
  extraPath: string[];
  requiresSudo: boolean;
  steps: PlannedStep[];
  warnings: string[];
}

export interface StepResult {
  id: string;
  description: string;
  command: string;
  skipped: boolean;
  exitCode: number | null;
  signal?: string;
  timedOut: boolean;
  durationMs: number;
  ok: boolean;
}

export interface RunResult {
  ok: boolean;
  dryRun: boolean;
  steps: StepResult[];
  error?: string;
}
