import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeHub, tempDir } from './helpers.ts';

test('serves the UI with SPA fallback and answers CORS preflights on /api', async (t) => {
  const dir = tempDir();
  const ui = tempDir('bizzi-hub-ui-');
  t.after(() => {
    dir.cleanup();
    ui.cleanup();
  });
  writeFileSync(join(ui.path, 'index.html'), '<!doctype html><title>bizzi</title>');
  mkdirSync(join(ui.path, 'assets'));
  writeFileSync(join(ui.path, 'assets', 'app.js'), 'console.log(1)');
  const hub = await makeHub(dir.path, { uiDir: ui.path });
  t.after(() => hub.close());

  const index = await fetch(`${hub.url}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await index.text(), /<title>bizzi/);

  const asset = await fetch(`${hub.url}/assets/app.js`);
  assert.match(asset.headers.get('content-type') ?? '', /javascript/);
  assert.match(asset.headers.get('cache-control') ?? '', /immutable/);

  const deep = await fetch(`${hub.url}/some/client/route`);
  assert.match(await deep.text(), /<title>bizzi/);

  const traversal = await fetch(`${hub.url}/%2e%2e/%2e%2e/etc/passwd`);
  assert.ok(traversal.status === 400 || (await traversal.text()).includes('<title>bizzi'));

  const preflight = await fetch(`${hub.url}/api/pair`, { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), '*');

  const wrongMethod = await fetch(`${hub.url}/api/pair`);
  assert.equal(wrongMethod.status, 405);
  const unknown = await fetch(`${hub.url}/api/nope`, { method: 'POST', body: '{}' });
  assert.equal(unknown.status, 404);
  const garbage = await fetch(`${hub.url}/api/pair`, { method: 'POST', body: 'not json' });
  assert.equal(garbage.status, 400);
});
