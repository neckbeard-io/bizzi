import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClaudeAdapter } from '../src/adapter.ts';
import { fakeQueryFn } from './fake.ts';

test('listModels reads supportedModels from a process that never gets a prompt, then closes it', async () => {
  const fq = fakeQueryFn(
    () => {},
    (q) => {
      (q as unknown as { supportedModels: () => Promise<unknown> }).supportedModels = async () => [
        { value: 'default', displayName: 'Default (recommended)', description: 'Opus · everyday', supportedEffortLevels: ['low', 'high'] },
        { value: 'haiku', displayName: 'Haiku', description: 'Fastest' },
        { value: 'claude-x', displayName: 'claude-x', description: '' },
      ];
    },
  );
  const adapter = new ClaudeAdapter({ claudePath: null, queryFn: fq.queryFn, hasTranscript: async () => true });
  assert.deepEqual(await adapter.listModels(), [
    { id: 'default', label: 'Default (recommended)', description: 'Opus · everyday', isDefault: true, efforts: ['low', 'high'] },
    { id: 'haiku', label: 'Haiku', description: 'Fastest' },
    { id: 'claude-x' },
  ]);
  const q = fq.last();
  assert.equal(q.received.length, 0, 'no prompt was sent');
  assert.equal(q.options.persistSession, false);
  assert.ok(q.calls.some((c) => c.method === 'close'));
});
