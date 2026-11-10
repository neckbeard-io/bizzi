// Policies, install facts on agents.list, unsupported refusal, version watching and auto-updates.

import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { createNode, type BizziNode } from '@bizzi/core';
import { FakeAdapter } from '@bizzi/core/testing';
import { BizziError, GLOBAL_CHANNEL, type AgentKind, type ChannelEvent } from '@bizzi/protocol';
import { parsePlatform, type InstallPlan, type RunOptions, type RunResult } from '@bizzi/provision';
import {
  createProvisioningExtension,
  createUpdatesExtension,
  defaultPolicies,
  InstallAssessor,
  InstallWatcher,
  MemorySecretBackend,
  PolicyStore,
  SecretStore,
  type UpdatesOptions,
  type WatchFn,
} from '../src/index.ts';
import { logger, sleep, tempDir, waitFor } from './helpers.ts';

const mac = parsePlatform('darwin-arm64');

function fakeBinary(path: string): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '\x7fELF fake');
  chmodSync(path, 0o755);
  return path;
}

/** A fake fs.watch: records listeners per directory; `fire(dir, name)` simulates an event. */
function fakeWatch() {
  const listeners = new Map<string, ((event: string, filename: string | null) => void)[]>();
  const watchFn: WatchFn = (path, listener) => {
    const l = listeners.get(path) ?? [];
    l.push(listener as (event: string, filename: string | null) => void);
    listeners.set(path, l);
    return {
      close() {
        listeners.set(
          path,
          (listeners.get(path) ?? []).filter((x) => x !== listener),
        );
      },
    };
  };
  return {
    watchFn,
    dirs: () => [...listeners.entries()].filter(([, l]) => l.length > 0).map(([d]) => d).sort(),
    fire(dir: string, name: string | null) {
      for (const l of listeners.get(dir) ?? []) l('rename', name);
    },
  };
}

interface Setup {
  node: BizziNode;
  home: string;
  dir: string;
  global: ChannelEvent[];
  plans: InstallPlan[];
  updates: ReturnType<typeof createUpdatesExtension>;
  policies: PolicyStore;
}

async function setup(adapters: FakeAdapter[], updatesOpts: Omit<UpdatesOptions, 'assessor' | 'policies'> = {}): Promise<Setup> {
  const dir = tempDir('bizzi-updates-');
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  const env = { HOME: home, PATH: `${join(home, '.local/bin')}:/usr/bin:/bin` };
  const assessor = new InstallAssessor({ platform: mac, env, home });
  const policies = new PolicyStore({ path: join(dir, 'data', 'agent-policies.json') });
  const plans: InstallPlan[] = [];
  const runPlan = async (plan: InstallPlan, o: RunOptions = {}): Promise<RunResult> => {
    plans.push(plan);
    o.onProgress?.({ agent: plan.agent, stage: 'done', done: true, ok: true });
    return { ok: true, dryRun: false, steps: [] };
  };
  const provisioning = createProvisioningExtension({
    secrets: new SecretStore({ backend: new MemorySecretBackend() }),
    platform: mac,
    env,
    home,
    hasCommand: () => true,
    assessor,
    runPlan,
    refreshAfterInstall: false,
  });
  const updates = createUpdatesExtension({ assessor, policies, ...updatesOpts });
  const node = await createNode({ dataDir: join(dir, 'node'), adapters, logger, version: '0.0.0-test', extensions: [provisioning, updates] });
  after(() => node.close());
  const global: ChannelEvent[] = [];
  node.subscribe(GLOBAL_CHANNEL, node.bus.lastSeq(GLOBAL_CHANNEL), (e) => global.push(e));
  return { node, home, dir, global, plans, updates, policies };
}

