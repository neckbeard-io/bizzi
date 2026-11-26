import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { BizziError, type StartSessionOptions } from '@bizzi/protocol';
import { ApiChatAdapter, clearDiscovered, createAdapters, type ApiAdapterOptions, type ApiConfigFile } from '../src/index.ts';
import { anthropicEvents, captureLogger, ctx, fakeApi, json, openaiEvents, Recorder, sse, type Handler } from './helpers.ts';

const KEY = 'sk-test-0123456789abcdef';

let dir: string;
let server: Awaited<ReturnType<typeof fakeApi>> | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bizzi-api-'));
  clearDiscovered();
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function setup(handler: Handler, extraOf: (url: string) => ApiConfigFile = () => ({}), opts: Partial<ApiAdapterOptions> = {}) {
  server = await fakeApi(handler);
  const extra = extraOf(server.url);
  const config: ApiConfigFile = {
    ...extra,
    providers: {
      claude: { api: 'anthropic', baseUrl: `${server.url}/anthropic/v1`, apiKeyEnv: 'TEST_ANTHROPIC_KEY', billing: 'metered' },
      local: { api: 'openai', baseUrl: `${server.url}/openai/v1`, billing: 'budgetless' },
      keyed: { api: 'openai', baseUrl: `${server.url}/openai/v1`, apiKeyEnv: 'TEST_OPENAI_KEY' },
      ...extra.providers,
    },
  };
  const adapter = new ApiChatAdapter({ dataDir: dir, config, env: {}, retryBaseMs: 1, ...opts });
  return { adapter, server };
}

function startOpts(o: Partial<StartSessionOptions> = {}): StartSessionOptions {
  return { sessionId: 's_one', mode: 'structured', cwd: dir, env: { TEST_ANTHROPIC_KEY: KEY, TEST_OPENAI_KEY: KEY }, ...o };
}

const text = (t: string) => [{ type: 'text' as const, text: t }];

