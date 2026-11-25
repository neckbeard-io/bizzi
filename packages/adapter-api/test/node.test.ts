// The api agent driven by the real node core: session lifecycle, billing from the provider, interrupt,
// fork, and resume after a node restart.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createNode, nullLogger, type BizziNode } from '@bizzi/core';
import { sessionChannel, type ChannelEvent } from '@bizzi/protocol';
import { ApiChatAdapter, clearDiscovered, type ApiConfigFile } from '../src/index.ts';
import { fakeApi, json, openaiEvents, sse } from './helpers.ts';

async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, what: string, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('core drives an api chat session end to end', async () => {
  clearDiscovered();
  const dir = mkdtempSync(join(tmpdir(), 'bizzi-api-node-'));
  const ws = join(dir, 'ws');
  mkdirSync(ws);
  let posts = 0;
  const server = await fakeApi((req, res) => {
    if (req.method === 'GET') return json(res, 200, { data: [{ id: 'qwen', max_model_len: 8192 }] });
    posts++;
    if (req.body.messages.at(-1).content === 'slow') return sse(res, openaiEvents(['partial']).slice(0, 2), { hang: true });
    return sse(res, openaiEvents([`answer ${posts}`]));
  });
  const config: ApiConfigFile = { providers: { h200: { api: 'openai', baseUrl: `${server.url}/v1`, billing: 'budgetless' } }, defaultModel: 'h200/qwen' };
  const open = (): Promise<BizziNode> =>
    createNode({ dataDir: join(dir, 'data'), adapters: [new ApiChatAdapter({ dataDir: join(dir, 'data'), config, env: {} })], version: '0.0.0-test', machineName: 't', logger: nullLogger });
  let node = await open();
  try {
    const agents = await node.call('agents.list', {});
    const api = agents.agents.find((a) => a.agent === 'api');
    assert.equal(api?.installed, true);
    assert.equal(api?.capabilities?.streaming, 'token');

    const { workspace } = await node.call('workspace.create', { path: ws });
    const { session } = await node.call('session.create', { workspaceId: workspace.id, agent: 'api' });
    const events: ChannelEvent[] = [];
    node.subscribe(sessionChannel(session.id), 0, (ev) => events.push(ev));
    const get = async () => (await node.call('session.get', { sessionId: session.id })).session;

    const { turnId } = await node.call('session.send', { sessionId: session.id, input: [{ type: 'text', text: 'hi' }] });
    await waitFor(() => events.find((e) => e.type === 'turn.completed' && e.data.turnId === turnId), 'turn 1');
    await waitFor(async () => (await get()).status === 'idle', 'idle');
    const info = await get();
    assert.equal(info.model, 'h200/qwen');
    assert.equal(info.billing, 'budgetless');
    assert.equal(info.agentSessionRef, session.id);
    assert.ok(events.some((e) => e.type === 'context.updated' && e.data.window === 8192));

    // Interrupt through the core.
    const slow = await node.call('session.send', { sessionId: session.id, input: [{ type: 'text', text: 'slow' }] });
    await waitFor(() => events.find((e) => e.type === 'message.delta' && e.data.text === 'partial'), 'partial delta');
    await node.call('session.interrupt', { sessionId: session.id });
    const done = await waitFor(() => events.find((e) => e.type === 'turn.completed' && e.data.turnId === slow.turnId), 'interrupted turn');
    assert.equal(done.type === 'turn.completed' && done.data.stopReason, 'interrupted');

    // Native fork keeps the conversation.
    const fork = await node.call('session.fork', { sessionId: session.id });
    const forkEvents: ChannelEvent[] = [];
    node.subscribe(sessionChannel(fork.session.id), 0, (ev) => forkEvents.push(ev));
    await waitFor(() => !forkEvents.some((e) => e.type === 'agent.raw') && forkEvents.some((e) => e.type === 'session.info'), 'fork started');
    assert.ok(!forkEvents.some((e) => e.type === 'agent.raw'), 'native fork, not a fresh start');

    // Restart the node: the session comes back idle and continues its conversation.
    await node.close();
    node = await open();
    await waitFor(async () => (await node.call('session.get', { sessionId: session.id })).session.status === 'idle', 'idle after restart');
    const after: ChannelEvent[] = [];
    node.subscribe(sessionChannel(session.id), 0, (ev) => after.push(ev));
    const t3 = await node.call('session.send', { sessionId: session.id, input: [{ type: 'text', text: 'still there?' }] });
    await waitFor(() => after.find((e) => e.type === 'turn.completed' && e.data.turnId === t3.turnId), 'turn after restart');
    const last = server.requests.filter((r) => r.method === 'POST').at(-1)!;
    assert.deepEqual(
      last.body.messages.map((m: { content: string }) => m.content),
      ['hi', 'answer 1', 'slow', 'partial', 'still there?'],
    );
  } finally {
    await node.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
