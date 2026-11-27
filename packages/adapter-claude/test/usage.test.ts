import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { StartSessionOptions } from '@bizzi/protocol';
import type { SDKControlGetContextUsageResponse, SDKControlGetUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAdapter } from '../src/index.ts';
import type { ClaudeSession } from '../src/session.ts';
import { approxTokens, claudeAccount, contextFromSdk, keyFingerprint, PlanUsage, readPlanUsage } from '../src/usage.ts';
import { assistant, collector, fakeQueryFn, init, result, silentLogger, tick, toolResult, toolUse, waitFor } from './fake.ts';
import type { FakeQuery, Script } from './fake.ts';

const base: StartSessionOptions = { sessionId: 's_1', mode: 'structured', cwd: '/tmp/ws' };
const NO_KEY = { ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '' };

function ctxResponse(over: Partial<SDKControlGetContextUsageResponse> = {}): SDKControlGetContextUsageResponse {
  return {
    categories: [
      { id: 'system_prompt', name: 'System prompt', tokens: 3000, color: 'x', kind: 'used' },
      { id: 'system_tools', name: 'System tools', tokens: 12000, color: 'x', kind: 'used' },
      { id: 'mcp_tools', name: 'MCP tools', tokens: 5000, color: 'x', kind: 'used' },
      { id: 'messages', name: 'Messages', tokens: 20000, color: 'x', kind: 'used' },
      { id: 'skills', name: 'Skills', tokens: 0, color: 'x', kind: 'used' },
      { id: 'autocompact_buffer', name: 'Autocompact buffer', tokens: 33000, color: 'x' },
      { id: 'free_space', name: 'Free space', tokens: 127000, color: 'x' },
    ],
    totalTokens: 40000,
    maxTokens: 200000,
    rawMaxTokens: 200000,
    percentage: 20,
    gridRows: [],
    model: 'claude-haiku-5-5',
    memoryFiles: [],
    mcpTools: [
      { name: 'mcp__bizzi-memory__recall', serverName: 'bizzi-memory', tokens: 1200 },
      { name: 'mcp__bizzi-memory__remember', serverName: 'bizzi-memory', tokens: 800, isLoaded: false },
      { name: 'mcp__linear__create_issue', serverName: 'linear', tokens: 3000 },
    ],
    agents: [],
    ...over,
  } as SDKControlGetContextUsageResponse;
}

async function setup(script: Script, extend: (fq: FakeQuery) => void, start: Partial<StartSessionOptions> = {}, contextRefreshMs?: number) {
  const fq = fakeQueryFn(script, extend);
  const adapter = new ClaudeAdapter({ claudePath: null, queryFn: fq.queryFn, hasTranscript: async () => true, ...(contextRefreshMs !== undefined ? { contextRefreshMs } : {}) });
  const c = collector();
  const session = (await adapter.start({ ...base, ...start }, c.emit, { logger: silentLogger })) as ClaudeSession;
  return { adapter, session, c, fq: fq.last() };
}

function withMethods(fq: FakeQuery, methods: Record<string, unknown>): void {
  Object.assign(fq, methods);
}

test('capabilities advertise context and accountUsage for structured sessions', () => {
  const caps = new ClaudeAdapter().capabilities('structured');
  assert.equal(caps.context, true);
  assert.equal(caps.accountUsage, true);
});

