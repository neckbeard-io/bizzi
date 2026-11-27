// Domain objects exchanged over the protocol. Hierarchy: Machine > Workspace > Session.

// 'api': plain model API chat without tools (spec §6.5 item 1, @bizzi/adapter-api).
export type AgentKind = 'claude' | 'codex' | 'opencode' | 'agy' | 'shell' | 'api';
export const AGENT_KINDS: readonly AgentKind[] = ['claude', 'codex', 'opencode', 'agy', 'shell', 'api'];

export type SessionMode = 'structured' | 'terminal';

export type SessionStatus =
  | 'starting'
  | 'running'
  | 'waiting_input'
  | 'waiting_approval'
  | 'idle'
  | 'paused'
  | 'ended'
  | 'failed';

export type MachineRole = 'node' | 'hub';

export interface MachineInfo {
  id: string;
  name: string;
  hostname: string;
  os: 'darwin' | 'linux' | 'win32' | 'other';
  arch: string;
  /** A display/GUI session is available to agents (macOS Aqua session, or a virtual X display). */
  headful: boolean;
  alwaysOn: boolean;
  /** User-set labels (`gui`, `prod-access`, …); see `isMachineTag`. Set with `machine.set`. */
  tags: string[];
  /** User-written paragraph about what the machine is for; part of the machine card (knowledge.md §9.2). */
  description?: string;
  /** User-chosen identity color (spec §11.1 "Identity color"); set with `machine.set`. */
  color?: LabelColor;
  online: boolean;
  roles: MachineRole[];
  bizziVersion: string;
  /** Set by the hub: last time the machine's node was connected. */
  lastSeenAt?: string;
  /**
   * This machine's node can reach a routing classifier (`BIZZI_ROUTER_URL`; the model may run elsewhere
   * on its network). A hub without one of its own borrows it with `route.score`.
   */
  routing?: { model: string; maxOptions: number };
}

/** A machine tag: lowercase letters, digits, `.`, `_` and `-`, starting with a letter or digit, at most 64 characters. */
export function isMachineTag(v: unknown): v is string {
  return typeof v === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(v);
}

/** Longest machine description `machine.set` accepts, in characters. */
export const MAX_MACHINE_DESCRIPTION = 2000;

export type AgentAuthState = 'ok' | 'missing' | 'expired' | 'unknown';

export interface AgentProbe {
  agent: AgentKind;
  installed: boolean;
  path?: string;
  version?: string;
  latestVersion?: string;
  auth: AgentAuthState;
  /** e.g. account email or plan, when the agent reports it */
  account?: string;
  notes?: string[];
  /** How the binary appears to have been installed (recipe method name, e.g. 'installer', 'brew', 'npm'). */
  method?: string;
  updateAvailable?: boolean;
  /** Whether the binary is on the PATH of non-interactive shells (launchd/systemd/containers). */
  onPath?: boolean;
  /** Whether bizzi supports this installed version (spec §7 "Supported versions"). Absent = not checked. */
  support?: AgentSupport;
  /** Why `support` isn't 'ok', e.g. "OpenCode v1 is not supported; bizzi drives v2 only". */
  supportReason?: string;
  /** Confirmable fixes for `support` or for a non-preferred install method. Never run automatically. */
  remedies?: AgentRemedy[];
  /** The recipe's preferred method on this OS (first in its method order). */
  preferredMethod?: string;
  /** Real path of the executable after resolving symlinks and wrapper shims. */
  realPath?: string;
  updatePolicy?: UpdatePolicy;
  restartPolicy?: RestartPolicy;
  /** Billing class of the logged-in account (spec §12.3), when known. */
  billing?: BillingClass;
  /** Sessions on this machine whose agent process runs an older version than the installed one. */
  staleSessions?: number;
}

export type AgentSupport = 'ok' | 'untested' | 'unsupported';

export interface AgentRemedy {
  /** upgrade: move to a supported version · migrate: switch to the preferred install method · restart-service: restart a stale shared server. */
  kind: 'upgrade' | 'migrate' | 'restart-service';
  title: string;
  /**
   * Recipe remedy id. Pass it as `remedy` to `agent.plan` / `agent.install` to run the remedy's own
   * steps (e.g. a major-version upgrade) instead of the method's plain update.
   */
  id?: string;
  /** Target method for 'migrate' / 'upgrade'. */
  method?: string;
  /** Shell command shown to the user, when there's a single one. */
  command?: string;
}

/** spec §7 / updates.md §6. */
export type UpdatePolicy = 'auto' | 'notify' | 'pinned';
export type RestartPolicy = 'when-idle' | 'ask' | 'manual';

/** spec §12.3: metered = pay per token · plan = subscription windows · budgetless = inference you own. */
export type BillingClass = 'metered' | 'plan' | 'budgetless';

/** `container`: agent sessions run inside a container on this machine (topology.md §7). */
export type WorkspaceKind = 'git' | 'dir' | 'worktree' | 'container';