describe('policies', () => {
  it('defaults follow updates.md §6', () => {
    assert.deepEqual(defaultPolicies('claude'), { update: 'auto', restart: 'when-idle' });
    assert.deepEqual(defaultPolicies('opencode'), { update: 'auto', restart: 'when-idle' });
    assert.deepEqual(defaultPolicies('agy'), { update: 'auto', restart: 'ask' });
  });

  it('persist across restarts, ignore junk, and reject bad values', () => {
    const dir = tempDir();
    const path = join(dir, 'p', 'agent-policies.json');
    const a = new PolicyStore({ path });
    assert.deepEqual(a.set('codex', { update: 'pinned' }), { update: 'pinned', restart: 'when-idle' });
    a.set('codex', { restart: 'manual' });
    assert.deepEqual(new PolicyStore({ path }).get('codex'), { update: 'pinned', restart: 'manual' });
    assert.deepEqual(new PolicyStore({ path }).overrides('claude'), {});
    assert.throws(() => a.set('codex', { update: 'sometimes' as never }), (e: unknown) => e instanceof BizziError && e.code === 'bad_request');
    writeFileSync(path, JSON.stringify({ agents: { codex: { update: 'weekly', restart: 'ask' } } }));
    assert.deepEqual(new PolicyStore({ path }).get('codex'), { update: 'auto', restart: 'ask' });
    writeFileSync(path, '{not json');
    assert.deepEqual(new PolicyStore({ path }).get('codex'), defaultPolicies('codex'));
  });

  it('agent.policy.set stores them and agents.list shows them', async () => {
    const s = await setup([new FakeAdapter({ agent: 'codex', probe: { version: '0.167.0' } })]);
    const before = (await s.node.call('agents.list', {})).agents[0]!;
    assert.equal(before.updatePolicy, 'auto');
    assert.equal(before.restartPolicy, 'when-idle');
    const { agent } = await s.node.call('agent.policy.set', { agent: 'codex', update: 'notify', restart: 'ask' });
    assert.equal(agent.updatePolicy, 'notify');
    assert.equal(agent.restartPolicy, 'ask');
    assert.equal((await s.node.call('agents.list', {})).agents[0]!.updatePolicy, 'notify', 'no re-probe needed');
    const saved = JSON.parse(readFileSync(join(s.dir, 'data', 'agent-policies.json'), 'utf8')) as { agents: Record<string, unknown> };
    assert.deepEqual(saved.agents.codex, { update: 'notify', restart: 'ask' });
    // An agent without an adapter still gets an answer.
    const { agent: agy } = await s.node.call('agent.policy.set', { agent: 'agy', update: 'pinned' });
    assert.deepEqual([agy.installed, agy.updatePolicy, agy.restartPolicy], [false, 'pinned', 'ask']);
    await assert.rejects(s.node.call('agent.policy.set', { agent: 'codex', update: 'never' as never }), (e: unknown) => e instanceof BizziError && e.code === 'bad_request');
  });
});

describe('install facts on agents.list', () => {
  it('reports realPath, method, preferredMethod, support and the migrate remedy', async () => {
    const dir = tempDir();
    const cask = fakeBinary(join(dir, 'opt/homebrew/Caskroom/claude-code/2.1.311/claude'));
    const s = await setup([new FakeAdapter({ agent: 'claude', probe: { path: cask, version: '2.1.311' } })]);
    const [claude] = (await s.node.call('agents.list', {})).agents;
    assert.equal(claude?.realPath, cask);
    assert.equal(claude?.method, 'brew');
    assert.equal(claude?.preferredMethod, 'native');
    assert.equal(claude?.support, 'ok');
    assert.deepEqual(claude?.remedies, [{ kind: 'migrate', title: 'Switch to the native installer', method: 'native' }]);
  });

  it('refuses structured sessions on an unsupported install and suggests terminal mode', async () => {
    const oc = new FakeAdapter({ agent: 'opencode', probe: { path: '/nowhere/.opencode/bin/opencode', version: '1.14.3' } });
    const term = new FakeAdapter({ agent: 'opencode', modes: ['terminal'] });
    const s = await setup([oc, term]);
    const { workspace } = await s.node.call('workspace.create', { path: join(s.dir, 'ws'), create: true });
    const [listing] = (await s.node.call('agents.list', {})).agents;
    assert.equal(listing?.support, 'unsupported');
    assert.equal(listing?.remedies?.[0]?.title, 'Upgrade to v2');
    await assert.rejects(s.node.call('session.create', { workspaceId: workspace.id, agent: 'opencode', mode: 'structured' }), (e: unknown) => {
      assert.ok(e instanceof BizziError);
      assert.equal(e.code, 'unsupported');
      assert.match(e.message, /OpenCode v1 is not supported.*terminal-mode session/);
      return true;
    });
    const { session } = await s.node.call('session.create', { workspaceId: workspace.id, agent: 'opencode', mode: 'terminal' });
    assert.equal(session.mode, 'terminal');
  });

  it('agent.plan updates and uninstalls an adopted Homebrew install via the formula it came from', async () => {
    const dir = tempDir();
    const bin = fakeBinary(join(dir, 'opt/homebrew/Cellar/opencode/2.2.6/bin/opencode'));
    writeFileSync(join(dir, 'opt/homebrew/Cellar/opencode/2.2.6/INSTALL_RECEIPT.json'), JSON.stringify({ source: { tap: 'homebrew/core' } }));
    const s = await setup([new FakeAdapter({ agent: 'opencode', probe: { path: bin, version: '2.2.6' } })]);
    await s.node.call('agents.list', {});
    const un = (await s.node.call('agent.plan', { agent: 'opencode', action: 'uninstall' })).plan;
    assert.equal(un.method, 'brew');
    assert.equal(un.steps[0]?.command, 'brew uninstall opencode');
    const up = (await s.node.call('agent.plan', { agent: 'opencode', action: 'update' })).plan;
    assert.equal(up.steps[0]?.command, 'brew upgrade opencode');
    // An explicit other method is respected; fresh installs keep the recipe's tap.
    assert.equal((await s.node.call('agent.plan', { agent: 'opencode', action: 'uninstall', method: 'npm' })).plan.method, 'npm');
    assert.equal((await s.node.call('agent.plan', { agent: 'opencode', action: 'install', method: 'brew' })).plan.steps[0]?.command, 'HOMEBREW_NO_AUTO_UPDATE=1 brew install anomalyco/tap/opencode-v2');
  });
});

