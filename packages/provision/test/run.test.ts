import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { currentPlatform, parseRecipe, planInstall, RecipeSet, runPlan, type InstallProgress } from '../src/index.ts';
import { isolatedEnv, recipesWithFake, tempDir } from './helpers.ts';

const platform = currentPlatform();

function setup() {
  const home = realpathSync(tempDir());
  const tools = join(home, 'tools');
  return { home, tools, env: isolatedEnv(home) };
}

test('dry run prints every command and executes nothing', async () => {
  const { home, tools, env } = setup();
  const plan = planInstall('fake', platform, { recipes: recipesWithFake(), home, toolsDir: tools, env, hasCommand: () => true });
  const events: InstallProgress[] = [];
  const res = await runPlan(plan, { dryRun: true, env, onProgress: (p) => events.push(p) });

  assert.equal(res.ok, true);
  assert.equal(res.dryRun, true);
  assert.ok(res.steps.every((s) => s.skipped));
  assert.equal(existsSync(join(tools, 'fake')), false, 'nothing was written');
  assert.equal(events[0]?.stage, 'plan');
  assert.match(events[0]?.message ?? '', /^\[dry-run\] install fake/);
  const stepEvents = events.filter((e) => e.stage === 'step');
  assert.equal(stepEvents.length, plan.steps.length);
  assert.match(stepEvents[0]?.message ?? '', /\[1\/5\] Say hello\n\$ echo "installing fake latest for /);
  // `fake` isn't an AgentKind, so events report the default agent.
  assert.ok(events.every((e) => e.agent === 'shell'));
  assert.deepEqual(events.at(-1), { agent: plan.agent, stage: 'done', message: 'install fake: ok', done: true, ok: true });
  assert.equal(events.filter((e) => e.stage === 'output').length, 0);
});

test('dry run of a real agent recipe runs nothing', async () => {
  const { home, env } = setup();
  for (const agent of ['claude', 'codex', 'opencode', 'agy'] as const) {
    const plan = planInstall(agent, platform, { home, env, hasCommand: () => true });
    const events: InstallProgress[] = [];
    const res = await runPlan(plan, { dryRun: true, env, onProgress: (p) => events.push(p) });
    assert.equal(res.ok, true);
    assert.ok(events.every((e) => e.agent === agent));
    assert.ok(events.some((e) => e.stage === 'step' && e.message?.includes(plan.steps[0]?.command ?? '???')));
  }
});

test('real run of the fake recipe: env, cwd, output streaming and verify', async () => {
  const { home, tools, env } = setup();
  const plan = planInstall('fake', platform, { recipes: recipesWithFake(), home, toolsDir: tools, env, version: '1.2.3', hasCommand: () => true });
  const events: InstallProgress[] = [];
  const res = await runPlan(plan, { env, onProgress: (p) => events.push(p) });
  assert.equal(res.ok, true, JSON.stringify(events, null, 1));
  const output = events.filter((e) => e.stage === 'output').map((e) => e.message);
  const target = platform.os === 'darwin' ? (platform.arch === 'arm64' ? 'mac-arm' : 'mac-intel') : `linux-${platform.arch === 'x64' ? 'amd64' : 'arm64'}`;
  assert.deepEqual(output, [
    `installing fake 1.2.3 for ${target}`,
    `FAKE_VAR=from-step cwd=${home}`,
    'argv 1.2.3',
    // verify step: found via the method's binDir, prepended to PATH
    'fake-agent 1.2.3',
  ]);
  assert.ok(existsSync(join(tools, 'fake', 'bin', 'fake-agent')));
  assert.ok(res.steps.every((s) => s.ok && !s.skipped && s.exitCode === 0));
  assert.deepEqual(events.at(-1), { agent: plan.agent, stage: 'done', message: 'install fake: ok', done: true, ok: true });

  const un = await runPlan(planInstall('fake', platform, { recipes: recipesWithFake(), home, toolsDir: tools, env, action: 'uninstall' }), { env });
  assert.equal(un.ok, true);
  assert.equal(existsSync(join(tools, 'fake')), false);
});

const failing = `
schema: 1
name: failing
kind: tool
displayName: Failing
homepage: https://example.com
docs: [https://example.com]
verified: true
platforms: { darwin-arm64: {}, darwin-x64: {}, linux-x64: {}, linux-arm64: {} }
detect: { binaries: [failing], version: { args: [--version], regex: '(\\d+)' } }
latest: [{ type: npm, package: failing, verified: true }]
methods:
  - id: steps
    kind: script
    label: Steps
    targetDir: "~/x"
    pinnable: false
    verified: true
    install:
      - { description: tolerated, run: "echo soft; exit 3", allowFailure: true }
      - { description: breaks, run: "echo hard >&2; exit 7" }
      - { description: never, run: "echo unreachable" }
  - id: slow
    kind: script
    label: Slow
    targetDir: "~/x"
    pinnable: false
    verified: true
    install:
      - { description: hangs, run: "sleep 30", timeoutMs: 300 }
  - id: sudo
    kind: script
    label: Sudo
    targetDir: "~/x"
    pinnable: false
    verified: true
    install:
      - { description: root, run: "echo root", requiresSudo: true }
`;

test('failures stop the plan; allowFailure steps continue; stderr is streamed', async () => {
  const { home, env } = setup();
  const recipes = new RecipeSet([parseRecipe(failing)]);
  const plan = planInstall('failing', platform, { recipes, home, env, method: 'steps', verify: false, hasCommand: () => true });
  const events: InstallProgress[] = [];
  const res = await runPlan(plan, { env, onProgress: (p) => events.push(p) });
  assert.equal(res.ok, false);
  assert.deepEqual(
    res.steps.map((s) => [s.description, s.exitCode, s.ok]),
    [
      ['tolerated', 3, false],
      ['breaks', 7, false],
    ],
  );
  assert.match(res.error ?? '', /\[2\/3\] breaks: exit 7/);
  assert.ok(events.some((e) => e.stage === 'warning' && /allowed to fail/.test(e.message ?? '')));
  assert.ok(events.some((e) => e.stage === 'output' && e.message === 'hard'));
  assert.ok(!events.some((e) => e.message === 'unreachable'));
  assert.equal(events.at(-1)?.ok, false);
  assert.equal(events.at(-1)?.done, true);
});

test('step timeouts kill the step', async () => {
  const { home, env } = setup();
  const recipes = new RecipeSet([parseRecipe(failing)]);
  const plan = planInstall('failing', platform, { recipes, home, env, method: 'slow', verify: false, hasCommand: () => true });
  const started = Date.now();
  const res = await runPlan(plan, { env });
  assert.equal(res.ok, false);
  assert.equal(res.steps[0]?.timedOut, true);
  assert.match(res.error ?? '', /timed out after 300 ms/);
  assert.ok(Date.now() - started < 10_000);
});

test('sudo steps are refused unless allowed', async () => {
  const { home, env } = setup();
  const recipes = new RecipeSet([parseRecipe(failing)]);
  const plan = planInstall('failing', platform, { recipes, home, env, method: 'sudo', verify: false, hasCommand: () => true });
  assert.equal(plan.requiresSudo, true);
  const res = await runPlan(plan, { env });
  assert.equal(res.ok, false);
  assert.equal(res.steps.length, 0);
  assert.match(res.error ?? '', /require sudo/);
  assert.equal((await runPlan(plan, { env, dryRun: true })).ok, true, 'dry run still prints it');
});

test('abort signal stops a running step', async () => {
  const { home, env } = setup();
  const recipes = new RecipeSet([parseRecipe(failing.replace('timeoutMs: 300', 'timeoutMs: 60000'))]);
  const plan = planInstall('failing', platform, { recipes, home, env, method: 'slow', verify: false, hasCommand: () => true });
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 200);
  const res = await runPlan(plan, { env, signal: ctrl.signal });
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /aborted/);
});

test('a missing working directory fails the step with a clear error', async () => {
  const { home, env } = setup();
  const yaml = failing.replace('{ description: hangs, run: "sleep 30", timeoutMs: 300 }', '{ description: elsewhere, run: "true", cwd: "~/nope" }');
  const recipes = new RecipeSet([parseRecipe(yaml)]);
  const plan = planInstall('failing', platform, { recipes, home, env, method: 'slow', verify: false, hasCommand: () => true });
  const res = await runPlan(plan, { env });
  assert.equal(res.ok, false);
  assert.match(res.error ?? '', /working directory .*\/nope does not exist/);
});
