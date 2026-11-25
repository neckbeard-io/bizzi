import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  MCP_SERVER_ENTRY,
  MCP_SERVER_NAME,
  RULES_PREAMBLE,
  TOOLS_NOTE,
  approxTokens,
  buildKnowledgeDigest,
  buildSystemPromptAppend,
  knowledgeForSession,
  mcpServerSpec,
} from '../src/index.ts';
import type { KnowledgeStore, NewKnowledgeItem } from '../src/index.ts';
import { CTX, M1, P1, W1, memStore } from './helpers.ts';

function put(store: KnowledgeStore, over: Partial<NewKnowledgeItem> & Pick<NewKnowledgeItem, 'title'>) {
  return store.insert({
    type: 'memory',
    kind: 'fact',
    scope: { level: 'project', projectId: P1 },
    body: '',
    source: { via: 'ui', machineId: M1 },
    status: 'active',
    ...over,
  });
}

test('rules come in full, general → specific, with the override note', () => {
  const { store } = memStore();
  put(store, { type: 'rule', kind: undefined, title: 'Never touch migrations/', scope: { level: 'workspace', workspaceId: W1 }, body: 'Ask first.\nThey are generated.' });
  put(store, { type: 'rule', kind: undefined, title: 'Use pnpm', scope: { level: 'global' }, body: 'Not npm or yarn.' });
  put(store, { type: 'rule', kind: undefined, title: 'Codex: run just fmt', scope: { level: 'global' }, appliesTo: ['codex'] });
  const text = buildSystemPromptAppend(CTX, { store });
  assert.ok(text.includes(RULES_PREAMBLE));
  assert.ok(text.includes('more specific'));
  const g = text.indexOf('Use pnpm');
  const w = text.indexOf('Never touch migrations/');
  assert.ok(g > 0 && w > g, 'global before workspace');
  assert.ok(text.includes('  They are generated.'), 'multi-line bodies kept in full');
  assert.ok(!text.includes('just fmt'), 'codex-only rule hidden from claude');
  assert.ok(buildSystemPromptAppend({ ...CTX, agent: 'codex' }, { store }).includes('(codex only)'));
  assert.ok(text.includes(TOOLS_NOTE));
  assert.ok(!buildSystemPromptAppend(CTX, { store, includeToolsNote: false }).includes('bizzi-memory tools'));
});

test('memory digest respects the token budget and the entry cap', () => {
  const { store, clock } = memStore();
  for (let i = 0; i < 60; i++) {
    clock.advance(1000);
    put(store, { title: `Fact number ${i}`, body: `detail ${i} `.repeat(30) });
  }
  const d = buildKnowledgeDigest(CTX, { store, memoryTokenBudget: 400, maxMemories: 100 });
  assert.ok(d.memoryTokens <= 400, `memory section ${d.memoryTokens} tokens`);
  assert.ok(d.memories.length > 3 && d.memories.length < 60);
  assert.equal(d.omittedMemories, 60 - d.memories.length);
  assert.equal(d.memories[0]!.item.title, 'Fact number 59', 'most recent first without a query');
  assert.ok(d.text.includes('…'), 'long bodies are excerpted');
  assert.equal(d.approxTokens, approxTokens(d.text));

  const capped = buildKnowledgeDigest(CTX, { store, memoryTokenBudget: 100_000, maxMemories: 5 });
  assert.equal(capped.memories.length, 5);

  const none = buildKnowledgeDigest(CTX, { store, memoryTokenBudget: 10 });
  assert.equal(none.memories.length, 0);
  assert.ok(!none.text.includes('## Memory digest'));
});

test('a query (first prompt) pulls matching memories to the top of the digest', () => {
  const { store, clock } = memStore();
  put(store, { title: 'Flaky e2e test', body: 'checkout e2e flakes when redis is cold' });
  for (let i = 0; i < 5; i++) {
    clock.advance(1000);
    put(store, { title: `Recent note ${i}`, body: 'unrelated', scope: { level: 'workspace', workspaceId: W1 } });
  }
  const d = buildKnowledgeDigest(CTX, { store, query: 'why is the checkout e2e test flaky?' });
  assert.equal(d.memories[0]!.item.title, 'Flaky e2e test');
  assert.equal(d.memories.length, 6, 'non-matching memories still fill the digest');
});

test('empty store still tells the agent about the tools', () => {
  const { store } = memStore();
  const text = buildSystemPromptAppend(CTX, { store });
  assert.ok(text.startsWith('# bizzi knowledge'));
  assert.ok(!text.includes('## Rules'));
  assert.ok(text.includes('memory_search'));
});

test('mcpServerSpec / knowledgeForSession', () => {
  const { store } = memStore();
  assert.ok(existsSync(MCP_SERVER_ENTRY));
  const spec = mcpServerSpec(CTX, { dbPath: '/data/bizzi/knowledge.db' });
  assert.equal(spec.type, 'stdio');
  assert.ok(spec.type === 'stdio');
  assert.equal(spec.command, process.execPath);
  assert.deepEqual(spec.args, [
    MCP_SERVER_ENTRY,
    '--db',
    '/data/bizzi/knowledge.db',
    '--agent',
    'claude',
    '--machine-id',
    CTX.machineId,
    '--project-id',
    CTX.projectId!,
    '--workspace-id',
    CTX.workspaceId!,
    '--session-id',
    CTX.sessionId!,
  ]);
  assert.throws(() => mcpServerSpec(CTX, { dbPath: ':memory:' }), /on-disk/);
  const opts = knowledgeForSession(CTX, { store, dbPath: '/data/k.db' });
  assert.ok(opts.systemPromptAppend.includes('bizzi knowledge'));
  assert.ok(opts.mcpServers?.[MCP_SERVER_NAME]);
  const noMcp = knowledgeForSession(CTX, { store, withMcp: false });
  assert.equal(noMcp.mcpServers, undefined);
  assert.ok(!noMcp.systemPromptAppend.includes('memory_search'));
});

test('Claude sessions skip Claude memories harvested here; other agents and machines keep them (§8)', () => {
  const { store } = memStore();
  const harvested = (title: string, machineId: string, workspaceId: string) =>
    put(store, {
      title,
      tags: ['harvest:claude'],
      source: { via: 'harvest', agent: 'claude', machineId, workspaceId, ref: `claude:/x/${title}.md` },
    });
  harvested('Native here', M1, W1);
  harvested('From another workspace', M1, 'w_ALPHA_OTHER');
  harvested('From another machine', 'm_TWO', 'w_REMOTE');
  put(store, { title: 'Saved through the tool', source: { via: 'tool', agent: 'claude', machineId: M1, workspaceId: W1 } });

  const claude = buildKnowledgeDigest(CTX, { store });
  assert.deepEqual(claude.memories.map((m) => m.item.title).sort(), ['From another machine', 'From another workspace', 'Saved through the tool']);
  assert.equal(claude.omittedMemories, 0, 'native memories are not counted as omitted');
  assert.ok(!claude.text.includes('Native here'));

  assert.equal(buildKnowledgeDigest({ ...CTX, agent: 'codex' }, { store }).memories.length, 4, 'other agents get every memory');
  assert.equal(buildKnowledgeDigest(CTX, { store, includeNative: true }).memories.length, 4);
});
