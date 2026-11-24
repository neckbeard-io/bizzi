import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createNode } from '@bizzi/core';
import { FakeAdapter } from '@bizzi/core/testing';
import { createRoutingExtension } from '../src/index.ts';

test('route.suggest on a node routes among its own workspaces', async (t) => {
  const dir = mkdtempSync(join(os.tmpdir(), 'bizzi-routing-'));
  const node = await createNode({ dataDir: dir, adapters: [new FakeAdapter()], version: '0.0.0-test', machineName: 'laptop', extensions: [createRoutingExtension()] });
  t.after(async () => {
    await node.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const a = await node.call('workspace.create', { path: join(dir, 'acme'), create: true, name: 'acme' });
  await node.call('workspace.create', { path: join(dir, 'notes'), create: true, name: 'notes' });

  const { suggestion } = (await node.call('route.suggest', { text: '#acme fix the build' })) as { suggestion: any };
  assert.deepEqual([suggestion.source, suggestion.candidates[0].workspaceId, suggestion.candidates[0].label], ['explicit', a.workspace.id, 'laptop · acme']);
  const { suggestion: open } = (await node.call('route.suggest', { text: 'fix the build' })) as { suggestion: any };
  assert.deepEqual([open.source, open.offered, open.note], ['none', 2, 'no routing classifier configured']);
});

test('route.score: a node with a classifier advertises it and scores for the hub; one without says unsupported', async (t) => {
  const dir = mkdtempSync(join(os.tmpdir(), 'bizzi-routing-'));
  const f = (async () =>
    new Response(
      JSON.stringify({ choices: [{ logprobs: { content: [{ token: 'B', top_logprobs: [{ token: 'B', logprob: Math.log(0.8) }, { token: 'A', logprob: Math.log(0.2) }] }] } }] }),
    )) as unknown as typeof fetch;
  const ext = createRoutingExtension({ backend: { url: 'http://lab.test/v1', model: 'lab-qwen', maxOptions: 5, fetch: f } });
  const node = await createNode({ dataDir: join(dir, 'a'), adapters: [new FakeAdapter()], version: '0.0.0-test', extensions: [ext] });
  const bare = await createNode({ dataDir: join(dir, 'b'), adapters: [new FakeAdapter()], version: '0.0.0-test', extensions: [createRoutingExtension()] });
  t.after(async () => {
    await node.close();
    await bare.close();
    rmSync(dir, { recursive: true, force: true });
  });

  assert.deepEqual(node.machine.routing, { model: 'lab-qwen', maxOptions: 5 });
  assert.equal(bare.machine.routing, undefined);
  const r = (await node.call('route.score', { machineId: node.machine.id, text: 'cart page', options: ['first', 'second'] })) as any;
  assert.deepEqual([r.probabilities.map((p: number) => p.toFixed(2)), r.letterMass.toFixed(2), r.model], [['0.20', '0.80'], '1.00', 'lab-qwen']);
  await assert.rejects(node.call('route.score', { text: 'x', options: ['1', '2', '3', '4', '5', '6'] }), /between 1 and 5 options/);
  await assert.rejects(node.call('route.score', { text: '', options: ['a'] }), /text must be/);
  await assert.rejects(node.call('route.score', { text: 'x', options: [1] as unknown as string[] }), /options must be/);
  await assert.rejects(bare.call('route.score', { text: 'x', options: ['a'] }), (e: any) => e.code === 'unsupported');
});
