import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { WidgetValue } from '@bizzi/protocol';
import {
  MemorySecretBackend,
  SecretStore,
  createWidgetsExtension,
  expand,
  jsonPath,
  parseCommandOutput,
  parseDuration,
  parsePath,
  parseWidget,
  scrub,
  secretLookup,
  type WidgetsExtension,
} from '../src/index.ts';
import { harness, tempDir, waitFor, writeScript, type Harness } from './helpers.ts';

describe('widget expressions', () => {
  it('JSONPath subset', () => {
    const doc = { info: { spend: 5, 'max-budget': 10, items: [{ n: 1 }, { n: 2 }] }, top: [3] };
    assert.equal(jsonPath(doc, '$.info.spend'), 5);
    assert.equal(jsonPath(doc, "$.info['max-budget']"), 10);
    assert.equal(jsonPath(doc, '$["info"].items[1].n'), 2);
    assert.equal(jsonPath(doc, '$.top[0]'), 3);
    assert.deepEqual(jsonPath(doc, '$'), doc);
    assert.equal(jsonPath(doc, '$.info.missing.deeper'), undefined);
    assert.equal(jsonPath(doc, '$.info.items.n'), undefined, 'a key on an array is missing');
    assert.equal(jsonPath(doc, '$.info.constructor'), undefined, 'own properties only');
    assert.throws(() => parsePath('info.spend'), /must start with \$/);
    assert.throws(() => parsePath('$..spend'), /expected a key/);
    assert.throws(() => parsePath('$.items[*]'), /unsupported selector/);
  });

  it('templating: env, secrets where allowed, scrubbing', async () => {
    const secrets: string[] = [];
    const ctx = { env: { BASE: 'http://x' }, secret: async (n: string) => (n === 'KEY' ? 's3cr3t/x' : undefined), allowSecrets: true };
    assert.equal(await expand('${env:BASE}/k?t=${secret:KEY}', ctx, secrets), 'http://x/k?t=s3cr3t/x');
    assert.deepEqual(secrets, ['s3cr3t/x']);
    await assert.rejects(expand('${env:NOPE}', ctx, []), /NOPE is not set/);
    await assert.rejects(expand('${secret:OTHER}', ctx, []), /secret OTHER not found/);
    await assert.rejects(expand('${secret:KEY}', { ...ctx, allowSecrets: false }, []), /not allowed/);
    await assert.rejects(expand('${file:/etc/passwd}', ctx, []), /unknown placeholder/);
    assert.equal(scrub('failed for http://x/k?t=s3cr3t/x and s3cr3t%2Fx', secrets), 'failed for http://x/k?t=*** and ***');
  });

  it('secret lookup by name or agent:name', async () => {
    const store = new SecretStore({ backend: new MemorySecretBackend() });
    await store.set('codex', 'TOKEN', 'codex-token');
    await store.set('claude', 'LITELLM_KEY', 'sk-lite');
    const lookup = secretLookup(store);
    assert.equal(await lookup('LITELLM_KEY'), 'sk-lite');
    assert.equal(await lookup('codex:TOKEN'), 'codex-token');
    assert.equal(await lookup('claude:TOKEN'), undefined);
    assert.equal(await lookup('nope:TOKEN'), undefined);
  });

  it('file validation', () => {
    const ok = parseWidget(
      {
        id: 'litellm-billed',
        label: 'billed',
        kind: 'meter',
        placement: ['bar'],
        every: '60s',
        source: {
          type: 'http',
          url: '${env:ANTHROPIC_BASE_URL}/key/info',
          headers: { Authorization: 'Bearer ${secret:LITELLM_KEY}' },
          value: '$.info.spend',
          max: '$.info.max_budget',
          resetsAt: '$.info.budget_reset_at',
          format: 'usd',
        },
        thresholds: { warn: 0.8, error: 0.95 },
        billing: { account: 'claude-via-litellm' },
      },
      'litellm.json',
    );
    assert.ok('def' in ok, JSON.stringify(ok));
    assert.equal(ok.def.format, 'usd');
    assert.equal(ok.def.everyMs, 60_000);
    assert.deepEqual(ok.def.billing, { account: 'claude-via-litellm', agent: 'claude', billing: 'metered' });

    const bad = parseWidget(
      { label: 'x', every: 'often', color: 'red', source: { type: 'command', command: ['./x', '${secret:K}'] }, billing: { account: 'mystery' } },
      'x.json',
    );
    assert.ok('errors' in bad);
    const text = bad.errors.join('\n');
    assert.match(text, /unknown field "color"/);
    assert.match(text, /every must be a duration/);
    assert.match(text, /only allowed in http url\/headers and command env/);
    assert.match(text, /billing.agent must be one of/);
    assert.ok('errors' in parseWidget({ label: 'x', source: { type: 'shell', run: 'ls' } }, 'y.json'));
    assert.equal(parseDuration('1.5m'), 90_000);
    assert.equal(parseDuration('500ms'), 500);
    assert.equal(parseDuration('soon'), undefined);
  });

  it('command output: one JSON object or one line', () => {
    assert.deepEqual(parseCommandOutput('{"value":3,"max":8,"tone":"warn","link":"https://x"}\n'), { value: 3, max: 8, tone: 'warn', link: 'https://x' });
    assert.deepEqual(parseCommandOutput('\n  queue 3/8  \nignored'), { text: 'queue 3/8' });
    assert.throws(() => parseCommandOutput(''), /printed nothing/);
    assert.throws(() => parseCommandOutput('{"value":"3"}'), /value must be a number/);
    assert.throws(() => parseCommandOutput('{"tone":"purple"}'), /tone must be one of/);
    assert.throws(() => parseCommandOutput('{nope'), /not one JSON object/);
  });
});