export interface WorkspaceInfo {
  id: string;
  machineId: string;
  name: string;
  /** Absolute path on the machine. */
  path: string;
  kind: WorkspaceKind;
  projectId?: string;
  /** kind 'worktree': the repo workspace it was created from (UI groups it under that one). */
  parentWorkspaceId?: string;
  /** kind 'worktree': the branch checked out in it. */
  branch?: string;
  /** kind 'container': how its container is built and run (topology.md §7). */
  container?: WorkspaceContainer;
  createdAt: string;
  /** User-chosen identity color (spec §11.1 "Identity color"); set with `workspace.set`. A worktree without one shows its repo's. */
  color?: LabelColor;
  /** User-chosen icon in place of the name's first letter: one or two characters or an emoji (`isLabelIcon`). */
  icon?: string;
}

export interface SessionInfo {
  id: string;
  machineId: string;
  workspaceId: string;
  agent: AgentKind;
  mode: SessionMode;
  status: SessionStatus;
  title?: string;
  /** The agent's own id for this conversation (Claude session id, Codex thread id, OpenCode session id). */
  agentSessionRef?: string;
  model?: string;
  permissionMode?: string;
  effort?: string;
  forkedFrom?: string;
  /** Fork to another machine (topology.md §6): the machine `forkedFrom` runs on, when not this one. */
  forkedFromMachineId?: string;
  /** Agent-to-agent (spec §12.1): the parent session that started this helper. */
  spawnedBy?: string;
  /** Cross-machine helper (spec §12.4): the machine the parent (`spawnedBy`) runs on, when not this one. */
  spawnedByMachineId?: string;
  /** Helpers only. child: stops with its parent · detached: outlives it. */
  scope?: 'child' | 'detached';
  /** 0 for sessions you start; parent depth + 1 for helpers (spec §12.2 depth limit). */
  depth?: number;
  /** Version of the agent process currently running this session (updates.md §2). */
  agentVersion?: string;
  /** Billing class of what the session runs on (spec §12.3). */
  billing?: BillingClass;
  /** Optional cap for this session and its helpers (usage.md §2). */
  budget?: SessionBudget;
  /** Fan-out group (spec §12): sessions you started together on the same task share this id. */
  group?: string;
  /** Highest seq viewed on any device (spec §4); "done, not yet seen" = idle with lastSeq > seenThrough. */
  seenThrough?: number;
  /**
   * Latest context-window occupancy the agent reported (`context.updated`), without the breakdown, so lists
   * (the sidebar tree) can show it for sessions nobody has open. Absent until the agent reports one.
   */
  context?: SessionContext;
  /**
   * Work the agent left running in the background between turns (`background.updated`): shell commands,
   * subagents, workflows. Absent when there is none. Cleared whenever the agent process goes away, since the
   * tasks die with it. Lists show such a session as still active (spec §11.1 "background").
   */
  background?: BackgroundTask[];
  // ---- parent answers approvals (spec §12.5)
  /** Helpers only: started while `parentAnswersApprovals` was on, so its parent may answer some of its approvals. */
  parentAnswersApprovals?: boolean;
  createdAt: string;
  updatedAt: string;
  lastSeq: number;
}

/** Only `metered` spend counts toward `usd`; budgetless providers count tokens only (usage.md §2). */
export interface SessionBudget {
  usd?: number;
  tokens?: number;
  turns?: number;
}

/** Guardrails for agent-to-agent helpers (spec §12.2). Per machine, optionally overridden per workspace. */
export interface OrchestrationSettings {
  /** parent → helper → helper's helper = 2. */
  maxDepth: number;
  maxHelpersPerParent: number;
  maxHelpersPerMachine: number;
  /** What `session_start` does beyond the concurrency limits. */
  onLimit: 'queue' | 'fail';
  /** Let a parent answer its helpers' approvals (default: they go to you). */
  parentAnswersApprovals: boolean;
  /** Optional metered-spend cap for a whole session tree. */
  treeBudgetUsd?: number;
}

export const DEFAULT_ORCHESTRATION_SETTINGS: OrchestrationSettings = {
  maxDepth: 2,
  maxHelpersPerParent: 4,
  maxHelpersPerMachine: 8,
  onLimit: 'fail',
  parentAnswersApprovals: false,
};

export type InputBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; dataBase64: string }
  | { type: 'file'; path: string };

export type ApprovalKind = 'shell' | 'edit' | 'write' | 'read' | 'mcp' | 'web' | 'plan' | 'other';
export type ApprovalDecisionKind = 'allow' | 'allow_always' | 'deny';
/** How an approval ended: a decision, or 'cancelled' when its turn ended / the node restarted first. */
export type ApprovalResolution = ApprovalDecisionKind | 'cancelled';