describe('InstallWatcher', () => {
  it('debounces per agent, filters by file name, tolerates missing dirs and retries them', async () => {
    const dir = tempDir();
    const versions = join(dir, 'versions');
    mkdirSync(versions);
    mkdirSync(join(dir, 'bin'));
    const fw = fakeWatch();
    const changes: AgentKind[] = [];
    const w = new InstallWatcher({ onChange: (a) => changes.push(a), debounceMs: 40, watchFn: fw.watchFn });
    const later = join(dir, 'later');
    w.update(new Map([['claude', [versions, join(dir, 'bin', 'claude'), later]]]));
    // A directory is watched itself; a file, or a missing path whose parent exists, via the parent.
    assert.deepEqual(fw.dirs(), [dir, join(dir, 'bin'), versions].sort());
    for (let i = 0; i < 5; i++) fw.fire(versions, '2.1.322');
    fw.fire(join(dir, 'bin'), 'agy'); // another file in the same dir: ignored
    await sleep(15);
    assert.deepEqual(changes, [], 'still within the debounce window');
    await sleep(80);
    assert.deepEqual(changes, ['claude'], 'one change for a burst');

    fw.fire(join(dir, 'bin'), 'claude');
    await sleep(80);
    assert.deepEqual(changes, ['claude', 'claude']);

    // Paths dropped from the targets are unwatched; close stops pending timers.
    w.update(new Map([['claude', [versions]]]));
    assert.deepEqual(fw.dirs(), [versions]);
    fw.fire(versions, null);
    w.close();
    await sleep(80);
    assert.deepEqual(changes, ['claude', 'claude']);
    assert.deepEqual(fw.dirs(), []);
  });

  it('skips paths whose directory does not exist yet and picks them up on a later update', () => {
    const dir = tempDir();
    const fw = fakeWatch();
    const w = new InstallWatcher({ onChange: () => {}, debounceMs: 10, watchFn: fw.watchFn });
    const target = join(dir, 'a', 'b', 'opencode');
    w.update(new Map([['opencode', [target]]]));
    assert.deepEqual(w.watched(), {});
    mkdirSync(join(dir, 'a', 'b'), { recursive: true });
    w.update(new Map([['opencode', [target]]]));
    assert.deepEqual(w.watched(), { opencode: [target] });
    assert.deepEqual(fw.dirs(), [join(dir, 'a', 'b')]);
    w.close();
  });

  it('works with the real fs.watch', async () => {
    const dir = tempDir();
    const changes: AgentKind[] = [];
    const w = new InstallWatcher({ onChange: (a) => changes.push(a), debounceMs: 50 });
    after(() => w.close());
    w.update(new Map([['codex', [dir]]]));
    await sleep(50);
    writeFileSync(join(dir, 'current'), 'x');
    await waitFor(() => changes.length > 0, 'fs.watch event', 5000);
    assert.deepEqual(changes, ['codex']);
  });
});

