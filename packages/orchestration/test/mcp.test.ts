import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import os from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createNode, type BizziNode } from '@bizzi/core';
import { FakeAdapter, defaultScript, type FakeScript } from '@bizzi/core/testing';
import type { McpServerSpec, SessionInfo } from '@bizzi/protocol';
import { createOrchestrationExtension, MCP_SERVER_NAME, type OrchestrationExtension } from '../src/index.ts';

function tempDir(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(os.tmpdir(), 'bizzi-orch-'));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

async function waitFor<T>(fn: () => T | undefined | false, what: string, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** "/review <path>": a reviewer that reads a file, edits it and reports. Everything else: the default script. */
const script: FakeScript = (input, ctx) => {
  const text = input.find((b) => b.type === 'text')?.text ?? '';
  if (text.startsWith('/review ')) {
    const path = text.slice(8).trim();
    return [
      { type: 'tool', title: `cat ${path}`, kind: 'read', name: 'Read' },
      { type: 'tool', title: `edit ${path}`, kind: 'edit', name: 'Edit' },
      { type: 'emit', event: { type: 'file.changed', data: { path, change: 'modified', diff: `@@ -1 +1 @@\n-old\n+new\n` } } },
      { type: 'text', text: `Found 1 issue in ${path}: off-by-one in the loop. Fixed it.` },
    ];
  }
  return defaultScript(input, ctx);
};

interface Harness {
  node: BizziNode;
  ext: OrchestrationExtension;
  claude: FakeAdapter;
  codex: FakeAdapter;
  repo: string;
}

async function harness(t: import('node:test').TestContext): Promise<Harness> {
  const tmp = tempDir();
  const claude = new FakeAdapter({ script });
  const codex = new FakeAdapter({ agent: 'codex', script, capabilities: { permissionModes: ['read-only', 'untrusted', 'auto', 'full-access'] } });
  const ext = createOrchestrationExtension();
  const node = await createNode({ dataDir: join(tmp.path, 'data'), adapters: [claude, codex], version: '0', interruptGraceMs: 200, extensions: [ext] });
  t.after(async () => {
    await node.close();
    tmp.cleanup();
  });
  const repo = join(tmp.path, 'repo');
  mkdirSync(repo);
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q'], { cwd: repo, env });
  writeFileSync(join(repo, 'a.ts'), 'old\n');
  execFileSync('git', ['add', '.'], { cwd: repo, env });
  execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init'], { cwd: repo, env });
  return { node, ext, claude, codex, repo: realpathSync(repo) };
}

/** Start a parent session and connect an MCP client with the spec its agent was given. */
async function parentWithClient(t: import('node:test').TestContext, h: Harness, extra: Record<string, unknown> = {}) {
  const { workspace } = await h.node.call('workspace.create', { path: h.repo });
  const { session } = await h.node.call('session.create', { workspaceId: workspace.id, agent: 'claude', ...extra });
  const opts = await waitFor(() => h.claude.starts.find((s) => s.sessionId === session.id), 'parent start');
  const spec = opts.mcpServers?.[MCP_SERVER_NAME] as Extract<McpServerSpec, { type: 'http' }> | undefined;
  assert.ok(spec, 'bizzi-agents injected');
  assert.equal(spec.type, 'http');
  assert.match(opts.systemPromptAppend ?? '', /bizzi-agents tools/);
  const client = await connect(spec);
  t.after(() => client.close());
  return { session, workspace, spec, client };
}

async function connect(spec: Extract<McpServerSpec, { type: 'http' }>): Promise<Client> {
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(spec.url), { requestInit: { headers: spec.headers ?? {} } }));
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<CallToolResult & { structuredContent?: Record<string, unknown> }> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult & { structuredContent?: Record<string, unknown> };
}

function textOf(r: CallToolResult): string {
  return r.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
}

