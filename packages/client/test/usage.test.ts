import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AccountUsage, SessionEvent, SessionEventBody, WidgetValue } from '@bizzi/protocol';
import {
  accountConstraint,
  accountTone,
  contextBreakdown,
  contextView,
  emptyTimeline,
  formatResetIn,
  reduceTimeline,
  selectAccounts,
  timelineItems,
  versionChip,
  widgetStale,
  widgetText,
  widgetTone,
  windowShortLabel,
} from '../src/index.ts';
import type { BizziState } from '../src/index.ts';

const now = Date.parse('2026-11-10T10:00:00Z');

function account(id: string, over: Partial<AccountUsage> = {}): AccountUsage {
  return { agent: 'claude', accountId: id, label: id, billing: 'plan', machines: ['m1'], status: 'ok', observedAt: '2026-11-10T09:00:00Z', ...over };
}

test('context bar: label, fill against usable, tones from 80% and near compaction, unknown without data', () => {
  assert.deepEqual(contextView(null), { known: false });
  assert.deepEqual(contextView({ used: 10, window: 0 }), { known: false });
  const v = contextView({ used: 142_000, window: 200_000, usable: 160_000, compactAt: 160_000 });
  assert.ok(v.known);
  assert.equal(v.label, '71% · compacts at 80%');
  assert.equal(v.level, 'warn');
  const red = contextView({ used: 152_000, window: 200_000, usable: 160_000, compactAt: 160_000 });
  assert.ok(red.known);
  assert.equal(red.tone, 'err'); // within 5% of the window from compaction
  const calm = contextView({ used: 50_000, window: 200_000, usable: 160_000 });
  assert.ok(calm.known);
  assert.equal(calm.tone, 'neutral');
  assert.equal(calm.level, 'neutral');
  const mid = contextView({ used: 105_000, window: 200_000, usable: 160_000, compactAt: 180_000 });
  assert.ok(mid.known);
  assert.equal(mid.level, 'elevated');
  assert.equal(mid.tone, 'neutral');
  const amber = contextView({ used: 130_000, window: 200_000, usable: 160_000, compactAt: 180_000 });
  assert.ok(amber.known);
  assert.equal(amber.tone, 'warn');
  const noCompact = contextView({ used: 40_000, window: 200_000 });
  assert.ok(noCompact.known);
  assert.equal(noCompact.label, '20%');
});

test('context breakdown: used categories first, bizzi overhead called out, then buffer and free', () => {
  const segs = contextBreakdown({
    used: 60_000,
    window: 200_000,
    categories: [
      { id: 'free', label: 'Free space', tokens: 110_000, kind: 'free' },
      { id: 'bizzi', label: 'bizzi overhead', tokens: 4_000, kind: 'used' },
      { id: 'messages', label: 'Messages', tokens: 30_000, kind: 'used' },
      { id: 'buffer', label: 'Autocompact buffer', tokens: 30_000, kind: 'buffer' },
      { id: 'mcp', label: 'MCP tools', tokens: 26_000, kind: 'used' },
    ],
  });
  assert.deepEqual(
    segs.map((s) => s.id),
    ['messages', 'mcp', 'bizzi', 'buffer', 'free'],
  );
  assert.equal(segs.find((s) => s.bizzi)?.id, 'bizzi');
  assert.equal(segs[0]?.share, 0.15);
  assert.deepEqual(
    contextBreakdown({ used: 50, window: 200 }).map((s) => [s.id, s.tokens]),
    [
      ['used', 50],
      ['free', 150],
    ],
  );
});

test('accounts: most constrained first, amber from 80%, red when limited', () => {
  const claude = account('claude', { windows: [{ id: 'five_hour', label: '5-hour', usedPercent: 62, windowMins: 300 }, { id: 'seven_day', label: '7-day', usedPercent: 31 }] });
  const codex = account('codex', { agent: 'codex', windows: [{ id: 'primary', label: 'primary', usedPercent: 85, windowMins: 300 }] });
  const api = account('api', { billing: 'metered', spend: { usd: 12, capUsd: 100 } });
  const limited = account('lim', { status: 'limited', windows: [{ id: 'five_hour', label: '5h', usedPercent: 40 }] });
  assert.equal(accountConstraint(api), 12);
  assert.equal(accountTone(claude), 'neutral');
  assert.equal(accountTone(codex), 'warn');
  assert.equal(accountTone(limited), 'err');
  const s = { accounts: { a: claude, b: codex, c: api, d: limited } } as unknown as BizziState;
  assert.deepEqual(
    selectAccounts(s).map((a) => a.accountId),
    ['lim', 'codex', 'claude', 'api'],
  );
  assert.equal(windowShortLabel(claude.windows?.[0] as never), '5h');
  assert.equal(windowShortLabel({ id: 'seven_day', label: '7-day', usedPercent: 1 }), '7d');
  assert.equal(formatResetIn('2026-11-10T11:20:00Z', now), '1h20');
  assert.equal(formatResetIn('2026-11-10T09:00:00Z', now), '');
});

