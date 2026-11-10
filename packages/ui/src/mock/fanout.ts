// Mock fan-out (spec §12) and context baselines (usage.md §2): three runs of the same task in their own
// worktrees of acme-shop (Claude on the plan login, Codex on an API key, OpenCode on the local H200
// gateway), plus learned baselines for the preflight.
import type { ContextBaseline, SessionEventBody, SessionInfo, WorkspaceInfo } from '@bizzi/protocol';
import { MACHINE, MINI, iso } from './fixtures.ts';

export const FANOUT_GROUP = 'fo_checkout';
const PROMPT = 'The checkout spec fails about 1 in 20 runs on CI. Find the race and fix it.';
const BASE = 'fix/flaky-checkout';

function wt(n: number, agent: string, minutes: number): WorkspaceInfo {
  const branch = `${BASE}-fanout-${n}-${agent}`;
  return {
    id: `w_fo${n}`,
    machineId: MACHINE.id,
    name: `acme-shop · ${branch}`,
    path: `/Users/dev/src/acme-shop.worktrees/${branch.replace(/\//g, '-')}`,
    kind: 'worktree',
    parentWorkspaceId: 'w_acme',
    branch,
    projectId: 'p_acme',
    createdAt: iso(minutes),
  };
}

export const FANOUT_WORKSPACES: WorkspaceInfo[] = [wt(1, 'claude', -22), wt(2, 'codex', -22), wt(3, 'opencode', -22)];

function run(n: number, over: Partial<SessionInfo> & Pick<SessionInfo, 'id' | 'agent'>): SessionInfo {
  return {
    machineId: MACHINE.id,
    workspaceId: `w_fo${n}`,
    mode: 'structured',
    status: 'idle',
    title: `Fix the flaky checkout spec · ${n}/3`,
    group: FANOUT_GROUP,
    depth: 0,
    createdAt: iso(-22),
    updatedAt: iso(-6),
    lastSeq: 0,
    ...over,
  };
}

export const FANOUT_SESSIONS: SessionInfo[] = [
  run(1, { id: 's_fo_claude', agent: 'claude', model: 'opus', billing: 'plan' }),
  run(2, { id: 's_fo_codex', agent: 'codex', model: 'gpt-5.5-codex', billing: 'metered', status: 'running', budget: { usd: 3 }, updatedAt: iso(-1) }),
  run(3, { id: 's_fo_opencode', agent: 'opencode', model: 'qwen3.8-27b (h200)', billing: 'budgetless', updatedAt: iso(-9) }),
];

const SPEC_DIFF = [
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
  '',
].join('\n');

const MOCK_DIFF = [
  'diff --git a/src/payments/mock.ts b/src/payments/mock.ts',
  'index 51c0a2e..9e7d3b4 100644',
  '--- a/src/payments/mock.ts',
  '+++ b/src/payments/mock.ts',
  '@@ -1,6 +1,9 @@',
  ' let pending = Promise.resolve();',
  ' export const payments = {',
  '   charge() {',
  '-    pending = new Promise((r) => setTimeout(r, 0));',
  '+    pending = new Promise((r) => queueMicrotask(r));',
  '     return pending;',
  '   },',
  '+  settled() {',
  '+    return pending;',
  '+  },',
  ' };',
  '',
].join('\n');

const RETRY_DIFF = [
  'diff --git a/vitest.config.ts b/vitest.config.ts',
  'index 0c4e1aa..77b2f19 100644',
  '--- a/vitest.config.ts',
  '+++ b/vitest.config.ts',
  '@@ -2,5 +2,6 @@',
  ' export default defineConfig({',
  '   test: {',
  "     environment: 'node',",
  '+    retry: 2,',
  '   },',
  ' });',
  '',
].join('\n');

/** `git diff` per fan-out worktree. */
export const FANOUT_DIFFS: Record<string, string> = {
  w_fo1: SPEC_DIFF + MOCK_DIFF,
  w_fo2: MOCK_DIFF,
  w_fo3: RETRY_DIFF,
};

export const FANOUT_GIT: Record<string, { branch: string; ahead: number; behind: number; files: { path: string; status: string }[] }> = {
  w_fo1: { branch: `${BASE}-fanout-1-claude`, ahead: 0, behind: 0, files: [{ path: 'src/checkout/checkout.spec.ts', status: ' M' }, { path: 'src/payments/mock.ts', status: ' M' }] },
  w_fo2: { branch: `${BASE}-fanout-2-codex`, ahead: 0, behind: 0, files: [{ path: 'src/payments/mock.ts', status: ' M' }] },
  w_fo3: { branch: `${BASE}-fanout-3-opencode`, ahead: 0, behind: 0, files: [{ path: 'vitest.config.ts', status: ' M' }] },
};