describe('anthropic wire format', () => {
  test('streams text and thinking, reports usage, context and billing, replays thinking blocks', async () => {
    let turn = 0;
    const { adapter, server } = await setup(async (req, res) => {
      if (req.method === 'GET' && req.path === '/anthropic/v1/models/claude-x') return json(res, 200, { id: 'claude-x', max_input_tokens: 200_000, max_tokens: 64_000 });
      if (req.path === '/anthropic/v1/messages') {
        turn++;
        return sse(res, turn === 1 ? anthropicEvents(['Hel', 'lo'], { thinking: 'hmm', signature: 'sig-1', usage: { in: 100, out: 7, cacheRead: 50 } }) : anthropicEvents(['again']));
      }
      json(res, 404, { error: { message: 'nope' } });
    });
    const rec = new Recorder();
    const s = await adapter.start(startOpts({ model: 'claude/claude-x', systemPromptAppend: 'Rules: be brief.' }), rec.emit, ctx);
    assert.equal(s.agentSessionRef(), 's_one');
    assert.deepEqual(rec.of('session.info')[0], { agentSessionRef: 's_one', model: 'claude/claude-x' });
    const acct = rec.of('account.usage')[0]!;
    assert.equal(acct.agent, 'api');
    assert.equal(acct.billing, 'metered');
    assert.match(acct.accountId, /^claude:[0-9a-f]{12}$/);
    assert.ok(!JSON.stringify(rec.events).includes(KEY), 'key never in events');

    await s.send('t1', text('hi'));
    const done = await rec.waitFor('turn.completed');
    assert.equal(done.stopReason, 'end_turn');
    assert.deepEqual(done.usage, { inputTokens: 100, outputTokens: 7, cacheReadTokens: 50, contextWindow: 200_000 });
    assert.deepEqual(
      rec.of('message.delta').map((d) => d.text),
      ['Hel', 'lo'],
    );
    assert.deepEqual(rec.of('message.completed'), [{ messageId: 't1-a', role: 'assistant', text: 'Hello' }]);
    assert.deepEqual(rec.of('reasoning.completed'), [{ messageId: 't1-r', text: 'hmm' }]);
    const c = rec.of('context.updated')[0]!;
    assert.equal(c.used, 157);
    assert.equal(c.window, 200_000);
    assert.equal(c.categories?.[0]?.id, 'bizzi');
    assert.deepEqual(rec.of('usage.updated').at(-1), { inputTokens: 100, outputTokens: 7, cacheReadTokens: 50, contextWindow: 200_000 });

    const post = server.requests.find((r) => r.method === 'POST')!;
    assert.equal(post.headers['x-api-key'], KEY);
    assert.equal(post.headers['anthropic-version'], '2023-06-01');
    assert.equal(post.headers.authorization, undefined);
    assert.equal(post.body.model, 'claude-x');
    assert.equal(post.body.stream, true);
    assert.equal(post.body.max_tokens, 32_000, 'discovered output cap, capped');
    assert.equal(post.body.system, 'Rules: be brief.');
    assert.deepEqual(post.body.messages, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);

    await s.send('t2', text('more'));
    await rec.waitFor('turn.completed', (d) => d.turnId === 't2');
    const second = server.requests.filter((r) => r.method === 'POST')[1]!;
    assert.deepEqual(second.body.messages[1], {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'hmm', signature: 'sig-1' },
        { type: 'text', text: 'Hello' },
      ],
    });
    assert.deepEqual(rec.of('usage.updated').at(-1), { inputTokens: 110, outputTokens: 12, cacheReadTokens: 50, contextWindow: 200_000 });
    // Discovery ran once for the model.
    assert.equal(server.requests.filter((r) => r.method === 'GET').length, 1);
    await s.stop();
  });

  test('effort goes to output_config; refusal and max_tokens stop reasons', async () => {
    let n = 0;
    const { adapter, server } = await setup((req, res) => {
      if (req.method === 'GET') return json(res, 404, {});
      n++;
      return sse(res, anthropicEvents(['x'], { stop: n === 1 ? 'refusal' : 'max_tokens' }));
    });
    const rec = new Recorder();
    const s = await adapter.start(startOpts({ model: 'claude/claude-x', effort: 'low' }), rec.emit, ctx);
    await s.send('t1', text('a'));
    assert.equal((await rec.waitFor('turn.completed')).stopReason, 'refusal');
    await s.send('t2', text('b'));
    assert.equal((await rec.waitFor('turn.completed', (d) => d.turnId === 't2')).stopReason, 'other');
    assert.equal(rec.of('error').at(-1)?.code, 'max_tokens');
    const post = server.requests.find((r) => r.method === 'POST')!;
    assert.deepEqual(post.body.output_config, { effort: 'low' });
    assert.equal(post.body.max_tokens, 16_000, 'default output cap without discovery');
  });

  test('a stream error event fails the turn without leaking the key', async () => {
    const { adapter } = await setup((req, res) => {
      if (req.method === 'GET') return json(res, 404, {});
      return sse(res, [
        anthropicEvents([])[0]!,
        { event: 'error', data: { type: 'error', error: { type: 'overloaded_error', message: `Overloaded (key ${KEY})` } } },
      ]);
    });
    const rec = new Recorder();
    const lines: string[] = [];
    const s = await adapter.start(startOpts({ model: 'claude/claude-x' }), rec.emit, { logger: captureLogger(lines) });
    await s.send('t1', text('a'));
    const done = await rec.waitFor('turn.completed');
    assert.equal(done.stopReason, 'error');
    assert.match(done.error!, /Overloaded/);
    assert.ok(!JSON.stringify(rec.events).includes(KEY));
    assert.ok(!lines.join('\n').includes(KEY));
  });
});