test('widgets: meter text with share, thresholds, explicit tones and staleness', () => {
  const w: WidgetValue = { id: 'litellm', machineId: 'm1', label: 'billed', kind: 'meter', placement: ['bar'], value: 554, max: 2474, format: 'usd', observedAt: '2026-11-10T09:59:00Z' };
  assert.equal(widgetText(w), '$554 / $2,474 (22%)');
  assert.equal(widgetTone(w), 'neutral');
  assert.equal(widgetTone({ ...w, value: 2400 }), 'err');
  assert.equal(widgetTone({ ...w, value: 2000 }), 'warn');
  assert.equal(widgetTone({ ...w, tone: 'error' }), 'err');
  assert.equal(widgetText({ ...w, format: 'number', value: 3, max: 8 }), '3 / 8');
  assert.equal(widgetText({ id: 'ci', machineId: 'm1', label: 'CI', kind: 'status', placement: ['workspace'], text: 'passing' }), 'passing');
  assert.equal(widgetStale(w, now), false);
  assert.equal(widgetStale({ ...w, observedAt: '2026-11-10T09:00:00Z' }, now), true);
  assert.equal(widgetStale({ ...w, error: 'timeout' }, now), true);
});

test('version chip only flags a stale process', () => {
  assert.equal(versionChip({}, { version: '2.1.322' }), null);
  assert.deepEqual(versionChip({ agentVersion: '2.1.311' }, { version: '2.1.322' }), { text: '2.1.311 · 2.1.322 installed', stale: true });
  assert.deepEqual(versionChip({ agentVersion: '2.1.322' }, { version: '2.1.322' }), { text: '2.1.322', stale: false });
});

test('timeline: context, compaction, restart divider and status source', () => {
  const bodies: SessionEventBody[] = [
    { type: 'context.updated', data: { used: 120_000, window: 200_000, usable: 160_000 } },
    { type: 'session.status', data: { status: 'waiting_approval', source: 'detector:claude-permission' } },
    { type: 'context.compacted', data: { before: 150_000, after: 40_000 } },
    { type: 'session.restarting', data: { fromVersion: '2.1.311', toVersion: '2.1.322', reason: 'update' } },
    { type: 'account.usage', data: { agent: 'claude', accountId: 'a', label: 'a', billing: 'plan', machines: [], status: 'ok', observedAt: '2026-11-10T10:00:00Z' } },
  ];
  const evs = (list: SessionEventBody[], from = 1): SessionEvent[] => list.map((b, i) => ({ ...b, ch: 'session:s', seq: from + i, ts: '2026-11-10T10:00:00Z' }) as SessionEvent);
  let t = reduceTimeline(emptyTimeline('s'), evs(bodies));
  assert.equal(t.context?.used, 40_000);
  assert.equal(t.statusSource, 'detector:claude-permission');
  assert.ok(t.restartItemId);
  t = reduceTimeline(t, evs([{ type: 'session.restarted', data: { fromVersion: '2.1.311', toVersion: '2.1.322', ok: true } }], 6));
  assert.equal(t.restartItemId, null);
  assert.equal(t.agentVersion, '2.1.322');
  const items = timelineItems(t);
  assert.deepEqual(
    items.map((i) => i.kind),
    ['compact', 'restart'],
  );
  const r = items[1];
  assert.ok(r && r.kind === 'restart');
  assert.equal(r.state, 'ok');
  assert.equal(r.toVersion, '2.1.322');
  // A later status without a source clears it.
  t = reduceTimeline(t, evs([{ type: 'session.status', data: { status: 'running' } }], 7));
  assert.equal(t.statusSource, undefined);
});