export interface ApprovalRequest {
  approvalId: string;
  toolId?: string;
  kind: ApprovalKind;
  title: string;
  description?: string;
  /** The tool input the agent wants to use (command, file edit, …). */
  input?: unknown;
  /** Whether the adapter supports `editedInput` in the decision. */
  editable: boolean;
  /** Decisions this agent supports for this request. */
  options: ApprovalDecisionKind[];
}

export interface ApprovalDecision {
  decision: ApprovalDecisionKind;
  /** Optional message to the agent (e.g. why it was denied). */
  message?: string;
  /** Replacement tool input, only when the request was `editable`. */
  editedInput?: unknown;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  contextWindow?: number;
}

/** usage.md §1.2. `used` is the agent's own occupancy figure, never a sum of turns. */
export interface ContextUsage {
  used: number;
  window: number;
  /** Window minus the agent's compaction buffer, when known. Warnings key off this. */
  usable?: number;
  /** Token count at which the agent compacts, when known. */
  compactAt?: number;
  /** Only where the agent reports a breakdown (Claude); bizzi adds a 'bizzi' row for what it injects. */
  categories?: ContextCategory[];
}

/** What `SessionInfo.context` keeps of a `ContextUsage` (no breakdown). */
/** One piece of background work an agent is running (`background.updated`). */
export interface BackgroundTask {
  id: string;
  /** What runs: a shell command, a subagent, a workflow, or something else the agent names. */
  kind: 'shell' | 'agent' | 'workflow' | 'other';
  /** The agent's one-line description ("Wait for PR checks to finish"). */
  description: string;
}

export const MAX_BACKGROUND_TASKS = 50;
export const MAX_BACKGROUND_DESCRIPTION = 200;

export interface SessionContext {
  used: number;
  window: number;
  usable?: number;
  compactAt?: number;
}

/** Context occupancy 0..1+ of `usable` (or `window`), the share warnings key off; 0 for an unknown window. */
export function contextFraction(c: SessionContext): number {
  const of = c.usable ?? c.window;
  return of > 0 ? c.used / of : 0;
}

export interface ContextCategory {
  id: string;
  label: string;
  tokens: number;
  kind: 'used' | 'free' | 'buffer' | 'deferred';
}

/**
 * Starting context learned per (agent, model, workspace) from the first `context.updated` of earlier
 * sessions (usage.md §2): "Codex starts at about 14k here". `tokens` is the median of recent samples.
 */
export interface ContextBaseline {
  machineId: string;
  agent: AgentKind;
  model?: string;
  workspaceId?: string;
  tokens: number;
  /** Samples behind the median (at most the last 10 kept). */
  samples: number;
  /** ISO time of the newest sample. */
  updatedAt: string;
}

/** Per-login usage snapshot (usage.md §3.3). Merged per (agent, accountId) across machines; newest wins. */
export interface AccountUsage {
  agent: AgentKind;
  /** Stable account identity: email / account id, or an API-key fingerprint. */
  accountId: string;
  /** e.g. "claude · max · mc@…" */
  label: string;
  billing: BillingClass;
  machines: string[];
  windows?: UsageWindow[];
  spend?: { usd: number; capUsd?: number; period?: string; resetsAt?: string };
  status: 'ok' | 'warning' | 'limited' | 'unknown';
  /** ISO; the UI shows the age. */
  observedAt: string;
}

export interface UsageWindow {
  /** e.g. five_hour, seven_day, primary, secondary */
  id: string;
  label: string;
  usedPercent: number;
  resetsAt?: string;
  windowMins?: number;
  /**
   * Windows that limit the same pool of models share a group (agy: "Gemini models", "Claude and GPT
   * models", each with its own 5h and weekly window). Absent: the login has one pool.
   */
  group?: string;
}

/** A node-run widget's rendered value (usage.md §4). Widgets are data, never client-side code. */
export interface WidgetValue {
  id: string;
  machineId: string;
  label: string;
  kind: 'meter' | 'text' | 'status';
  placement: ('bar' | 'machine' | 'workspace' | 'session-header')[];
  text?: string;
  value?: number;
  max?: number;
  format?: 'usd' | 'percent' | 'number' | 'tokens';
  tone?: 'neutral' | 'ok' | 'warn' | 'error';
  tooltip?: string;
  link?: string;
  resetsAt?: string;
  /** Set when the last run failed; the previous value (if any) is kept. */
  error?: string;
  /** ISO time of the last successful run; the UI shows staleness. */
  observedAt?: string;
}

/** Density preference: a layout density, or `theme` to follow the theme's own. */
export type DensityPref = 'theme' | 'compact' | 'comfortable' | 'spacious';

/**
 * User-wide UI preferences (theming.md §5), stored on the server the client is connected to: the hub (shared
 * by every device) or a node in local mode. Light/dark mode is not here: it stays per device.
 */
