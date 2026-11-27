import { NO_CAPABILITIES } from '@bizzi/protocol';
import type { AccountUsage, AgentCapabilities, AgentListing, ContextUsage, MachineInfo, SessionInfo, WidgetValue, WorkspaceInfo } from '@bizzi/protocol';

export const MACHINE: MachineInfo = {
  id: 'm_laptop',
  name: 'this laptop',
  hostname: 'mbp-dev.local',
  os: 'darwin',
  arch: 'arm64',
  headful: true,
  alwaysOn: false,
  tags: ['prod-access'],
  color: 'blue',
  description: 'Work laptop with production access (kube contexts, VPN). Production investigations happen here.',
  online: true,
  roles: ['node'],
  bizziVersion: '0.0.1-mock',
  // Held awake on the power adapter while a turn runs (spec §8.1).
  keepAwake: { supported: true, settings: { mode: 'turns', onBattery: false }, active: true, since: new Date(Date.now() - 4 * 60_000).toISOString(), turns: 1, background: 0, power: 'ac' },
};

/** server-a: offline in the demo (its data comes from the hub's replica). */
export const SERVER: MachineInfo = {
  id: 'm_server',
  name: 'server-a',
  hostname: 'server-a.lan',
  os: 'linux',
  arch: 'x64',
  headful: false,
  alwaysOn: true,
  tags: ['docker'],
  color: 'orange',
  online: false,
  roles: ['node'],
  bizziVersion: '0.0.1',
  // No keep-awake backend on Linux yet: the setting shows as unavailable.
  keepAwake: { supported: false, settings: { mode: 'turns', onBattery: false }, active: false, turns: 0, background: 0 },
};

/** mac-mini: an always-on second Mac (online), where Codex runs a version newer than bizzi tested. */
export const MINI: MachineInfo = {
  id: 'm_mini',
  name: 'mac-mini',
  hostname: 'mac-mini.local',
  os: 'darwin',
  arch: 'arm64',
  headful: true,
  alwaysOn: true,
  tags: ['gui', 'xcode'],
  color: 'green',
  description: 'Always-on Mac for Xcode builds, simulators and screenshots. No production access.',
  online: true,
  roles: ['node'],
  bizziVersion: '0.0.1-mock',
  keepAwake: { supported: true, settings: { mode: 'turns_and_background', onBattery: true }, active: true, since: new Date(Date.now() - 25 * 60_000).toISOString(), turns: 0, background: 1, power: 'ac' },
};

/** What each demo machine is doing, for keep-awake in mock `machine.set` (mac-mini watches a CI run). */
export const MOCK_KEEP_AWAKE_WORK: Record<string, { turns: number; background: number }> = {
  m_laptop: { turns: 1, background: 0 },
  m_mini: { turns: 0, background: 1 },
};

export const OTHER_MACHINES: MachineInfo[] = [SERVER, MINI];

/** The hub's own host (hello.machine in hub mode); not a node. */
export const HUB_MACHINE: MachineInfo = {
  id: 'm_hub',
  name: 'home hub',
  hostname: 'hub.example.com',
  os: 'linux',
  arch: 'x64',
  headful: false,
  alwaysOn: true,
  tags: [],
  online: true,
  roles: ['hub'],
  bizziVersion: '0.0.1-mock',
};

export const HUB_ORIGIN = 'https://hub.example.com';
/** Setup code accepted by the mock hub's /api/pair. */
export const MOCK_SETUP_CODE = 'DEMO-1234';

const CLAUDE_CAPS: AgentCapabilities = {
  ...NO_CAPABILITIES,
  modes: ['structured', 'terminal'],
  streaming: 'token',
  steer: true,
  interrupt: true,
  fork: true,
  resume: true,
  resumeAfterNodeRestart: true,
  approvals: 'per-tool',
  editableApprovals: true,
  permissionModes: ['default', 'acceptEdits', 'plan', 'bypassPermissions'],
  models: ['opus', 'sonnet', 'haiku'],
  setModelMidSession: true,
  effort: ['low', 'medium', 'high', 'max'],
  planMode: true,
  todos: true,
  subagents: true,
  slashCommands: true,
  skills: true,
  images: true,
  mcpInjection: 'launch',
  instructionInjection: 'system-append',
  usage: 'tokens+cost',
  terminal: true,
  questions: true,
};

