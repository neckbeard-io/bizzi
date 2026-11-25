import type { AgentCapabilities } from './capabilities.ts';
import type { NodeCaller } from './hub.ts';
import type {
  AccountUsage,
  AgentKind,
  AgentProbe,
  ContainerLifecycle,
  ContainerMount,
  ContainerStatus,
  ContextBaseline,
  ApprovalDecision,
  DeviceInfo,
  DeviceKind,
  ForkSessionSpec,
  ForkSource,
  ForkTarget,
  ForkTransfer,
  HelperParent,
  HelperReadResult,
  HelperStartRequest,
  HelperStartResult,
  HelperWaitResult,
  HelperWaitUntil,
  InputBlock,
  InstallAction,
  InstallPlan,
  KnowledgeInboxCard,
  KnowledgeItemInfo,
  KnowledgePromotePreview,
  KnowledgeRecord,
  KnowledgeScope,
  KnowledgeScopeLevel,
  KnowledgeSettings,
  LoginMode,
  MachineInfo,
  MachineRole,
  OrchestrationSettings,
  PipelineInfo,
  PipelineSpec,
  QuestionAnswers,
  RestartPolicy,
  RouteDecision,
  RouteDecisionInput,
  RouteSuggestion,
  RoutingRule,
  SecretInfo,
  SessionBudget,
  SessionInfo,
  SessionMode,
  ThemeFile,
  UpdatePolicy,
  UserPrefs,
  WebPushSubscription,
  WidgetValue,
  WorkspaceInfo,
} from './model.ts';

type Empty = Record<string, never>;

export interface FsEntry {
  name: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
  size?: number;
}

/**
 * A directory offered by the workspace picker (`fs.browse` / `fs.complete` / `fs.suggest`). Only
 * directories and symlinks that resolve to directories are ever listed.
 */
export interface BrowseEntry {
  name: string;
  /** Absolute path on the machine (not symlink-resolved). */
  path: string;
  kind: 'dir' | 'symlink';
  /** Has a `.git` entry (a repository root or a worktree). */
  git?: boolean;
  /** Already registered as this bizzi workspace (compared by real path). */
  workspaceId?: string;
  /** Name starts with '.'. */
  hidden?: boolean;
  /** `fs.suggest` only: why it was offered. */
  suggest?: 'home' | 'root' | 'recent' | 'repo';
}

export interface GitFileStatus {
  path: string;
  /** Porcelain v1 XY code, e.g. " M", "??", "A ". */
  status: string;
}

export interface AgentListing extends AgentProbe {
  capabilities?: AgentCapabilities;
}

/**
 * Routing to a machine (hub). Methods that name a session or workspace are routed by that id.
 * Methods without one take an optional `machineId`: required when talking to a hub, ignored by a
 * node when it matches its own machine (a different id → `not_found`).
 */
export interface MachineTarget {
  machineId?: string;
}

/** Client → server methods. Every method is a request with exactly one response. */
export interface Methods {
  hello: {
    params: { protocol: string; client: { name: string; version: string }; token?: string };
    /** `machine` is the node's machine (role 'node') or the hub's own host (role 'hub'). */
    result: { protocol: string; serverVersion: string; machine: MachineInfo; role?: MachineRole };
  };
  /** Replays events with seq > since (default 0), then streams live ones. */
  subscribe: { params: { ch: string; since?: number }; result: { ch: string; lastSeq: number } };
  unsubscribe: { params: { ch: string }; result: Empty };

  'machines.list': { params: Empty; result: { machines: MachineInfo[] } };
  /**
   * Set a machine's user-owned fields (knowledge.md §9.1–9.2): `tags` replaces the list, `description`
   * replaces the text (`''` clears it). Emits `machine.updated`.
   */
  'machine.set': { params: MachineTarget & { tags?: string[]; description?: string }; result: { machine: MachineInfo } };
  'agents.list': { params: MachineTarget & { refresh?: boolean }; result: { agents: AgentListing[] } };

  'workspaces.list': { params: MachineTarget; result: { workspaces: WorkspaceInfo[] } };
  /** Adopt an existing directory, or create it when `create` is true. */
  'workspace.create': {
    params: MachineTarget & { path: string; name?: string; create?: boolean };
    result: { workspace: WorkspaceInfo };
  };
  /** Removes the workspace from bizzi's registry only; files are untouched. */
  'workspace.remove': { params: { workspaceId: string }; result: Empty };