describe('openai-compatible wire format', () => {
  test('streams content and reasoning, usage chunk, system message, no auth for a keyless provider', async () => {
    const { adapter, server } = await setup((req, res) => {
      if (req.method === 'GET' && req.path === '/openai/v1/models') return json(res, 200, { data: [{ id: 'qwen', max_model_len: 131072 }] });
      if (req.path === '/openai/v1/chat/completions') return sse(res, openaiEvents(['Hi', ' there'], { reasoning: 'think', usage: { prompt: 30, completion: 6, cached: 10 } }));
      json(res, 404, {});
    });
    const rec = new Recorder();
    const s = await adapter.start(startOpts({ model: 'local/qwen', systemPromptAppend: 'sys' }), rec.emit, ctx);
    assert.equal(rec.of('account.usage')[0]?.billing, 'budgetless');
    assert.equal(rec.of('account.usage')[0]?.accountId, 'local');
    await s.send('t1', text('hello'));
    const done = await rec.waitFor('turn.completed');
    assert.equal(done.stopReason, 'end_turn');
    assert.deepEqual(done.usage, { inputTokens: 20, outputTokens: 6, cacheReadTokens: 10, contextWindow: 131072 });
    assert.equal(rec.of('message.completed')[0]?.text, 'Hi there');
    assert.equal(rec.of('reasoning.completed')[0]?.text, 'think');
    assert.equal(rec.of('context.updated')[0]?.used, 36);
    const post = server.requests.find((r) => r.method === 'POST')!;
    assert.equal(post.headers.authorization, undefined);
    assert.deepEqual(post.body.stream_options, { include_usage: true });
    assert.equal(post.body.max_tokens, undefined, 'no output cap unless configured');
    assert.deepEqual(post.body.messages, [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
    ]);
    await s.send('t2', text('again'));
    await rec.waitFor('turn.completed', (d) => d.turnId === 't2');
    const second = server.requests.filter((r) => r.method === 'POST')[1]!;
    assert.deepEqual(second.body.messages.slice(1), [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'Hi there' },
      { role: 'user', content: 'again' },
    ]);
  });

  test('bearer key, images as data URLs, provider body and reasoning_effort, max_completion_tokens', async () => {
    const { adapter, server } = await setup(
      (req, res) => (req.method === 'GET' ? json(res, 404, {}) : sse(res, openaiEvents(['ok']))),
      (url) => ({
        providers: {
          keyed: {
            api: 'openai',
            baseUrl: `${url}/openai/v1`,
            apiKeyEnv: 'TEST_OPENAI_KEY',
            maxTokensParam: 'max_completion_tokens',
            maxOutputTokens: 500,
            body: { chat_template_kwargs: { enable_thinking: false } },
            models: [{ id: 'm1', price: { inputPerMTok: 1, outputPerMTok: 2 } }],
          },
        },
      }),
    );
    const fresh = adapter;
    const rec = new Recorder();
    const s = await fresh.start(startOpts({ model: 'keyed/m1', effort: 'high' }), rec.emit, ctx);
    await s.send('t1', [
      { type: 'text', text: 'look' },
      { type: 'image', mediaType: 'image/png', dataBase64: 'AAAA' },
    ]);
    const done = await rec.waitFor('turn.completed');
    assert.equal(done.usage?.costUsd, (12 * 1 + 4 * 2) / 1e6);
    const post = server.requests.find((r) => r.method === 'POST')!;
    assert.equal(post.headers.authorization, `Bearer ${KEY}`);
    assert.equal(post.body.reasoning_effort, 'high');
    assert.equal(post.body.max_completion_tokens, 500);
    assert.deepEqual(post.body.chat_template_kwargs, { enable_thinking: false });
    assert.deepEqual(post.body.messages[0].content, [
      { type: 'text', text: 'look' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ]);
    assert.equal(fresh.capabilities('structured').usage, 'tokens+cost');
  });

  test('retries 503 (honoring retry-after), then succeeds; 401 fails at once with the message', async () => {
    let n = 0;
    const { adapter, server } = await setup((req, res) => {
      if (req.method === 'GET') return json(res, 404, {});
      n++;
      if (req.body.model === 'bad') return json(res, 401, { error: { message: `invalid key ${KEY}` } });
      if (n === 1) return json(res, 503, { error: { message: 'busy' } }, { 'retry-after-ms': '5' });
      return sse(res, openaiEvents(['fine']));
    });
    const rec = new Recorder();
    const s = await adapter.start(startOpts({ model: 'keyed/good' }), rec.emit, ctx);
    await s.send('t1', text('a'));
    assert.equal((await rec.waitFor('turn.completed')).stopReason, 'end_turn');
    assert.equal(server.requests.filter((r) => r.method === 'POST').length, 2);

    await s.set!({ model: 'keyed/bad' });
    await s.send('t2', text('b'));
    const failed = await rec.waitFor('turn.completed', (d) => d.turnId === 't2');
    assert.equal(failed.stopReason, 'error');
    assert.equal(failed.error, '401 invalid key ***');
    assert.equal(server.requests.filter((r) => r.method === 'POST').length, 3, 'no retry on 401');
    assert.equal(rec.of('error').at(-1)?.code, 'api_error');

    // The failed message isn't kept, so the next request doesn't repeat it.
    await s.set!({ model: 'keyed/good' });
    await s.send('t3', text('c'));
    await rec.waitFor('turn.completed', (d) => d.turnId === 't3');
    const last = server.requests.filter((r) => r.method === 'POST').at(-1)!;
    assert.deepEqual(
      last.body.messages.map((m: { content: string }) => m.content),
      ['a', 'fine', 'c'],
    );
  });

  test('a mid-stream error chunk fails the turn and keeps the partial reply', async () => {
    const { adapter } = await setup((req, res) =>
      req.method === 'GET'
        ? json(res, 404, {})
        : sse(res, [openaiEvents(['par'])[1]!, { data: { error: { message: 'upstream died', code: 502 } } }]),
    );
    const rec = new Recorder();
    const s = await adapter.start(startOpts({ model: 'local/qwen' }), rec.emit, ctx);
    await s.send('t1', text('a'));
    const done = await rec.waitFor('turn.completed');
    assert.equal(done.stopReason, 'error');
    assert.equal(done.error, 'upstream died');
    assert.equal(rec.of('message.completed')[0]?.text, 'par');
  });
});

