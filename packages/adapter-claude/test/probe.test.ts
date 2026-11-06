import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAdapter, findClaudeBinary, probeClaude } from '../src/index.ts';
import { parseAuthStatus, parseVersion } from '../src/probe.ts';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'bizzi-claude-probe-'));
}

function script(dir: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'claude');
  writeFileSync(p, body);
  chmodSync(p, 0o755);
  return p;
}

const nodeClaude = (authJson: string) => `#!/usr/bin/env node
const a = process.argv.slice(2).join(' ');
if (a === '--version') console.log('2.1.311 (Claude Code)');
else if (a === 'auth status --json') console.log(${JSON.stringify(authJson)});
else process.exit(2);
`;

test('probe never throws when nothing is installed', async () => {
  const dir = tempDir();
  try {
    const p = await probeClaude({ searchDirs: [dir] });
    assert.equal(p.agent, 'claude');
    assert.equal(p.installed, false);
    assert.equal(p.auth, 'unknown');
    const viaAdapter = await new ClaudeAdapter({ searchDirs: [join(dir, 'nope')] }).probe();
    assert.equal(viaAdapter.installed, false);
    const bogus = await new ClaudeAdapter({ claudePath: '/definitely/not/here/claude' }).probe();
    assert.equal(bogus.installed, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('probe reads version and `claude auth status --json`', async () => {
  const dir = tempDir();
  try {
    script(dir, nodeClaude(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'me@example.com' })));
    const p = await probeClaude({ searchDirs: [dir] });
    assert.equal(p.installed, true);
    assert.equal(p.path, join(dir, 'claude'));
    assert.equal(p.version, '2.1.311');
    assert.equal(p.auth, 'ok');
    assert.equal(p.account, 'me@example.com');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('probe reports missing auth and survives a broken binary', async () => {
  const dir = tempDir();
  try {
    script(join(dir, 'a'), nodeClaude(JSON.stringify({ loggedIn: false })));
    assert.equal((await probeClaude({ searchDirs: [join(dir, 'a')] })).auth, 'missing');
    script(join(dir, 'b'), '#!/usr/bin/env node\nprocess.exit(3)\n');
    const broken = await probeClaude({ searchDirs: [join(dir, 'b')], env: { PATH: '' }, timeoutMs: 5000 });
    assert.equal(broken.installed, true);
    assert.equal(broken.version, undefined);
    assert.ok(['unknown', 'ok'].includes(broken.auth));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a native binary or node script is preferred over a shell wrapper', async () => {
  const dir = tempDir();
  try {
    const wrapper = script(join(dir, 'shim'), '#!/usr/bin/env bash\nexec claude-real --settings x "$@"\n');
    const real = script(join(dir, 'real'), nodeClaude('{}'));
    assert.deepEqual(await findClaudeBinary({ searchDirs: [join(dir, 'shim'), join(dir, 'real')] }), { path: real, wrapper: false });
    assert.deepEqual(await findClaudeBinary({ searchDirs: [join(dir, 'shim')] }), { path: wrapper, wrapper: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parsers', () => {
  assert.equal(parseVersion('2.1.311 (Claude Code)'), '2.1.311');
  assert.equal(parseVersion('garbage'), undefined);
  assert.equal(parseAuthStatus('not json'), undefined);
  assert.deepEqual(parseAuthStatus('{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty"}'), {
    auth: 'ok',
    account: undefined,
    notes: ['auth method: oauth_token', 'api provider: firstParty'],
  });
});
