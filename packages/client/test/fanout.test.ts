import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AccountUsage, AgentListing, ContextBaseline, SessionEvent, SessionEventBody, SessionInfo, WidgetValue, WorkspaceInfo } from '@bizzi/protocol';
import {
  emptyTimeline,
  fanoutBranch,
  findBaseline,
  modelPrice,
  preflightRun,
  preflightTotal,
  reduceTimeline,
  selectFanoutGroup,
  selectFanoutGroups,
  startFanout,
} from '../src/index.ts';
import type { BizziState, PreflightContext } from '../src/index.ts';

const T = (min: number): string => new Date(Date.parse('2026-11-10T10:00:00Z') + min * 60_000).toISOString();

function base(over: Partial<ContextBaseline>): ContextBaseline {
  return { machineId: 'm1', agent: 'claude', workspaceId: 'w1', tokens: 20_000, samples: 3, updatedAt: T(0), ...over };
}

const AGENTS: AgentListing[] = [
  { agent: 'claude', installed: true, auth: 'ok', billing: 'plan', support: 'ok' },
  { agent: 'codex', installed: true, auth: 'ok', billing: 'metered', support: 'ok' },
  { agent: 'opencode', installed: true, auth: 'ok', billing: 'budgetless', support: 'ok' },
];

const CLAUDE_PLAN: AccountUsage = {
  agent: 'claude',
  accountId: 'dev@example.com',
  label: 'claude · max',
  billing: 'plan',
  machines: ['m1'],
  windows: [
    { id: 'five_hour', label: '5-hour', usedPercent: 86 },
    { id: 'seven_day', label: '7-day', usedPercent: 30 },
  ],
  status: 'warning',
  observedAt: T(0),
};

const H200: WidgetValue = { id: 'h200', machineId: 'm2', label: 'h200', kind: 'meter', placement: ['bar'], value: 3, max: 8, tooltip: 'In-flight requests on the local H200 gateway' };

function ctx(over: Partial<PreflightContext> = {}): PreflightContext {
  return {
    machineId: 'm1',
    workspaceId: 'w1',
    agents: AGENTS,
    accounts: [CLAUDE_PLAN],
    baselines: [base({ model: 'opus', tokens: 18_000 }), base({ agent: 'codex', model: 'claude-sonnet-5-5', tokens: 14_000 }), base({ agent: 'opencode', model: 'qwen3.8-27b', tokens: 9_000 })],
    widgets: [H200],
    ...over,
  };
}

test('modelPrice: versions before aliases, unknown models have no price', () => {
  assert.equal(modelPrice('opus')?.inputPerMTok, 4);
  assert.equal(modelPrice('claude-opus-5-5')?.inputPerMTok, 4);
  assert.equal(modelPrice('claude-opus-4-8')?.inputPerMTok, 5);
  assert.equal(modelPrice('claude-sonnet-4-6')?.inputPerMTok, 3);
  assert.equal(modelPrice('sonnet')?.inputPerMTok, 2);
  assert.equal(modelPrice('claude-haiku-5-5')?.outputPerMTok, 0.5);
  assert.equal(modelPrice('gpt-5.5-codex'), null);
  assert.equal(modelPrice(undefined), null);
});

test('findBaseline: this workspace first, any model when none given, then elsewhere on the machine', () => {
  const list = [base({ model: 'opus', samples: 2 }), base({ model: 'sonnet', samples: 7, tokens: 11_000 }), base({ model: 'haiku', workspaceId: 'w9', tokens: 5_000 }), base({ machineId: 'm2', model: 'fable' })];
  assert.equal(findBaseline(list, { machineId: 'm1', workspaceId: 'w1', agent: 'claude', model: 'opus' })?.baseline.model, 'opus');
  // No model: the best-sampled one here.
  assert.equal(findBaseline(list, { machineId: 'm1', workspaceId: 'w1', agent: 'claude' })?.baseline.model, 'sonnet');
  const other = findBaseline(list, { machineId: 'm1', workspaceId: 'w1', agent: 'claude', model: 'haiku' });
  assert.equal(other?.elsewhere, true);
  assert.equal(other?.baseline.tokens, 5_000);
  // Other machines never count.
  assert.equal(findBaseline(list, { machineId: 'm1', workspaceId: 'w1', agent: 'claude', model: 'fable' }), null);
  assert.equal(findBaseline(list, { machineId: 'm1', workspaceId: 'w1', agent: 'codex' }), null);
});

test('preflight: plan window above 80% warns, with a budgetless swap', () => {
  const p = preflightRun({ agent: 'claude', model: 'opus' }, ctx());
  assert.equal(p.billing, 'plan');
  assert.equal(p.billingSource, 'probe');
  assert.equal(p.baseline?.tokens, 18_000);
  assert.equal(p.estimate.kind, 'plan');
  assert.equal(p.estimate.kind === 'plan' ? p.estimate.window?.usedPercent : 0, 86);
  assert.ok(p.warnings.some((w) => /5-hour window at 86%/.test(w)));
  assert.deepEqual(p.swap, { agent: 'opencode', model: 'qwen3.8-27b' });
});