const CODEX_CAPS: AgentCapabilities = {
  ...NO_CAPABILITIES,
  modes: ['structured', 'terminal'],
  streaming: 'token',
  steer: false,
  interrupt: true,
  resume: true,
  resumeAfterNodeRestart: true,
  approvals: 'per-command',
  editableApprovals: false,
  permissionModes: ['untrusted', 'on-request', 'never'],
  models: 'dynamic',
  setModelMidSession: true,
  effort: ['minimal', 'low', 'medium', 'high'],
  todos: true,
  mcpInjection: 'config-file',
  instructionInjection: 'file',
  usage: 'tokens',
  terminal: true,
};

const OPENCODE_CAPS: AgentCapabilities = {
  ...NO_CAPABILITIES,
  modes: ['structured'],
  streaming: 'token',
  interrupt: true,
  resume: true,
  approvals: 'per-tool',
  permissionModes: ['build', 'plan'],
  models: 'dynamic',
  setModelMidSession: true,
  usage: 'tokens+cost',
};

const TERMINAL_CAPS: AgentCapabilities = { ...NO_CAPABILITIES, modes: ['terminal'], interrupt: true, terminal: true };

export const AGENTS: AgentListing[] = [
  {
    agent: 'claude',
    installed: true,
    path: '/opt/homebrew/bin/claude',
    realPath: '/opt/homebrew/Caskroom/claude-code/2.4.1/claude',
    method: 'brew',
    preferredMethod: 'installer',
    version: '2.4.1',
    latestVersion: '2.4.3',
    auth: 'ok',
    account: 'dev@example.com (Max)',
    billing: 'plan',
    support: 'ok',
    remedies: [{ kind: 'migrate', title: 'Switch to the native installer', method: 'installer' }],
    notes: ['Installed with Homebrew: it does not update itself.'],
    updatePolicy: 'notify',
    restartPolicy: 'when-idle',
    staleSessions: 1,
    capabilities: CLAUDE_CAPS,
  },
  {
    agent: 'codex',
    installed: true,
    path: '/opt/homebrew/bin/codex',
    method: 'brew',
    preferredMethod: 'brew',
    version: '0.98.0',
    auth: 'expired',
    billing: 'plan',
    support: 'ok',
    notes: ['login expired 3 days ago'],
    updatePolicy: 'auto',
    restartPolicy: 'when-idle',
    capabilities: CODEX_CAPS,
  },
  {
    agent: 'opencode',
    installed: true,
    path: '/usr/local/bin/opencode',
    method: 'script',
    preferredMethod: 'script',
    version: '1.3.2',
    latestVersion: '2.1.0',
    auth: 'ok',
    billing: 'budgetless',
    support: 'unsupported',
    supportReason: 'OpenCode v1 is not supported; bizzi drives v2 only.',
    remedies: [
      { kind: 'upgrade', id: 'major', title: 'Upgrade to v2', command: 'opencode upgrade --major' },
      { kind: 'upgrade', id: 'v2-installer', title: 'Upgrade to v2 with the v2 installer', method: 'script', command: 'curl -fsSL https://opencode.ai/v2/install | bash -s -- --no-modify-path' },
    ],
    updatePolicy: 'notify',
    restartPolicy: 'ask',
    capabilities: OPENCODE_CAPS,
  },
  { agent: 'agy', installed: false, auth: 'missing', notes: ['not installed'] },
  { agent: 'shell', installed: true, path: '/bin/zsh', version: '5.9', auth: 'ok', capabilities: TERMINAL_CAPS },
];

