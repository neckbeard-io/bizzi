// docs/usage.md: context.updated / context.compacted / account.usage from codex app-server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODEX_STRUCTURED_CAPABILITIES } from '../src/index.ts';
import { approxTokens, CodexRateLimits, codexAccount, contextFromCodex } from '../src/usage.ts';
import { ctx, EventLog, fakeAdapter, startOpts } from './helpers.ts';

const text = (t: string) => [{ type: 'text' as const, text: t }];
const breakdown = (n: number) => ({ totalTokens: n, inputTokens: n, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 });

test('capabilities advertise context and accountUsage', () => {
  assert.equal(CODEX_STRUCTURED_CAPABILITIES.context, true);
  assert.equal(CODEX_STRUCTURED_CAPABILITIES.accountUsage, true);
});

test('contextFromCodex: used = last.totalTokens (not the thread total); compact limit; bizzi rows', () => {
  const u = { total: breakdown(900000), last: breakdown(50000), modelContextWindow: 272000 };
  assert.deepEqual(contextFromCodex(u, undefined), { used: 50000, window: 272000 });
  assert.deepEqual(contextFromCodex(u, undefined, { compactAt: 244800, bizziTokens: 1500 }), {
    used: 50000,
    window: 272000,
    compactAt: 244800,
    usable: 244800,
    categories: [
      { id: 'bizzi', label: 'bizzi overhead', tokens: 1500, kind: 'used' },
      { id: 'other', label: 'Everything else', tokens: 48500, kind: 'used' },
      { id: 'free_space', label: 'Free space', tokens: 222000, kind: 'free' },
    ],
  });
  assert.equal(contextFromCodex({ ...u, modelContextWindow: null }, undefined), undefined);
  assert.equal(contextFromCodex({ ...u, modelContextWindow: null }, 100000)?.window, 100000);
});

test('codexAccount: only ChatGPT logins carry an identity', () => {
  assert.deepEqual(codexAccount({ type: 'chatgpt', email: 'a@b.c', planType: 'plus', workspaceName: null }), { accountId: 'a@b.c', email: 'a@b.c', planType: 'plus' });
  assert.equal(codexAccount({ type: 'apiKey' }), undefined);
  assert.equal(codexAccount({ type: 'gcp' }), undefined);
  assert.equal(codexAccount(null), undefined);
});

test('CodexRateLimits: sparse updates merge; reached type -> limited', () => {
  const r = new CodexRateLimits();
  assert.equal(r.status(), 'unknown');
  const snap = { limitId: 'codex', limitName: null, normalModelSlug: null, primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 4102444800 }, secondary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: null }, credits: null, individualLimit: null, spendControlReached: null, planType: 'plus' as const, rateLimitReachedType: null };
  r.applyRead({ ordinaryUsageAllowed: true, rateLimits: snap, rateLimitsByLimitId: null, rateLimitResetCredits: null, accountId: null, rateLimitUpsell: null });
  assert.equal(r.status(), 'ok');
  r.applyUpdate({ ...snap, primary: null, secondary: { usedPercent: 82, windowDurationMins: 10080, resetsAt: null }, planType: null });
  assert.deepEqual(r.windows(), [
    { id: 'primary', label: '5h', usedPercent: 10, resetsAt: '2100-01-01T00:00:00.000Z', windowMins: 300 },
    { id: 'secondary', label: '7d', usedPercent: 82, windowMins: 10080 },
  ]);
  assert.equal(r.planType, 'plus');
  assert.equal(r.status(), 'warning');
  r.applyUpdate({ ...snap, primary: null, secondary: null, planType: null, rateLimitReachedType: 'rate_limit_reached' });
  assert.equal(r.status(), 'limited');
  r.applyUpdate({ ...snap, limitId: 'other', primary: { usedPercent: 99, windowDurationMins: 60, resetsAt: null } });
  assert.equal(r.windows()[0]?.usedPercent, 10, 'another bucket is ignored');
});

test('turn usage -> context.updated; compaction -> one context.compacted; ChatGPT login -> account.usage', async () => {
  const log = new EventLog();
  const s = await fakeAdapter({ env: { FAKE_AUTH: 'chatgpt', FAKE_COMPACT_LIMIT: '180000' } }).start(
    startOpts({ systemPromptAppend: 'r'.repeat(400), mcpServers: { 'bizzi.mem': { type: 'stdio', command: 'x' } } }),
    log.emit,
    ctx(),
  );
  try {
    const first = await log.waitFor('account.usage');
    assert.equal(first.agent, 'codex');
    assert.equal(first.accountId, 'dev@example.com');
    assert.equal(first.label, 'codex · pro · dev@example.com');
    assert.equal(first.billing, 'plan');
    assert.deepEqual(first.machines, []);
    assert.equal(first.status, 'ok');
    assert.deepEqual(first.windows, [
      { id: 'primary', label: '5h', usedPercent: 18, resetsAt: '2100-01-01T00:00:00.000Z', windowMins: 300 },
      { id: 'secondary', label: '7d', usedPercent: 31.5, resetsAt: '2100-01-08T00:00:00.000Z', windowMins: 10080 },
    ]);
    const rl = log.received('account/rateLimits/read');
    assert.deepEqual(rl, [{ excludeResetCreditDetails: true }]);

    await s.send('t_c', text('compact'));
    await log.waitFor('turn.completed');
    const contexts = log.ofType('context.updated');
    assert.equal(contexts.length, 2);
    // bizzi overhead: 400 bytes of instructions (100) + the bizzi_mem tool schema only (not 'other').
    const mcp = approxTokens(JSON.stringify({ name: 'recall', description: 'd'.repeat(400), inputSchema: { type: 'object' } }));
    assert.deepEqual(contexts[0], {
      used: 150000,
      window: 200000,
      compactAt: 180000,
      usable: 180000,
      categories: [
        { id: 'bizzi', label: 'bizzi overhead', tokens: 100 + mcp, kind: 'used' },
        { id: 'other', label: 'Everything else', tokens: 150000 - 100 - mcp, kind: 'used' },
        { id: 'free_space', label: 'Free space', tokens: 50000, kind: 'free' },
      ],
    });
    assert.equal(contexts[1]?.used, 9000);
    assert.deepEqual(log.ofType('context.compacted'), [{ before: 150000 }]);

    const updated = log.ofType('account.usage').at(-1)!;
    assert.equal(updated.status, 'warning');
    assert.equal(updated.windows?.[0]?.usedPercent, 85);
    assert.equal(updated.label, 'codex · pro · dev@example.com', 'a null planType in a sparse update keeps the old one');
    const raw = log.ofType('agent.raw').map((r) => (r.payload as { method: string; params?: { item?: { type?: string } } }));
    assert.ok(!raw.some((r) => r.method === 'thread/compacted' || r.method === 'account/rateLimits/updated' || r.params?.item?.type === 'contextCompaction'));
  } finally {
    await s.stop();
  }
});

test('no ChatGPT login: no account.usage; context still reported from token usage', async () => {
  const log = new EventLog();
  const s = await fakeAdapter().start(startOpts(), log.emit, ctx());
  try {
    await s.send('t_1', text('stream'));
    await log.waitFor('turn.completed');
    assert.deepEqual(log.ofType('context.updated'), [{ used: 100, window: 200000 }]);
    assert.equal(log.ofType('account.usage').length, 0);
    assert.equal(log.received('account/rateLimits/read').length, 0);
  } finally {
    await s.stop();
  }
});
