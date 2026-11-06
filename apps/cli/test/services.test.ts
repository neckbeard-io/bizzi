import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createJsonLogger } from '@bizzi/core';
import type { KnowledgeStore } from '@bizzi/knowledge';
import { createKnowledgeRuntime } from '../src/knowledge.ts';
import { loadServices } from '../src/services.ts';

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));

function tempDir() {
  const path = mkdtempSync(join(os.tmpdir(), 'bizzi-cli-services-'));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

test('a missing services package is skipped', async () => {
  const lines: string[] = [];
  const logger = createJsonLogger({ level: 'debug', write: (l) => lines.push(l) });
  const tmp = tempDir();
  try {
    assert.equal(await loadServices({ dataDir: tmp.path, logger }, '@bizzi/services-does-not-exist'), undefined);
    assert.ok(lines.some((l) => l.includes('services package not installed')));
  } finally {
    tmp.cleanup();
  }
});

test('services share the knowledge store with the session-start hook', async () => {
  const logger = createJsonLogger({ level: 'error', write: () => {} });
  const tmp = tempDir();
  try {
    const runtime = (await createKnowledgeRuntime(tmp.path, logger))!;
    const opened: string[] = [];
    const store = runtime.store.bind(runtime);
    runtime.store = (machineId: string): KnowledgeStore => {
      opened.push(machineId);
      return store(machineId);
    };

    // Without the knowledge runtime: provisioning + login only.
    const bare = await loadServices({ dataDir: tmp.path, logger });
    assert.equal((bare!.extensions as unknown[]).length, 2);

    const loaded = await loadServices({ dataDir: tmp.path, logger, knowledge: runtime });
    const extensions = loaded!.extensions as { methods: Record<string, (p: unknown, ctx: unknown) => unknown> }[];
    assert.equal(extensions.length, 3);
    const knowledge = extensions.find((e) => 'knowledge.list' in e.methods)!;
    const ctx = { node: { machine: { id: 'm_TEST' } } };
    assert.deepEqual(await knowledge.methods['knowledge.list']!({}, ctx), { items: [] });
    assert.deepEqual(opened, ['m_TEST']);

    // The injection hook reads the same store (same instance, same rows).
    await knowledge.methods['knowledge.add']!({ type: 'rule', title: 'Shared', body: 'Seen by both.', scope: { level: 'global' } }, {
      ...ctx,
      emitGlobal: () => {},
    });
    const start = await runtime.prepareStart(
      { id: 's_1', machineId: 'm_TEST', workspaceId: 'w_1', agent: 'claude', mode: 'structured', status: 'starting', createdAt: '', updatedAt: '', lastSeq: 0 },
      { id: 'w_1', machineId: 'm_TEST', name: 'w', path: tmp.path, kind: 'dir', createdAt: '' },
    );
    assert.match(start.systemPromptAppend ?? '', /Seen by both/);
    assert.equal(store('m_TEST'), store('m_TEST'));
    runtime.close();
  } finally {
    tmp.cleanup();
  }
});

test('serve --help documents --no-services', async () => {
  const out = await new Promise<string>((resolve, reject) =>
    execFile(process.execPath, [MAIN, 'serve', '--help'], (err, stdout) => (err ? reject(err) : resolve(stdout))),
  );
  assert.match(out, /--no-services/);
});