/** server-a's agents (shown from the cache while it is offline). */
export const SERVER_AGENTS: AgentListing[] = [
  { agent: 'claude', installed: true, path: '/home/dev/.local/bin/claude', version: '2.4.3', latestVersion: '2.4.3', auth: 'ok', account: 'dev@example.com (Max)', capabilities: CLAUDE_CAPS },
  { agent: 'codex', installed: false, auth: 'missing' },
  { agent: 'opencode', installed: false, auth: 'missing' },
  { agent: 'agy', installed: false, auth: 'missing', notes: ['headless: needs a Gemini API key'] },
  { agent: 'shell', installed: true, path: '/bin/bash', version: '5.2', auth: 'ok', capabilities: TERMINAL_CAPS },
];

/** mac-mini's agents: Claude via the native installer, Codex newer than the tested range. */
export const MINI_AGENTS: AgentListing[] = [
  { agent: 'claude', installed: true, path: '/Users/dev/.local/bin/claude', method: 'installer', preferredMethod: 'installer', version: '2.4.3', latestVersion: '2.4.3', auth: 'ok', account: 'dev@example.com (Max)', billing: 'plan', support: 'ok', updatePolicy: 'auto', restartPolicy: 'when-idle', capabilities: CLAUDE_CAPS },
  {
    agent: 'codex',
    installed: true,
    path: '/opt/homebrew/bin/codex',
    method: 'brew',
    preferredMethod: 'brew',
    version: '0.101.0',
    auth: 'ok',
    account: 'dev@example.com (ChatGPT Pro)',
    billing: 'plan',
    support: 'untested',
    supportReason: 'Newer than the range bizzi was tested with (up to 0.99).',
    updatePolicy: 'auto',
    restartPolicy: 'when-idle',
    capabilities: CODEX_CAPS,
  },
  { agent: 'opencode', installed: false, auth: 'missing' },
  { agent: 'agy', installed: false, auth: 'missing' },
  { agent: 'shell', installed: true, path: '/bin/zsh', version: '5.9', auth: 'ok', capabilities: TERMINAL_CAPS },
];

export const AGENTS_BY_MACHINE: Record<string, AgentListing[]> = { m_laptop: AGENTS, m_server: SERVER_AGENTS, m_mini: MINI_AGENTS };

export const CAPS_BY_AGENT: Record<string, AgentCapabilities> = {
  claude: CLAUDE_CAPS,
  codex: CODEX_CAPS,
  opencode: OPENCODE_CAPS,
  agy: TERMINAL_CAPS,
  shell: TERMINAL_CAPS,
};

const T0 = Date.parse('2026-11-05T09:00:00Z');
export const iso = (offsetMin: number): string => new Date(T0 + offsetMin * 60_000).toISOString();

export const WORKSPACES: WorkspaceInfo[] = [
  { id: 'w_acme', machineId: MACHINE.id, name: 'acme-shop', path: '/Users/dev/src/acme-shop', kind: 'git', projectId: 'p_acme', color: 'purple', createdAt: iso(-60 * 24 * 7) },
  { id: 'w_notes', machineId: MACHINE.id, name: 'research-notes', path: '/Users/dev/research/notes', kind: 'dir', icon: '📚', createdAt: iso(-60 * 24 * 2) },
  { id: 'w_infra', machineId: SERVER.id, name: 'infra', path: '/srv/infra', kind: 'git', createdAt: iso(-60 * 24 * 30) },
  {
    id: 'w_acme_oauth',
    machineId: MACHINE.id,
    name: 'acme-shop · feat/oauth',
    path: '/Users/dev/src/acme-shop.worktrees/feat-oauth',
    kind: 'worktree',
    parentWorkspaceId: 'w_acme',
    branch: 'feat/oauth',
    projectId: 'p_acme',
    createdAt: iso(-40),
  },
  // Worktrees of the OAuth lead's helpers (they show as branch chips on the helpers' rows, not as nodes), one
  // you started a session in yourself, and a leftover nothing uses.
  {
    id: 'w_acme_awake',
    machineId: MACHINE.id,
    name: 'acme-shop · feat/keep-awake',
    path: '/Users/dev/src/acme-shop.worktrees/feat-keep-awake',
    kind: 'worktree',
    parentWorkspaceId: 'w_acme',
    branch: 'feat/keep-awake',
    projectId: 'p_acme',
    createdAt: iso(-35),
  },
  {
    id: 'w_acme_tools',
    machineId: MACHINE.id,
    name: 'acme-shop · feat/session-tools',
    path: '/Users/dev/src/acme-shop.worktrees/feat-session-tools',
    kind: 'worktree',
    parentWorkspaceId: 'w_acme',
    branch: 'feat/session-tools',
    projectId: 'p_acme',
    createdAt: iso(-34),
  },
  {
    id: 'w_acme_cart',
    machineId: MACHINE.id,
    name: 'acme-shop · feat/cart-redesign',
    path: '/Users/dev/src/acme-shop.worktrees/feat-cart-redesign',
    kind: 'worktree',
    parentWorkspaceId: 'w_acme',
    branch: 'feat/cart-redesign',
    projectId: 'p_acme',
    createdAt: iso(-60 * 6),
  },
  {
    id: 'w_acme_spike',
    machineId: MACHINE.id,
    name: 'acme-shop · spike/old-cache',
    path: '/Users/dev/src/acme-shop.worktrees/spike-old-cache',
    kind: 'worktree',
    parentWorkspaceId: 'w_acme',
    branch: 'spike/old-cache',
    projectId: 'p_acme',
    createdAt: iso(-60 * 24 * 3),
  },
  { id: 'w_ext', machineId: MINI.id, name: 'extensions', path: '/Users/dev/src/extensions', kind: 'git', createdAt: iso(-60 * 24 * 12) },
];

