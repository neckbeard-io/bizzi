// Handshake against the real `codex app-server` from the @openai/codex devDependency.
// Needs no login: initialize, account/read and thread/start all answer while logged out.
// Uses a throwaway CODEX_HOME so nothing touches ~/.codex. Skips if the binary is unavailable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BizziError } from '@bizzi/protocol';
import { CodexAdapter } from '../src/index.ts';
import { ctx, EventLog, startOpts } from './helpers.ts';

function localCodex(): string | undefined {
  try {
    const pkg = createRequire(import.meta.url).resolve('@openai/codex/package.json');
    const bin = join(dirname(pkg), 'bin', 'codex.js');
    return existsSync(bin) ? bin : undefined;
  } catch {
    return undefined;
  }
}

const codexPath = localCodex();
const vendored = readFileSync(new URL('../src/generated/VERSION', import.meta.url), 'utf8').trim();

test('real codex app-server: probe + thread/start handshake without login', { skip: !codexPath && 'local @openai/codex not installed', timeout: 60_000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'bizzi-codex-home-'));
  try {
    // Strip API-key env so auth is deterministic.
    const adapter = new CodexAdapter({
      codexPath: process.execPath,
      codexArgsPrefix: [codexPath as string],
      env: { CODEX_HOME: home, OPENAI_API_KEY: '', CODEX_API_KEY: '' },
      requestTimeoutMs: 30_000,
    });
    const probe = await adapter.probe();
    if (!probe.installed || probe.auth === 'unknown') {
      t.skip(`codex app-server unavailable: ${probe.notes?.join('; ') ?? 'unknown'}`);
      return;
    }
    assert.equal(probe.version, vendored.replace(/^codex-cli /, ''), 'vendored types match the installed devDependency');
    assert.equal(probe.auth, 'missing');

    const log = new EventLog();
    let session;
    try {
      session = await adapter.start(startOpts({ cwd: home, permissionMode: 'read-only' }), log.emit, ctx());
    } catch (e) {
      if (e instanceof BizziError && e.code === 'agent_unavailable') {
        t.skip(`codex app-server could not start: ${e.message}`);
        return;
      }
      throw e;
    }
    try {
      const info = await log.waitFor('session.info', (d) => d.agentSessionRef !== undefined);
      assert.match(info.agentSessionRef as string, /^[0-9a-f-]{36}$/);
      assert.equal(info.permissionMode, 'read-only');
      assert.equal(session.agentSessionRef(), info.agentSessionRef);
    } finally {
      await session.stop();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
