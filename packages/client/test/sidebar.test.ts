import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentListing, SessionEvent, SessionEventBody, SessionInfo, WorkspaceInfo } from '@bizzi/protocol';
import {
  breakdownEqual,
  collapsedCounts,
  emptyTimeline,
  isDoneUnseen,
  machineTotalsLabel,
  reduceTimeline,
  selectHelperTreeModel,
  selectMachineSummary,
  selectMachineWorkspaces,
  selectNestedSessions,
  selectWaitingCount,
  selectWorkspaceBreakdown,
  selectWorkspaceRow,
  sessionContext,
  sessionMarkState,
  workspaceRowEqual,
} from '../src/index.ts';
import type { BizziState, Timeline } from '../src/index.ts';

const T = (min: number): string => new Date(Date.parse('2026-11-10T10:00:00Z') + min * 60_000).toISOString();

function sess(id: string, over: Partial<SessionInfo> = {}): SessionInfo {
  return { id, machineId: 'm1', workspaceId: 'w1', agent: 'claude', mode: 'structured', status: 'idle', createdAt: T(0), updatedAt: T(0), lastSeq: 5, seenThrough: 5, ...over };
}

function ws(id: string, over: Partial<WorkspaceInfo> = {}): WorkspaceInfo {
  return { id, machineId: 'm1', name: id, path: `/src/${id}`, kind: 'git', createdAt: T(0), ...over };
}