/** git.status per workspace (spec §11.1 row 1 branch/dirty and row 3 ahead/behind). */
export const GIT_STATUS: Record<string, { branch: string; ahead: number; behind: number; files: { path: string; status: string }[] }> = {
  w_acme: {
    branch: 'fix/flaky-checkout',
    ahead: 1,
    behind: 0,
    files: [
      { path: 'src/checkout/checkout.spec.ts', status: ' M' },
      { path: 'notes.txt', status: '??' },
    ],
  },
  w_acme_oauth: { branch: 'feat/oauth', ahead: 3, behind: 1, files: [{ path: 'src/auth/oauth.ts', status: 'A ' }] },
  w_acme_awake: { branch: 'feat/keep-awake', ahead: 1, behind: 0, files: [{ path: 'src/power/caffeinate.ts', status: 'A ' }] },
  w_acme_tools: { branch: 'feat/session-tools', ahead: 2, behind: 0, files: [] },
  w_acme_cart: { branch: 'feat/cart-redesign', ahead: 4, behind: 0, files: [] },
  w_acme_spike: { branch: 'spike/old-cache', ahead: 0, behind: 6, files: [] },
  w_infra: { branch: 'main', ahead: 0, behind: 0, files: [] },
  w_ext: { branch: 'main', ahead: 0, behind: 2, files: [] },
};