  /**
   * `git worktree add` + a new workspace (kind 'worktree') grouped under the repo workspace.
   * Creates `branch` from `base` (default HEAD) unless it already exists.
   */
  'worktree.create': {
    params: { workspaceId: string; branch: string; base?: string; path?: string; name?: string };
    result: { workspace: WorkspaceInfo };
  };
  /** Removes the worktree and its workspace. Never deletes the branch; refuses on uncommitted changes unless `force`. */
  'worktree.remove': { params: { workspaceId: string; force?: boolean }; result: Empty };

  /** `spawnedBy`: only that parent's helpers. */
  'sessions.list': {
    params: MachineTarget & { workspaceId?: string; spawnedBy?: string };
    result: { sessions: SessionInfo[] };
  };
  'session.get': { params: { sessionId: string }; result: { session: SessionInfo; capabilities: AgentCapabilities } };
  'session.create': {
    params: {
      workspaceId: string;
      agent: AgentKind;
      mode?: SessionMode;
      model?: string;
      permissionMode?: string;
      effort?: string;
      title?: string;
      /** Resume an existing agent-native session (Claude session id, Codex thread id, …). */
      resumeRef?: string;
      /** Terminal mode: initial size. */
      cols?: number;
      rows?: number;
      /** Terminal mode only: run this command (argv) instead of the agent's TUI. */
      command?: string[];
      budget?: SessionBudget;
      /** Fan-out group id (spec §12), stored on the session; at most 128 characters. */
      group?: string;
    };
    result: { session: SessionInfo };
  };
  /** New session continuing from the source session's conversation (agent-native fork when supported). */
  'session.fork': { params: { sessionId: string; title?: string }; result: { session: SessionInfo } };
  /** Stop the session if needed and remove it and its events. */
  'session.delete': { params: { sessionId: string }; result: Empty };
  'session.send': { params: { sessionId: string; input: InputBlock[] }; result: { turnId: string } };
  'session.steer': { params: { sessionId: string; input: InputBlock[] }; result: Empty };
  'session.interrupt': { params: { sessionId: string }; result: Empty };
  /** Record that the user has seen the session through `seq` (spec §4 `seen_through`). Never moves backwards. */
  'session.markSeen': { params: { sessionId: string; seq: number }; result: { seenThrough: number } };
  /** Restart the agent process on the installed version at the next safe point and resume (updates.md §5). */
  'session.restart': { params: { sessionId: string }; result: Empty };
  'session.stop': { params: { sessionId: string }; result: Empty };
  /**
   * A helper's permission mode can't be loosened beyond its parent's (`conflict`). `budget` replaces
   * the session's budget (`{}` clears it); a session held for budget accepts sends again once within it.
   */
  'session.set': {
    params: { sessionId: string; model?: string; permissionMode?: string; effort?: string; budget?: SessionBudget };
    result: { session: SessionInfo };
  };
  'approval.respond': { params: { sessionId: string; approvalId: string } & ApprovalDecision; result: Empty };
  /** Answer a `question.asked`; `cancel` declines it. */
  'question.respond': {
    params: { sessionId: string; questionId: string; answers?: QuestionAnswers; cancel?: boolean };
    result: Empty;
  };

  /** Terminal-mode sessions only. */
  'term.input': { params: { sessionId: string; dataBase64: string }; result: Empty };
  'term.resize': { params: { sessionId: string; cols: number; rows: number }; result: Empty };
  /** Recent terminal output (scrollback) as of `seq`; subscribe with `since: seq` to continue live. */
  'term.snapshot': { params: { sessionId: string }; result: { dataBase64: string; seq: number } };