describe('interrupt, stop and timeouts', () => {
  test('interrupt aborts the request, completes the turn as interrupted and keeps the partial text', async () => {
    const { adapter, server } = await setup((req, res) => {
      if (req.method === 'GET') return json(res, 404, {});
      if (server.requests.filter((r) => r.method === 'POST').length === 1) return sse(res, openaiEvents(['partial ']).slice(0, 2), { hang: true });
      return sse(res, openaiEvents(['next']));
    });
    const rec = new Recorder();
    const s = await adapter.start(startOpts({ model: 'local/qwen' }), rec.emit, ctx);
    await s.send('t1', text('long task'));
    await rec.waitFor('message.delta');
    await assert.rejects(s.send('tx', text('too soon')), (e: unknown) => e instanceof BizziError && e.code === 'conflict');
    await s.interrupt();
    const done = await rec.waitFor('turn.completed');
    assert.equal(done.stopReason, 'interrupted');
    assert.equal(rec.of('message.completed')[0]?.text, 'partial ');
    await s.send('t2', text('go on'));
    await rec.waitFor('turn.completed', (d) => d.turnId === 't2');
    const second = server.requests.filter((r) => r.method === 'POST')[1]!;
    assert.deepEqual(
      second.body.messages.map((m: { role: string; content: string }) => `${m.role}:${m.content}`),
      ['user:long task', 'assistant:partial ', 'user:go on'],
    );
  });

  test('stop during a turn completes it as interrupted', async () => {
    const { adapter } = await setup((req, res) => (req.method === 'GET' ? json(res, 404, {}) : sse(res, openaiEvents(['x']).slice(0, 2), { hang: true })));
    const rec = new Recorder();
    const s = await adapter.start(startOpts({ model: 'local/qwen' }), rec.emit, ctx);
    await s.send('t1', text('a'));
    await rec.waitFor('message.delta');
    await s.stop();
    assert.equal(rec.of('turn.completed')[0]?.stopReason, 'interrupted');
    await assert.rejects(s.send('t2', text('b')), /stopped/);
  });

  test('a stalled stream fails after the idle timeout', async () => {
    const { adapter } = await setup((req, res) => (req.method === 'GET' ? json(res, 404, {}) : sse(res, openaiEvents(['x']).slice(0, 2), { hang: true })), undefined, { idleTimeoutMs: 80 });
    const rec = new Recorder();
    const s = await adapter.start(startOpts({ model: 'local/qwen' }), rec.emit, ctx);
    await s.send('t1', text('a'));
    const done = await rec.waitFor('turn.completed');
    assert.equal(done.stopReason, 'error');
    assert.match(done.error!, /stalled/);
  });

  test('maxConcurrent queues requests to a provider', async () => {
    let inFlight = 0;
    let peak = 0;
    const { adapter } = await setup(
      async (req, res) => {
        if (req.method === 'GET') return json(res, 404, {});
        inFlight++;
        peak = Math.max(peak, inFlight);
        await sse(res, openaiEvents(['a', 'b', 'c']), { delayMs: 10 });
        inFlight--;
      },
      (url) => ({ providers: { solo: { api: 'openai', baseUrl: `${url}/openai/v1`, maxConcurrent: 1 } } }),
    );
    const fresh = adapter;
    const recs = [new Recorder(), new Recorder(), new Recorder()];
    const sessions = await Promise.all(recs.map((r, i) => fresh.start(startOpts({ sessionId: `s_c${i}`, model: 'solo/m' }), r.emit, ctx)));
    await Promise.all(sessions.map((s, i) => s.send(`t${i}`, text('go'))));
    await Promise.all(recs.map((r) => r.waitFor('turn.completed')));
    assert.equal(peak, 1);
    assert.ok(recs.every((r) => r.of('turn.completed')[0]?.stopReason === 'end_turn'));
  });
});