export const SESSIONS: SessionInfo[] = [
  {
    id: 's_demo',
    machineId: MACHINE.id,
    workspaceId: 'w_acme',
    agent: 'claude',
    mode: 'structured',
    status: 'idle',
    title: 'Fix flaky checkout test',
    // Turn over, but a background command is still running: the sidebar shows it as active (turning dotted ring).
    background: [
      { id: 'bg_ci', kind: 'shell', description: 'Wait for PR checks to finish' },
      { id: 'bg_logs', kind: 'shell', description: 'Tail the checkout test log' },
    ],
    model: 'opus',
    permissionMode: 'default',
    effort: 'high',
    agentVersion: '2.4.0',
    billing: 'plan',
    createdAt: iso(-30),
    updatedAt: iso(-2),
    lastSeq: 0,
  },
  {
    id: 's_review',
    machineId: MACHINE.id,
    workspaceId: 'w_acme',
    agent: 'codex',
    mode: 'structured',
    status: 'waiting_approval',
    title: 'Refactor payment retries',
    model: 'gpt-5.5-codex',
    permissionMode: 'on-request',
    effort: 'medium',
    agentVersion: '0.98.0',
    billing: 'plan',
    createdAt: iso(-90),
    updatedAt: iso(-5),
    lastSeq: 0,
  },
  {
    id: 's_term',
    machineId: MACHINE.id,
    workspaceId: 'w_acme',
    agent: 'shell',
    mode: 'terminal',
    status: 'running',
    title: 'zsh',
    createdAt: iso(-15),
    updatedAt: iso(-1),
    lastSeq: 0,
  },
  {
    id: 's_plan',
    machineId: MACHINE.id,
    workspaceId: 'w_acme',
    agent: 'claude',
    mode: 'structured',
    status: 'waiting_input',
    title: 'Plan the auth migration',
    model: 'sonnet',
    permissionMode: 'plan',
    agentVersion: '2.4.1',
    billing: 'plan',
    createdAt: iso(-12),
    updatedAt: iso(-3),
    lastSeq: 0,
  },
  // Closed: listed under the sidebar's "Ended (1)" in acme, and reopenable.
  {
    id: 's_old',
    machineId: MACHINE.id,
    workspaceId: 'w_acme',
    agent: 'claude',
    mode: 'structured',
    status: 'ended',
    title: 'Bump eslint to v10',
    model: 'sonnet',
    agentVersion: '2.4.0',
    billing: 'plan',
    createdAt: iso(-60 * 30),
    updatedAt: iso(-60 * 28),
    lastSeq: 0,
  },
  {
    id: 's_infra',
    machineId: SERVER.id,
    workspaceId: 'w_infra',
    agent: 'claude',
    mode: 'structured',
    status: 'idle',
    title: 'Upgrade Postgres to 17',
    model: 'opus',
    createdAt: iso(-60 * 5),
    updatedAt: iso(-60 * 2.2),
    lastSeq: 0,
  },
  {
    id: 's_notes',
    machineId: MACHINE.id,
    workspaceId: 'w_notes',
    agent: 'opencode',
    mode: 'structured',
    status: 'idle',
    title: 'Summarize papers on CRDTs',
    billing: 'budgetless',
    createdAt: iso(-60 * 26),
    updatedAt: iso(-60 * 25),
    lastSeq: 0,
  },
  // Agent-to-agent (spec §12.1): a Claude parent with two helpers, one in a worktree.
  {
    id: 's_lead',
    machineId: MACHINE.id,
    workspaceId: 'w_acme',
    agent: 'claude',
    mode: 'structured',
    status: 'running',
    title: 'Implement OAuth login',
    model: 'opus',
    permissionMode: 'acceptEdits',
    agentVersion: '2.4.1',
    billing: 'plan',
    budget: { usd: 5 },
    depth: 0,
    createdAt: iso(-40),
    updatedAt: iso(-1),
    lastSeq: 0,
  },
  {
    id: 's_helper_review',
    machineId: MACHINE.id,
    workspaceId: 'w_acme_oauth',
    agent: 'codex',
    mode: 'structured',
    status: 'waiting_input',
    title: 'Review the OAuth change',
    model: 'gpt-5.5-codex',
    agentVersion: '0.98.0',
    billing: 'metered',
    budget: { usd: 2 },
    spawnedBy: 's_lead',
    scope: 'child',
    depth: 1,
    createdAt: iso(-30),
    updatedAt: iso(-4),
    lastSeq: 0,
  },
  {
    id: 's_helper_explore',
    machineId: MACHINE.id,
    workspaceId: 'w_acme',
    agent: 'opencode',
    mode: 'structured',
    status: 'idle',
    title: 'Map the session middleware',
    model: 'qwen3.8-27b (h200)',
    billing: 'budgetless',
    spawnedBy: 's_lead',
    scope: 'child',
    depth: 1,
    createdAt: iso(-29),
    updatedAt: iso(-20),
    lastSeq: 0,
  },
  // More of the lead's helpers in worktrees: one working with a helper of its own, one that has ended.
  {
    id: 's_helper_awake',
    machineId: MACHINE.id,
    workspaceId: 'w_acme_awake',
    agent: 'claude',
    mode: 'structured',
    status: 'running',
    title: 'Keep the Mac awake while agents work',
    model: 'sonnet',
    billing: 'plan',
    spawnedBy: 's_lead',
    scope: 'child',
    depth: 1,
    createdAt: iso(-28),
    updatedAt: iso(-1),
    lastSeq: 0,
  },
  {
    id: 's_helper_awake_tests',
    machineId: MACHINE.id,
    workspaceId: 'w_acme_awake',
    agent: 'codex',
    mode: 'structured',
    status: 'idle',
    title: 'Write tests for the power assertion',
    model: 'gpt-5.5-codex',
    billing: 'plan',
    spawnedBy: 's_helper_awake',
    scope: 'child',
    depth: 2,
    createdAt: iso(-20),
    updatedAt: iso(-6),
    lastSeq: 0,
  },
  {
    id: 's_helper_tools',
    machineId: MACHINE.id,
    workspaceId: 'w_acme_tools',
    agent: 'opencode',
    mode: 'structured',
    status: 'ended',
    title: 'Session history tools',
    billing: 'budgetless',
    spawnedBy: 's_lead',
    scope: 'child',
    depth: 1,
    createdAt: iso(-27),
    updatedAt: iso(-15),
    lastSeq: 0,
  },
  // Started by you in a worktree: listed under that worktree.
  {
    id: 's_cart',
    machineId: MACHINE.id,
    workspaceId: 'w_acme_cart',
    agent: 'claude',
    mode: 'structured',
    status: 'idle',
    title: 'Redesign the cart drawer',
    model: 'opus',
    billing: 'plan',
    createdAt: iso(-60 * 6),
    updatedAt: iso(-60 * 4),
    lastSeq: 0,
  },
  {
    id: 's_ext',
    machineId: MINI.id,
    workspaceId: 'w_ext',
    agent: 'codex',
    mode: 'structured',
    status: 'idle',
    title: 'Clean up the theme stylesheet',
    model: 'gpt-5.5-codex',
    agentVersion: '0.101.0',
    billing: 'plan',
    createdAt: iso(-60 * 3),
    updatedAt: iso(-60 * 2),
    lastSeq: 0,
  },
];