  'fs.list': { params: { workspaceId: string; path?: string }; result: { entries: FsEntry[] } };
  'fs.read': {
    params: { workspaceId: string; path: string; maxBytes?: number };
    result: { content: string; encoding: 'utf8' | 'base64'; truncated: boolean };
  };
  /**
   * Workspace picker (spec §5.2, §10): list the directories in `path` on the machine (default: the node
   * user's home; `~` and `~/…` are expanded). Unlike fs.list this is not confined to a workspace: it runs
   * as the node's OS user, the same trust as a terminal session. Directories and symlinks to directories
   * only; file contents are never read. `truncated` when the listing hit the node's entry cap.
   */
  'fs.browse': {
    params: MachineTarget & { path?: string; showHidden?: boolean };
    result: { path: string; parent?: string; home: string; entries: BrowseEntry[]; truncated: boolean };
  };
  /**
   * Shell-like directory completion of a partially typed absolute path (`~/re` → `repo`). `base` is the
   * typed directory part (`~/`), so a completion's full text is `base + name + '/'`. Matches that keep
   * the typed case come first; matching ignores case on case-insensitive filesystems (macOS, Windows).
   * Hidden directories only when `showHidden` or the typed name starts with '.'. `limit` default 50.
   */
  'fs.complete': {
    params: MachineTarget & { prefix: string; limit?: number; showHidden?: boolean };
    result: { completions: BrowseEntry[]; base: string };
  };
  /**
   * Starting points for the picker: home, common source roots that exist (~/src, ~/repo, ~/code, …),
   * parents of existing workspaces, and git repositories one level under those that aren't workspaces yet.
   */
  'fs.suggest': { params: MachineTarget; result: { entries: BrowseEntry[] } };
  'git.status': {
    params: { workspaceId: string };
    result: { isRepo: boolean; branch?: string; ahead?: number; behind?: number; files: GitFileStatus[] };
  };
  'git.diff': { params: { workspaceId: string; path?: string; staged?: boolean }; result: { diff: string } };

  // ---- provisioning (docs/spec.md §7)
  /** Preview the steps for installing / updating / uninstalling an agent. */
  'agent.plan': {
    params: MachineTarget & { agent: AgentKind; action: InstallAction; method?: string; version?: string };
    result: { plan: InstallPlan };
  };
  /** Run a plan; progress streams as `install.progress` (global channel) with this jobId. */
  'agent.install': {
    params: MachineTarget & { agent: AgentKind; action: InstallAction; method?: string; version?: string; dryRun?: boolean };
    result: { jobId: string; plan: InstallPlan };
  };
  /** Start a login flow as a terminal-mode session; it emits `login.prompt` / `login.completed`. */
  'agent.login': {
    params: MachineTarget & { agent: AgentKind; mode?: LoginMode; workspaceId?: string };
    result: { session: SessionInfo };
  };
  /** Store a secret (e.g. an API key) on the machine; injected into that agent's environment. */
  'agent.setSecret': { params: MachineTarget & { agent: AgentKind; name: string; value: string }; result: Empty };
  'agent.deleteSecret': { params: MachineTarget & { agent: AgentKind; name: string }; result: Empty };
  'agent.secrets': { params: MachineTarget & { agent?: AgentKind }; result: { secrets: SecretInfo[] } };
  /**
   * Switch an adopted install to the recipe's preferred method (spec §7): install with the preferred
   * method, check PATH order, re-probe login, remove the old install once no session uses it.
   */
  'agent.migrate': {
    params: MachineTarget & { agent: AgentKind; toMethod?: string; dryRun?: boolean };
    result: { jobId: string; plan: InstallPlan };
  };
  'agent.policy.set': {
    params: MachineTarget & { agent: AgentKind; update?: UpdatePolicy; restart?: RestartPolicy };
    result: { agent: AgentListing };
  };

  // ---- usage and widgets (docs/usage.md)
  /** Per-login usage; on a hub, merged across machines per account. */
  'usage.list': { params: Empty; result: { accounts: AccountUsage[] } };
  /** On a hub without machineId: every online machine's widgets. */
  'widgets.list': { params: MachineTarget; result: { widgets: WidgetValue[] } };
  'widget.refresh': { params: MachineTarget & { widgetId: string }; result: { widget: WidgetValue } };
  /**
   * Learned starting context per agent, model and workspace (usage.md §2). `workspaceId` narrows to one
   * workspace; on a hub without machineId or workspaceId: every online machine's baselines.
   */
  'baselines.list': { params: MachineTarget & { workspaceId?: string }; result: { baselines: ContextBaseline[] } };

  // ---- orchestration (spec §12)
  'orchestration.settings.get': {
    params: MachineTarget & { workspaceId?: string };
    result: { settings: OrchestrationSettings };
  };
  'orchestration.settings.set': {
    params: MachineTarget & { workspaceId?: string; settings: Partial<OrchestrationSettings> };
    result: { settings: OrchestrationSettings };
  };