describe('installed-version watching', () => {
  it('re-probes on a watched change, emits the change, and reports installed versions', async () => {
    const fw = fakeWatch();
    const claude = new FakeAdapter({ agent: 'claude' });
    const s = await setup([claude], { watch: true, debounceMs: 20, watchFn: fw.watchFn });
    const v1 = fakeBinary(join(s.home, '.local/share/claude/versions/2.1.311'));
    mkdirSync(join(s.home, '.local/bin'), { recursive: true });
    symlinkSync(v1, join(s.home, '.local/bin/claude'));
    claude.options.probe = { path: join(s.home, '.local/bin/claude'), version: '2.1.311' };
    await s.updates.reprobe('test');
    assert.deepEqual(s.updates.watched(), { claude: [join(s.home, '.local/bin/claude'), join(s.home, '.local/share/claude/versions')] });
    assert.equal(s.updates.installedVersion('claude'), '2.1.311');
    // (The start-up probe saw the adapter's default fake probe; that change was announced too.)
    s.global.length = 0;
    await s.updates.reprobe('again');
    assert.deepEqual(s.global.filter((e) => e.type === 'install.progress'), [], 'nothing changed since');

    // Claude's auto-updater: new version dir, symlink flips.
    claude.options.probe = { path: join(s.home, '.local/bin/claude'), version: '2.1.322' };
    fw.fire(join(s.home, '.local/share/claude/versions'), '2.1.322');
    fw.fire(join(s.home, '.local/bin'), 'claude');
    await waitFor(() => s.global.some((e) => e.type === 'install.progress'), 'detected event');
    await sleep(60);
    const detected = s.global.filter((e) => e.type === 'install.progress');
    assert.equal(detected.length, 1, 'one event for the burst');
    assert.deepEqual(
      { ...(detected[0]!.data as object), jobId: undefined },
      { agent: 'claude', jobId: undefined, stage: 'detected', message: 'claude 2.1.311 → 2.1.322 installed', done: true, ok: true },
    );
    assert.ok(s.global.some((e) => e.type === 'machine.updated'));
    assert.deepEqual(s.updates.installedVersions(), { claude: '2.1.322' });
  });

  it('is off by default: no watches, no background probes', async () => {
    const fw = fakeWatch();
    const s = await setup([new FakeAdapter({ agent: 'claude' })], { watchFn: fw.watchFn });
    await sleep(30);
    assert.deepEqual(fw.dirs(), []);
    assert.equal(s.node.registry.lastKnown('claude'), undefined, 'nothing probed in the background');
  });
});

describe('auto-update check', () => {
  it('runs the recipe update for auto, only observes self-updating installs, and skips notify/pinned', async () => {
    const dir = tempDir();
    const cask = fakeBinary(join(dir, 'opt/homebrew/Caskroom/codex/0.167.0/codex'));
    const ocBin = fakeBinary(join(dir, 'opt/homebrew/Cellar/opencode/2.0.25/bin/opencode'));
    const codex = new FakeAdapter({ agent: 'codex', probe: { path: cask, version: '0.167.0' } });
    const opencode = new FakeAdapter({ agent: 'opencode', probe: { path: ocBin, version: '2.0.25' } });
    const claude = new FakeAdapter({ agent: 'claude' });
    const latest: Partial<Record<AgentKind, string>> = { codex: '0.168.0', opencode: '2.0.30', claude: '2.1.400' };
    const s = await setup([codex, opencode, claude], { latest: async (a) => latest[a] });
    const native = fakeBinary(join(s.home, '.local/share/claude/versions/2.1.322'));
    claude.options.probe = { path: native, version: '2.1.322' };
    s.policies.set('opencode', { update: 'notify' });
    await s.node.call('agents.list', {});

    assert.deepEqual(await s.updates.checkForUpdates(), ['codex']);
    await waitFor(() => s.plans.length === 1, 'update job');
    assert.equal(s.plans[0]?.action, 'update');
    assert.equal(s.plans[0]?.method, 'brew');
    assert.deepEqual(s.plans[0]?.steps[0]?.argv, ['brew', 'upgrade', '--cask', 'codex']);

    const agents = (await s.node.call('agents.list', {})).agents;
    const oc = agents.find((a) => a.agent === 'opencode')!;
    assert.equal(oc.updateAvailable, true, 'notify: flagged only');
    assert.equal(oc.latestVersion, '2.0.30');
    assert.equal(agents.find((a) => a.agent === 'claude')?.updateAvailable, true, 'native claude: observed, not updated');

    // One attempt per release; pinned never updates.
    assert.deepEqual(await s.updates.checkForUpdates(), []);
    latest.codex = '0.169.0';
    s.policies.set('codex', { update: 'pinned' });
    assert.deepEqual(await s.updates.checkForUpdates(), []);
    assert.equal(s.plans.length, 1);
  });
});