/** Sessions whose last turn finished after you last looked (done, not yet seen). */
export const UNSEEN_SESSIONS = new Set(['s_ext']);

// ---------------------------------------------------------------- context, usage, widgets (docs/usage.md)

/** Claude-style breakdown: "71% · compacts at 80%", with bizzi's own overhead as a row. */
export const DEMO_CONTEXT: ContextUsage = {
  used: 142_000,
  window: 200_000,
  usable: 160_000,
  compactAt: 160_000,
  categories: [
    { id: 'system', label: 'System prompt', tokens: 3_100, kind: 'used' },
    { id: 'tools', label: 'System tools', tokens: 14_200, kind: 'used' },
    { id: 'mcp', label: 'MCP tools (6 servers)', tokens: 26_300, kind: 'used' },
    { id: 'bizzi', label: 'bizzi overhead', tokens: 4_300, kind: 'used' },
    { id: 'memory', label: 'Memory files', tokens: 2_400, kind: 'used' },
    { id: 'messages', label: 'Messages', tokens: 91_700, kind: 'used' },
    { id: 'buffer', label: 'Autocompact buffer', tokens: 40_000, kind: 'buffer' },
    { id: 'free', label: 'Free space', tokens: 18_000, kind: 'free' },
  ],
};

export const LEAD_CONTEXT: ContextUsage = {
  used: 48_000,
  window: 200_000,
  usable: 160_000,
  compactAt: 160_000,
  categories: [
    { id: 'system', label: 'System prompt', tokens: 3_100, kind: 'used' },
    { id: 'tools', label: 'System tools', tokens: 14_200, kind: 'used' },
    { id: 'bizzi', label: 'bizzi overhead', tokens: 6_900, kind: 'used' },
    { id: 'messages', label: 'Messages', tokens: 23_800, kind: 'used' },
    { id: 'buffer', label: 'Autocompact buffer', tokens: 40_000, kind: 'buffer' },
    { id: 'free', label: 'Free space', tokens: 112_000, kind: 'free' },
  ],
};

