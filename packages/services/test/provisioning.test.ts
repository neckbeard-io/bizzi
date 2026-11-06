import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { FakeAdapter } from '@bizzi/core/testing';
import { BizziError, type GlobalEventMap } from '@bizzi/protocol';
import { parseRecipe, RecipeSet } from '@bizzi/provision';
import { createProvisioningExtension, MemorySecretBackend, SecretStore } from '../src/index.ts';
import { harness, tempDir, waitFor, type Harness } from './helpers.ts';

// A fake recipe under a real agent name (so it is a valid AgentKind); its steps only echo, sleep
// and write inside a temp tools dir. Nothing real is ever installed.
const FAKE_OPENCODE = `
schema: 1
name: opencode
kind: agent
displayName: Fake OpenCode
homepage: https://example.com/fake
docs: [https://example.com/fake/docs]
verified: true
platforms:
  darwin-arm64: {}
  darwin-x64: {}
  linux-x64: {}
  linux-arm64: {}
detect:
  binaries: [bizzi-fake-oc]
  searchPaths: ["{{toolsDir}}/fakeoc/bin"]
  version:
    args: [--version]
    regex: 'bizzi-fake-oc (\\d+\\.\\d+\\.\\d+)'
latest:
  - type: npm
    package: "@example/fake-oc"
    verified: true
methods:
  - id: echo
    kind: script
    label: Echo installer
    targetDir: "{{toolsDir}}/fakeoc/bin"
    pinnable: true
    verified: true
    install:
      - description: Say hello
        run: echo "installing {{version|latest}}"
      - description: Take a moment
        run: sleep 0.3
      - description: Write the binary
        run: |
          mkdir -p {{toolsDir}}/fakeoc/bin
          printf '#!/bin/sh\\necho "bizzi-fake-oc 1.0.0"\\n' > {{toolsDir}}/fakeoc/bin/bizzi-fake-oc
          chmod +x {{toolsDir}}/fakeoc/bin/bizzi-fake-oc
    uninstall:
      - description: Remove it
        run: rm -rf {{toolsDir}}/fakeoc
login:
  interactive:
    argv: [bizzi-fake-oc, login]
    description: Fake login
    verified: true
  headless: []
auth:
  rules:
    - env: [FAKE_OC_KEY]
  absent: missing
`;

type Progress = GlobalEventMap['install.progress'];

function setup() {
  const home = tempDir('bizzi-services-home-');
  const toolsDir = join(home, 'tools');
  const env = { PATH: '/usr/bin:/bin', HOME: home };
  const recipes = new RecipeSet([parseRecipe(FAKE_OPENCODE, 'fake-opencode.yaml')]);
  const secrets = new SecretStore({ backend: new MemorySecretBackend() });
  const ext = createProvisioningExtension({ secrets, recipes, env, home, toolsDir, hasCommand: () => true });
  return { home, toolsDir, ext, secrets };
}

function progress(h: Harness, jobId?: string): Progress[] {
  return h.global
    .filter((e) => e.type === 'install.progress')
    .map((e) => e.data as Progress)
    .filter((p) => jobId === undefined || p.jobId === jobId);
}

const code = (c: string) => (e: unknown) => e instanceof BizziError && e.code === c;

