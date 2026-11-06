import { NO_CAPABILITIES } from '@bizzi/protocol';
import type { AgentCapabilities, AgentListing, MachineInfo, SessionInfo, WorkspaceInfo } from '@bizzi/protocol';

export const MACHINE: MachineInfo = {
  id: 'm_laptop',
  name: 'this laptop',
  hostname: 'mbp-dev.local',
  os: 'darwin',
  arch: 'arm64',
  headful: true,
  alwaysOn: false,
  tags: ['gpu'],
  online: true,
  roles: ['node'],
  bizziVersion: '0.0.1-mock',
};

export const OTHER_MACHINES: MachineInfo[] = [
  {
    id: 'm_server',
    name: 'server-a',
    hostname: 'server-a.lan',
    os: 'linux',
    arch: 'x64',
    headful: false,
    alwaysOn: true,
    tags: ['docker'],
    online: true,
    roles: ['node', 'hub'],
    bizziVersion: '0.0.1',
  },
];

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
  { agent: 'claude', installed: true, path: '/opt/homebrew/bin/claude', version: '2.4.1', latestVersion: '2.4.3', auth: 'ok', account: 'dev@example.com (Max)', capabilities: CLAUDE_CAPS },
  { agent: 'codex', installed: true, path: '/opt/homebrew/bin/codex', version: '0.98.0', auth: 'expired', notes: ['login expired 3 days ago'], capabilities: CODEX_CAPS },
  { agent: 'opencode', installed: true, path: '/usr/local/bin/opencode', version: '1.3.2', auth: 'ok', capabilities: OPENCODE_CAPS },
  { agent: 'agy', installed: false, auth: 'missing', notes: ['not installed'] },
  { agent: 'shell', installed: true, path: '/bin/zsh', version: '5.9', auth: 'ok', capabilities: TERMINAL_CAPS },
];

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
  { id: 'w_acme', machineId: MACHINE.id, name: 'acme-shop', path: '/Users/dev/src/acme-shop', kind: 'git', createdAt: iso(-60 * 24 * 7) },
  { id: 'w_notes', machineId: MACHINE.id, name: 'research-notes', path: '/Users/dev/research/notes', kind: 'dir', createdAt: iso(-60 * 24 * 2) },
  { id: 'w_infra', machineId: 'm_server', name: 'infra', path: '/srv/infra', kind: 'git', createdAt: iso(-60 * 24 * 30) },
];

export const SESSIONS: SessionInfo[] = [
  {
    id: 's_demo',
    machineId: MACHINE.id,
    workspaceId: 'w_acme',
    agent: 'claude',
    mode: 'structured',
    status: 'idle',
    title: 'Fix flaky checkout test',
    model: 'opus',
    permissionMode: 'default',
    effort: 'high',
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
    id: 's_notes',
    machineId: MACHINE.id,
    workspaceId: 'w_notes',
    agent: 'opencode',
    mode: 'structured',
    status: 'idle',
    title: 'Summarize papers on CRDTs',
    createdAt: iso(-60 * 26),
    updatedAt: iso(-60 * 25),
    lastSeq: 0,
  },
];

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