describe('sessions: keys, resume, fork, model switch', () => {
  test('a missing key fails the start; the session env (agent secrets) supplies it', async () => {
    const { adapter } = await setup((_req, res) => json(res, 404, {}));
    await assert.rejects(
      adapter.start(startOpts({ model: 'claude/x', env: {} }), new Recorder().emit, ctx),
      (e: unknown) => e instanceof BizziError && e.code === 'agent_unavailable' && /TEST_ANTHROPIC_KEY/.test(e.message),
    );
    const s = await adapter.start(startOpts({ model: 'claude/x', env: { TEST_ANTHROPIC_KEY: KEY } }), new Recorder().emit, ctx);
    await s.stop();
    const fromNode = new ApiChatAdapter({ dataDir: dir, config: adapter.options.config!, env: { TEST_ANTHROPIC_KEY: KEY } });
    await (await fromNode.start(startOpts({ sessionId: 's_two', model: 'claude/x', env: {} }), new Recorder().emit, ctx)).stop();
  });

  test('unknown models are bad requests', async () => {
    const { adapter } = await setup((_req, res) => json(res, 404, {}));
    await assert.rejects(adapter.start(startOpts({ model: 'nope/x' }), new Recorder().emit, ctx), (e: unknown) => e instanceof BizziError && e.code === 'bad_request');
  });

  test('resume after a restart (new adapter, same data dir) and fork keep the conversation', async () => {
    const { adapter, server } = await setup((req, res) => (req.method === 'GET' ? json(res, 404, {}) : sse(res, openaiEvents([`reply${server.requests.filter((r) => r.method === 'POST').length}`]))));
    const rec = new Recorder();
    const s = await adapter.start(startOpts({ model: 'local/qwen', effort: 'low' }), rec.emit, ctx);
    await s.send('t1', text('first'));
    await rec.waitFor('turn.completed');
    await s.stop();
    assert.equal(adapter.capabilities('structured').resumeAfterNodeRestart, true);
    const file = join(dir, 'api-chat', 's_one.json');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.ok(!readFileSync(file, 'utf8').includes(KEY));

    const again = new ApiChatAdapter({ dataDir: dir, config: adapter.options.config!, env: {} });
    const rec2 = new Recorder();
    const resumed = await again.start(startOpts({ resumeRef: 's_one' }), rec2.emit, ctx);
    assert.deepEqual(rec2.of('session.info')[0], { agentSessionRef: 's_one', model: 'local/qwen', effort: 'low' });
    await resumed.send('t2', text('second'));
    await rec2.waitFor('turn.completed');
    const post = server.requests.filter((r) => r.method === 'POST').at(-1)!;
    assert.deepEqual(
      post.body.messages.map((m: { content: string }) => m.content),
      ['first', 'reply1', 'second'],
    );
    assert.equal(post.body.reasoning_effort, 'low');

    const rec3 = new Recorder();
    const fork = await again.start(startOpts({ sessionId: 's_fork', resumeRef: 's_one', fork: true }), rec3.emit, ctx);
    assert.equal(fork.agentSessionRef(), 's_fork');
    await fork.send('t3', text('branch'));
    await rec3.waitFor('turn.completed');
    const forked = server.requests.filter((r) => r.method === 'POST').at(-1)!;
    assert.equal(forked.body.messages.length, 5);
    // The source conversation is unchanged by the fork.
    const src = JSON.parse(readFileSync(file, 'utf8')) as { messages: unknown[] };
    assert.equal(src.messages.length, 4);
    assert.deepEqual(readdirSync(join(dir, 'api-chat')).sort(), ['s_fork.json', 's_one.json']);

    await assert.rejects(again.start(startOpts({ resumeRef: 'missing' }), new Recorder().emit, ctx), (e: unknown) => e instanceof BizziError && e.code === 'not_found');
    await assert.rejects(again.start(startOpts({ resumeRef: '../etc/passwd' }), new Recorder().emit, ctx), (e: unknown) => e instanceof BizziError && e.code === 'not_found');
  });

  test('switching from an anthropic to an openai provider mid-session flattens the history to text', async () => {
    const { adapter, server } = await setup((req, res) => {
      if (req.method === 'GET') return json(res, 404, {});
      if (req.path.startsWith('/anthropic')) return sse(res, anthropicEvents(['from claude'], { thinking: 't', signature: 's' }));
      return sse(res, openaiEvents(['from local']));
    });
    const rec = new Recorder();
    const s = await adapter.start(startOpts({ model: 'claude/c' }), rec.emit, ctx);
    await s.send('t1', text('q1'));
    await rec.waitFor('turn.completed');
    await s.set!({ model: 'local/qwen' });
    assert.deepEqual(rec.of('session.info').at(-1), { model: 'local/qwen' });
    assert.deepEqual(
      rec.of('account.usage').map((a) => a.billing),
      ['metered', 'budgetless'],
    );
    await s.send('t2', text('q2'));
    await rec.waitFor('turn.completed', (d) => d.turnId === 't2');
    const post = server.requests.filter((r) => r.method === 'POST').at(-1)!;
    assert.equal(post.path, '/openai/v1/chat/completions');
    assert.deepEqual(post.body.messages, [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'from claude' },
      { role: 'user', content: 'q2' },
    ]);
    await assert.rejects(s.set!({ permissionMode: 'plan' }), (e: unknown) => e instanceof BizziError && e.code === 'unsupported');
  });

  test('file inputs are attached as text; binary files are refused', async () => {
    const { adapter, server } = await setup((req, res) => (req.method === 'GET' ? json(res, 404, {}) : sse(res, openaiEvents(['ok']))));
    writeFileSync(join(dir, 'notes.md'), '# Notes\nhello');
    writeFileSync(join(dir, 'blob.bin'), Buffer.from([1, 0, 2]));
    const rec = new Recorder();
    const s = await adapter.start(startOpts({ model: 'local/qwen' }), rec.emit, ctx);
    await assert.rejects(s.send('t0', [{ type: 'file', path: 'blob.bin' }]), /binary/);
    await s.send('t1', [{ type: 'file', path: 'notes.md' }]);
    await rec.waitFor('turn.completed');
    const post = server.requests.find((r) => r.method === 'POST')!;
    assert.match(post.body.messages[0].content, /^File notes\.md:\n```\n# Notes\nhello\n```$/);
  });
});