  // ---- knowledge (docs/knowledge.md)
  'knowledge.list': {
    params: MachineTarget & {
      type?: 'rule' | 'memory';
      status?: KnowledgeItemInfo['status'];
      scopeLevel?: KnowledgeScopeLevel;
      workspaceId?: string;
      projectId?: string;
      query?: string;
      limit?: number;
    };
    result: { items: KnowledgeItemInfo[] };
  };
  'knowledge.add': {
    params: MachineTarget & {
      type: 'rule' | 'memory';
      title: string;
      body: string;
      scope: KnowledgeScope;
      kind?: string;
      appliesTo?: AgentKind[];
      tags?: string[];
    };
    result: { item: KnowledgeItemInfo };
  };
  'knowledge.update': {
    params: MachineTarget & {
      id: string;
      title?: string;
      body?: string;
      scope?: KnowledgeScope;
      appliesTo?: AgentKind[];
      tags?: string[];
    };
    result: { item: KnowledgeItemInfo };
  };
  'knowledge.forget': { params: MachineTarget & { id: string }; result: Empty };
  'knowledge.inbox': { params: MachineTarget; result: { cards: KnowledgeInboxCard[] } };
  'knowledge.accept': { params: MachineTarget & { ids: string[]; scope?: KnowledgeScope }; result: Empty };
  'knowledge.reject': { params: MachineTarget & { ids: string[] }; result: Empty };
  'knowledge.settings.get': { params: MachineTarget; result: { settings: KnowledgeSettings } };
  'knowledge.settings.set': {
    params: MachineTarget & { settings: Partial<KnowledgeSettings> };
    result: { settings: KnowledgeSettings };
  };
  /**
   * Replication (knowledge.md §9.4), called by the hub over the node link. `pull` returns the items
   * changed after `since` (exclusive, by HLC), oldest first, tombstones included. `storeId` names the
   * node's knowledge database; a new one means it was replaced and the hub syncs everything again.
   */
  'knowledge.sync.pull': {
    params: MachineTarget & { since?: string; limit?: number };
    result: { items: KnowledgeRecord[]; more: boolean; storeId: string };
  };
  /** Merge items from other machines: last writer by HLC wins. `applied` counts the ones that were newer. */
  'knowledge.sync.push': { params: MachineTarget & { items: KnowledgeRecord[] }; result: { applied: number } };

  // ---- knowledge: Add to AGENTS.md (knowledge.md §8)
  /**
   * What "Add to AGENTS.md…" would append to the workspace's root AGENTS.md: the picked items under a
   * `## heading` section, as a unified diff. Reads only. Items already tagged `promoted`, inactive or
   * outside the workspace's scope are listed in `skipped`.
   */
  'knowledge.promote.preview': {
    params: MachineTarget & { workspaceId: string; ids: string[]; heading?: string };
    result: { preview: KnowledgePromotePreview };
  };
  /**
   * Append the picked items to the workspace's AGENTS.md (creating it if missing) and tag them
   * `promoted`. With the preview's `baseHash`, fails with `conflict` if the file changed since. Never commits.
   */
  'knowledge.promote': {
    params: MachineTarget & { workspaceId: string; ids: string[]; heading?: string; baseHash?: string };
    result: { path: string; created: boolean; promoted: string[] };
  };

  // ---- routing (spec §11.2)
  /**
   * Where should this prompt run? On a hub: across every online machine. On a node: its own workspaces.
   * Explicit `@machine`, `#workspace` and `/agent` tokens win; otherwise the configured logprob classifier
   * scores the targets. Read-only: nothing is started.
   */
  'route.suggest': { params: { text: string }; result: { suggestion: RouteSuggestion } };
  /**
   * One option-logit readout through this machine's classifier (`MachineInfo.routing`). A hub without a
   * classifier of its own borrows a machine's this way: the model only has to be reachable from that
   * machine, not run on it. `probabilities` has one entry per option, normalized over the letters.
   */
  'route.score': {
    params: MachineTarget & { text: string; options: string[] };
    result: { probabilities: number[]; letterMass: number; ms: number; model: string };
  };
  // ---- one-pane mode (spec §11.2 steps 2–3, override recording). Stored where `route.suggest` answers:
  // on the hub across machines, on a node in local mode. Never relayed.
  /** Record a routed prompt (the labelled eval set). Returns it with its id and time. */
  'route.record': { params: { decision: RouteDecisionInput }; result: { decision: RouteDecision } };
  /** Recorded decisions, newest first; `overridden` filters; `before` (an id) pages. `total` counts the filter's matches. */
  'route.decisions': {
    params: { limit?: number; before?: string; overridden?: boolean };
    result: { decisions: RouteDecision[]; total: number };
  };
  /** Routing rules (knowledge.md §9.3), tried in order; the first that matches applies. `set` replaces the list. */
  'route.rules.get': { params: Empty; result: { rules: RoutingRule[] } };
  'route.rules.set': { params: { rules: RoutingRule[] }; result: { rules: RoutingRule[] } };