test('bizzi-agents MCP: Claude asks Codex to review in a worktree, waits, reads the findings', async (t) => {
  const h = await harness(t);
  const { session: parent, workspace, client } = await parentWithClient(t, h, { permissionMode: 'acceptEdits' });

  const tools = (await client.listTools()).tools.map((x) => x.name).sort();
  assert.deepEqual(tools, ['machines_list', 'session_interrupt', 'session_read', 'session_send', 'session_start', 'session_stop', 'session_wait', 'sessions_list']);

  const started = await call(client, 'session_start', {
    agent: 'codex',
    prompt: '/review a.ts',
    worktree: 'review/a',
    permissionMode: 'full-access',
  });
  assert.equal(started.isError, undefined, textOf(started));
  const sc = started.structuredContent!;
  const helperId = sc.sessionId as string;
  assert.equal(sc.agent, 'codex');
  assert.equal(sc.scope, 'child');
  assert.equal(sc.depth, 1);
  assert.equal(sc.branch, 'review/a');
  assert.equal(sc.permissionMode, 'auto', 'clamped to the parent (acceptEdits = workspace edits)');
  assert.match(textOf(started), /Note: permission mode full-access is looser/);

  const helper = h.node.sessions.get(helperId).session;
  assert.equal(helper.spawnedBy, parent.id);
  const wt = h.node.workspaces.get(helper.workspaceId);
  assert.equal(wt.kind, 'worktree');
  assert.equal(wt.parentWorkspaceId, workspace.id);
  assert.equal(h.codex.starts.at(-1)?.cwd, wt.path);

  const waited = await call(client, 'session_wait', { sessionId: helperId, until: 'done', timeout: 5 });
  assert.equal(textOf(waited), 'idle: turn finished (end_turn)');
  assert.deepEqual(waited.structuredContent, { sessionId: helperId, state: 'idle', reached: true, reason: 'turn finished (end_turn)' });

  const read = await call(client, 'session_read', { sessionId: helperId });
  const r = read.structuredContent!;
  assert.equal(r.finalMessage, 'Found 1 issue in a.ts: off-by-one in the loop. Fixed it.');
  assert.equal(r.stopReason, 'end_turn');
  assert.deepEqual(r.changedFiles, [{ path: 'a.ts', change: 'modified', diffRef: 'a.ts' }]);
  assert.deepEqual(r.tools, { total: 2, byKind: { read: 1, edit: 1 }, failed: 0, denied: 0 });
  assert.equal(r.transcript, undefined, 'no transcript by default');
  const diff = await call(client, 'session_read', { sessionId: helperId, detail: 'diff', path: 'a.ts' });
  assert.match(String(diff.structuredContent!.diff), /\+new/);

  // Follow-up turn and list.
  const sent = await call(client, 'session_send', { sessionId: helperId, text: 'thanks, anything else?' });
  assert.match(textOf(sent), /turn t_/);
  await call(client, 'session_wait', { sessionId: helperId, timeout: 5 });
  const again = await call(client, 'session_read', { sessionId: helperId, since: r.cursor as number });
  assert.equal(again.structuredContent!.finalMessage, 'echo: thanks, anything else?');
  const list = await call(client, 'sessions_list');
  assert.deepEqual((list.structuredContent!.helpers as { sessionId: string }[]).map((x) => x.sessionId), [helperId]);

  // The user (not the agent) sees the helper nested under the parent.
  const nested = await h.node.call('sessions.list', { spawnedBy: parent.id });
  assert.deepEqual(nested.sessions.map((s: SessionInfo) => s.id), [helperId]);

  await call(client, 'session_interrupt', { sessionId: helperId });
  const stopped = await call(client, 'session_stop', { sessionId: helperId });
  assert.equal(textOf(stopped), 'Stopped.');
  assert.equal(h.node.sessions.get(helperId).session.status, 'ended');
});

test('bizzi-agents MCP: auth, ownership, guardrail errors and child cascade', async (t) => {
  const h = await harness(t);
  const { session: parent, spec, client } = await parentWithClient(t, h);

  // No / wrong token: 401. Wrong host: 403.
  const post = (headers: Record<string, string>, url = spec.url) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
  assert.equal((await post({})).status, 401);
  assert.equal((await post({ authorization: 'Bearer nope' })).status, 401);
  assert.equal(await rawStatus(spec.url, { ...spec.headers, host: 'evil.example:80' }), 403);
  assert.equal((await fetch(spec.url, { headers: spec.headers ?? {} })).status, 405);

  // A second session's helpers are invisible to the first.
  const { session: other } = await h.node.call('session.create', { workspaceId: parent.workspaceId, agent: 'claude' });
  const otherSpec = (await waitFor(() => h.claude.starts.find((s) => s.sessionId === other.id), 'other start')).mcpServers?.[MCP_SERVER_NAME] as Extract<McpServerSpec, { type: 'http' }>;
  assert.notEqual(otherSpec.headers?.Authorization, spec.headers?.Authorization);
  const otherClient = await connect(otherSpec);
  t.after(() => otherClient.close());
  const mine = await call(client, 'session_start', { agent: 'claude', prompt: '/slow 2000' });
  const helperId = mine.structuredContent!.sessionId as string;
  const denied = await call(otherClient, 'session_stop', { sessionId: helperId });
  assert.equal(denied.isError, true);
  assert.match(textOf(denied), /not_found: no helper/);
  const notHelper = await call(client, 'session_read', { sessionId: other.id });
  assert.equal(notHelper.isError, true);

  // Timeout: reached false, quickly.
  const w = await call(client, 'session_wait', { sessionId: helperId, until: 'done', timeout: 0.05 });
  assert.equal(w.structuredContent!.reached, false);
  assert.match(textOf(w), /^running \(not yet\): still running/);

  // Depth: helpers at the limit don't get the tools; the core refuses deeper starts anyway.
  await h.node.call('orchestration.settings.set', { workspaceId: parent.workspaceId, settings: { maxDepth: 1 } });
  const leaf = await call(client, 'session_start', { agent: 'claude', prompt: 'leaf' });
  const leafId = leaf.structuredContent!.sessionId as string;
  const leafStart = await waitFor(() => h.claude.starts.find((s) => s.sessionId === leafId), 'leaf start');
  assert.equal(leafStart.mcpServers?.[MCP_SERVER_NAME], undefined);
  await expectRejectDepth(h.node, leafId);

  // Concurrency (fail).
  await h.node.call('orchestration.settings.set', { workspaceId: parent.workspaceId, settings: { maxHelpersPerParent: 2 } });
  const over = await call(client, 'session_start', { agent: 'claude', prompt: 'third' });
  assert.equal(over.isError, true);
  assert.match(textOf(over), /conflict: this session already has 2 live helper\(s\) \(max 2\)/);

  // Stopping the parent stops its child helpers and revokes its token.
  await h.node.call('session.stop', { sessionId: parent.id });
  await waitFor(() => h.node.sessions.get(helperId).session.status === 'ended', 'child stopped');
  await waitFor(() => h.node.sessions.get(leafId).session.status === 'ended', 'leaf stopped');
  assert.equal((await post(spec.headers ?? {})).status, 401);
});