test('contextFromSdk: agent figures, buffer -> usable/compactAt, bizzi carved out of its rows', () => {
  const append = 'x'.repeat(4000); // ≈ 1000 tokens (bytes / 4)
  const ctx = contextFromSdk(ctxResponse(), { systemPromptAppend: append, mcpServers: ['bizzi-memory'] })!;
  assert.equal(ctx.used, 40000);
  assert.equal(ctx.window, 200000);
  assert.equal(ctx.usable, 167000);
  assert.equal(ctx.compactAt, 167000);
  const by = Object.fromEntries(ctx.categories!.map((c) => [c.id, c]));
  assert.equal(by.system_prompt?.tokens, 2000);
  assert.equal(by.mcp_tools?.tokens, 3800);
  assert.equal(by.skills, undefined, 'zero rows dropped');
  assert.deepEqual(by.autocompact_buffer, { id: 'autocompact_buffer', label: 'Autocompact buffer', tokens: 33000, kind: 'buffer' });
  assert.equal(by.free_space?.kind, 'free');
  assert.deepEqual(by.bizzi, { id: 'bizzi', label: 'bizzi overhead', tokens: 2200, kind: 'used' });
  // The breakdown still sums to the CLI's own rows.
  const used = ctx.categories!.filter((c) => c.kind === 'used').reduce((n, c) => n + c.tokens, 0);
  assert.equal(used, 3000 + 12000 + 5000 + 20000);
  assert.equal(approxTokens(append), 1000);
});

test('contextFromSdk: no buffer row leaves usable unset; no window -> undefined', () => {
  const ctx = contextFromSdk(ctxResponse({ categories: [{ id: 'messages', name: 'Messages', tokens: 10, color: 'x', kind: 'used' }] }))!;
  assert.equal(ctx.usable, undefined);
  assert.equal(ctx.compactAt, undefined);
  assert.equal(contextFromSdk(ctxResponse({ maxTokens: 0, rawMaxTokens: 0 })), undefined);
});

test('session emits context.updated after a turn and context.compacted on a compact boundary', async () => {
  let calls = 0;
  const { session, c } = await setup(
    (fq, u) => {
      fq.emit(init(String(fq.options.sessionId)), result([u.uuid!], 0.01));
    },
    (fq) =>
      withMethods(fq, {
        getContextUsage: async (opts: unknown) => {
          calls++;
          assert.deepEqual(opts, { detail: 'summary' });
          return ctxResponse({ totalTokens: 40000 + calls });
        },
      }),
    { systemPromptAppend: 'RULES', mcpServers: { 'bizzi-memory': { type: 'stdio', command: 'x' } } },
  );
  await waitFor(() => c.of('context.updated').length === 1); // at start
  await session.send('t_1', [{ type: 'text', text: 'hi' }]);
  await waitFor(() => c.of('turn.completed').length === 1);
  await waitFor(() => c.of('context.updated').length === 2);
  assert.equal(c.of('context.updated')[1]?.used, 40002);
  assert.ok(c.of('context.updated')[1]?.categories?.some((x) => x.id === 'bizzi'));

  await session.stop();
});

test('compact boundary -> context.compacted with before/after, then a refresh', async () => {
  const { session, c, fq } = await setup(() => {}, (fq) => withMethods(fq, { getContextUsage: async () => ctxResponse() }));
  await waitFor(() => c.of('context.updated').length === 1);
  fq.emit({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 160000, post_tokens: 12000 }, uuid: 'cb', session_id: 's' });
  await waitFor(() => c.of('context.compacted').length === 1);
  assert.deepEqual(c.of('context.compacted'), [{ before: 160000, after: 12000 }]);
  await waitFor(() => c.of('context.updated').length === 2);
  assert.equal(c.of('agent.raw').length, 0);
  await session.stop();
});