function state(sessions: SessionInfo[], over: Partial<BizziState> = {}): BizziState {
  return {
    version: 1,
    connection: { state: 'open', url: 'x', sessions: 1 } as BizziState['connection'],
    machine: null,
    role: 'hub',
    selectedMachineId: 'm1',
    machines: { m1: { id: 'm1', name: 'laptop', hostname: 'l', os: 'darwin', arch: 'arm64', headful: true, alwaysOn: false, tags: [], online: true, roles: ['node'], bizziVersion: '1' } },
    agents: {},
    machineErrors: {},
    workspaces: { w1: ws('w1') },
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

function tl(sessionId: string, bodies: SessionEventBody[]): Timeline {
  const evs = bodies.map((b, i) => ({ ...b, ch: `session:${sessionId}`, seq: i + 1, ts: T(i) }) as SessionEvent);
  return reduceTimeline(emptyTimeline(sessionId), evs);
}

test('mark states: waiting > failed > working > background > done-unseen > idle; ended sessions have no mark', () => {
  const s = state([
    sess('idle'),
    sess('done', { lastSeq: 9, seenThrough: 5 }),
    sess('run', { status: 'running' }),
    sess('fail', { status: 'failed' }),
    sess('wait', { status: 'waiting_approval' }),
    sess('gone', { status: 'ended' }),
    sess('legacy', { lastSeq: 9, seenThrough: undefined }),
    // Between turns with a background command still running; also unseen output, which it outranks.
    sess('bg', { lastSeq: 9, seenThrough: 5, background: [{ id: 't1', kind: 'shell', description: 'Wait for CI' }] }),
    // A running turn stays "working" whatever runs in the background.
    sess('runbg', { status: 'running', background: [{ id: 't2', kind: 'agent', description: 'Review' }] }),
  ]);
  const st = (id: string): ReturnType<typeof sessionMarkState> => sessionMarkState(s, s.sessions[id] as SessionInfo);
  assert.equal(st('idle'), 'idle');
  assert.equal(st('done'), 'done');
  assert.equal(st('run'), 'working');
  assert.equal(st('fail'), 'failed');
  assert.equal(st('wait'), 'waiting');
  assert.equal(st('gone'), null);
  // No seenThrough from the server: never "done, not yet seen".
  assert.equal(st('legacy'), 'idle');
  assert.equal(st('bg'), 'background');
  assert.equal(st('runbg'), 'working');

  const row = selectWorkspaceRow(s, 'w1');
  assert.deepEqual(
    row.marks.map((m) => m.state),
    ['waiting', 'failed', 'working', 'working', 'background', 'done', 'idle', 'idle'],
  );
  assert.equal(row.counts.idle, 2);
  assert.equal(row.counts.background, 1);
  assert.equal(row.urgent?.sessionId, 'wait');
  assert.equal(row.urgent?.state, 'waiting');
});

test('done-unseen clears once seenThrough catches up; the timeline lastSeq counts too', () => {
  const s1 = state([sess('a', { lastSeq: 3, seenThrough: 3 })]);
  assert.equal(isDoneUnseen(s1, s1.sessions.a as SessionInfo), false);
  // The open session's channel saw more events than the list knows.
  const t = tl('a', [
    { type: 'turn.started', data: { turnId: 't1', input: [] } },
    { type: 'message.completed', data: { messageId: 'm', role: 'assistant', text: '\n## Removed five unused selectors\nDetails…' } },
    { type: 'turn.completed', data: { turnId: 't1', stopReason: 'end_turn' } },
    { type: 'session.status', data: { status: 'idle' } },
  ]);
  const s2 = state([sess('a', { lastSeq: 3, seenThrough: 3 })], { timelines: { a: t } });
  assert.equal(isDoneUnseen(s2, s2.sessions.a as SessionInfo), true);
  const row = selectWorkspaceRow(s2, 'w1');
  assert.deepEqual(row.urgent, { sessionId: 'a', agent: 'claude', state: 'done', text: 'Removed five unused selectors' });
  const s3 = state([sess('a', { lastSeq: 3, seenThrough: 4 })], { timelines: { a: t } });
  assert.equal(selectWorkspaceRow(s3, 'w1').urgent, null);
});

test('row 2 shows the waiting reason from the pending approval (shell command in backticks)', () => {
  const t = tl('w', [
    { type: 'turn.started', data: { turnId: 't', input: [] } },
    { type: 'approval.requested', data: { approvalId: 'ap', kind: 'shell', title: 'Run build', input: { command: ['bun', 'run', 'build'] }, editable: false, options: ['allow', 'deny'] } },
  ]);
  const s = state([sess('w', { status: 'waiting_approval', updatedAt: T(5) }), sess('f', { status: 'failed', updatedAt: T(9) })], { timelines: { w: t } });
  const row = selectWorkspaceRow(s, 'w1');
  assert.equal(row.urgent?.text, 'approve `bun run build`?');
  // Budget waits read their reason.
  const b = tl('b', [{ type: 'session.status', data: { status: 'waiting_input', prompt: 'budget', reason: '$2.00 cap reached' } }]);
  const s2 = state([sess('b', { status: 'waiting_input' })], { timelines: { b } });
  assert.equal(selectWorkspaceRow(s2, 'w1').urgent?.text, 'budget: $2.00 cap reached');
});

test('helpers count inside their parent mark and escalate its state', () => {
  const s = state([
    sess('p', { status: 'running', updatedAt: T(3) }),
    sess('h1', { spawnedBy: 'p', depth: 1, agent: 'codex', status: 'waiting_input', createdAt: T(1) }),
    sess('h2', { spawnedBy: 'p', depth: 1, agent: 'opencode', workspaceId: 'w2', createdAt: T(2) }),
    sess('h3', { spawnedBy: 'h1', depth: 2, status: 'ended', createdAt: T(3) }),
    sess('orphan', { spawnedBy: 'unknown', status: 'running' }),
  ]);
  const row = selectWorkspaceRow(s, 'w1');
  assert.equal(row.marks.length, 2);
  const parent = row.marks.find((m) => m.sessionId === 'p');
  assert.deepEqual(parent, { sessionId: 'p', agent: 'claude', state: 'waiting', helpers: 2 });
  assert.ok(row.marks.some((m) => m.sessionId === 'orphan'));
  assert.equal(row.urgent?.sessionId, 'h1');
  // A helper in another workspace (worktree) doesn't get a mark there either.
  assert.equal(selectWorkspaceRow(s, 'w2').marks.length, 0);

  const nested = selectNestedSessions(s, 'w1').map((r) => `${r.session.id}@${r.depth}`);
  assert.deepEqual(nested, ['p@0', 'h1@1', 'h3@2', 'h2@1', 'orphan@0']);
  assert.deepEqual(
    selectNestedSessions(s, 'w2').map((r) => r.session.id),
    ['h2'],
  );
  assert.deepEqual(
    selectWorkspaceBreakdown(s, 'w1').map((l) => [l.sessionId, l.state, l.depth]),
    [
      ['p', 'working', 0],
      ['h1', 'waiting', 1],
      ['h2', 'idle', 1],
      ['orphan', 'working', 0],
    ],
  );
});

test('helper tree: root totals count metered spend only', () => {
  const usage = (cost: number): Timeline => tl('x', [{ type: 'usage.updated', data: { inputTokens: 1000, outputTokens: 200, costUsd: cost } }]);
  const s = state(
    [sess('p', { billing: 'plan' }), sess('a', { spawnedBy: 'p', billing: 'metered' }), sess('b', { spawnedBy: 'p', billing: 'budgetless' }), sess('c', { spawnedBy: 'a', billing: 'metered' })],
    { timelines: { p: usage(3), a: usage(0.5), b: usage(9), c: usage(0.25) } },
  );
  const tree = selectHelperTreeModel(s, 'p');
  assert.ok(tree);
  assert.deepEqual(
    tree.nodes.map((n) => [n.sessionId, n.depth, n.meteredUsd]),
    [
      ['p', 0, undefined],
      ['a', 1, 0.5],
      ['c', 2, 0.25],
      ['b', 1, undefined],
    ],
  );
  assert.equal(tree.meteredUsd, 0.75);
  assert.equal(tree.nodes[0]?.tokens, 1200);
});

test('machine summary: totals, waiting, cached when offline, unsupported agents and stale sessions', () => {
  const agents: AgentListing[] = [
    { agent: 'opencode', installed: true, auth: 'ok', support: 'unsupported' },
    { agent: 'claude', installed: true, auth: 'ok', staleSessions: 2 },
  ];
  const s = state([sess('a', { status: 'running' }), sess('b', { status: 'waiting_input' }), sess('c', { status: 'ended' })], { agents: { m1: agents } });
  const m = selectMachineSummary(s, 'm1');
  assert.deepEqual(m, { live: 2, waiting: 1, online: true, cached: false, unsupported: ['opencode'], staleSessions: 2 });
  assert.equal(machineTotalsLabel(m), '2 · 1 waiting');
  const off = selectMachineSummary(state([sess('a')], { machines: { m1: { ...(s.machines.m1 as BizziState['machines'][string]), online: false } } }), 'm1');
  assert.equal(machineTotalsLabel(off), '1 (cached)');
  assert.equal(selectWaitingCount(s), 1);
});

test('worktree workspaces are grouped under their parent repo', () => {
  const s = state([], {
    workspaces: {
      a: ws('a', { name: 'acme' }),
      z: ws('z', { name: 'zeta' }),
      wt: ws('wt', { name: 'acme-oauth', kind: 'worktree', parentWorkspaceId: 'a', branch: 'feat/oauth' }),
      lost: ws('lost', { name: 'lost', kind: 'worktree', parentWorkspaceId: 'gone' }),
      other: ws('other', { machineId: 'm2' }),
    },
  });
  assert.deepEqual(
    selectMachineWorkspaces(s, 'm1').map((r) => `${r.workspace.id}@${r.depth}`),
    ['a@0', 'wt@1', 'lost@0', 'z@0'],
  );
});

test('phone: more than three marks collapse to counts; row equality ignores unrelated changes', () => {
  const s = state([sess('a', { status: 'waiting_input' }), sess('b', { status: 'running' }), sess('c', { status: 'running' }), sess('d'), sess('e')]);
  const row = selectWorkspaceRow(s, 'w1');
  assert.deepEqual(collapsedCounts(row), [
    { state: 'waiting', n: 1 },
    { state: 'working', n: 2 },
    { state: 'idle', n: 2 },
  ]);
  assert.equal(collapsedCounts(selectWorkspaceRow(state([sess('a')]), 'w1')), null);
  // A new state object with the same sessions (e.g. a streaming delta elsewhere) gives an equal row.
  const again = selectWorkspaceRow({ ...s, version: 2, sessions: { ...s.sessions } }, 'w1');
  assert.notEqual(again, row);
  assert.ok(workspaceRowEqual(row, again));
});

test('session context: the open timeline wins, else the session list; unknown without either', () => {
  const s = state(
    [
      sess('listed', { context: { used: 50_000, window: 200_000, usable: 100_000 } }),
      sess('open', { context: { used: 10_000, window: 200_000 } }),
      sess('none'),
      sess('gone', { status: 'ended', context: { used: 1, window: 2 } }),
    ],
    { timelines: { open: tl('open', [{ type: 'context.updated', data: { used: 100_000, window: 200_000 } }]) } },
  );
  assert.equal(sessionContext(s, s.sessions['listed']!), 0.5);
  assert.equal(sessionContext(s, s.sessions['open']!), 0.5);
  assert.equal(sessionContext(s, s.sessions['none']!), undefined);
  const lines = selectWorkspaceBreakdown(s, 'w1');
  assert.deepEqual(
    lines.map((l) => [l.sessionId, l.context, l.mode]).sort(),
    [
      ['listed', 0.5, 'structured'],
      ['none', undefined, 'structured'],
      ['open', 0.5, 'structured'],
    ],
  );
  assert.ok(breakdownEqual(lines, selectWorkspaceBreakdown(s, 'w1')));
  const moved = state([...Object.values(s.sessions).filter((x) => x.id !== 'listed'), sess('listed', { context: { used: 60_000, window: 200_000, usable: 100_000 } })], { timelines: s.timelines });
  assert.equal(breakdownEqual(lines, selectWorkspaceBreakdown(moved, 'w1')), false);
});