/** POST with arbitrary headers (fetch won't override Host). */
function rawStatus(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end('{}');
  });
}

async function expectRejectDepth(node: BizziNode, leafId: string): Promise<void> {
  await assert.rejects(node.orchestration.startHelper(leafId, { agent: 'claude', prompt: 'too deep' }), /depth limit reached \(max 1\)/);
}

test('bizzi-agents: no tools for terminal sessions; tokens are re-minted on restart of the agent process', async (t) => {
  const tmp = tempDir();
  const fake = new FakeAdapter({ modes: ['structured', 'terminal'] });
  const ext = createOrchestrationExtension();
  const node = await createNode({ dataDir: join(tmp.path, 'data'), adapters: [fake], version: '0', extensions: [ext] });
  t.after(async () => {
    await node.close();
    tmp.cleanup();
  });
  assert.match(ext.url ?? '', /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  const { workspace } = await node.call('workspace.create', { path: join(tmp.path, 'ws'), create: true });
  const { session: term } = await node.call('session.create', { workspaceId: workspace.id, agent: 'claude', mode: 'terminal' });
  const termStart = await waitFor(() => fake.starts.find((s) => s.sessionId === term.id), 'terminal start');
  assert.equal(termStart.mcpServers?.[MCP_SERVER_NAME], undefined);

  const { session } = await node.call('session.create', { workspaceId: workspace.id, agent: 'claude' });
  const first = (await waitFor(() => fake.starts.find((s) => s.sessionId === session.id), 'start')).mcpServers?.[MCP_SERVER_NAME] as Extract<McpServerSpec, { type: 'http' }>;
  // Crash, then send again: a new agent process with a new token; the old one is dead.
  await node.call('session.send', { sessionId: session.id, input: [{ type: 'text', text: '/crash' }] });
  await waitFor(() => node.sessions.get(session.id).session.status === 'failed', 'failed');
  await node.call('session.send', { sessionId: session.id, input: [{ type: 'text', text: 'again' }] });
  const second = (await waitFor(() => fake.starts.filter((s) => s.sessionId === session.id)[1], 'restart')).mcpServers?.[MCP_SERVER_NAME] as Extract<McpServerSpec, { type: 'http' }>;
  assert.notEqual(first.headers?.Authorization, second.headers?.Authorization);
  const client = await connect(second);
  t.after(() => client.close());
  assert.equal((await call(client, 'sessions_list')).structuredContent!.helpers instanceof Array, true);
  await assert.rejects(connect(first));
});

test('bizzi-agents: the fake agent calls the tools itself with its own token (/mcp, as in smoke:v12)', async (t) => {
  const h = await harness(t);
  const { workspace } = await h.node.call('workspace.create', { path: h.repo });
  const { session } = await h.node.call('session.create', { workspaceId: workspace.id, agent: 'claude' });
  const events: { type: string; data: any }[] = [];
  const off = h.node.bus.on(`session:${session.id}`, (ev) => events.push(ev));
  t.after(off);
  const run = async (text: string) => {
    const before = events.length;
    await h.node.call('session.send', { sessionId: session.id, input: [{ type: 'text', text }] });
    await waitFor(() => events.slice(before).some((e) => e.type === 'turn.completed'), text);
    return events.slice(before).find((e) => e.type === 'tool.completed')!.data;
  };
  const started = await run('/mcp bizzi-agents session_start {"agent":"codex","prompt":"hi"}');
  assert.equal(started.status, 'ok', started.error);
  const helperId = JSON.parse(started.output).structuredContent.sessionId as string;
  assert.equal(h.node.sessions.get(helperId).session.spawnedBy, session.id);
  const listed = await run('/mcp bizzi-agents sessions_list');
  assert.deepEqual(JSON.parse(listed.output).structuredContent.helpers.map((x: { sessionId: string }) => x.sessionId), [helperId]);
  const missing = await run('/mcp nope sessions_list');
  assert.equal(missing.status, 'error');
  assert.match(missing.error, /no such MCP server/);
});
