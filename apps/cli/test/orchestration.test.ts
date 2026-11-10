import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createJsonLogger, createNode } from '@bizzi/core';
import { FakeAdapter } from '@bizzi/core/testing';
import { createKnowledgeRuntime } from '../src/knowledge.ts';
import { loadOrchestration } from '../src/orchestration.ts';

function tempDir() {
  const path = mkdtempSync(join(os.tmpdir(), 'bizzi-cli-orch-'));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

test('a missing orchestration package is skipped', async () => {
  const lines: string[] = [];
  const logger = createJsonLogger({ level: 'debug', write: (l) => lines.push(l) });
  assert.equal(await loadOrchestration(logger, '@bizzi/orchestration-does-not-exist'), undefined);
  assert.ok(lines.some((l) => l.includes('orchestration package not installed')));
});

test('sessions get both bizzi-memory and bizzi-agents: knowledge prepareStart composes with the extension', async (t) => {
  const tmp = tempDir();
  const logger = createJsonLogger({ level: 'error', write: () => {} });
  const knowledge = await createKnowledgeRuntime(tmp.path, logger);
  assert.ok(knowledge);
  const ext = await loadOrchestration(logger);
  assert.ok(ext);
  const fake = new FakeAdapter();
  const node = await createNode({ dataDir: tmp.path, adapters: [fake], version: '0', logger, prepareStart: knowledge.prepareStart, extensions: [ext] });
  t.after(async () => {
    await node.close();
    knowledge.close();
    tmp.cleanup();
  });
  const { workspace } = await node.call('workspace.create', { path: join(tmp.path, 'ws'), create: true });
  const { session } = await node.call('session.create', { workspaceId: workspace.id, agent: 'claude' });
  const deadline = Date.now() + 5000;
  while (!fake.starts.some((s) => s.sessionId === session.id)) {
    if (Date.now() > deadline) throw new Error('session did not start');
    await new Promise((r) => setTimeout(r, 5));
  }
  const opts = fake.starts.find((s) => s.sessionId === session.id)!;
  assert.deepEqual(Object.keys(opts.mcpServers ?? {}).sort(), ['bizzi-agents', 'bizzi-memory']);
  assert.equal(opts.mcpServers?.['bizzi-agents']?.type, 'http');
  assert.match(opts.systemPromptAppend ?? '', /# bizzi knowledge[\s\S]*## bizzi-agents tools/);
});