interface Gateway {
  url: string;
  mode: 'ok' | 'fail' | 'high';
  auth: (string | undefined)[];
  server: Server;
}

async function gateway(): Promise<Gateway> {
  const g = { mode: 'ok', auth: [] } as unknown as Gateway;
  g.server = createServer((req, res) => {
    g.auth.push(req.headers.authorization);
    if (req.url === '/plain') return void res.end('  up 3d  \nmore\n');
    if (req.url !== '/key/info') return void res.writeHead(404).end();
    if (req.headers.authorization !== 'Bearer sk-lite-123') return void res.writeHead(401).end('bad key sk-lite-123');
    if (g.mode === 'fail') return void res.writeHead(503, 'Busy').end('{}');
    const spend = g.mode === 'high' ? 2400 : '554.5';
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ info: { spend, max_budget: 2474, budget_reset_at: '2026-12-01T00:00:00Z' } }));
  });
  await new Promise<void>((r) => g.server.listen(0, '127.0.0.1', r));
  g.url = `http://127.0.0.1:${(g.server.address() as AddressInfo).port}`;
  after(() => new Promise<void>((r) => g.server.close(() => r())));
  return g;
}

function writeWidget(dir: string, file: string, body: unknown): void {
  writeFileSync(join(dir, file), JSON.stringify(body, null, 2));
}

async function start(dir: string, env: NodeJS.ProcessEnv, watch = false): Promise<{ h: Harness; w: WidgetsExtension; store: SecretStore }> {
  const store = new SecretStore({ backend: new MemorySecretBackend() });
  await store.set('claude', 'LITELLM_KEY', 'sk-lite-123');
  const w = createWidgetsExtension({ dir, env, secret: secretLookup(store), watch });
  const h = await harness({ extensions: [w] });
  after(() => h.close());
  return { h, w, store };
}

function get(w: WidgetsExtension, id: string): WidgetValue {
  const v = w.list().find((x) => x.id === id);
  assert.ok(v, `widget ${id}`);
  return v;
}

