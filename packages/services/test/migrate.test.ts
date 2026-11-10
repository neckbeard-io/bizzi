// agent.migrate (spec §7): plan, dry run, and the 4-step job with a fake runPlan and a fake login shell.

import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { createNode, type BizziNode } from '@bizzi/core';
import { FakeAdapter } from '@bizzi/core/testing';
import { BizziError, GLOBAL_CHANNEL, type ChannelEvent, type GlobalEventMap } from '@bizzi/protocol';
import { parsePlatform, type ExecResult, type InstallPlan, type RunOptions, type RunResult } from '@bizzi/provision';
import { createProvisioningExtension, createUpdatesExtension, InstallAssessor, MemorySecretBackend, SecretStore } from '../src/index.ts';
import { logger, tempDir, waitFor } from './helpers.ts';

type Progress = GlobalEventMap['install.progress'];
const mac = parsePlatform('darwin-arm64');

function fakeBinary(path: string): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '\x7fELF fake');
  chmodSync(path, 0o755);
  return path;
}

interface Opts {
  /** What `command -v claude` prints in the login shell. */
  loginFinds: (home: string, brewBin: string) => string;
  /** Does the native install "succeed"? */
  installOk?: boolean;
  authAfter?: 'ok' | 'missing';
}

async function setup(o: Opts) {
  const dir = tempDir('bizzi-migrate-');
  const home = join(dir, 'home');
  const brewBin = join(dir, 'opt/homebrew/bin');
  const cask = fakeBinary(join(dir, 'opt/homebrew/Caskroom/claude-code/2.1.311/claude'));
  mkdirSync(brewBin, { recursive: true });
  symlinkSync(cask, join(brewBin, 'claude'));
  mkdirSync(join(home, '.local/bin'), { recursive: true });
  // bizzi's own PATH: the native bin dir first (what a correct setup looks like).
  const env = { HOME: home, USER: 'tester', SHELL: '/bin/zsh', PATH: `${join(home, '.local/bin')}:${brewBin}:/usr/bin:/bin` };
  const claude = new FakeAdapter({ agent: 'claude', probe: { path: join(brewBin, 'claude'), version: '2.1.311', auth: 'ok' } });

  const plans: InstallPlan[] = [];
  const runPlan = async (plan: InstallPlan, ro: RunOptions = {}): Promise<RunResult> => {
    plans.push(plan);
    for (const [i, s] of plan.steps.entries()) ro.onProgress?.({ agent: plan.agent, stage: 'step', message: `[${i + 1}/${plan.steps.length}] ${s.description}` });
    const ok = plan.action !== 'install' || o.installOk !== false;
    if (plan.action === 'install' && ok) {
      // What the native installer does: a version dir plus the ~/.local/bin/claude symlink.
      const v = fakeBinary(join(home, '.local/share/claude/versions/2.1.322'));
      symlinkSync(v, join(home, '.local/bin/claude'));
      claude.options.probe = { path: join(home, '.local/bin/claude'), version: '2.1.322', auth: o.authAfter ?? 'ok' };
    }
    if (plan.action === 'uninstall') rmSync(join(brewBin, 'claude'));
    ro.onProgress?.({ agent: plan.agent, stage: 'done', done: true, ok });
    return ok ? { ok, dryRun: false, steps: [] } : { ok, dryRun: false, steps: [], error: 'installer exited 1' };
  };
  const execCalls: { file: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  const exec = async (file: string, args: string[], eo: { env?: NodeJS.ProcessEnv } = {}): Promise<ExecResult> => {
    execCalls.push({ file, args, ...(eo.env ? { env: eo.env } : {}) });
    const found = o.loginFinds(home, brewBin);
    const stdout = `welcome banner from .zprofile\n__BIZZI_PATH__${join(home, '.local/bin')}:${brewBin}:/usr/bin\n__BIZZI_BIN__${found}\n`;
    return { code: 0, signal: null, stdout, stderr: '', timedOut: false, aborted: false, durationMs: 1 };
  };

  const assessor = new InstallAssessor({ platform: mac, env, home });
  const provisioning = createProvisioningExtension({
    secrets: new SecretStore({ backend: new MemorySecretBackend() }),
    platform: mac,
    env,
    home,
    hasCommand: () => true,
    assessor,
    runPlan,
    exec,
    refreshAfterInstall: false,
  });
  const updates = createUpdatesExtension({ assessor });
  const node: BizziNode = await createNode({ dataDir: join(dir, 'node'), adapters: [claude], logger, version: '0.0.0-test', extensions: [provisioning, updates] });
  after(() => node.close());
  const global: ChannelEvent[] = [];
  node.subscribe(GLOBAL_CHANNEL, node.bus.lastSeq(GLOBAL_CHANNEL), (e) => global.push(e));
  await node.call('agents.list', {});
  const progress = (jobId: string) => global.filter((e) => e.type === 'install.progress' && (e.data as Progress).jobId === jobId).map((e) => e.data as Progress);
  const finished = async (jobId: string) => {
    await waitFor(() => progress(jobId).some((p) => p.done), `job ${jobId}`);
    await provisioning.idle();
    const all = progress(jobId);
    return { all, done: all.find((p) => p.done)! };
  };
  return { node, home, brewBin, cask, claude, plans, execCalls, progress, finished, dir };
}

const nativeFirst = (home: string) => join(home, '.local/bin/claude');

describe('agent.migrate', () => {
  it('dry run returns the 4-step plan and changes nothing', async () => {
    const s = await setup({ loginFinds: nativeFirst });
    const { jobId, plan } = await s.node.call('agent.migrate', { agent: 'claude', dryRun: true });
    assert.equal(plan.method, 'native');
    assert.deepEqual(
      plan.steps.map((x) => x.id),
      ['claude.native.install.1', 'claude.verify', 'migrate.path', 'migrate.reprobe', 'claude.brew.uninstall.1'],
    );
    assert.equal(plan.steps[0]?.command, 'curl -fsSL https://claude.ai/install.sh | bash -s latest');
    assert.equal(plan.steps.at(-1)?.command, 'brew uninstall --cask claude-code');
    assert.match(plan.steps.at(-1)?.title ?? '', /^Remove the old install: /);
    assert.ok(plan.notes?.some((n) => n.includes('only when no session is using claude')));
    const { all, done } = await s.finished(jobId);
    assert.equal(done.ok, true);
    assert.match(done.message ?? '', /dry-run/);
    assert.equal(all.filter((p) => p.done).length, 1, 'exactly one done event');
    assert.equal(all.filter((p) => p.stage === 'step').length, 5);
    assert.deepEqual(s.plans, [], 'nothing ran');
    assert.deepEqual(s.execCalls, []);
  });

  it('installs, checks PATH, re-probes, then removes the old install when no session uses it', async () => {
    const s = await setup({ loginFinds: nativeFirst });
    const { jobId } = await s.node.call('agent.migrate', { agent: 'claude' });
    const { all, done } = await s.finished(jobId);
    assert.equal(done.ok, true, done.message ?? "");
    assert.match(done.message ?? '', /old brew install was removed/);
    assert.deepEqual(s.plans.map((p) => `${p.action}:${p.method}`), ['install:native', 'uninstall:brew']);
    assert.deepEqual(s.plans[1]?.steps[0]?.argv, ['brew', 'uninstall', '--cask', 'claude-code']);
    // The login shell ran with a launchd-like env: minimal PATH, profile sourced (-l).
    assert.equal(s.execCalls[0]?.file, '/bin/zsh');
    assert.equal(s.execCalls[0]?.args[0], '-l');
    assert.equal(s.execCalls[0]?.env?.PATH, '/usr/bin:/bin:/usr/sbin:/sbin');
    assert.ok(all.some((p) => p.stage === 'output' && /login: .*\.local\/bin\/claude .*\(ok\)/.test(p.message ?? '')));
    // Steps are numbered across the whole job; sub-plan "done" events became "phase".
    assert.equal(all.filter((p) => p.done).length, 1);
    assert.ok(all.some((p) => p.stage === 'phase'));
    assert.equal(Math.max(...all.map((p) => p.step ?? 0)), 5);
    assert.ok(all.every((p) => p.total === 5));
    const listing = (await s.node.call('agents.list', {})).agents[0]!;
    assert.equal(listing.method, 'native');
    assert.equal(listing.remedies, undefined);
  });

  it('keeps the old install while a session still uses the agent', async () => {
    const s = await setup({ loginFinds: nativeFirst });
    const { workspace } = await s.node.call('workspace.create', { path: join(s.dir, 'ws'), create: true });
    const { session } = await s.node.call('session.create', { workspaceId: workspace.id, agent: 'claude', mode: 'structured' });
    await waitFor(() => s.node.sessions.get(session.id).session.status === 'idle', 'session idle');
    const { jobId } = await s.node.call('agent.migrate', { agent: 'claude' });
    const { done } = await s.finished(jobId);
    assert.equal(done.ok, true);
    assert.match(done.message ?? '', /was kept because 1 session\(s\) still use claude/);
    assert.match(done.message ?? '', /brew uninstall --cask claude-code/);
    assert.deepEqual(s.plans.map((p) => p.action), ['install']);
  });

  it('stops with instructions when the old install comes first on the login PATH', async () => {
    const s = await setup({ loginFinds: (_h, brewBin) => join(brewBin, 'claude') });
    const { jobId } = await s.node.call('agent.migrate', { agent: 'claude' });
    const { done } = await s.finished(jobId);
    assert.equal(done.ok, false);
    assert.match(done.message ?? '', /must come first on PATH, but in login shells `claude` resolves to .*opt\/homebrew\/bin\/claude/);
    assert.match(done.message ?? '', /bizzi does not edit shell startup files/);
    assert.match(done.message ?? '', /export PATH="[^"]*\.local\/bin:\$PATH"/);
    assert.deepEqual(s.plans.map((p) => p.action), ['install'], 'old install untouched');
  });

  it('keeps the old install when the new one is not logged in, or the install failed', async () => {
    const a = await setup({ loginFinds: nativeFirst, authAfter: 'missing' });
    const r1 = await a.finished((await a.node.call('agent.migrate', { agent: 'claude' })).jobId);
    assert.equal(r1.done.ok, false);
    assert.match(r1.done.message ?? '', /not logged in.*agent\.login/);
    assert.deepEqual(a.plans.map((p) => p.action), ['install']);

    const b = await setup({ loginFinds: nativeFirst, installOk: false });
    const r2 = await b.finished((await b.node.call('agent.migrate', { agent: 'claude' })).jobId);
    assert.equal(r2.done.ok, false);
    assert.match(r2.done.message ?? '', /installing with .* failed: installer exited 1; the old install was not touched/);
    assert.deepEqual(b.execCalls, [], 'no PATH check after a failed install');
  });

  it('refuses what it cannot or need not migrate', async () => {
    const s = await setup({ loginFinds: nativeFirst });
    const isCode = (code: string) => (e: unknown) => e instanceof BizziError && e.code === code;
    await assert.rejects(s.node.call('agent.migrate', { agent: 'claude', toMethod: 'brew' }), isCode('conflict'));
    await assert.rejects(s.node.call('agent.migrate', { agent: 'claude', toMethod: 'nope' }), isCode('not_found'));
    await assert.rejects(s.node.call('agent.migrate', { agent: 'codex' }), isCode('agent_unavailable'));
    await assert.rejects(s.node.call('agent.migrate', { agent: 'shell' }), isCode('unsupported'));
    s.claude.options.probe = { path: '/somewhere/odd/claude', version: '2.1.311' };
    await s.node.call('agents.list', { refresh: true });
    await assert.rejects(s.node.call('agent.migrate', { agent: 'claude' }), (e: unknown) => isCode('bad_request')(e) && /can't tell how/.test((e as Error).message));
    s.claude.options.probe = { installed: false, path: undefined };
    await s.node.call('agents.list', { refresh: true });
    await assert.rejects(s.node.call('agent.migrate', { agent: 'claude' }), (e: unknown) => isCode('bad_request')(e) && /not installed/.test((e as Error).message));
  });
});
