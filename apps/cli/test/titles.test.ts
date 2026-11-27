import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { nullLogger } from '@bizzi/core';
import { loadTitleSuggester, TITLE_SYSTEM_PROMPT } from '../src/titles.ts';

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? (JSON.parse(body) as Record<string, unknown>) : {};
}

test('title model: only with an explicit utilityModel; key from the api agent secrets', async (t) => {
  const dir = mkdtempSync(join(os.tmpdir(), 'bizzi-titles-'));
  const posts: { auth: string | undefined; body: Record<string, unknown> }[] = [];
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(404).end('{}');
      return;
    }
    posts.push({ auth: req.headers.authorization, body: await readJson(req) });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Fix flaky upload test' } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const prev = process.env.BIZZI_AUTO_TITLE_MODEL;
  delete process.env.BIZZI_AUTO_TITLE_MODEL;
  t.after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.BIZZI_AUTO_TITLE_MODEL;
    else process.env.BIZZI_AUTO_TITLE_MODEL = prev;
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const agentEnv = async (agent: string): Promise<Record<string, string>> => (agent === 'api' ? { LOCAL_KEY: 'secret-1' } : {});

  const suggest = (await loadTitleSuggester(dir, nullLogger))!;
  assert.ok(suggest);
  // No api-providers.json: nothing is asked (presets alone never bill for titles).
  assert.equal(await suggest('the upload test is flaky', { agentEnv }), undefined);
  // A defaultModel alone isn't enough either.
  writeFileSync(join(dir, 'api-providers.json'), JSON.stringify({ defaultModel: 'local/m', providers: { local: { api: 'openai', baseUrl: url, apiKeyEnv: 'LOCAL_KEY', models: ['m'] } } }));
  assert.equal(await suggest('the upload test is flaky', { agentEnv }), undefined);
  assert.equal(posts.length, 0);

  writeFileSync(join(dir, 'api-providers.json'), JSON.stringify({ utilityModel: 'local/m', providers: { local: { api: 'openai', baseUrl: url, apiKeyEnv: 'LOCAL_KEY', models: ['m'] } } }));
  assert.equal(await suggest('the upload test is flaky', { agentEnv }), 'Fix flaky upload test');
  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.auth, 'Bearer secret-1');
  const messages = posts[0]!.body.messages as { role: string; content: unknown }[];
  assert.deepEqual(messages[0], { role: 'system', content: TITLE_SYSTEM_PROMPT });

  process.env.BIZZI_AUTO_TITLE_MODEL = 'off';
  assert.equal(await loadTitleSuggester(dir, nullLogger), undefined);
});
