import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { OpenCodeAdapter, probeOpenCode } from '../src/index.ts';

const dir = mkdtempSync(join(tmpdir(), 'bizzi-oc-probe-'));

/** A stand-in `opencode` binary: prints a version and a canned `auth list --format json`. */
function fakeBinary(name: string, authJson: string, version = 'opencode v2.0.25'): string {
  const p = join(dir, name);
  writeFileSync(
    p,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi\nif [ "$1" = "auth" ]; then echo '${authJson}'; echo "$@" > "${p}.args"; exit 0; fi\nexit 1\n`,
  );
  chmodSync(p, 0o755);
  return p;
}

// Isolated config dir + no provider keys in the environment.
const isolated = (configHome: string): Record<string, string> => ({
  XDG_CONFIG_HOME: configHome,
  OPENCODE_CONFIG_DIR: join(configHome, 'none'),
  ANTHROPIC_API_KEY: '',
  OPENAI_API_KEY: '',
  OPENROUTER_API_KEY: '',
  GEMINI_API_KEY: '',
  GOOGLE_GENERATIVE_AI_API_KEY: '',
  OPENCODE_API_KEY: '',
});

test('missing binary: not installed, never throws', async () => {
  const p = await new OpenCodeAdapter({ binary: join(dir, 'does-not-exist') }).probe();
  assert.equal(p.agent, 'opencode');
  assert.equal(p.installed, false);
  assert.equal(p.auth, 'unknown');
});

test('providers declared in config → auth ok without starting a server', async () => {
  const cfg = join(dir, 'cfg1');
  mkdirSync(join(cfg, 'opencode'), { recursive: true });
  writeFileSync(join(cfg, 'opencode', 'opencode.jsonc'), '{ // comment\n "providers": { "local": { "settings": { "apiKey": "secret" } } },\n}');
  const bin = fakeBinary('oc1', '[]');
  const p = await probeOpenCode({ binary: bin, env: isolated(cfg), timeoutMs: 5_000 });
  assert.equal(p.installed, true);
  assert.equal(p.version, '2.0.25');
  assert.equal(p.auth, 'ok');
  assert.ok(p.notes?.some((n) => n.includes('local')));
  assert.ok(!JSON.stringify(p).includes('secret'), 'never leaks config secrets');
});

test('stored provider credential via auth list (standalone, never the background service)', async () => {
  const cfg = join(dir, 'cfg2');
  const bin = fakeBinary('oc2', '[{"id":"mcp_1","name":"atlassian","connections":[{"type":"credential"}]},{"id":"anthropic","name":"Anthropic","connections":[{"type":"credential"}]}]');
  const p = await probeOpenCode({ binary: bin, env: isolated(cfg), timeoutMs: 5_000 });
  assert.equal(p.auth, 'ok');
  assert.equal(p.account, 'Anthropic');
  const { readFileSync } = await import('node:fs');
  assert.match(readFileSync(`${bin}.args`, 'utf8'), /auth list --format json --standalone/);
});

test('only MCP logins → auth unknown with a hint', async () => {
  const cfg = join(dir, 'cfg3');
  const bin = fakeBinary('oc3', '[{"id":"mcp_1","name":"atlassian","connections":[{"type":"credential"}]}]');
  const p = await probeOpenCode({ binary: bin, env: isolated(cfg), timeoutMs: 5_000 });
  assert.equal(p.auth, 'unknown');
  assert.ok(p.notes?.some((n) => n.includes('opencode auth login')));
});

test('v1 install is flagged', async () => {
  const bin = fakeBinary('oc4', '[]', '1.4.2');
  const p = await probeOpenCode({ binary: bin, env: isolated(join(dir, 'cfg4')), timeoutMs: 5_000 });
  assert.equal(p.version, '1.4.2');
  assert.ok(p.notes?.some((n) => n.includes('v1')));
});
