// docs/usage.md §1: context.updated from the latest own step's tokens and the model's limit.context.

import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { StartSessionOptions } from '@bizzi/protocol';
import { OPENCODE_CAPABILITIES, OpenCodeAdapter } from '../src/index.ts';
import { approxTokens, contextFromStep } from '../src/context.ts';
import type { OpenCodeSession } from '../src/session.ts';
import { FakeOpenCode } from './fake-server.ts';
import { ctx, Recorder } from './helpers.ts';

const PASSWORD = 'test-password';
const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'bizzi-oc-ctx-')));

let fake: FakeOpenCode;
let adapter: OpenCodeAdapter;

before(async () => {
  fake = new FakeOpenCode({ password: PASSWORD });
  await fake.start();
  adapter = new OpenCodeAdapter({ serverUrl: fake.url, serverPassword: PASSWORD, healthIntervalMs: 0, interruptFallbackMs: 500 });
});

after(async () => {
  await adapter.dispose();
  await fake.close();
});

async function start(extra: Partial<StartSessionOptions> = {}): Promise<{ s: OpenCodeSession; rec: Recorder }> {
  const rec = new Recorder();
  const s = (await adapter.start({ sessionId: 's_ctx', mode: 'structured', cwd, ...extra }, rec.emit, ctx)) as OpenCodeSession;
  return { s, rec };
}

test('capabilities: context yes, accountUsage no', () => {
  assert.equal(OPENCODE_CAPABILITIES.context, true);
  assert.equal(OPENCODE_CAPABILITIES.accountUsage, false);
});

test('contextFromStep: one step total, never summed; bizzi rows; no window -> undefined', () => {
  const t = { input: 1000, output: 50, reasoning: 10, cache: { read: 4000, write: 200 } };
  assert.deepEqual(contextFromStep(t, 128000), { used: 5260, window: 128000 });
  assert.deepEqual(contextFromStep(t, 128000, 300)?.categories, [
    { id: 'bizzi', label: 'bizzi overhead', tokens: 300, kind: 'used' },
    { id: 'other', label: 'Everything else', tokens: 4960, kind: 'used' },
    { id: 'free_space', label: 'Free space', tokens: 122740, kind: 'free' },
  ]);
  assert.equal(contextFromStep(t, undefined), undefined);
  assert.equal(contextFromStep(undefined, 1000), undefined);
});

test('each own step reports the latest step size; subagent steps do not count', async () => {
  const { s, rec } = await start({ systemPromptAppend: 'r'.repeat(80) });
  try {
    await s.send('t_1', [{ type: 'text', text: 'scenario:tools' }]);
    await rec.waitFor('turn.completed');
    const ctxs = rec.of('context.updated');
    assert.deepEqual(
      ctxs.map((c) => [c.used, c.window]),
      [
        [55, 128000],
        [63, 128000],
      ],
    );
    assert.deepEqual(ctxs[0]?.categories?.[0], { id: 'bizzi', label: 'bizzi overhead', tokens: approxTokens('r'.repeat(80)), kind: 'used' });
    assert.equal(rec.of('context.compacted').length, 0);
    assert.equal(rec.of('account.usage').length, 0);
  } finally {
    await s.stop();
  }
});

test('switching model picks up the new window', async () => {
  const { s, rec } = await start();
  try {
    await s.set({ model: 'fake/other' });
    await s.send('t_1', [{ type: 'text', text: 'scenario:basic' }]);
    await rec.waitFor('turn.completed');
    assert.deepEqual(rec.of('context.updated'), [{ used: 107, window: 32000 }]);
  } finally {
    await s.stop();
  }
});