/** The runs' history: [sessionId, event, ts]. */
export function fanoutHistory(): [string, SessionEventBody, string][] {
  const out: [string, SessionEventBody, string][] = [];
  let m = -22;
  const at = (): string => iso((m += 0.3));
  const add = (sid: string, body: SessionEventBody): void => {
    out.push([sid, body, at()]);
  };
  const start = (sid: string, model: string, turnId: string): void => {
    add(sid, { type: 'session.info', data: { model } });
    add(sid, { type: 'turn.started', data: { turnId, input: [{ type: 'text', text: PROMPT }] } });
  };

  start('s_fo_claude', 'opus', 't_foc1');
  add('s_fo_claude', { type: 'context.updated', data: { used: 18_900, window: 200_000, usable: 160_000, compactAt: 160_000 } });
  add('s_fo_claude', { type: 'tool.started', data: { toolId: 'tc_foc1', kind: 'edit', name: 'Edit', title: 'src/payments/mock.ts' } });
  add('s_fo_claude', { type: 'tool.completed', data: { toolId: 'tc_foc1', status: 'ok' } });
  add('s_fo_claude', { type: 'file.changed', data: { path: 'src/payments/mock.ts', change: 'modified', diff: MOCK_DIFF } });
  add('s_fo_claude', { type: 'file.changed', data: { path: 'src/checkout/checkout.spec.ts', change: 'modified', diff: SPEC_DIFF } });
  add('s_fo_claude', {
    type: 'message.completed',
    data: { messageId: 'msg_foc1', role: 'assistant', text: 'The mock settled on a timer, so the spec read the order before it was paid. The mock now settles on a microtask and exposes `settled()`, and the spec awaits it instead of sleeping. 200/200 runs pass.' },
  });
  add('s_fo_claude', { type: 'usage.updated', data: { inputTokens: 46_200, outputTokens: 3_400, contextWindow: 200_000 } });
  add('s_fo_claude', { type: 'context.updated', data: { used: 52_300, window: 200_000, usable: 160_000, compactAt: 160_000 } });
  add('s_fo_claude', { type: 'turn.completed', data: { turnId: 't_foc1', stopReason: 'end_turn', usage: { inputTokens: 46_200, outputTokens: 3_400 } } });

  m = -22;
  start('s_fo_codex', 'gpt-5.5-codex', 't_fox1');
  add('s_fo_codex', { type: 'context.updated', data: { used: 14_300, window: 272_000, usable: 245_000 } });
  add('s_fo_codex', { type: 'tool.started', data: { toolId: 'tc_fox1', kind: 'edit', name: 'apply_patch', title: 'src/payments/mock.ts' } });
  add('s_fo_codex', { type: 'tool.completed', data: { toolId: 'tc_fox1', status: 'ok', output: 'Success. Updated 1 file.' } });
  add('s_fo_codex', { type: 'file.changed', data: { path: 'src/payments/mock.ts', change: 'modified', diff: MOCK_DIFF } });
  add('s_fo_codex', { type: 'message.completed', data: { messageId: 'msg_fox1', role: 'assistant', text: 'Patched the payment mock to settle deterministically. Running the spec 100 times now.' } });
  add('s_fo_codex', { type: 'tool.started', data: { toolId: 'tc_fox2', kind: 'shell', name: 'commandExecution', title: 'for i in $(seq 100); do npx vitest run checkout || break; done' } });
  add('s_fo_codex', { type: 'usage.updated', data: { inputTokens: 61_000, outputTokens: 2_900, costUsd: 0.41, contextWindow: 272_000 } });
  add('s_fo_codex', { type: 'context.updated', data: { used: 64_000, window: 272_000, usable: 245_000 } });
  add('s_fo_codex', { type: 'session.status', data: { status: 'running', source: 'adapter' } });

  m = -22;
  start('s_fo_opencode', 'qwen3.8-27b (h200)', 't_foo1');
  add('s_fo_opencode', { type: 'context.updated', data: { used: 9_600, window: 131_072 } });
  add('s_fo_opencode', { type: 'tool.started', data: { toolId: 'tc_foo1', kind: 'edit', name: 'edit', title: 'vitest.config.ts' } });
  add('s_fo_opencode', { type: 'tool.completed', data: { toolId: 'tc_foo1', status: 'ok' } });
  add('s_fo_opencode', { type: 'file.changed', data: { path: 'vitest.config.ts', change: 'modified', diff: RETRY_DIFF } });
  add('s_fo_opencode', {
    type: 'message.completed',
    data: { messageId: 'msg_foo1', role: 'assistant', text: 'I could not reproduce the race reliably, so I enabled `retry: 2` in the vitest config. This hides the flake rather than fixing it.' },
  });
  add('s_fo_opencode', { type: 'usage.updated', data: { inputTokens: 38_000, outputTokens: 1_100, contextWindow: 131_072 } });
  add('s_fo_opencode', { type: 'context.updated', data: { used: 39_100, window: 131_072 } });
  add('s_fo_opencode', { type: 'turn.completed', data: { turnId: 't_foo1', stopReason: 'end_turn', usage: { inputTokens: 38_000, outputTokens: 1_100 } } });
  return out;
}

/** Learned starting context (what the node's baselines.list returns). */
export function mockBaselines(): ContextBaseline[] {
  return [
    { machineId: MACHINE.id, agent: 'claude', model: 'opus', workspaceId: 'w_acme', tokens: 18_400, samples: 8, updatedAt: iso(-22) },
    { machineId: MACHINE.id, agent: 'claude', model: 'sonnet', workspaceId: 'w_acme', tokens: 15_200, samples: 3, updatedAt: iso(-60 * 24) },
    { machineId: MACHINE.id, agent: 'claude', model: 'opus', workspaceId: 'w_notes', tokens: 12_100, samples: 2, updatedAt: iso(-60 * 26) },
    { machineId: MACHINE.id, agent: 'codex', model: 'gpt-5.5-codex', workspaceId: 'w_acme', tokens: 14_100, samples: 6, updatedAt: iso(-22) },
    { machineId: MACHINE.id, agent: 'opencode', model: 'qwen3.8-27b (h200)', workspaceId: 'w_acme', tokens: 9_800, samples: 4, updatedAt: iso(-22) },
    { machineId: MINI.id, agent: 'codex', model: 'gpt-5.5-codex', workspaceId: 'w_ext', tokens: 12_900, samples: 2, updatedAt: iso(-60 * 3) },
  ];
}