test('context refreshes mid-turn on each main-thread response and tool result, throttled and deduplicated', async () => {
  let used = 40000;
  let calls = 0;
  let release: (() => void) | undefined;
  const { session, c, fq } = await setup(
    () => new Promise<void>((r) => (release = r)), // the turn stays open until the test ends it
    (fq) =>
      withMethods(fq, {
        getContextUsage: async () => {
          calls++;
          return ctxResponse({ totalTokens: used });
        },
      }),
    {},
    20,
  );
  await waitFor(() => c.of('context.updated').length === 1);
  await session.send('t_1', [{ type: 'text', text: 'hi' }]);
  await waitFor(() => !!release);

  used = 52000;
  fq.emit(toolUse('msg_1', 'toolu_1', 'Read', { file_path: '/w/a' }));
  await waitFor(() => c.of('context.updated').length === 2);
  assert.equal(c.of('context.updated')[1]?.used, 52000);

  used = 90000;
  fq.emit(toolResult('toolu_1', 'x'.repeat(1000)));
  await waitFor(() => c.of('context.updated').length === 3);
  assert.equal(c.of('context.updated')[2]?.used, 90000);

  // More blocks of the same response don't ask again; subagent responses don't count.
  const before = calls;
  fq.emit(assistant('msg_1', { type: 'text', text: 'more' }), toolUse('msg_sub', 'toolu_2', 'Read', {}, 'toolu_task'));
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls, before);

  // A burst within the interval coalesces into one trailing refresh; an unchanged figure isn't re-sent.
  fq.emit(toolUse('msg_2', 'toolu_3', 'Read', {}), toolUse('msg_3', 'toolu_4', 'Read', {}), toolUse('msg_4', 'toolu_5', 'Read', {}));
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(calls - before <= 2, `burst coalesced (${calls - before} calls)`);
  assert.equal(c.of('context.updated').length, 3);

  release!();
  await session.stop();
});

test('no getContextUsage -> no context events', async () => {
  const { session, c } = await setup((fq, u) => fq.emit(result([u.uuid!], 0.01)), () => {});
  await session.send('t_1', [{ type: 'text', text: 'hi' }]);
  await waitFor(() => c.of('turn.completed').length === 1);
  await tick();
  assert.equal(c.of('context.updated').length, 0);
  assert.equal(c.of('account.usage').length, 0);
  await session.stop();
});

test('subscription login: rate_limit_event + experimental query -> account.usage', async () => {
  const plan: SDKControlGetUsageResponse = {
    session: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 0, total_lines_added: 0, total_lines_removed: 0, model_usage: {} },
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 40, resets_at: '2099-01-01T05:00:00.000Z' },
      seven_day: { utilization: 31, resets_at: '2099-01-07T00:00:00.000Z' },
      model_scoped: [{ display_name: 'Fable', utilization: 12, resets_at: null }],
    },
  } as unknown as SDKControlGetUsageResponse;
  const { session, c, fq } = await setup(
    () => {},
    (fq) =>
      withMethods(fq, {
        accountInfo: async () => ({ email: 'mc@example.com', subscriptionType: 'max', apiProvider: 'firstParty' }),
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => plan,
      }),
    { env: NO_KEY },
  );
  await waitFor(() => c.of('account.usage').length === 1);
  const first = c.of('account.usage')[0]!;
  assert.equal(first.agent, 'claude');
  assert.equal(first.accountId, 'mc@example.com');
  assert.equal(first.label, 'claude · max · mc@example.com');
  assert.equal(first.billing, 'plan');
  assert.deepEqual(first.machines, []);
  assert.equal(first.status, 'ok');
  assert.deepEqual(first.windows, [
    { id: 'five_hour', label: '5h', usedPercent: 40, resetsAt: '2099-01-01T05:00:00.000Z', windowMins: 300 },
    { id: 'seven_day', label: '7d', usedPercent: 31, resetsAt: '2099-01-07T00:00:00.000Z', windowMins: 10080 },
    { id: 'model:Fable', label: '7d Fable', usedPercent: 12, windowMins: 10080 },
  ]);

  const resetsAt = 4102444800; // 2100-01-01T00:00:00Z, epoch seconds
  fq.emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.62, resetsAt }, uuid: 'r', session_id: 's' });
  await waitFor(() => c.of('account.usage').length === 2);
  const second = c.of('account.usage')[1]!;
  assert.equal(second.status, 'warning');
  assert.deepEqual(second.windows?.[0], { id: 'five_hour', label: '5h', usedPercent: 62, resetsAt: '2100-01-01T00:00:00.000Z', windowMins: 300 });

  fq.emit({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day', utilization: 1, resetsAt }, uuid: 'r2', session_id: 's' });
  await waitFor(() => c.of('account.usage').length === 3);
  assert.equal(c.of('account.usage')[2]!.status, 'limited');
  assert.equal(c.of('agent.raw').length, 0);
  await session.stop();
});