export interface UserPrefs {
  /** Selected theme: a built-in id or a custom theme's id (`themes.list`). */
  themeId?: string;
  density?: DensityPref;
  /**
   * Interface font: a family name, or `system` for the platform font. Unset or '': `system`. Used when the
   * device has it (JetBrains Mono ships with the UI), else the platform font.
   */
  uiFont?: string;
  /** Code font (code blocks, diffs, terminals): a family name, or `system`. Unset or '': JetBrains Mono. */
  codeFont?: string;
  /**
   * Saved session-start profiles (`AgentProfile`). Each agent has a built-in Default profile
   * (`defaultProfileId(agent)`), stored here only once edited; the others are user-created.
   */
  agentProfiles?: AgentProfile[];
  /** Per agent (an `AgentKind` key), the profile the New session dialog preselects. Unset: the Default profile. */
  preferredProfiles?: Record<string, string>;
}

/**
 * Named start options for an agent: what the New session dialog fills in. Unset fields mean "the
 * agent's own default". User-wide (stored with `UserPrefs`), so model ids are the agent's, not a machine's.
 */
export interface AgentProfile {
  id: string;
  agent: AgentKind;
  name: string;
  mode?: SessionMode;
  model?: string;
  permissionMode?: string;
  effort?: string;
}

export const MAX_AGENT_PROFILES = 200;

/** The id of an agent's built-in Default profile; it always exists and can be edited but not deleted. */
export function defaultProfileId(agent: AgentKind): string {
  return `default:${agent}`;
}

/** An agent's profiles: its Default (stored or blank) first, then the user's in stored order. */
export function profilesFor(prefs: UserPrefs | undefined, agent: AgentKind): AgentProfile[] {
  const own = (prefs?.agentProfiles ?? []).filter((p) => p.agent === agent);
  const defId = defaultProfileId(agent);
  const def = own.find((p) => p.id === defId) ?? { id: defId, agent, name: 'Default' };
  return [{ ...def, name: 'Default' }, ...own.filter((p) => p.id !== defId)];
}

/** The profile the New session dialog starts with for an agent. */
export function preferredProfile(prefs: UserPrefs | undefined, agent: AgentKind): AgentProfile {
  const list = profilesFor(prefs, agent);
  const want = prefs?.preferredProfiles?.[agent];
  return list.find((p) => p.id === want) ?? list[0]!;
}

/** One model an agent offers (`agents.models`). */
export interface ModelOption {
  /** What `session.create` / `session.set` take as `model`. */
  id: string;
  /** Display name, when the agent gives one. */
  label?: string;
  description?: string;
  /** The model the agent uses when none is given. */
  isDefault?: boolean;
  /** Effort levels this model accepts, when the agent says (a subset of the capability's `effort`). */
  efforts?: string[];
}

/** A custom theme stored on the hub (theming.md §5); `data` is the theme JSON (shape owned by @bizzi/ui). */
export interface ThemeFile {
  id: string;
  name: string;
  data: unknown;
  updatedAt: string;
}

export interface QuestionItem {
  id: string;
  text: string;
  /** Short label, e.g. "Auth method". */
  header?: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
  /** Free-text answer allowed (besides or instead of options). */
  allowText?: boolean;
}

/** Answers keyed by QuestionItem.id: an option label, several labels (multiSelect), or free text. */
export type QuestionAnswers = Record<string, string | string[]>;

// ---- provisioning

export type InstallAction = 'install' | 'update' | 'uninstall';

export interface InstallStep {
  id: string;
  title: string;
  /** Shell command shown to the user (already quoted). */
  command?: string;
  requiresSudo?: boolean;
}

export interface InstallPlan {
  /** Agent kind, or a tool name such as 'node'. */
  target: string;
  action: InstallAction;
  method: string;
  steps: InstallStep[];
  notes?: string[];
}

export type LoginMode = 'interactive' | 'device-code' | 'token';

export interface SecretInfo {
  agent: AgentKind;
  /** Environment variable name, e.g. ANTHROPIC_API_KEY. Values are never returned. */
  name: string;
  setAt: string;
}

// ---- knowledge (wire shape; see docs/knowledge.md)

export type KnowledgeScopeLevel = 'global' | 'tag' | 'machine' | 'project' | 'workspace' | 'session' | 'team';

export interface KnowledgeScope {
  level: KnowledgeScopeLevel;
  /** `tag` scope: applies on every machine with this tag. */
  tag?: string;
  machineId?: string;
  projectId?: string;
  workspaceId?: string;
  sessionId?: string;
}

export interface KnowledgeItemInfo {
  id: string;
  type: 'rule' | 'memory';
  scope: KnowledgeScope;
  /** Default: all agents. */
  appliesTo?: AgentKind[];
  /** Memories only: fact | preference | decision | gotcha | procedure | reference | todo. */
  kind?: string;
  title: string;
  body: string;
  tags: string[];
  source: {
    agent?: AgentKind;
    sessionId?: string;
    machineId: string;
    via: 'ui' | 'tool' | 'harvest' | 'extract';
    userRequested?: boolean;
  };
  status: 'active' | 'suggested' | 'superseded' | 'deleted';
  supersedes?: string[];
  createdAt: string;
  updatedAt: string;
}

