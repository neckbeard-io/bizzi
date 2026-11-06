// Read-only probes of the agents actually installed on this machine: runs `<agent> --version`
// only (auth commands and network lookups are disabled). Skips when an agent is absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { delimiter } from 'node:path';
import { augmentedEnv, findBinary, probe } from '../src/index.ts';

const opts = { auth: false, latest: false as const };

for (const agent of ['claude', 'opencode'] as const) {
  const onPath = findBinary([agent], (augmentedEnv({ npmPrefix: null }).PATH ?? '').split(delimiter));
  test(`real probe: ${agent} is installed with a version`, { skip: onPath ? false : `${agent} not installed` }, async () => {
    const p = await probe(agent, process.env, opts);
    assert.equal(p.agent, agent);
    assert.equal(p.installed, true, JSON.stringify(p));
    assert.match(p.version ?? '', /^\d+\.\d+\.\d+/);
    assert.ok(p.path);
  });
}

for (const agent of ['codex', 'agy'] as const) {
  test(`real probe: ${agent} is not installed`, async () => {
    const p = await probe(agent, process.env, opts);
    assert.equal(p.agent, agent);
    if (p.installed) {
      // Someone installed it after all; the probe must then have found a working binary.
      assert.match(p.version ?? '', /\d+\.\d+\.\d+/);
      return;
    }
    assert.equal(p.installed, false);
    assert.equal(p.version, undefined);
  });
}

test('real probe: a non-interactive PATH (launchd/systemd style) still finds per-user installs', async () => {
  const p = await probe('claude', { HOME: process.env.HOME ?? '', PATH: '/usr/bin:/bin' }, opts);
  if (!p.installed) return; // nothing installed outside the shell's PATH on this machine
  assert.match(p.version ?? '', /^\d+\.\d+\.\d+/);
});