  // ---- pipelines (docs/pipelines.md, spec §12.4); one machine: every stage runs on the workspace's node
  /** Newest first; `workspaceId` narrows to pipelines started there. */
  'pipelines.list': { params: MachineTarget & { workspaceId?: string }; result: { pipelines: PipelineInfo[] } };
  /** Validate the definition and start stage 1 (or wait at its gate). `title` defaults to the task's first line. */
  'pipeline.start': { params: { workspaceId: string; spec: PipelineSpec; task: string; title?: string }; result: { pipeline: PipelineInfo } };
  'pipeline.get': { params: MachineTarget & { pipelineId: string }; result: { pipeline: PipelineInfo } };
  /** Answer the pending gate: approve starts the stage (`message` becomes `{{gate.message}}`), reject cancels the run. */
  'pipeline.gate': {
    params: MachineTarget & { pipelineId: string; decision: 'approve' | 'reject'; message?: string };
    result: { pipeline: PipelineInfo };
  };
  /** Stop the running stage's session and end the run as cancelled. */
  'pipeline.cancel': { params: MachineTarget & { pipelineId: string }; result: { pipeline: PipelineInfo } };
  /** Forget a run that isn't running or waiting; its sessions and worktree are kept. */
  'pipeline.delete': { params: MachineTarget & { pipelineId: string }; result: Empty };

  // ---- container workspaces (topology.md §7)
  /**
   * A workspace of kind 'container' around a directory on the machine (adopted, or created with
   * `create`). Nothing starts yet: the container is created and started by the first session. The image
   * is `image`, else the repo's devcontainer.json, else bizzi's workspace image. `notes` lists
   * devcontainer.json settings that were ignored.
   */
  'container.create': {
    params: MachineTarget & {
      path: string;
      name?: string;
      create?: boolean;
      image?: string;
      /** `bridge` (default), `none`, or a Docker network name. */
      network?: string;
      mounts?: ContainerMount[];
      /** Replaces the default list of forwarded credential variables. */
      passEnv?: string[];
      user?: string;
      lifecycle?: ContainerLifecycle;
      idleMinutes?: number;
    };
    result: { workspace: WorkspaceInfo; notes?: string[] };
  };
  'container.status': { params: { workspaceId: string }; result: { container: ContainerStatus } };
  /** Stop the container now. Refuses while sessions are live unless `force` (which ends their agents). */
  'container.stop': { params: { workspaceId: string; force?: boolean }; result: { container: ContainerStatus } };