export type KnowledgePreset = 'trusting' | 'balanced' | 'strict';

export interface KnowledgeSettings {
  preset: KnowledgePreset;
  /** Scope used when an agent writes without naming one. */
  defaultAgentScope: KnowledgeScopeLevel;
  /** Per source × scope overrides; shape owned by @bizzi/knowledge. */
  overrides?: unknown;
}

export interface KnowledgeInboxCard {
  sessionId?: string;
  agent?: AgentKind;
  items: KnowledgeItemInfo[];
}

/**
 * A knowledge item as it replicates between nodes through the hub (knowledge.md §9.4): the whole
 * stored item, including its clock. Last writer by `hlc` wins; forgetting is a `deleted` tombstone.
 */
export interface KnowledgeRecord {
  id: string;
  type: 'rule' | 'memory';
  scope: KnowledgeScope & { teamId?: string };
  appliesTo?: AgentKind[];
  kind?: string;
  title: string;
  body: string;
  tags: string[];
  source: {
    agent?: AgentKind;
    sessionId?: string;
    machineId: string;
    via: 'ui' | 'tool' | 'harvest' | 'extract';
    userRequested?: boolean;
    projectId?: string;
    workspaceId?: string;
    ref?: string;
  };
  status: 'active' | 'suggested' | 'superseded' | 'deleted';
  supersedes?: string[];
  noticePending?: boolean;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
  /** Hybrid logical clock of the last change: `<15-digit ms>-<6-digit counter>-<machine id>`. */
  hlc: string;
}

// ---- knowledge: Add to AGENTS.md (knowledge.md §8)

export interface KnowledgePromotePreview {
  /** Absolute path of the workspace's AGENTS.md on its machine. */
  path: string;
  /** False: writing creates the file. */
  exists: boolean;
  /** Pass back to `knowledge.promote` so it fails if the file changed in between. */
  baseHash: string;
  heading: string;
  /** Items that would be written, in order. */
  ids: string[];
  skipped: { id: string; reason: 'not_found' | 'inactive' | 'already_promoted' | 'not_visible' }[];
  /** Unified diff of the change (always an append at the end of the file). */
  diff: string;
  /** E.g. the workspace has a CLAUDE.md, so Claude Code won't read AGENTS.md. */
  warnings: string[];
}

// ---- routing (spec §11.2: one-pane mode decides where a prompt runs)

export interface RouteCandidate {
  machineId: string;
  workspaceId: string;
  /** "laptop · acme-shop" */
  label: string;
  /** 0–1. A logprob readout for `classifier`; 1 for `explicit` and `single`. */
  probability: number;
}

export interface RouteSuggestion {
  /**
   * explicit: `@machine` / `#workspace` in the text (combinable) left one target, or a few the user must
   * pick from (`confident` false, e.g. `#acme-shop` on two machines) · single: only one target exists ·
   * classifier: a logprob readout over the targets · none: nothing decided (no classifier, it failed, or
   * the tokens can't be satisfied: see `note`) · rule: a routing rule (`route.rules.get`) left one target, or a
   * few to pick from when no classifier can choose. Whenever `confident` is false the client asks.
   */
  source: 'explicit' | 'single' | 'classifier' | 'none' | 'rule';
  /** Best first, at most 3: the choices to offer when asking. Empty when nothing decided. */
  candidates: RouteCandidate[];
  /** 1 − entropy / ln(N) over the targets scored; 1 for explicit and single. */
  confidence: number;
  /** confidence ≥ the router's threshold: send without asking. */
  confident: boolean;
  /** Agent named with `/agent` in the text. */
  agent?: AgentKind;
  /** The prompt with the routing tokens it used removed. */
  text: string;
  /** Targets offered to the classifier (online machines, at most the backend's option limit). */
  offered: number;
  classifier?: {
    model: string;
    /** The machine whose classifier the hub borrowed (`route.score`); absent when the router's own scored. */
    via?: string;
    ms: number;
    /** Share of the next-token probability that fell on option letters (low = the model wanted to say something else). */
    letterMass: number;
  };
  /** Why nothing was decided: no classifier, its error, several matches, or a token problem ("vps is offline", "no workspace matches @mac-mini and #bizzi"). */
  note?: string;
  /** The routing rule that narrowed the targets (step 3), whatever then chose among them. */
  rule?: { id: string; label: string };
}

// ---- one-pane mode (spec §11.2 steps 2–3: routing rules, recorded decisions)

/**
 * A routing preference (knowledge.md §9.3), e.g. "production, prod logs → machines tagged prod-access".
 * Matches when any of `match` appears in the prompt as a whole word or phrase, case-insensitive; a trailing
 * `*` matches a word prefix (`prod*`). Exactly one of `tag`, `machineId`, `workspaceId` says where it goes.
 */