describe('adapter surface', () => {
  test('capabilities, probe and createAdapters', async () => {
    const a = createAdapters({ dataDir: dir })[0]!;
    assert.equal(a.agent, 'api');
    const caps = a.capabilities('structured');
    assert.deepEqual(caps.modes, ['structured']);
    assert.equal(caps.streaming, 'token');
    assert.equal(caps.interrupt, true);
    assert.equal(caps.steer, false);
    assert.equal(caps.approvals, 'none');
    assert.equal(caps.mcpInjection, 'none');
    assert.equal(caps.models, 'dynamic');
    assert.equal(caps.usage, 'tokens');
    assert.deepEqual(a.capabilities('terminal').modes, []);
    const probe = await new ApiChatAdapter({ dataDir: dir, env: {} }).probe();
    assert.equal(probe.installed, true);
    assert.equal(probe.auth, 'unknown');
    assert.equal(probe.billing, 'metered');
    assert.ok(probe.notes?.some((n) => n.includes('anthropic, openai, gemini, openrouter')));

    // A file that lists every provider's models gives a fixed model list; edits are picked up.
    writeFileSync(
      join(dir, 'api-providers.json'),
      JSON.stringify({
        providers: { anthropic: null, openai: null, gemini: null, openrouter: null, h200: { api: 'openai', baseUrl: 'http://127.0.0.1:9/v1', models: ['qwen'], billing: 'budgetless' } },
      }),
    );
    assert.deepEqual(a.capabilities('structured').models, ['h200/qwen']);
    const p2 = await (a as ApiChatAdapter).probe();
    assert.equal(p2.auth, 'ok');
    assert.equal(p2.billing, 'budgetless');
    writeFileSync(join(dir, 'api-providers.json'), '{ broken');
    // A different mtime is needed for the reload on coarse-clock filesystems.
    const later = new Date(Date.now() + 5_000);
    (await import('node:fs')).utimesSync(join(dir, 'api-providers.json'), later, later);
    const p3 = await (a as ApiChatAdapter).probe();
    assert.ok(p3.notes?.[0]?.includes('api-providers.json'));
  });
});