  // ---- cross-machine work (spec §12.4, topology.md §6; node → hub requests, hub.ts)
  /**
   * Fork a session onto another machine: push the workspace state (git branch plus uncommitted changes,
   * or a shadow-git snapshot of a plain directory) to `toMachineId` and start a new session there seeded
   * with a brief from this session's timeline. Served by the session's node; needs its hub link. Without
   * a target, a git workspace lands in the target's workspace linked to this one (same project or
   * `origin`) as a worktree on `branch` (default `fork/<source branch>-<id>`).
   */
  'session.forkTo': {
    params: ForkTarget & {
      sessionId: string;
      toMachineId: string;
      /** Default: the source session's agent. */
      agent?: AgentKind;
      title?: string;
      /** Appended to the brief as the next instruction. */
      prompt?: string;
      branch?: string;
    };
    result: { session: SessionInfo; workspace: WorkspaceInfo; transfer: ForkTransfer };
  };
  /**
   * Node-to-node, through the hub (`caller` stamped by the hub): start a helper whose parent runs on the
   * caller's machine. Same guardrails as a local helper, applied with this machine's settings.
   */
  'helper.start': {
    params: MachineTarget & { caller?: NodeCaller; parent: HelperParent; request: HelperStartRequest };
    result: HelperStartResult;
  };
  /** The other helper tools for a cross-machine helper; only its parent (`parentId` on `caller`) may use them. */
  'helper.send': {
    params: MachineTarget & { caller?: NodeCaller; sessionId: string; parentId: string; input: InputBlock[] };
    result: { turnId: string };
  };
  'helper.interrupt': { params: MachineTarget & { caller?: NodeCaller; sessionId: string; parentId: string }; result: Empty };
  'helper.stop': { params: MachineTarget & { caller?: NodeCaller; sessionId: string; parentId: string }; result: Empty };
  'helper.wait': {
    params: MachineTarget & { caller?: NodeCaller; sessionId: string; parentId: string; until?: HelperWaitUntil; timeoutMs?: number };
    result: HelperWaitResult;
  };
  'helper.read': {
    params: MachineTarget & {
      caller?: NodeCaller;
      sessionId: string;
      parentId: string;
      since?: number;
      maxTokens?: number;
      detail?: 'summary' | 'full' | 'diff';
      path?: string;
    };
    result: HelperReadResult;
  };
  /**
   * Fork step 1 on the target: resolve where the fork lands and what the source may leave out of the
   * bundle (`heads`: commits the target repository already has).
   */
  'fork.prepare': {
    params: MachineTarget & ForkTarget & { caller?: NodeCaller; source: ForkSource; agent: AgentKind };
    result: { workspaceId?: string; path?: string; heads: string[] };
  };
  /** Fork step 2 on the target: apply the bundle, create the workspace or worktree, start the session with `brief`. */
  'fork.receive': {
    params: MachineTarget &
      ForkTarget & {
        caller?: NodeCaller;
        source: ForkSource;
        transfer: ForkTransfer;
        /** The git bundle (base64), absent when the target already has `transfer.commit`. */
        bundleBase64?: string;
        /** The ref inside the bundle that points at `transfer.commit`. */
        bundleRef?: string;
        session: ForkSessionSpec;
        brief: string;
      };
    result: { session: SessionInfo; workspace: WorkspaceInfo };
  };

  // ---- hub only (see hub.ts for the HTTP pairing/auth API)
  /** Create a one-time pairing code for a new device or node. */
  'pairing.create': {
    params: { kind: DeviceKind; name?: string };
    result: { code: string; expiresAt: string; pairUrl: string };
  };
  'devices.list': { params: Empty; result: { devices: DeviceInfo[] } };
  'device.revoke': { params: { deviceId: string }; result: Empty };
  /** Custom themes (theming.md §5). Hub-stored so every device sees them; a node stores them locally. */
  'themes.list': { params: Empty; result: { themes: ThemeFile[] } };
  'theme.save': { params: { id?: string; name: string; data: unknown }; result: { theme: ThemeFile } };
  'theme.delete': { params: { id: string }; result: Empty };
  /** User-wide preferences (theme choice, density); hub-local like themes.*. `prefs.set` merges and emits `prefs.updated`. */
  'prefs.get': { params: Empty; result: { prefs: UserPrefs } };
  'prefs.set': { params: { prefs: Partial<UserPrefs> }; result: { prefs: UserPrefs } };

  // ---- Web Push (tech-choices.md D9; hub only, paired devices)
  /** The hub's VAPID public key (base64url), the `applicationServerKey` for `pushManager.subscribe`. */
  'push.config': { params: Empty; result: { webPush: { publicKey: string } } };
  /** Register (or move to this device) a browser push subscription; replaces any row with the same endpoint. */
  'push.register': { params: { subscription: WebPushSubscription; name?: string }; result: Empty };
  'push.unregister': { params: { endpoint: string }; result: Empty };
  /** Send a test notification to this device's subscriptions. */
  'push.test': { params: Empty; result: { sent: number; failed: number } };
}

export type MethodName = keyof Methods;
export type MethodParams<M extends MethodName> = Methods[M]['params'];
export type MethodResult<M extends MethodName> = Methods[M]['result'];
