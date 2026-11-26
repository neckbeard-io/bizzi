import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { BizziError } from '@bizzi/protocol';
import {
  buildConfig,
  clearDiscovered,
  contextOf,
  costOf,
  createUtilityCompleter,
  defaultModelRef,
  Limiter,
  listedModels,
  resolveModel,
  SseParser,
} from '../src/index.ts';
import { anthropicEvents, fakeApi, json, openaiEvents, sse } from './helpers.ts';

let server: Awaited<ReturnType<typeof fakeApi>> | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  clearDiscovered();
});

describe('config', () => {
  test('presets, overrides, removal and validation', () => {
    const l = buildConfig({
      providers: {
        anthropic: { baseUrl: 'https://gateway.example/v1/' },
        gemini: null,
        h200: { api: 'openai', baseUrl: 'https://h200.example/v1', billing: 'budgetless', models: ['qwen', { id: 'big', contextWindow: 1000 }] },
        Bad: { api: 'openai', baseUrl: 'https://x' },
        nokey: { api: 'openai', baseUrl: 'https://x', apiKeyEnv: 'sk-literal-key' },
        noapi: { baseUrl: 'https://x' },
        ftp: { api: 'openai', baseUrl: 'ftp://x' },
      },
      defaultModel: 'h200/qwen',
    });
    assert.equal(l.config.providers.anthropic?.baseUrl, 'https://gateway.example/v1');
    assert.equal(l.config.providers.anthropic?.apiKeyEnv, 'ANTHROPIC_API_KEY', 'preset fields kept');
    assert.equal(l.config.providers.gemini, undefined);
    assert.deepEqual(l.custom, ['anthropic', 'h200']);
    assert.equal(l.errors.length, 4);
    assert.ok(l.errors.some((e) => e.includes('apiKeyEnv') && e.includes('never goes in this file')));
    assert.equal(defaultModelRef(l), 'h200/qwen');
    assert.equal(listedModels(l.config), undefined, 'presets list no models');
  });

  test('resolveModel: provider/model, nested slashes, bare provider, bare model, defaults', () => {
    const l = buildConfig({ providers: { h200: { api: 'openai', baseUrl: 'https://h/v1', models: ['qwen'] } } });
    assert.equal(resolveModel(l, 'openrouter/anthropic/claude-sonnet-5-5').model, 'anthropic/claude-sonnet-5-5');
    assert.equal(resolveModel(l, 'openrouter/anthropic/claude-sonnet-5-5').providerId, 'openrouter');
    assert.equal(resolveModel(l, 'anthropic').ref, 'anthropic/claude-opus-5-5');
    assert.equal(resolveModel(l, 'qwen').ref, 'h200/qwen');
    assert.equal(resolveModel(l, undefined).ref, 'h200/qwen', 'first file-defined provider wins');
    assert.equal(resolveModel(buildConfig(undefined), undefined).ref, 'anthropic/claude-opus-5-5');
    assert.throws(() => resolveModel(l, 'mystery'), (e: unknown) => e instanceof BizziError && e.code === 'bad_request');
    assert.throws(() => resolveModel(l, 'openai'), /no default model/);
  });

  test('cost and context', () => {
    assert.equal(costOf({ input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 0 }, { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3 }), 18.3);
    assert.equal(contextOf({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, undefined), undefined, 'no window, no guess');
    assert.deepEqual(contextOf({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, 100), { used: 15, window: 100 });
  });
});

describe('sse and limiter', () => {
  test('parser handles split chunks, CRLF, comments and multi-line data', () => {
    const p = new SseParser();
    const out = [...p.push('event: a\r\nda'), ...p.push('ta: 1\r\n'), ...p.push('data: 2\r\n\r\n: ping\n\ndata: x'), ...p.end()];
    assert.deepEqual(out, [{ event: 'a', data: '1\n2' }, { data: 'x' }]);
  });

  test('limiter queues beyond max and honors abort', async () => {
    const l = new Limiter(1);
    const r1 = await l.acquire();
    let second = false;
    const p2 = l.acquire().then((r) => {
      second = true;
      return r;
    });
    const ac = new AbortController();
    const p3 = l.acquire(ac.signal);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(second, false);
    ac.abort();
    await assert.rejects(p3);
    r1();
    (await p2)();
    assert.equal(second, true);
    assert.equal(l.active, 0);
  });
});

describe('utility completions', () => {
  test('one-shot completion with the utility model, key from the lookup, usage and billing', async () => {
    server = await fakeApi((req, res) => {
      if (req.method === 'GET') return json(res, 404, {});
      if (req.path.startsWith('/a/')) return sse(res, anthropicEvents(['A title'], { usage: { in: 40, out: 3 } }));
      return sse(res, openaiEvents(['Short ', 'title']));
    });
    const asked: string[] = [];
    const u = createUtilityCompleter({
      config: {
        providers: {
          cheap: { api: 'openai', baseUrl: `${server.url}/o/v1`, billing: 'budgetless', apiKeyEnv: 'CHEAP_KEY' },
          claude: { api: 'anthropic', baseUrl: `${server.url}/a/v1`, apiKeyEnv: 'CLAUDE_KEY', models: [{ id: 'c', price: { inputPerMTok: 1, outputPerMTok: 5 } }] },
        },
        utilityModel: 'cheap/small',
      },
      key: (name) => {
        asked.push(name);
        return `key-for-${name}`;
      },
      retryBaseMs: 1,
    });
    assert.equal(u.defaultModel(), 'cheap/small');
    const r = await u.complete({ system: 'Write a title.', prompt: 'long conversation…', maxTokens: 20 });
    assert.deepEqual(r, {
      text: 'Short title',
      model: 'cheap/small',
      billing: 'budgetless',
      stopReason: 'end_turn',
      usage: { inputTokens: 12, outputTokens: 4 },
    });
    const post = server.requests.find((x) => x.method === 'POST')!;
    assert.equal(post.headers.authorization, 'Bearer key-for-CHEAP_KEY');
    assert.equal(post.body.max_tokens, 20);
    assert.deepEqual(post.body.messages[0], { role: 'system', content: 'Write a title.' });

    const r2 = await u.complete({ model: 'claude/c', prompt: 'x' });
    assert.equal(r2.text, 'A title');
    assert.equal(r2.billing, 'metered');
    assert.equal(r2.usage?.costUsd, (40 * 1 + 3 * 5) / 1e6);
    assert.deepEqual(asked, ['CHEAP_KEY', 'CLAUDE_KEY']);
  });

  test('errors are BizziErrors: missing key, provider error, timeout', async () => {
    server = await fakeApi(async (req, res) => {
      if (req.method === 'GET') return json(res, 404, {});
      if (req.body.model === 'slow') return sse(res, openaiEvents(['x']).slice(0, 1), { hang: true });
      json(res, 400, { error: { message: 'model not found' } });
    });
    const u = createUtilityCompleter({ config: { providers: { p: { api: 'openai', baseUrl: `${server.url}/v1`, apiKeyEnv: 'P_KEY' } } }, key: () => undefined });
    await assert.rejects(u.complete({ model: 'p/m', prompt: 'x' }), (e: unknown) => e instanceof BizziError && e.code === 'agent_unavailable' && /P_KEY/.test(e.message));
    const ok = createUtilityCompleter({ config: { providers: { p: { api: 'openai', baseUrl: `${server.url}/v1` } } }, maxRetries: 0 });
    await assert.rejects(ok.complete({ model: 'p/m', prompt: 'x' }), (e: unknown) => e instanceof BizziError && e.code === 'agent_unavailable' && /400 model not found/.test(e.message));
    await assert.rejects(ok.complete({ model: 'p/slow', prompt: 'x', timeoutMs: 100 }), (e: unknown) => e instanceof BizziError && /did not answer within/.test(e.message));
    await assert.rejects(ok.complete({ model: 'p/m' }), (e: unknown) => e instanceof BizziError && e.code === 'bad_request');
    const ac = new AbortController();
    const pending = ok.complete({ model: 'p/slow', prompt: 'x', signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    await assert.rejects(pending, (e: unknown) => (e as Error).name === 'AbortError');
  });
});