export interface RoutingRule {
  id: string;
  match: string[];
  tag?: string;
  machineId?: string;
  workspaceId?: string;
  /** Agent to use when the prompt names none with `/agent`. */
  agent?: AgentKind;
}

/**
 * One routed prompt and where it went, recorded by the one-pane composer (`route.record`). The labeled set
 * for comparing classifiers (spec §11.2 "Choosing"): `text` → `chosen`, with what was offered and by whom.
 */
export interface RouteDecisionInput {
  /** The prompt as typed, routing tokens included. */
  text: string;
  source: 'explicit' | 'single' | 'classifier' | 'none' | 'rule';
  /** What the suggestion offered, best first (may be empty). */
  candidates: RouteCandidate[];
  confidence: number;
  classifier?: { model: string; via?: string };
  rule?: { id: string; label: string };
  chosen: { machineId: string; workspaceId: string; label: string; agent?: AgentKind };
  /** suggested: sent to the top candidate · picked: another offered candidate · other: a target that wasn't offered. */
  via: 'suggested' | 'picked' | 'other';
  /** `chosen` isn't the top candidate (false when nothing was offered). */
  overridden: boolean;
  /** The session started for it. */
  sessionId?: string;
}

export interface RouteDecision extends RouteDecisionInput {
  id: string;
  /** ISO time recorded. */
  at: string;
}

// ---- pipelines (docs/pipelines.md, spec §12.4)

/** Stage sessions carry `group: <pipeline id>`; pipeline ids start with this, so fan-out views can skip them. */
export const PIPELINE_ID_PREFIX = 'pl_';

/** One stage of a pipeline definition: an agent, a prompt template and where it runs. */
export interface PipelineStageSpec {
  /** Short unique name within the pipeline: lowercase letters, digits, `-` and `_` (`plan`, `implement`, `review`). */
  name: string;
  agent: AgentKind;
  model?: string;
  permissionMode?: string;
  effort?: string;
  /**
   * Prompt template. Placeholders: `{{task}}`, `{{gate.message}}`, `{{previous.name}}`, `{{previous.result}}`,
   * `{{previous.diff}}`, `{{previous.files}}`, and `{{stages.<name>.result|diff|files}}` for any earlier stage.
   */
  prompt: string;
  /** workspace (default): the pipeline's workspace · worktree: the pipeline's own worktree, shared by every stage that picks it. */
  where?: 'workspace' | 'worktree';
  /** Stop for your approval before this stage starts (an inbox item); approving can add a note (`{{gate.message}}`). */
  gate?: boolean;
  /** Cap for this stage's session (usage.md §2). */
  budget?: SessionBudget;
}

export interface PipelineSpec {
  stages: PipelineStageSpec[];
  /** Branch of the pipeline's worktree (default `pipeline/<title>-<id>`); only used when a stage runs `where: 'worktree'`. */
  branch?: string;
  /** Metered spend cap for the whole run, checked before each stage; reaching it gates the next stage with reason `budget`. */
  budgetUsd?: number;
}

export type PipelineStatus = 'running' | 'waiting' | 'done' | 'failed' | 'cancelled';
export type PipelineStageStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export interface PipelineStageRun {
  name: string;
  agent: AgentKind;
  status: PipelineStageStatus;
  sessionId?: string;
  workspaceId?: string;
  startedAt?: string;
  endedAt?: string;
  /** First line(s) of the stage's final message, at most 300 characters. */
  summary?: string;
  /** Files the stage changed (from its `file.changed` events). */
  changedFiles?: number;
  error?: string;
}