describe('widgets runtime', () => {
  it('http: templating, secrets, JSONPath, thresholds, billing, failure retention', async () => {
    const gw = await gateway();
    const dir = join(tempDir(), 'widgets');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir);
    writeWidget(dir, 'litellm.json', {
      label: 'billed',
      kind: 'meter',
      source: {
        type: 'http',
        url: '${env:GW}/key/info',
        headers: { Authorization: 'Bearer ${secret:LITELLM_KEY}' },
        value: '$.info.spend',
        max: '$.info.max_budget',
        resetsAt: '$.info.budget_reset_at',
        format: 'usd',
      },
      thresholds: { warn: 0.8, error: 0.95 },
      billing: { account: 'claude-via-litellm', label: 'LiteLLM' },
    });
    writeWidget(dir, 'uptime.json', { label: 'uptime', source: { type: 'http', url: '${env:GW}/plain' } });
    const { h, w } = await start(dir, { GW: gw.url });
    await w.idle();

    // Schema and AGENTS.md are written for agents editing the directory.
    assert.ok(existsSync(join(dir, 'widget.schema.json')));
    assert.match(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), /# bizzi widgets/);
    assert.equal(JSON.parse(readFileSync(join(dir, 'widget.schema.json'), 'utf8')).title, 'bizzi widget');

    let v = get(w, 'litellm');
    assert.equal(v.machineId, h.node.machine.id);
    assert.deepEqual([v.value, v.max, v.tone, v.format, v.resetsAt], [554.5, 2474, 'ok', 'usd', '2026-12-01T00:00:00.000Z']);
    assert.ok(v.observedAt);
    assert.equal(v.error, undefined);
    assert.equal(get(w, 'uptime').text, 'up 3d');
    assert.ok(h.global.some((e) => e.type === 'widget.updated' && (e.data as { widget: WidgetValue }).widget.id === 'litellm'));
    assert.ok(gw.auth.includes('Bearer sk-lite-123'));

    // billing.account feeds usage.list.
    let { accounts } = await h.node.call('usage.list', {});
    assert.equal(accounts.length, 1);
    assert.deepEqual(
      [accounts[0]!.agent, accounts[0]!.accountId, accounts[0]!.label, accounts[0]!.billing, accounts[0]!.status],
      ['claude', 'claude-via-litellm', 'LiteLLM', 'metered', 'ok'],
    );
    assert.deepEqual(accounts[0]!.spend, { usd: 554.5, capUsd: 2474, resetsAt: '2026-12-01T00:00:00.000Z' });

    // Failure: the previous value stays, error is set, observedAt is the last success.
    const observedAt = v.observedAt;
    gw.mode = 'fail';
    v = (await h.call(w, 'widget.refresh', { widgetId: 'litellm' })).widget;
    assert.equal(v.value, 554.5);
    assert.equal(v.error, 'HTTP 503 Busy');
    assert.equal(v.observedAt, observedAt);
    const updates = h.global.filter((e) => e.type === 'widget.updated' && (e.data as { widget: WidgetValue }).widget.id === 'litellm');
    assert.equal((updates.at(-1)!.data as { widget: WidgetValue }).widget.error, 'HTTP 503 Busy');

    // Recovery with a value past the error threshold.
    gw.mode = 'high';
    v = (await h.call(w, 'widget.refresh', { widgetId: 'litellm' })).widget;
    assert.deepEqual([v.value, v.tone, v.error], [2400, 'error', undefined]);
    ({ accounts } = await h.node.call('usage.list', {}));
    assert.equal(accounts[0]!.status, 'warning');

    // widgets.list through the node, machine routing, unknown widget.
    const listed = (await h.call(w, 'widgets.list', { machineId: h.node.machine.id })).widgets.map((x: WidgetValue) => x.id);
    assert.deepEqual(listed, ['litellm', 'uptime']);
    await assert.rejects(h.call(w, 'widgets.list', { machineId: 'm_other' }), { code: 'not_found' });
    await assert.rejects(h.call(w, 'widget.refresh', { widgetId: 'nope' }), { code: 'not_found' });
  });

  it('secrets never reach error messages', async () => {
    const dir = join(tempDir(), 'widgets');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir);
    // Connection refused on a URL carrying the secret.
    writeWidget(dir, 'leak.json', { label: 'leak', source: { type: 'http', url: 'http://127.0.0.1:1/x?key=${secret:LITELLM_KEY}' } });
    const { w } = await start(dir, {});
    await w.idle();
    const v = get(w, 'leak');
    assert.ok(v.error, 'failed');
    assert.doesNotMatch(v.error!, /sk-lite-123/);
  });

  it('command: JSON and plain output, env templating, thresholds, exit codes, timeouts, intervals', async () => {
    const root = tempDir();
    const dir = join(root, 'widgets');
    const counter = join(root, 'runs');
    writeScript(join(dir, 'queue.sh'), `echo x >> "${counter}"\necho '{"value": 7, "max": 8, "tooltip": "H200 queue"}'`);
    writeScript(join(dir, 'hello.sh'), 'echo "hello $GREETING ($#: $1)"');
    writeScript(join(dir, 'broken.sh'), 'echo "token $TOKEN is wrong" >&2\nexit 3');
    writeScript(join(dir, 'slow.sh'), 'sleep 5\necho late');
    writeWidget(dir, 'queue.json', {
      label: 'h200',
      kind: 'meter',
      every: '1s',
      source: { type: 'command', command: ['./queue.sh'] },
      thresholds: { warn: 0.8, error: 0.95 },
    });
    writeWidget(dir, 'hello.json', {
      label: 'hello',
      source: { type: 'command', command: ['./hello.sh', '${env:WHO}; rm -rf /'], env: { GREETING: '${env:WHO}' } },
    });
    writeWidget(dir, 'broken.json', { label: 'broken', kind: 'status', source: { type: 'command', command: './broken.sh', env: { TOKEN: '${secret:LITELLM_KEY}' } } });
    writeWidget(dir, 'slow.json', { label: 'slow', timeout: '300ms', source: { type: 'command', command: ['./slow.sh'] } });
    writeWidget(dir, 'argv-secret.json', { label: 'bad', source: { type: 'command', command: ['./hello.sh', '${secret:LITELLM_KEY}'] } });
    const { w } = await start(dir, { PATH: process.env.PATH, WHO: 'world' });
    await w.idle();

    const q = get(w, 'queue');
    assert.deepEqual([q.value, q.max, q.tone, q.tooltip], [7, 8, 'warn', 'H200 queue']);
    // No shell: the argument arrives verbatim.
    assert.equal(get(w, 'hello').text, 'hello world (1: world; rm -rf /)');
    const broken = get(w, 'broken');
    assert.equal(broken.error, 'exit 3: token *** is wrong');
    assert.equal(get(w, 'slow').error, 'timed out after 0.3s');
    const bad = get(w, 'argv-secret');
    assert.equal(bad.tone, 'error');
    assert.deepEqual(bad.placement, ['machine']);
    assert.match(bad.error!, /invalid widget file argv-secret.json: .*only allowed in http url\/headers and command env/);

    // The 1s interval runs the queue widget again.
    await waitFor(() => readFileSync(counter, 'utf8').trim().split('\n').length >= 2, 'second interval run', 5000);
  });

  it('watches the directory: add, change, invalid, remove', async () => {
    const dir = join(tempDir(), 'widgets');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir);
    const { h, w } = await start(dir, { PATH: process.env.PATH }, true);
    const events = () => h.global.filter((e) => e.type === 'widget.updated' || e.type === 'widget.removed');
    const last = (id: string) =>
      events()
        .filter((e) => (e.type === 'widget.removed' ? (e.data as { widgetId: string }).widgetId : (e.data as { widget: WidgetValue }).widget.id) === id)
        .at(-1);

    writeScript(join(dir, 'v.sh'), 'echo one');
    writeWidget(dir, 'v.json', { label: 'v', source: { type: 'command', command: ['./v.sh'] } });
    await waitFor(() => w.list().some((x) => x.id === 'v' && x.text === 'one'), 'widget added', 5000);

    writeScript(join(dir, 'v.sh'), 'echo two');
    writeWidget(dir, 'v.json', { label: 'v2', source: { type: 'command', command: ['./v.sh'] } });
    await waitFor(() => w.list().some((x) => x.id === 'v' && x.label === 'v2' && x.text === 'two'), 'widget changed', 5000);

    writeFileSync(join(dir, 'v.json'), '{ "label": ');
    await waitFor(() => (w.list().find((x) => x.id === 'v')?.error ?? '').startsWith('invalid widget file v.json: not valid JSON'), 'invalid file', 5000);
    assert.equal(w.list().find((x) => x.id === 'v')?.text, 'two', 'the last value is kept');

    rmSync(join(dir, 'v.json'));
    await waitFor(() => last('v')?.type === 'widget.removed', 'widget.removed', 5000);
    assert.equal(w.list().length, 0);
  });
});