test('rate_limit_event before accountInfo resolves is still reported once the account is known', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const { session, c, fq } = await setup(
    () => {},
    (fq) =>
      withMethods(fq, {
        accountInfo: async () => {
          await gate;
          return { email: 'mc@example.com', subscriptionType: 'pro' };
        },
        // Experimental query removed in this CLI: tolerated.
      }),
    { env: NO_KEY },
  );
  fq.emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.1 }, uuid: 'r', session_id: 's' });
  await tick();
  assert.equal(c.of('account.usage').length, 0);
  release();
  await waitFor(() => c.of('account.usage').length === 1);
  assert.deepEqual(c.of('account.usage')[0]!.windows, [{ id: 'five_hour', label: '5h', usedPercent: 10, windowMins: 300 }]);
  await session.stop();
});

test('API-key login: metered spend from total_cost_usd, fingerprint id, key never exposed', async () => {
  const { session, c } = await setup(
    (fq, u) => fq.emit(result([u.uuid!], 0.25)),
    (fq) => withMethods(fq, { accountInfo: async () => ({ apiKeySource: 'ANTHROPIC_API_KEY', apiProvider: 'firstParty' }) }),
    { env: { ANTHROPIC_API_KEY: 'sk-ant-secret', ANTHROPIC_AUTH_TOKEN: '', ANTHROPIC_BASE_URL: 'https://gw.example' } },
  );
  await tick();
  assert.equal(c.of('account.usage').length, 0, 'nothing to report before the first result');
  await session.send('t_1', [{ type: 'text', text: 'hi' }]);
  await waitFor(() => c.of('account.usage').length === 1);
  const u = c.of('account.usage')[0]!;
  assert.equal(u.billing, 'metered');
  assert.match(u.accountId, /^key:[0-9a-f]{16}$/);
  assert.equal(u.accountId, keyFingerprint({ ANTHROPIC_API_KEY: 'sk-ant-secret', ANTHROPIC_BASE_URL: 'https://gw.example' }));
  assert.deepEqual(u.spend, { usd: 0.25, period: 'session' });
  assert.equal(u.status, 'ok');
  assert.ok(!JSON.stringify(u).includes('sk-ant-secret'));
  await session.stop();
});

test('claudeAccount: Bedrock and unknown logins have no identity', () => {
  assert.equal(claudeAccount(undefined, 'key:abc'), undefined);
  assert.equal(claudeAccount({ apiProvider: 'bedrock' }, undefined), undefined);
  assert.equal(claudeAccount({ email: 'a@b', subscriptionType: 'max', apiKeySource: 'apiKeyHelper' }, undefined), undefined);
  assert.equal(claudeAccount({ apiProvider: 'gateway' }, 'key:0123456789abcdef')?.billing, 'metered');
});

test('PlanUsage: windows past their reset no longer count toward status', () => {
  const p = new PlanUsage();
  p.applyRateLimit({ status: 'rejected', rateLimitType: 'five_hour', utilization: 1, resetsAt: 1 });
  assert.equal(p.status(), 'unknown');
  p.applyRateLimit({ status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.85, resetsAt: 4102444800 });
  assert.equal(p.status(), 'warning');
  const q = new PlanUsage();
  q.applyRateLimit({ status: 'allowed' });
  assert.equal(q.status(), 'ok');
  assert.deepEqual(q.windows(), []);
});

test('readPlanUsage tolerates a missing or throwing method', async () => {
  assert.equal(await readPlanUsage({}), undefined);
  assert.equal(
    await readPlanUsage({
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
        throw new Error('gone');
      },
    }),
    undefined,
  );
});