describe('listModels', () => {
  test('configured models, else each provider\'s models endpoint; providers without a key are left out', async () => {
    const { adapter, server } = await setup(
      async (req, res) => {
        if (req.method === 'GET' && req.path === '/anthropic/v1/models?limit=1000') return json(res, 200, { data: [{ id: 'claude-x', display_name: 'Claude X' }] });
        if (req.method === 'GET' && req.path === '/openai/v1/models') return json(res, 200, { data: [{ id: 'llama' }, { id: '' }, null] });
        json(res, 404, { error: { message: 'nope' } });
      },
      (url) => ({ defaultModel: 'fixed/m1', providers: { fixed: { api: 'openai', baseUrl: `${url}/fixed/v1`, models: ['m1', { id: 'm2' }] } } }),
    );
    const ids = (await adapter.listModels({ env: { TEST_ANTHROPIC_KEY: KEY } })).filter((m) => ['claude', 'local', 'keyed', 'fixed'].includes(m.id.split('/')[0]!));
    assert.deepEqual(ids, [
      { id: 'claude/claude-x', label: 'Claude X' },
      { id: 'local/llama' },
      { id: 'fixed/m1', isDefault: true },
      { id: 'fixed/m2' },
    ]);
    const anthropicReq = server.requests.find((r) => r.path.startsWith('/anthropic/v1/models'));
    assert.equal(anthropicReq?.headers['x-api-key'], KEY);
    assert.ok(!server.requests.some((r) => r.path === '/openai/v1/models' && r.headers.authorization), 'keyed provider without a key is not asked');
  });
});