/** A pipeline run (docs/pipelines.md): stages run one after another on one machine. */
export interface PipelineInfo {
  /** `pl_…` */
  id: string;
  machineId: string;
  /** Where it was started; `where: 'workspace'` stages run here. */
  workspaceId: string;
  title: string;
  /** What `{{task}}` expands to. */
  task: string;
  spec: PipelineSpec;
  status: PipelineStatus;
  /** Index of the stage running, waiting at its gate, or that ended the run. */
  current: number;
  stages: PipelineStageRun[];
  /** Set while `status` is `waiting`: the stage about to start and why (its gate, or the run's budget). */
  gate?: { stage: number; reason: 'gate' | 'budget'; message: string; since: string };
  /** The pipeline's worktree workspace, once created. */
  worktreeId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

// ---- container workspaces (topology.md §7)

/** persistent: stopped when idle, restarted on the next session · ephemeral: removed when idle, recreated fresh. */
export type ContainerLifecycle = 'persistent' | 'ephemeral';

/** A shell command line (run with `sh -c`) or an argv. */
export type ContainerCommand = string | string[];

/** An extra bind mount. `source` is a path as the Docker daemon sees it (the dind sidecar's filesystem). */
export interface ContainerMount {
  source: string;
  target: string;
  readOnly?: boolean;
}

/**
 * A container workspace's recipe. The workspace directory is bind-mounted at the same absolute path, so
 * the agent's cwd and every path it prints match the machine's.
 */
export interface WorkspaceContainer {
  /** Image the container runs (for `build`, the tag bizzi builds it as). */
  image: string;
  /** explicit: given at creation · devcontainer: from the repo's devcontainer.json · default: bizzi's workspace image. */
  imageSource: 'explicit' | 'devcontainer' | 'default';
  /** devcontainer.json `build`: built on first start. Paths are absolute on the machine. */
  build?: { dockerfile: string; context: string; args?: Record<string, string> };
  /** `bridge` (default), `none` (no network at all), or the name of a Docker network. */
  network: string;
  mounts?: ContainerMount[];
  /** Fixed, non-secret environment set on the container (devcontainer.json `containerEnv`). */
  env?: Record<string, string>;
  /**
   * Names of the node's environment variables forwarded into agent processes (agent credentials such as
   * `CLAUDE_CODE_OAUTH_TOKEN`). Values are passed at exec time, never stored in the container's config.
   */
  passEnv?: string[];
  /** User agents run as (`uid:gid` or a name); default: the node's own uid:gid. */
  user?: string;
  /** devcontainer.json `onCreateCommand`, `updateContentCommand`, `postCreateCommand`: run in order once after creation. */
  postCreate?: ContainerCommand[];
  lifecycle: ContainerLifecycle;
  /** Minutes without a live session before the container is stopped (persistent) or removed (ephemeral). */
  idleMinutes: number;
}

/** Docker's container states, plus `absent` (not created yet, or removed) and `unreachable` (no daemon). */
export type ContainerState = 'absent' | 'created' | 'running' | 'paused' | 'restarting' | 'removing' | 'exited' | 'dead' | 'unreachable';

export interface ContainerStatus {
  workspaceId: string;
  /** Container name, `bizzi-ws-<workspace id>`. */
  name: string;
  state: ContainerState;
  image: string;
  /** Docker's container id, when it exists. */
  id?: string;
  startedAt?: string;
  /** Live (not ended or failed) sessions in the workspace. */
  liveSessions: number;
  /** When the idle timer stops or removes it, if it is running with no live session. */
  idleUntil?: string;
  /** Why the daemon couldn't answer (state `unreachable`). */
  error?: string;
}

// ---- identity color and icon (spec §11.1 "Identity color")

/**
 * A palette name, not a CSS color: each theme resolves it (`--label-<name>`) so it reads on that theme's
 * sidebar and cards, light or dark.
 */
export type LabelColor = 'red' | 'orange' | 'yellow' | 'green' | 'teal' | 'blue' | 'purple' | 'pink';
export const LABEL_COLORS: readonly LabelColor[] = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink'];

export function isLabelColor(v: unknown): v is LabelColor {
  return typeof v === 'string' && (LABEL_COLORS as readonly string[]).includes(v);
}

/** Longest workspace name `workspace.set` accepts, in characters. */
export const MAX_WORKSPACE_NAME = 200;

/**
 * A workspace icon: one or two user-perceived characters (an emoji, `AB`, `λ`), at most 16 UTF-16 units,
 * no whitespace or control characters. Callers trim first.
 */
export function isLabelIcon(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0 || v.length > 16) return false;
  // Whitespace, controls, and invisible or direction-changing format characters (ZWJ stays: emoji sequences).
  if (/[\s\p{Cc}\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/u.test(v)) return false;
  return graphemeCount(v) <= 2;
}

function graphemeCount(v: string): number {
  if (typeof Intl.Segmenter === 'function') return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(v)].length;
  return [...v].length;
}

// ---- hub: devices and pairing

export type DeviceKind = 'device' | 'node';

export interface DeviceInfo {
  id: string;
  name: string;
  kind: DeviceKind;
  /** For kind 'node': the machine it serves. */
  machineId?: string;
  /** The first device paired with the setup code. */
  owner?: boolean;
  createdAt: string;
  lastSeenAt?: string;
  revoked?: boolean;
}

// ---- hub: Web Push (tech-choices.md D9)

/** A browser push subscription, as `PushSubscription.toJSON()` returns it (keys base64url). */
export interface WebPushSubscription {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}

/** Printed by `bizzi serve` as a single JSON line on stdout once it is listening. */
export interface ServeReady {
  event: 'ready';
  /** WebSocket URL of the client-protocol endpoint, e.g. ws://127.0.0.1:7777/ws */
  url: string;
  /** Bearer token required in `hello` (local mode). */
  token: string;
  machineId: string;
  pid: number;
}

// ---- cross-machine work (spec §12.4, topology.md §6)

/** Spend of a helper and every helper below it (usage.md §2): usd counts metered billing only. */
export interface HelperSpent {
  usd: number;
  tokens: number;
  turns: number;
}

