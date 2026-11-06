import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BizziError } from '@bizzi/protocol';
import { parsePlatform, planInstall, type InstallPlan } from '../src/index.ts';
import { recipesWithFake } from './helpers.ts';

const HOME = '/home/tester';
const base = { home: HOME, toolsDir: `${HOME}/.bizzi/tools`, env: { PATH: '/usr/bin:/bin' } };
const all = { ...base, hasCommand: () => true };
const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'linux-x64-musl', 'linux-arm64-musl'];

function commands(p: InstallPlan): string[] {
  return p.steps.map((s) => s.command);
}

test('every agent has a default install plan on every platform', () => {
  for (const agent of ['claude', 'codex', 'opencode', 'agy'] as const) {
    for (const key of PLATFORMS) {
      const p = planInstall(agent, parsePlatform(key), all);
      assert.equal(p.agent, agent);
      assert.equal(p.action, 'install');
      assert.equal(p.requiresSudo, false);
      assert.ok(p.steps.length >= 2, `${agent} ${key}`);
      assert.equal(p.steps.at(-1)?.phase, 'verify');
      assert.deepEqual(p.steps.at(-1)?.argv?.[0], agent);
      assert.ok(p.targetDir.startsWith(HOME), `${agent} installs under home: ${p.targetDir}`);
    }
  }
});

test('default methods: vendor installer first', () => {
  const mac = parsePlatform('darwin-arm64');
  assert.deepEqual(commands(planInstall('claude', mac, all)), ['curl -fsSL https://claude.ai/install.sh | bash -s latest', 'claude --version']);
  assert.equal(planInstall('codex', mac, all).method, 'script');
  assert.equal(planInstall('opencode', mac, all).method, 'script');
  assert.equal(planInstall('agy', mac, all).method, 'script');
});

test('codex installer runs non-interactively into ~/.local/bin', () => {
  const p = planInstall('codex', parsePlatform('linux-x64'), all);
  assert.deepEqual(p.steps[0]?.env, {
    CODEX_NON_INTERACTIVE: '1',
    CODEX_INSTALL_DIR: `${HOME}/.local/bin`,
    CODEX_RELEASE: 'latest',
  });
  assert.equal(p.targetDir, `${HOME}/.local/bin`);
  assert.ok(p.extraPath.includes(`${HOME}/.local/bin`));
});

test('platform vars flow into commands (codex release binary, node tarball)', () => {
  const bin = planInstall('codex', parsePlatform('linux-arm64-musl'), { ...all, method: 'binary', version: '0.167.0' });
  assert.match(bin.steps[0]?.run ?? '', /codex-aarch64-unknown-linux-musl\.tar\.gz/);
  assert.match(bin.steps[0]?.run ?? '', /^v=0\.167\.0$/m);

  const node = planInstall('node', parsePlatform('darwin-x64'), all);
  assert.equal(node.version, '26.13.0', 'tools fall back to defaultVersion');
  assert.equal(node.targetDir, `${HOME}/.bizzi/tools/node/26.13.0`);
  assert.match(node.steps[0]?.run ?? '', /asset=node-v26\.13\.0-darwin-x64\.tar\.gz/);
  assert.match(node.steps[0]?.run ?? '', /ln -sfn \/home\/tester\/\.bizzi\/tools\/node\/26\.13\.0\/bin \/home\/tester\/\.bizzi\/tools\/node\/bin/);
  assert.deepEqual(node.extraPath, [`${HOME}/.bizzi/tools/node/bin`]);
  assert.equal(node.agent, 'shell');
  assert.equal(planInstall('node', parsePlatform('linux-x64'), { ...all, forAgent: 'codex' }).agent, 'codex');
});

test('brew is offered on macOS only', () => {
  const p = planInstall('claude', parsePlatform('darwin-arm64'), { ...all, method: 'brew' });
  assert.deepEqual(commands(p), ['HOMEBREW_NO_AUTO_UPDATE=1 brew install --cask claude-code', 'claude --version']);
  assert.equal(p.targetDir, '/opt/homebrew/bin');
  assert.equal(planInstall('claude', parsePlatform('darwin-x64'), { ...all, method: 'brew' }).targetDir, '/usr/local/bin');
  assert.throws(
    () => planInstall('claude', parsePlatform('linux-x64'), { ...all, method: 'brew' }),
    (e: unknown) => e instanceof BizziError && e.code === 'unsupported',
  );
});

test('errors: unknown recipe, unknown method, unsupported platform, bad version', () => {
  const linux = parsePlatform('linux-x64');
  assert.throws(() => planInstall('emacs', linux, all), (e: unknown) => e instanceof BizziError && e.code === 'not_found');
  assert.throws(() => planInstall('claude', linux, { ...all, method: 'apt' }), (e: unknown) => e instanceof BizziError && e.code === 'not_found');
  assert.throws(
    () => planInstall('node', parsePlatform('linux-arm64-musl'), all),
    (e: unknown) => e instanceof BizziError && e.code === 'unsupported',
  );
  for (const bad of ['1.0; rm -rf ~', '$(id)', '1.0 2.0', '', '../x']) {
    assert.throws(
      () => planInstall('claude', linux, { ...all, version: bad }),
      (e: unknown) => e instanceof BizziError && e.code === 'bad_request',
      bad,
    );
  }
});

