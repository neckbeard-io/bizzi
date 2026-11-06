// End-to-end: spawn the stdio server exactly as a session would (via mcpServerSpec) and call
// its tools with the official MCP client.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { KnowledgeStore, addKnowledge, listInbox, mcpServerSpec, parseServerConfig } from '../src/index.ts';
import type { KnowledgeContext } from '../src/index.ts';
import { M1, P1, S1, W1, tempDir } from './helpers.ts';

const CTX: KnowledgeContext = { agent: 'codex', machineId: M1, projectId: P1, workspaceId: W1, sessionId: S1 };

async function connect(dbPath: string, ctx: KnowledgeContext): Promise<Client> {
  const spec = mcpServerSpec(ctx, { dbPath });
  assert.ok(spec.type === 'stdio');
  const transport = new StdioClientTransport({ command: spec.command, args: spec.args ?? [], stderr: 'pipe' });
  const client = new Client({ name: 'bizzi-test', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

const textOf = (r: CallToolResult) => r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');

test('parseServerConfig: args win over env, validation', () => {
  const cfg = parseServerConfig(['--db', '/x.db', '--agent', 'claude', '--machine-id', 'm_1'], {
    BIZZI_PROJECT_ID: 'p_env',
    BIZZI_AGENT: 'codex',
  });
  assert.deepEqual(cfg, { dbPath: '/x.db', context: { agent: 'claude', machineId: 'm_1', projectId: 'p_env' } });
  assert.throws(() => parseServerConfig(['--db', '/x.db', '--machine-id', 'm'], {}), /agent/);
  assert.throws(() => parseServerConfig(['--agent', 'claude', '--machine-id', 'm'], {}), /--db/);
});

test('bizzi-memory MCP server over stdio, end to end', async () => {
  const tmp = tempDir();
  const dbPath = join(tmp.dir, 'knowledge.db');
  const seed = new KnowledgeStore({ path: dbPath, machineId: M1 });
  addKnowledge(
    seed,
    { type: 'rule', title: 'Use pnpm for installs', body: 'never npm', scope: 'project' },
    { via: 'ui', machineId: M1, projectId: P1 },
  );
  seed.close();

  const client = await connect(dbPath, CTX);
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, [
      'handoff_brief',
      'history_search',
      'knowledge_forget',
      'knowledge_update',
      'memory_add',
      'memory_search',
      'rule_add',
    ]);
    const instructions = client.getInstructions() ?? '';
    assert.match(instructions, /workspace" = only this directory on this machine/);
    assert.match(instructions, /available in this session: global, machine, project, workspace, session/);
    const memAdd = (await client.listTools()).tools.find((t) => t.name === 'memory_add')!;
    assert.match(memAdd.description ?? '', /If you omit scope, "project" is used/);

    // memory_add: live at project scope (balanced policy).
    const added = await call(client, 'memory_add', {
      title: 'Staging DB port',
      body: 'Staging Postgres listens on 5433, not 5432.',
      kind: 'gotcha',
    });
    assert.equal(added.isError, undefined);
    const sc = added.structuredContent as { id: string; status: string; scope: string; scopeDefaulted: boolean };
    assert.equal(sc.status, 'active');
    assert.equal(sc.scope, 'project');
    assert.equal(sc.scopeDefaulted, true);
    assert.match(textOf(added), /live now/);

    // Same memory again: deduped.
    const again = await call(client, 'memory_add', { title: 'Staging DB port', body: 'Staging Postgres listens on 5433, not 5432.', kind: 'gotcha' });
    assert.equal((again.structuredContent as { duplicate: boolean }).duplicate, true);

    // Global memory → suggested.
    const global = await call(client, 'memory_add', { title: 'User likes tabs', body: '', kind: 'preference', scope: 'global' });
    assert.equal((global.structuredContent as { status: string }).status, 'suggested');
    assert.match(textOf(global), /inbox/);

    // memory_search finds it; rules are searchable too.
    const found = await call(client, 'memory_search', { query: 'postgres port' });
    const results = (found.structuredContent as { results: Array<{ id: string }> }).results;
    assert.equal(results[0]?.id, sc.id);
    assert.match(textOf(found), /5433/);
    const rules = await call(client, 'memory_search', { query: 'pnpm', type: 'rule' });
    assert.equal((rules.structuredContent as { results: unknown[] }).results.length, 1);
    const none = await call(client, 'memory_search', { query: 'kubernetes' });
    assert.match(textOf(none), /No memory items/);

    // rule_add: unprompted → suggested; userRequested at workspace → live with notice.
    const unprompted = await call(client, 'rule_add', { title: 'Run just fmt', body: '', scope: 'project', userRequested: false, appliesTo: ['codex'] });
    assert.equal((unprompted.structuredContent as { status: string }).status, 'suggested');
    const asked = await call(client, 'rule_add', { title: 'Never touch migrations/', body: 'generated', scope: 'workspace', userRequested: true });
    assert.equal((asked.structuredContent as { decision: string }).decision, 'notice');

    // knowledge_update supersedes; knowledge_forget tombstones.
    const upd = await call(client, 'knowledge_update', { id: sc.id, body: 'Staging Postgres listens on 6543 now.' });
    const newId = (upd.structuredContent as { id: string }).id;
    assert.notEqual(newId, sc.id);
    const forgot = await call(client, 'knowledge_forget', { id: newId, reason: 'staging was retired' });
    assert.match(textOf(forgot), /Forgot/);

    // Errors come back as tool errors, not protocol failures.
    const missing = await call(client, 'knowledge_forget', { id: 'k_NOPE' });
    assert.equal(missing.isError, true);
    assert.match(textOf(missing), /not_found/);
    const badScope = await call(client, 'memory_add', { title: 'x', body: 'y', kind: 'fact', scope: 'team' });
    assert.equal(badScope.isError, true);

    // Not-yet-available tools say so clearly.
    const hist = await call(client, 'history_search', { query: 'anything' });
    assert.equal((hist.structuredContent as { available: boolean }).available, false);
    assert.match(textOf(hist), /not available yet/);
    const brief = await call(client, 'handoff_brief', { sessionId: 's_X' });
    assert.match(textOf(brief), /not available yet/);
  } finally {
    await client.close();
  }

  // The node sees everything the server wrote (same database file).
  const store = new KnowledgeStore({ path: dbPath, machineId: M1 });
  try {
    const inbox = listInbox(store, { sessionId: S1 });
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0]!.agent, 'codex');
    assert.deepEqual(inbox[0]!.counts, { memories: 1, rules: 2, forgets: 0 });
    const live = store.visible(CTX, 'memory');
    assert.deepEqual(live, [], 'the updated memory was forgotten, the original superseded');
  } finally {
    store.close();
    tmp.cleanup();
  }
});