const ago = (min: number): string => new Date(Date.now() - min * 60_000).toISOString();
const ahead = (min: number): string => new Date(Date.now() + min * 60_000).toISOString();

/** Per-login usage (usage.md §3): Claude Max at 62% of its 5-hour window, Codex Pro at 85%, agy's two pools, a metered API key. */
export function mockAccounts(): AccountUsage[] {
  return [
    {
      agent: 'claude',
      accountId: 'dev@example.com',
      label: 'claude · max · dev@…',
      billing: 'plan',
      machines: [MACHINE.id, SERVER.id, MINI.id],
      windows: [
        { id: 'five_hour', label: '5-hour', usedPercent: 62, resetsAt: ahead(80), windowMins: 300 },
        { id: 'seven_day', label: '7-day', usedPercent: 31, resetsAt: ahead(60 * 24 * 3 + 200), windowMins: 10080 },
        { id: 'seven_day_opus', label: '7-day Opus', usedPercent: 44, resetsAt: ahead(60 * 24 * 3 + 200) },
      ],
      status: 'ok',
      observedAt: ago(40),
    },
    {
      agent: 'codex',
      accountId: 'dev@example.com',
      label: 'codex · pro · dev@…',
      billing: 'plan',
      machines: [MACHINE.id, MINI.id],
      windows: [
        { id: 'primary', label: '5-hour', usedPercent: 85, resetsAt: ahead(125), windowMins: 300 },
        { id: 'secondary', label: 'weekly', usedPercent: 40, resetsAt: ahead(60 * 24 * 5), windowMins: 10080 },
      ],
      status: 'warning',
      observedAt: ago(3),
    },
    {
      agent: 'agy',
      accountId: 'dev@example.com',
      label: 'agy · google · dev@example.com',
      billing: 'plan',
      machines: [MACHINE.id],
      windows: [
        { id: 'gemini-weekly', label: 'Gemini · weekly', usedPercent: 17, resetsAt: ahead(60 * 24 * 6 + 1260), windowMins: 10080, group: 'Gemini' },
        { id: 'gemini-5h', label: 'Gemini · 5h', usedPercent: 70, resetsAt: ahead(139), windowMins: 300, group: 'Gemini' },
        { id: '3p-weekly', label: 'Claude and GPT · weekly', usedPercent: 50, resetsAt: ahead(60 * 24 * 6 + 1300), windowMins: 10080, group: 'Claude and GPT' },
        { id: '3p-5h', label: 'Claude and GPT · 5h', usedPercent: 100, resetsAt: ahead(191), windowMins: 300, group: 'Claude and GPT' },
      ],
      status: 'warning',
      observedAt: ago(2),
    },
    {
      agent: 'opencode',
      accountId: 'sk-ant-…a41f',
      label: 'opencode · api key · …a41f',
      billing: 'metered',
      machines: [MACHINE.id],
      spend: { usd: 12.4, period: 'November' },
      status: 'ok',
      observedAt: ago(26),
    },
  ];
}

/** Node-run widgets (usage.md §4): a LiteLLM spend meter, the H200 gateway load, CI, and a failing one. */
export function mockWidgets(): WidgetValue[] {
  return [
    {
      id: 'litellm-billed',
      machineId: MACHINE.id,
      label: 'billed',
      kind: 'meter',
      placement: ['bar'],
      value: 554.2,
      max: 2474,
      format: 'usd',
      tooltip: 'LiteLLM key claude-via-litellm: spend against max_budget',
      resetsAt: ahead(60 * 24 * 12),
      observedAt: ago(1),
    },
    { id: 'h200', machineId: MINI.id, label: 'h200', kind: 'meter', placement: ['bar', 'machine'], value: 3, max: 8, format: 'number', tooltip: 'In-flight requests on the local H200 gateway (vLLM)', observedAt: ago(0) },
    { id: 'ci', machineId: MACHINE.id, label: 'CI', kind: 'status', placement: ['workspace', 'session-header'], text: 'passing', tone: 'ok', tooltip: 'GitHub checks for the current branch', link: 'https://github.com/acme/shop/actions', observedAt: ago(2) },
    { id: 'disk', machineId: MACHINE.id, label: 'disk', kind: 'text', placement: ['machine'], text: '81% used', tone: 'warn', error: 'command timed out after 10s', observedAt: ago(42) },
  ];
}