/** What the target machine needs to know about a parent on another machine (`helper.start`). */
export interface HelperParent {
  sessionId: string;
  agent: AgentKind;
  permissionMode?: string;
  /** The parent's own depth (0 for a session you started). */
  depth: number;
  /** The parent workspace's project and normalized `origin` URL: the helper's default workspace is the linked one. */
  projectId?: string;
  gitRemote?: string;
}

/** The `session_start` arguments, as sent to the target machine. */
export interface HelperStartRequest {
  agent: AgentKind;
  prompt: string;
  /** Workspace id or path on the target machine. Default: the one linked to the parent's workspace. */
  workspace?: string;
  worktree?: string;
  model?: string;
  permissionMode?: string;
  effort?: string;
  scope?: 'child' | 'detached';
  /** Already capped by the parent's machine at what the parent's budgets have left. */
  budget?: SessionBudget;
  title?: string;
}

export interface HelperStartResult {
  session: SessionInfo;
  workspace: WorkspaceInfo;
  queued: boolean;
  notes: string[];
}

export type HelperWaitUntil = 'idle' | 'waiting' | 'done' | 'ended';

/** A pending approval or question of a helper, as its parent sees it. */
export interface HelperPendingItem {
  type: 'approval' | 'question';
  /** approvalId / questionId: pass to session_answer. */
  id: string;
  kind?: ApprovalKind;
  /** Approval title, or the question's text. */
  title: string;
  description?: string;
  /** Approvals: the tool input as JSON (truncated). */
  input?: string;
  options?: string[];
  questions?: QuestionItem[];
  /** What the parent may do: approvals 'allow' / 'deny'; questions 'answer' / 'cancel'. */
  parentMay: string[];
  /** Why the parent may not allow it (allowing stays with the user). */
  note?: string;
}

export interface HelperWaitResult {
  sessionId: string;
  state: SessionStatus;
  /** The `until` condition was met (false: timed out). */
  reached: boolean;
  reason: string;
  /** Cross-machine waits: the helper tree's spend, so the parent's machine can count it toward budgets. */
  usage?: HelperSpent;
  /** With parentAnswersApprovals: what the helper waits on and what the parent may answer (session_answer). */
  pending?: HelperPendingItem[];
}

export interface HelperChangedFile {
  path: string;
  change: 'created' | 'modified' | 'deleted';
  /** Pass to session_read `{ detail: 'diff', path }` for the diff. */
  diffRef: string;
}

/** `session_read`: a structured summary of what a helper did since a cursor (spec §12.1, usage.md §2). */
export interface HelperReadResult {
  sessionId: string;
  agent: AgentKind;
  state: SessionStatus;
  /** Pass as `since` next time to read only what's new. */
  cursor: number;
  turns: number;
  stopReason?: string;
  error?: string;
  finalMessage?: string;
  changedFiles: HelperChangedFile[];
  tools: { total: number; byKind: Record<string, number>; failed: number; denied: number };
  waitingOn?: { approvals: string[]; questions: string[]; budget?: string; items?: HelperPendingItem[] };
  usage: HelperSpent;
  /** detail 'full': the transcript in order (oldest entries dropped first to fit). */
  transcript?: string[];
  /** detail 'diff'. */
  diff?: string;
  truncated: boolean;
}

/**
 * How the workspace state traveled for a fork to another machine. `git`: the source branch plus any
 * uncommitted or untracked changes as one snapshot commit on top, sent as a git bundle and checked out
 * on `branch`. `snapshot`: a plain directory, committed into a shadow repository on each side.
 */
export interface ForkTransfer {
  kind: 'git' | 'snapshot';
  /** The commit the new session starts from. */
  commit: string;
  /** git: the branch created on the target machine. */
  branch?: string;
  /** git: the source workspace's branch (absent when detached). */
  sourceBranch?: string;
  /** The snapshot commit includes changes that weren't committed in the source workspace. */
  uncommitted: boolean;
  /** Size of the bundle sent through the hub (0 when the target already had every object). */
  bytes: number;
}

/** What `fork.prepare` and `fork.receive` are told about the source workspace. */
export interface ForkSource {
  kind: 'git' | 'dir';
  /** Source workspace name (default names on the target). */
  name: string;
  projectId?: string;
  /** Normalized `origin` URL (linked-workspace match) and the raw one (set as `origin` on a fresh clone). */
  gitRemote?: string;
  gitRemoteUrl?: string;
}

/** Where a fork lands on the target machine: an existing workspace there, or a new directory. */
export interface ForkTarget {
  /** A git workspace on the target: the fork gets a worktree of it on a new branch. */
  toWorkspaceId?: string;
  /** A new (absent or empty) directory on the target; required for plain-directory workspaces. */
  toPath?: string;
}

/** The session a fork starts on the target machine. */
export interface ForkSessionSpec {
  agent: AgentKind;
  model?: string;
  permissionMode?: string;
  effort?: string;
  title?: string;
  /** The source session id (`forkedFrom`). */
  forkedFrom: string;
}
