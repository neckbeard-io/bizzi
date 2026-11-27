import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccountUsage } from '@bizzi/protocol';
import { agyGroupName, agyStatus, createAgyUsageExtension, parseAgyUsage } from '../src/agy-usage.ts';
import type { ExtensionContext } from '../src/types.ts';

// The shape of `agy -p /usage --output-format json` (agy 1.5.18).
const OUTPUT = JSON.stringify({
  conversation_id: '',
  status: 'SUCCESS',
  command: {
    name: 'usage',
    data: {
      groups: [
        {
          name: 'Gemini Models',
          buckets: [
            { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.8257, reset_time: '2026-12-04T02:35:09Z' },
            { id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 0.3028, reset_time: '2026-11-27T07:35:09Z' },
          ],
        },
        {
          name: 'Claude and GPT models',
          buckets: [
            { id: '3p-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.5, reset_time: '2026-12-04T03:27:03Z' },
            { id: '3p-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 0, reset_time: '2026-11-27T08:27:03Z' },
          ],
        },
      ],
    },
  },
});

test('parseAgyUsage turns remaining fractions into grouped used-percent windows', () => {
  const w = parseAgyUsage(OUTPUT);
  assert.deepEqual(w[0], { id: 'gemini-weekly', label: 'Gemini · weekly', usedPercent: 17.4, resetsAt: '2026-12-04T02:35:09Z', windowMins: 10080, group: 'Gemini' });
  assert.deepEqual(w[1], { id: 'gemini-5h', label: 'Gemini · 5h', usedPercent: 69.7, resetsAt: '2026-11-27T07:35:09Z', windowMins: 300, group: 'Gemini' });
  assert.equal(w[3]!.group, 'Claude and GPT');
  assert.equal(w[3]!.usedPercent, 100);
  assert.deepEqual(parseAgyUsage('not json'), []);
  assert.deepEqual(parseAgyUsage('{"command":{"name":"usage"}}'), []);
});

test('agyGroupName drops the trailing "models"', () => {
  assert.equal(agyGroupName('Gemini Models'), 'Gemini');
  assert.equal(agyGroupName('Claude and GPT models'), 'Claude and GPT');
  assert.equal(agyGroupName('Models'), 'Models');
});

test('agyStatus: one exhausted pool warns, all exhausted is limited', () => {
  const w = parseAgyUsage(OUTPUT);
  assert.equal(agyStatus(w), 'warning');
  assert.equal(agyStatus(w.map((x) => ({ ...x, usedPercent: 100 }))), 'limited');
  assert.equal(agyStatus(w.map((x) => ({ ...x, usedPercent: 10 }))), 'ok');
  assert.equal(agyStatus([]), 'unknown');
});

function fakeCtx(installed: boolean): { ctx: ExtensionContext; reported: AccountUsage[] } {
  const reported: AccountUsage[] = [];
  const logger = { log() {}, child: () => logger };
  const node = {
    machine: { id: 'm1' },
    registry: { list: async () => [{ agent: 'agy', installed, path: installed ? '/bin/agy' : undefined, auth: 'unknown' }] },
    sessions: { list: () => [] },
    usage: { report: (u: AccountUsage) => reported.push(u) },
  };
  return { ctx: { node, logger } as unknown as ExtensionContext, reported };
}

test('poll reports the active Google account with every window', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-usage-'));
  const accountsFile = join(dir, 'google_accounts.json');
  writeFileSync(accountsFile, JSON.stringify({ active: 'someone@example.com', old: [] }));
  const calls: string[][] = [];
  const ext = createAgyUsageExtension({
    accountsFile,
    firstDelayMs: 60_000,
    now: () => new Date('2026-11-27T05:00:00Z'),
    run: async (file, args) => {
      calls.push([file, ...args]);
      return OUTPUT;
    },
  });
  const { ctx, reported } = fakeCtx(true);
  await ext.start!(ctx);
  const u = await ext.poll();
  await ext.stop!();
  assert.deepEqual(calls, [['/bin/agy', '-p', '/usage', '--output-format', 'json']]);
  assert.equal(reported.length, 1);
  assert.equal(u!.accountId, 'someone@example.com');
  assert.equal(u!.label, 'agy · google · someone@example.com');
  assert.equal(u!.billing, 'plan');
  assert.equal(u!.status, 'warning');
  assert.equal(u!.windows!.length, 4);
  assert.deepEqual(u!.machines, ['m1']);
});

test('poll does nothing when agy is missing or the command fails', async () => {
  let ran = 0;
  const missing = createAgyUsageExtension({ firstDelayMs: 60_000, run: async () => (ran++, OUTPUT) });
  const a = fakeCtx(false);
  await missing.start!(a.ctx);
  assert.equal(await missing.poll(), undefined);
  await missing.stop!();
  assert.equal(ran, 0);

  const failing = createAgyUsageExtension({ firstDelayMs: 60_000, run: async () => Promise.reject(new Error('exit 2')) });
  const b = fakeCtx(true);
  await failing.start!(b.ctx);
  assert.equal(await failing.poll(), undefined);
  await failing.stop!();
  assert.equal(b.reported.length, 0);
});