test('preflight: metered estimate = baseline × built-in input price; tree and run budgets warn', () => {
  const p = preflightRun({ agent: 'codex', model: 'claude-sonnet-5-5', budgetUsd: 0.01 }, ctx({ treeBudgetUsd: 0.02 }));
  assert.equal(p.billing, 'metered');
  assert.equal(p.estimate.kind, 'metered');
  // 14k × $2 / MTok
  assert.ok(p.estimate.kind === 'metered' && Math.abs(p.estimate.usdPerTurn - 0.028) < 1e-9);
  assert.ok(p.warnings.some((w) => /exceeds the tree budget of \$0.02/.test(w)));
  assert.ok(p.warnings.some((w) => /exceeds this run's budget of \$0.01/.test(w)));

  // No baseline, or no price: no estimate rather than a guess.
  const nb = preflightRun({ agent: 'codex', model: 'claude-opus-5-5' }, ctx());
  assert.deepEqual(nb.estimate, { kind: 'metered-unknown', reason: 'no baseline yet' });
  const np = preflightRun({ agent: 'codex', model: 'gpt-5.5-codex' }, ctx({ baselines: [base({ agent: 'codex', model: 'gpt-5.5-codex' })] }));
  assert.equal(np.estimate.kind, 'metered-unknown');
  assert.match(np.estimate.kind === 'metered-unknown' ? np.estimate.reason : '', /no built-in price for gpt-5.5-codex/);

  const total = preflightTotal([p, nb, preflightRun({ agent: 'opencode' }, ctx())]);
  assert.ok(Math.abs(total.usdPerTurn - 0.028) < 1e-9);
  assert.equal(total.partial, true);
});

test('preflight: budgetless is free with gateway load; no swap offered; billing from the account when unprobed', () => {
  const p = preflightRun({ agent: 'opencode' }, ctx());
  assert.equal(p.billing, 'budgetless');
  assert.deepEqual(p.estimate, { kind: 'free', load: H200 });
  assert.equal(p.swap, null);
  assert.deepEqual(p.warnings, []);

  const noProbe = preflightRun({ agent: 'claude' }, ctx({ agents: [{ agent: 'claude', installed: true, auth: 'ok' }] }));
  assert.equal(noProbe.billing, 'plan');
  assert.equal(noProbe.billingSource, 'account');
  assert.equal(noProbe.swap, null, 'no budgetless agent installed: nothing to swap to');

  const unknown = preflightRun({ agent: 'agy' }, ctx());
  assert.equal(unknown.estimate.kind, 'unknown');
  assert.ok(unknown.warnings.some((w) => /not installed/.test(w)));
});

test('fanoutBranch', () => {
  assert.equal(fanoutBranch('main-fanout', 2, 'codex'), 'main-fanout-2-codex');
  assert.equal(fanoutBranch('try/', 1, 'claude'), 'try-1-claude');
});

test('startFanout: one worktree and session per run, same group and prompt; failures stay per run', async () => {
  const calls: string[] = [];
  let n = 0;
  const fake = {
    async createWorktree(p: { workspaceId: string; branch: string; base?: string }): Promise<WorkspaceInfo> {
      calls.push(`wt ${p.branch}${p.base ? ` from ${p.base}` : ''}`);
      if (p.branch.endsWith('agy')) throw new Error('branch exists');
      return { id: `w_${p.branch}`, machineId: 'm1', name: p.branch, path: `/x/${p.branch}`, kind: 'worktree', parentWorkspaceId: 'w1', branch: p.branch, createdAt: T(0) };
    },
    async createSession(p: { workspaceId: string; agent: SessionInfo['agent']; group?: string; title?: string; model?: string; budget?: { usd?: number } }): Promise<SessionInfo> {
      calls.push(`session ${p.workspaceId} ${p.agent} ${p.group} ${p.model ?? '-'} ${p.budget?.usd ?? '-'} "${p.title}"`);
      return { id: `s${++n}`, machineId: 'm1', workspaceId: p.workspaceId, agent: p.agent, mode: 'structured', status: 'idle', createdAt: T(0), updatedAt: T(0), lastSeq: 0, ...(p.group ? { group: p.group } : {}) };
    },
    async send(id: string, input: unknown): Promise<{ turnId: string }> {
      calls.push(`send ${id} ${String(input)}`);
      return { turnId: 't' };
    },
  };
  const res = await startFanout(fake as never, {
    workspaceId: 'w1',
    prompt: 'Fix the flaky checkout test',
    branchPrefix: 'main-fanout',
    base: 'main',
    group: 'fo_x',
    runs: [{ agent: 'claude', model: 'opus' }, { agent: 'codex', budgetUsd: 2 }, { agent: 'agy' }],
  });
  assert.equal(res.group, 'fo_x');
  assert.deepEqual(res.runs.map((r) => [r.branch, r.session?.group ?? null, r.error ?? null]), [
    ['main-fanout-1-claude', 'fo_x', null],
    ['main-fanout-2-codex', 'fo_x', null],
    ['main-fanout-3-agy', null, 'branch exists'],
  ]);
  assert.ok(calls.includes('wt main-fanout-1-claude from main'));
  assert.ok(calls.includes('session w_main-fanout-1-claude claude fo_x opus - "Fix the flaky checkout test · 1/3"'));
  assert.ok(calls.includes('session w_main-fanout-2-codex codex fo_x - 2 "Fix the flaky checkout test · 2/3"'));
  assert.equal(calls.filter((c) => c.startsWith('send ') && c.endsWith('Fix the flaky checkout test')).length, 2);
});

function sess(id: string, over: Partial<SessionInfo> = {}): SessionInfo {
  return { id, machineId: 'm1', workspaceId: 'w1', agent: 'claude', mode: 'structured', status: 'idle', createdAt: T(0), updatedAt: T(0), lastSeq: 5, seenThrough: 5, ...over };
}

function ws(id: string, over: Partial<WorkspaceInfo> = {}): WorkspaceInfo {
  return { id, machineId: 'm1', name: id, path: `/src/${id}`, kind: 'git', createdAt: T(0), ...over };
}

function timeline(sessionId: string, bodies: SessionEventBody[]) {
  const events = bodies.map((b, i) => ({ ...b, ch: `session:${sessionId}`, seq: i + 1, ts: T(i) }) as SessionEvent);
  return reduceTimeline(emptyTimeline(sessionId), events);
}

function state(sessions: SessionInfo[], over: Partial<BizziState> = {}): BizziState {
  return {
    version: 1,
    connection: { state: 'open', url: 'x', sessions: 1 } as BizziState['connection'],
    machine: null,
    role: 'node',
    selectedMachineId: 'm1',
    machines: {},
    agents: {},
    machineErrors: {},
    workspaces: {
      w1: ws('w1'),
      wa: ws('wa', { kind: 'worktree', parentWorkspaceId: 'w1', branch: 'main-fanout-1-claude' }),
      wb: ws('wb', { kind: 'worktree', parentWorkspaceId: 'w1', branch: 'main-fanout-2-codex' }),
    },
    sessions: Object.fromEntries(sessions.map((s) => [s.id, s])),
    sessionsLoaded: true,
    capabilities: {},
    timelines: {},
    jobs: {},
    devices: null,
    knowledgeInbox: null,
    knowledgeSettings: null,
    knowledgeRev: 0,
    gaps: {},
    accounts: {},
    usageState: 'ok',
    widgets: {},
    gitStatus: {},
    pipelines: {},
    prefs: null,
    models: {},
    ...over,
  };
}

test('fan-out groups: grouped by session.group under the repo workspace; compare model counts metered spend only', () => {
  const a = sess('sa', { workspaceId: 'wa', group: 'fo_1', title: 'Fix it · 1/2', billing: 'plan', createdAt: T(1) });
  const b = sess('sb', { workspaceId: 'wb', agent: 'codex', group: 'fo_1', title: 'Fix it · 2/2', billing: 'metered', status: 'running', createdAt: T(1) });
  const lone = sess('sc', { title: 'Unrelated' });
  const s = state([a, b, lone], {
    timelines: {
      sa: timeline('sa', [
        { type: 'message.completed', data: { messageId: 'm1', role: 'assistant', text: 'First try' } },
        { type: 'file.changed', data: { path: 'src/x.ts', change: 'modified', diff: '@@ -1 +1 @@\n-a\n+b\n' } },
        { type: 'message.completed', data: { messageId: 'm2', role: 'assistant', text: 'Done: fixed the race.' } },
        { type: 'turn.completed', data: { turnId: 't1', stopReason: 'end_turn', usage: { inputTokens: 1000, outputTokens: 200, costUsd: 0.5 } } },
        { type: 'context.updated', data: { used: 50_000, window: 200_000, usable: 160_000 } },
      ]),
      sb: timeline('sb', [{ type: 'usage.updated', data: { inputTokens: 3000, outputTokens: 100, costUsd: 0.07 } }]),
    },
  });

  const groups = selectFanoutGroups(s);
  assert.deepEqual(groups.map((g) => [g.group, g.title, g.workspaceId, g.sessions.map((x) => x.id)]), [['fo_1', 'Fix it', 'w1', ['sa', 'sb']]]);
  assert.equal(selectFanoutGroups(s, 'w1').length, 1);
  assert.equal(selectFanoutGroups(s, 'w_other').length, 0);

  const g = selectFanoutGroup(s, 'fo_1');
  assert.ok(g);
  const [ra, rb] = g.runs;
  assert.equal(ra?.branch, 'main-fanout-1-claude');
  assert.equal(ra?.finalMessage, 'Done: fixed the race.');
  assert.deepEqual(ra?.files.map((f) => f.path), ['src/x.ts']);
  assert.equal(ra?.tokens, 1200);
  assert.equal(ra?.meteredUsd, undefined, 'plan billing never counts as spend');
  assert.equal(ra?.context, 50_000 / 160_000);
  assert.equal(rb?.state, 'working');
  assert.equal(rb?.meteredUsd, 0.07);
  assert.equal(g.meteredUsd, 0.07);
  assert.equal(g.tokens, 1200 + 3100);
  assert.equal(selectFanoutGroup(s, 'fo_nope'), null);
});
