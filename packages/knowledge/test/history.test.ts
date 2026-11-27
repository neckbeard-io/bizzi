// history_search / handoff_brief: the stdio server reaches the node's history endpoint with the URL and
// token bizzi puts in its environment (mcpServerSpec env), and renders what comes back.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { HistorySearchResult, SessionBrief } from '@bizzi/protocol';
import { HISTORY_TOKEN_ENV, HISTORY_URL_ENV, KnowledgeStore, httpHistorySource, knowledgeForSession } from '../src/index.ts';
import type { KnowledgeContext } from '../src/index.ts';
import { M1, P1, S1, W1, tempDir } from './helpers.ts';

const CTX: KnowledgeContext = { agent: 'claude', machineId: M1, projectId: P1, workspaceId: W1, sessionId: S1 };

const BRIEF: SessionBrief = {
  sessionId: 's_OTHER',
  title: 'Fix the build',
  agent: 'codex',
  status: 'idle',
  workspace: { id: W1, path: '/repo', branch: 'main' },
  createdAt: '2026-11-27T10:00:00.000Z',
  updatedAt: '2026-11-27T11:00:00.000Z',
  asked: { first: 'Fix the build', later: [], prompts: 1 },
  did: { turns: 1, tools: { total: 2, byKind: { shell: 2 }, failed: 0 }, changedFiles: [{ path: 'a.ts', change: 'modified' }], prs: ['#12'] },
  ended: { state: 'idle', stopReason: 'end_turn', lastReply: 'Fixed. Merge it?' },
  open: { approvals: [], questions: [], asks: 'Fixed. Merge it?' },
  text: '# Fix the build (codex, s_OTHER)\n\nPRs mentioned: #12',
  truncated: false,
};

/** A stand-in for the node's /history endpoint. */
async function fakeNode(t: import('node:test').TestContext, token: string) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.statusCode = 401;
        return res.end(JSON.stringify({ error: { code: 'unauthorized', message: 'unauthorized' } }));
      }
      const { method, params } = JSON.parse(body) as { method: string; params: Record<string, unknown> };
      calls.push({ method, params });
      if (method === 'search') {
        const result: HistorySearchResult = {
          hits: [{ sessionId: 's_OTHER', title: 'Fix the build', agent: 'codex', workspaceId: W1, role: 'assistant', seq: 7, ts: '2026-11-27T11:00:00.000Z', snippet: 'the [build] is fixed' }],
          nextOffset: 1,
          fullText: true,
        };
        return res.end(JSON.stringify({ result }));
      }
      if (params.sessionId === 's_OTHER') return res.end(JSON.stringify({ result: { brief: BRIEF } }));
      return res.end(JSON.stringify({ error: { code: 'not_found', message: `no session ${String(params.sessionId)} in this project on this machine` } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/history`, calls };
}

test('history_search and handoff_brief over stdio, through the env bizzi sets', async (t) => {
  const tmp = tempDir();
  t.after(tmp.cleanup);
  const node = await fakeNode(t, 'tok');
  const store = new KnowledgeStore({ path: join(tmp.dir, 'knowledge.db'), machineId: M1 });
  const k = knowledgeForSession(CTX, { store, env: { [HISTORY_URL_ENV]: node.url, [HISTORY_TOKEN_ENV]: 'tok' } });
  store.close();
  const spec = k.mcpServers!['bizzi-memory']!;
  assert.ok(spec.type === 'stdio');
  assert.deepEqual(spec.env, { [HISTORY_URL_ENV]: node.url, [HISTORY_TOKEN_ENV]: 'tok' });
  assert.ok(!(spec.args ?? []).includes('tok'), 'the token never goes on the command line');
  assert.match(k.systemPromptAppend, /history_search/);

  const env = Object.fromEntries(Object.entries({ ...process.env, ...spec.env }).filter((e): e is [string, string] => typeof e[1] === 'string'));
  const client = new Client({ name: 'bizzi-test', version: '0.0.0' });
  await client.connect(new StdioClientTransport({ command: spec.command, args: spec.args ?? [], env, stderr: 'pipe' }));
  t.after(() => client.close());

  const hits = (await client.callTool({ name: 'history_search', arguments: { query: 'build', scope: 'workspace', limit: 1 } })) as CallToolResult;
  assert.equal(hits.isError, undefined);
  const text = hits.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
  assert.match(text, /s_OTHER "Fix the build" \(codex\) .* seq 7 assistant: the \[build\] is fixed/);
  assert.match(text, /More: offset 1/);
  assert.deepEqual(node.calls[0], { method: 'search', params: { query: 'build', scope: 'workspace', limit: 1 } });

  const brief = (await client.callTool({ name: 'handoff_brief', arguments: { sessionId: 's_OTHER' } })) as CallToolResult;
  assert.equal((brief.structuredContent as unknown as SessionBrief).did.prs[0], '#12');
  assert.match(brief.content.map((c) => (c.type === 'text' ? c.text : '')).join(''), /PRs mentioned: #12/);
  const missing = (await client.callTool({ name: 'handoff_brief', arguments: { sessionId: 's_ELSEWHERE' } })) as CallToolResult;
  assert.equal(missing.isError, true);
  assert.match(missing.content.map((c) => (c.type === 'text' ? c.text : '')).join(''), /not_found: no session s_ELSEWHERE in this project/);
});

test('httpHistorySource: a revoked token and an unreachable node are clear errors', async (t) => {
  const node = await fakeNode(t, 'right');
  await assert.rejects(httpHistorySource(node.url, 'wrong').search({ query: 'x' }), /token was revoked/);
  await assert.rejects(httpHistorySource('http://127.0.0.1:9/history', 't').brief('s_1'), /unreachable/);
});
