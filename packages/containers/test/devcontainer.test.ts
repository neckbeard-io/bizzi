import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseDevcontainer, readDevcontainer, stripJsonc } from '../src/index.ts';

test('stripJsonc: comments and trailing commas go, strings stay intact', () => {
  const text = `{
    // a comment
    "url": "http://x//y", /* block */ "s": "a,}",
    "list": [1, 2, /* c */ ],
    "o": { "k": "v", // trailing
    },
  }`;
  assert.deepEqual(JSON.parse(stripJsonc(text)), { url: 'http://x//y', s: 'a,}', list: [1, 2], o: { k: 'v' } });
  assert.deepEqual(JSON.parse(stripJsonc('{"q": "say \\"hi\\" // not a comment"}')), { q: 'say "hi" // not a comment' });
});

test('parseDevcontainer: image, env, user, create commands; the rest noted', () => {
  const r = parseDevcontainer(
    JSON.stringify({
      name: 'Acme',
      image: 'mcr.microsoft.com/devcontainers/typescript-node:22',
      containerEnv: { NODE_ENV: 'development', ROOT: '${containerWorkspaceFolder}/src', FROM_HOST: '${localEnv:HOME}' },
      remoteEnv: { PORT: 3000 },
      remoteUser: 'node',
      onCreateCommand: 'npm ci',
      postCreateCommand: ['npm', 'run', 'build'],
      postStartCommand: 'npm start',
      updateContentCommand: { a: 'x', b: 'y' },
      features: { 'ghcr.io/devcontainers/features/go:1': {} },
      forwardPorts: [3000],
      customizations: { vscode: {} },
    }),
    '/w/acme/.devcontainer/devcontainer.json',
    '/w/acme',
  );
  assert.equal(r.image, 'mcr.microsoft.com/devcontainers/typescript-node:22');
  assert.equal(r.build, undefined);
  assert.deepEqual(r.env, { NODE_ENV: 'development', ROOT: '/w/acme/src', PORT: '3000' });
  assert.equal(r.user, 'node');
  assert.deepEqual(r.postCreate, ['npm ci', ['npm', 'run', 'build']]);
  assert.deepEqual(r.notes, [
    "containerEnv.FROM_HOST uses a variable bizzi doesn't substitute; ignored",
    'updateContentCommand in the object (parallel) form is not supported',
    'features are not installed (ghcr.io/devcontainers/features/go:1); bake them into the image',
    'postStartCommand is ignored',
    'forwardPorts is ignored',
  ]);
});

test('parseDevcontainer: a Dockerfile build resolves paths against the devcontainer.json folder', () => {
  const r = parseDevcontainer(
    '{ "build": { "dockerfile": "Dockerfile", "context": "..", "args": { "VARIANT": "3.12" } }, "containerUser": "vscode" }',
    '/w/acme/.devcontainer/devcontainer.json',
    '/w/acme',
  );
  assert.deepEqual(r.build, { dockerfile: '/w/acme/.devcontainer/Dockerfile', context: '/w/acme', args: { VARIANT: '3.12' } });
  assert.equal(r.user, 'vscode');
  assert.deepEqual(r.notes, []);

  const legacy = parseDevcontainer('{ "dockerFile": "../Dockerfile.dev" }', '/w/acme/.devcontainer.json', '/w/acme');
  assert.deepEqual(legacy.build, { dockerfile: '/w/Dockerfile.dev', context: '/w/acme' });

  const compose = parseDevcontainer('{ "dockerComposeFile": "compose.yml", "service": "app" }', '/w/a/.devcontainer.json', '/w/a');
  assert.equal(compose.image, undefined);
  assert.equal(compose.build, undefined);
  assert.ok(compose.notes.some((n) => n.startsWith('dockerComposeFile is not supported')));
});

test('parseDevcontainer rejects what is not a JSON object', () => {
  assert.throws(() => parseDevcontainer('[1]', '/x/.devcontainer.json', '/x'), /not a JSON object/);
  assert.throws(() => parseDevcontainer('{ nope', '/x/.devcontainer.json', '/x'), /\/x\/\.devcontainer\.json/);
});

test('readDevcontainer finds .devcontainer/devcontainer.json first, then .devcontainer.json', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'bizzi-dc-'));
  try {
    assert.equal(await readDevcontainer(dir), undefined);
    writeFileSync(join(dir, '.devcontainer.json'), '{ "image": "b" }');
    assert.equal((await readDevcontainer(dir))?.image, 'b');
    mkdirSync(join(dir, '.devcontainer'));
    writeFileSync(join(dir, '.devcontainer', 'devcontainer.json'), '{ "image": "a", }');
    const r = await readDevcontainer(dir);
    assert.equal(r?.image, 'a');
    assert.equal(r?.file, join(dir, '.devcontainer', 'devcontainer.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