// ---------------------------------------------------------------- virtual files

export const FILES: Record<string, string> = {
  'README.md': '# acme-shop\n\nA demo storefront.\n\n```sh\nnpm install\nnpm test\n```\n',
  'package.json': JSON.stringify({ name: 'acme-shop', version: '1.4.0', scripts: { test: 'vitest run', dev: 'vite' } }, null, 2) + '\n',
  'notes.txt': 'scratch notes\n',
  'src/checkout/checkout.ts': [
    "import { payments } from '../payments/client';",
    '',
    'export async function submit(orderId: string): Promise<void> {',
    '  const order = await loadOrder(orderId);',
    "  order.status = 'pending';",
    '  await payments.charge(order.total, order.card);',
    "  order.status = 'paid';",
    '  await saveOrder(order);',
    '}',
    '',
  ].join('\n'),
  'src/checkout/checkout.spec.ts': [
    "import { expect, test } from 'vitest';",
    "import { submit } from './checkout';",
    "import { payments } from '../payments/mock';",
    '',
    "test('marks the order paid', async () => {",
    "  await submit('o_1');",
    '  await payments.settled();',
    "  expect(await order('o_1').status()).toBe('paid');",
    '});',
    '',
  ].join('\n'),
  'src/payments/client.ts': "export const payments = {\n  async charge(amount: number, card: string) {\n    return fetch('/api/charge', { method: 'POST', body: JSON.stringify({ amount, card }) });\n  },\n};\n",
  'src/payments/mock.ts': 'let pending = Promise.resolve();\nexport const payments = {\n  charge() {\n    pending = new Promise((r) => setTimeout(r, 0));\n    return pending;\n  },\n  settled: () => pending,\n};\n',
};

export const CHECKOUT_DIFF = [
  'diff --git a/src/checkout/checkout.spec.ts b/src/checkout/checkout.spec.ts',
  'index 3b18e51..a1c2f0d 100644',
  '--- a/src/checkout/checkout.spec.ts',
  '+++ b/src/checkout/checkout.spec.ts',
  '@@ -3,8 +3,8 @@',
  " import { payments } from '../payments/mock';",
  ' ',
  " test('marks the order paid', async () => {",
  "   await submit('o_1');",
  '-  await sleep(50);',
  '+  await payments.settled();',
  "   expect(await order('o_1').status()).toBe('paid');",
  ' });',
  ' ',
  '',
].join('\n');

export const NOTES_DIFF = [
  'diff --git a/notes.txt b/notes.txt',
  'new file mode 100644',
  'index 0000000..8d1c8b6',
  '--- /dev/null',
  '+++ b/notes.txt',
  '@@ -0,0 +1 @@',
  '+scratch notes',
  '',
].join('\n');

export const ASSISTANT_REPLY = `I found the flake. \`checkout.spec.ts\` races the payment mock: the test awaits \`submit()\`, but the mock settles on the **next tick**, so roughly 1 run in 20 reads the order before it is marked paid.

### Fix

1. Await the mock's \`settled()\` promise before asserting.
2. Drop the arbitrary \`sleep(50)\` that only hid the race.

\`\`\`ts
await submit('o_1');
await payments.settled();
expect(await order('o_1').status()).toBe('paid');
\`\`\`

| Run | Before | After |
|---|---|---|
| 100× local | 6 failures | 0 failures |
| CI (3 shards) | flaky | green |

> The production client is unaffected; only the mock resolves asynchronously.

Want me to add a lint rule that flags \`sleep()\` in specs?`;

export const REVIEW_REPLY = `I've split the retry logic out of \`charge()\` into a small \`withRetry()\` helper with exponential backoff and a cap of 3 attempts. Before I run the integration suite I need permission to start the local payment sandbox.`;