describe('provisioning extension', () => {
  it('agent.plan maps the recipe plan to the wire shape', async () => {
    const { ext } = setup();
    const h = await harness({ extensions: [ext] });
    after(() => h.close());
    const { plan } = await h.call(ext, 'agent.plan', { agent: 'opencode', action: 'install', version: '1.2.3' });
    assert.equal(plan.target, 'opencode');
    assert.equal(plan.action, 'install');
    assert.equal(plan.method, 'echo');
    assert.deepEqual(
      plan.steps.map((s: { title: string }) => s.title),
      ['Say hello', 'Take a moment', 'Write the binary', 'Verify Fake OpenCode runs'],
    );
    assert.equal(plan.steps[0].command, 'echo "installing 1.2.3"');
    assert.ok(plan.steps.every((s: { requiresSudo?: boolean }) => s.requiresSudo === undefined));
    assert.match(plan.notes[0], /Echo installer on .+, version 1\.2\.3/);

    await assert.rejects(h.call(ext, 'agent.plan', { agent: 'shell', action: 'install' }), code('unsupported'));
    await assert.rejects(h.call(ext, 'agent.plan', { agent: 'codex', action: 'install' }), code('not_found'));
    await assert.rejects(h.call(ext, 'agent.plan', { agent: 'opencode', action: 'reinstall' }), code('bad_request'));
    await assert.rejects(h.call(ext, 'agent.plan', { agent: 'nope', action: 'install' }), code('bad_request'));
    await assert.rejects(h.call(ext, 'agent.plan', { agent: 'opencode', action: 'install', method: 'brew' }), code('not_found'));
    await assert.rejects(h.call(ext, 'agent.plan', { machineId: 'm_other', agent: 'opencode', action: 'install' }), code('not_found'));
    // Its own machine id is accepted.
    await h.call(ext, 'agent.plan', { machineId: h.node.machine.id, agent: 'opencode', action: 'uninstall' });
  });

  it('agent.install dryRun streams install.progress with jobId/step/total and runs nothing', async () => {
    const { ext, toolsDir } = setup();
    const h = await harness({ extensions: [ext] });
    after(() => h.close());
    const res = await h.call(ext, 'agent.install', { agent: 'opencode', action: 'install', dryRun: true });
    assert.match(res.jobId, /^job_[0-9A-Z]{26}$/);
    assert.equal(res.plan.steps.length, 4);
    await ext.idle();
    const events = progress(h, res.jobId);
    assert.equal(events[0]!.stage, 'plan');
    assert.match(events[0]!.message ?? '', /^\[dry-run\] install opencode/);
    assert.deepEqual(
      events.filter((e) => e.stage === 'step').map((e) => [e.step, e.total]),
      [
        [1, 4],
        [2, 4],
        [3, 4],
        [4, 4],
      ],
    );
    const done = events.at(-1)!;
    assert.deepEqual([done.stage, done.done, done.ok, done.agent], ['done', true, true, 'opencode']);
    assert.ok(events.every((e) => e.agent === 'opencode' && e.total === 4));
    assert.equal(events.filter((e) => e.stage === 'output').length, 0);
    assert.equal(existsSync(join(toolsDir, 'fakeoc')), false, 'nothing was written');
  });

  it('serializes real installs per machine', async () => {
    const { ext, toolsDir } = setup();
    const h = await harness({ extensions: [ext] });
    after(() => h.close());
    const a = await h.call(ext, 'agent.install', { agent: 'opencode', action: 'install' });
    const b = await h.call(ext, 'agent.install', { agent: 'opencode', action: 'update', version: '2.0.0' });
    await ext.idle();

    const all = progress(h);
    const ofA = all.filter((p) => p.jobId === a.jobId);
    const ofB = all.filter((p) => p.jobId === b.jobId);
    assert.deepEqual(
      [ofA.at(-1)?.ok, ofB.at(-1)?.ok],
      [true, true],
      JSON.stringify(all.filter((p) => p.stage === 'done' || p.stage === 'output')),
    );
    // B announced it was queued, and none of its steps started before A finished.
    assert.equal(ofB[0]!.stage, 'queued');
    const aDone = all.findIndex((p) => p.jobId === a.jobId && p.done);
    const bFirstStep = all.findIndex((p) => p.jobId === b.jobId && p.stage === 'plan');
    assert.ok(aDone >= 0 && bFirstStep > aDone, 'job B ran after job A');
    assert.ok(ofA.some((p) => p.stage === 'output' && p.message === 'installing latest'));
    assert.ok(ofB.some((p) => p.stage === 'output' && p.message === 'installing 2.0.0'));
    // The verify step found the freshly written binary.
    assert.ok(ofA.some((p) => p.stage === 'output' && p.message === 'bizzi-fake-oc 1.0.0'));
    assert.ok(existsSync(join(toolsDir, 'fakeoc', 'bin', 'bizzi-fake-oc')));
    // Output lines carry the step they belong to.
    const hello = ofA.find((p) => p.message === 'installing latest')!;
    assert.deepEqual([hello.step, hello.total], [1, 4]);
  });

  it('agent.setSecret / agent.secrets / agent.deleteSecret, injected into the agent env', async () => {
    const { ext, secrets } = setup();
    const claude = new FakeAdapter({ agent: 'claude' });
    const codex = new FakeAdapter({ agent: 'codex' });
    const h = await harness({ extensions: [ext], adapters: [claude, codex] });
    after(() => h.close());
    const VALUE = 'sk-ant-test-value';

    await h.call(ext, 'agent.setSecret', { agent: 'claude', name: 'ANTHROPIC_API_KEY', value: VALUE });
    await h.call(ext, 'agent.setSecret', { agent: 'codex', name: 'OPENAI_API_KEY', value: 'sk-openai' });
    const listed = await h.call(ext, 'agent.secrets', {});
    assert.deepEqual(
      listed.secrets.map((s: { agent: string; name: string }) => `${s.agent}:${s.name}`),
      ['claude:ANTHROPIC_API_KEY', 'codex:OPENAI_API_KEY'],
    );
    assert.ok(!JSON.stringify(listed).includes(VALUE), 'values are never returned');
    assert.deepEqual(
      (await h.call(ext, 'agent.secrets', { agent: 'codex' })).secrets.map((s: { name: string }) => s.name),
      ['OPENAI_API_KEY'],
    );
    await assert.rejects(h.call(ext, 'agent.setSecret', { agent: 'claude', name: 'PATH', value: 'x' }), code('bad_request'));
    await assert.rejects(h.call(ext, 'agent.setSecret', { agent: 'claude', name: 'K' }), code('bad_request'));

    // A session's agent gets its own secrets (and only those) as env vars.
    const { workspace } = await h.node.call('workspace.create', { path: tempDir() });
    await h.node.call('session.create', { workspaceId: workspace.id, agent: 'claude' });
    await waitFor(() => claude.starts.length === 1, 'claude start');
    assert.equal(claude.starts[0]!.env?.ANTHROPIC_API_KEY, VALUE);
    assert.equal(claude.starts[0]!.env?.OPENAI_API_KEY, undefined);
    await h.node.call('session.create', { workspaceId: workspace.id, agent: 'codex' });
    await waitFor(() => codex.starts.length === 1, 'codex start');
    assert.deepEqual(codex.starts[0]!.env, { OPENAI_API_KEY: 'sk-openai' });

    await h.call(ext, 'agent.deleteSecret', { agent: 'claude', name: 'ANTHROPIC_API_KEY' });
    await h.call(ext, 'agent.deleteSecret', { agent: 'claude', name: 'ANTHROPIC_API_KEY' }); // idempotent
    assert.equal(secrets.list('claude').length, 0);
    await h.node.call('session.create', { workspaceId: workspace.id, agent: 'claude' });
    await waitFor(() => claude.starts.length === 2, 'second claude start');
    assert.equal(claude.starts[1]!.env?.ANTHROPIC_API_KEY, undefined);
  });
});