test('version pinning', () => {
  const linux = parsePlatform('linux-x64');
  assert.deepEqual(commands(planInstall('claude', linux, { ...all, version: '2.1.89' }))[0], 'curl -fsSL https://claude.ai/install.sh | bash -s 2.1.89');
  assert.deepEqual(commands(planInstall('claude', linux, { ...all, version: 'stable' }))[0], 'curl -fsSL https://claude.ai/install.sh | bash -s stable');
  assert.equal(
    commands(planInstall('opencode', linux, { ...all, version: '2.2.5' }))[0],
    'curl -fsSL https://opencode.ai/v2/install | bash -s -- --no-modify-path --version 2.2.5',
  );
  const agy = planInstall('agy', linux, { ...all, version: '1.5.2' });
  assert.equal(agy.version, undefined);
  assert.match(agy.warnings.join('\n'), /can't pin versions/);
});

test('update and uninstall plans', () => {
  const linux = parsePlatform('linux-x64');
  assert.deepEqual(commands(planInstall('claude', linux, { ...all, action: 'update' })), ['claude update', 'claude --version']);
  assert.deepEqual(commands(planInstall('claude', linux, { ...all, action: 'update', version: '2.1.89' })), ['claude install 2.1.89', 'claude --version']);
  const un = planInstall('claude', linux, { ...all, action: 'uninstall' });
  assert.deepEqual(commands(un), ['rm -f "$HOME/.local/bin/claude"', 'rm -rf "$HOME/.local/share/claude"']);
  assert.ok(un.steps.every((s) => s.phase === 'main'), 'no verify step on uninstall');
  assert.deepEqual(un.extraPath, []);
  // Methods without an update list re-run install (codex installer).
  assert.match(commands(planInstall('codex', linux, { ...all, action: 'update' }))[0] ?? '', /install\.sh \| sh$/);
  assert.deepEqual(commands(planInstall('opencode', linux, { ...all, action: 'uninstall' })), ['opencode uninstall --force']);
});

test('npm route plans a managed Node first when npm is missing', () => {
  const linux = parsePlatform('linux-x64');
  const p = planInstall('codex', linux, { ...base, method: 'npm', hasCommand: (c) => c !== 'npm' });
  assert.deepEqual(
    p.steps.map((s) => [s.recipe, s.phase]),
    [
      ['node', 'dependency'],
      ['node', 'dependency'],
      ['codex', 'main'],
      ['codex', 'verify'],
    ],
  );
  assert.equal(p.steps[2]?.command, `NPM_CONFIG_PREFIX=${HOME}/.local npm install -g @openai/codex@latest`);
  assert.deepEqual(p.steps[2]?.env, { NPM_CONFIG_PREFIX: `${HOME}/.local` });
  assert.deepEqual(p.extraPath, [`${HOME}/.local/bin`, `${HOME}/.bizzi/tools/node/bin`]);

  // With npm present there is no dependency.
  assert.equal(planInstall('codex', linux, { ...all, method: 'npm' }).steps.length, 2);
});

test('auto-selection skips methods whose requirements are missing', () => {
  const linux = parsePlatform('linux-x64');
  // No curl/bash: the native installer can't run, npm (with a node dependency) can be planned.
  const p = planInstall('claude', linux, { ...base, hasCommand: () => false });
  assert.equal(p.method, 'npm');
  assert.match(p.warnings.join('\n'), /node: requires "curl"/);
  // Only curl+bash: native.
  assert.equal(planInstall('claude', linux, { ...base, hasCommand: (c) => c === 'curl' || c === 'bash' }).method, 'native');
});

test('template values are shell-quoted when unsafe', () => {
  const recipes = recipesWithFake();
  const home = '/home/o\'brien/my home';
  const p = planInstall('fake', parsePlatform('linux-x64'), { recipes, home, toolsDir: `${home}/tools`, hasCommand: () => true });
  const write = p.steps.find((s) => s.description === 'Write the fake binary');
  assert.match(write?.run ?? '', /mkdir -p '\/home\/o'\\''brien\/my home\/tools'\/fake\/bin/);
  // argv and cwd are passed raw (no shell involved).
  assert.equal(p.steps.find((s) => s.description === 'Show env and cwd')?.cwd, home);
});

test('fake recipe: when-conditions, defaults and dry-run text', () => {
  const recipes = recipesWithFake();
  const p = planInstall('fake', parsePlatform('darwin-arm64'), { ...all, recipes, version: '1.2.3' });
  assert.equal(p.steps[0]?.command, 'echo "installing fake 1.2.3 for mac-arm"');
  assert.equal(p.steps[1]?.command, `FAKE_VAR=from-step echo "FAKE_VAR=$FAKE_VAR cwd=$(pwd)"`);
  assert.equal(p.steps[3]?.command, 'echo argv 1.2.3');
  const unpinned = planInstall('fake', parsePlatform('darwin-arm64'), { ...all, recipes });
  assert.equal(unpinned.steps[3]?.command, 'echo argv latest');
  assert.equal(planInstall('fake', parsePlatform('darwin-arm64'), { ...all, recipes, verify: false }).steps.at(-1)?.phase, 'main');
});
