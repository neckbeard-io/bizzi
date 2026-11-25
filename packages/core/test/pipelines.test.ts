import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { BizziError, GLOBAL_CHANNEL, sessionChannel, type PipelineInfo, type PipelineSpec, type SessionInfo } from '@bizzi/protocol';
import { MAX_PLACEHOLDER_CHARS, createNode, parsePipelineSpec, renderTemplate, type BizziNode } from '../src/index.ts';
import { FakeAdapter, defaultScript, textOf, type FakeScript } from '../src/testing/index.ts';
import { record, tempDir, waitFor } from './helpers.ts';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'bizzi test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'bizzi test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], { cwd, env: GIT_ENV, encoding: 'utf8' });
}

function makeRepo(root: string): string {
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  writeFileSync(join(repo, 'README.md'), 'hello\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  return realpathSync(repo);
}

/** PLAN → a plan; IMPLEMENT → edits README.md and adds feature.txt in its cwd; anything else: the default script. */
const script: FakeScript = (input, ctx) => {
  const text = textOf(input);
  if (text.startsWith('PLAN')) return [{ type: 'text', text: 'Plan: add feature.txt and mention it in the README.' }];
  if (text.startsWith('IMPLEMENT')) {
    const cwd = ctx.session.opts.cwd;
    writeFileSync(join(cwd, 'README.md'), 'hello\nsee feature.txt\n');
    writeFileSync(join(cwd, 'feature.txt'), 'the feature\n');
    return [
      { type: 'tool', title: 'edit README.md', kind: 'edit', name: 'Edit' },
      { type: 'emit', event: { type: 'file.changed', data: { path: 'README.md', change: 'modified' } } },
      { type: 'emit', event: { type: 'file.changed', data: { path: 'feature.txt', change: 'created', diff: '--- /dev/null\n+++ b/feature.txt\n@@ -0,0 +1 @@\n+the feature\n' } } },
      { type: 'text', text: 'Implemented the plan.' },
    ];
  }
  return defaultScript(input, ctx);
};

async function setup(t: import('node:test').TestContext, o: { git?: boolean; usage?: { costUsd: number }; dataDir?: string } = {}) {
  const tmp = tempDir('bizzi-pipelines-');
  const dataDir = o.dataDir ?? join(tmp.path, 'data');
  const adapters = () => [
    new FakeAdapter({ agent: 'claude', script, ...(o.usage ? { usage: { inputTokens: 10, outputTokens: 20, ...o.usage }, probe: { billing: 'metered' as const } } : {}) }),
    new FakeAdapter({ agent: 'codex', script, capabilities: { permissionModes: ['read-only', 'auto'] } }),
  ];
  const open = () => createNode({ dataDir, adapters: adapters(), version: '0.0.0-test', machineName: 'test-machine', interruptGraceMs: 200 });
  const node = await open();
  let current: BizziNode = node;
  t.after(async () => {
    await current.close();
    tmp.cleanup();
  });
  const path = o.git ? makeRepo(tmp.path) : join(tmp.path, 'ws');
  const { workspace } = await node.call('workspace.create', { path, create: !o.git });
  return {
    node,
    workspace,
    tmp,
    async restart(): Promise<BizziNode> {
      await current.close();
      current = await open();
      return current;
    },
  };
}

async function rejects(p: Promise<unknown> | (() => unknown), code: string, re?: RegExp): Promise<void> {
  const run = typeof p === 'function' ? Promise.resolve().then(p) : p;
  await assert.rejects(run, (err: unknown) => {
    assert.ok(err instanceof BizziError, String(err));
    assert.equal(err.code, code, err.message);
    if (re) assert.match(err.message, re);
    return true;
  });
}

async function until(node: BizziNode, id: string, pred: (p: PipelineInfo) => boolean, what: string): Promise<PipelineInfo> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const { pipeline } = await node.call('pipeline.get', { pipelineId: id });
    if (pred(pipeline)) return pipeline;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; pipeline is ${JSON.stringify(pipeline)}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** The text a stage session was prompted with. */
function promptOf(node: BizziNode, sessionId: string): string {
  const ev = node.bus.replay(sessionChannel(sessionId)).find((e) => e.type === 'turn.started');
  assert.ok(ev && ev.type === 'turn.started');
  return textOf(ev.data.input);
}

const REVIEW_SPEC: PipelineSpec = {
  stages: [
    { name: 'plan', agent: 'claude', permissionMode: 'plan', prompt: 'PLAN {{task}}' },
    { name: 'implement', agent: 'codex', where: 'worktree', gate: true, prompt: 'IMPLEMENT {{task}}\n\nThe plan:\n{{previous.result}}' },
    {
      name: 'review',
      agent: 'claude',
      where: 'worktree',
      prompt: 'Review the change for {{task}} against the plan.\nPlan:\n{{stages.plan.result}}\nFiles:\n{{previous.files}}\nDiff:\n{{previous.diff}}',
    },
  ],
};

test('parsePipelineSpec: names, agents, placeholders and fields', () => {
  const ok = parsePipelineSpec(REVIEW_SPEC);
  assert.equal(ok.stages.length, 3);
  assert.equal(ok.stages[1]!.gate, true);
  const bad = (spec: unknown, re: RegExp) => assert.throws(() => parsePipelineSpec(spec), (e: unknown) => e instanceof BizziError && e.code === 'bad_request' && re.test(e.message));
  bad({ stages: [] }, /non-empty/);
  bad({ stages: [{ name: 'A', agent: 'claude', prompt: 'x' }] }, /name/);
  bad({ stages: [{ name: 'a', agent: 'gpt', prompt: 'x' }] }, /agent/);
  bad({ stages: [{ name: 'a', agent: 'claude', prompt: ' ' }] }, /prompt/);
  bad({ stages: [{ name: 'a', agent: 'claude', prompt: 'x' }, { name: 'a', agent: 'claude', prompt: 'y' }] }, /twice/);
  bad({ stages: [{ name: 'a', agent: 'claude', prompt: '{{previous.result}}' }] }, /first stage/);
  bad({ stages: [{ name: 'a', agent: 'claude', prompt: '{{stages.b.result}}' }, { name: 'b', agent: 'claude', prompt: 'y' }] }, /earlier stage/);
  bad({ stages: [{ name: 'a', agent: 'claude', prompt: '{{tsak}}' }] }, /unknown placeholder/);
  bad({ stages: [{ name: 'a', agent: 'claude', prompt: 'x', where: 'cloud' }] }, /where/);
  bad({ stages: [{ name: 'a', agent: 'claude', prompt: 'x', extra: 1 }] }, /unknown field/);
  bad({ stages: [{ name: 'a', agent: 'claude', prompt: 'x' }], budgetUsd: -1 }, /budgetUsd/);
});

test('renderTemplate: fills placeholders, clips long values, appends a gate note it does not place', async () => {
  const value = async (stage: number, field: string) => (field === 'diff' ? 'x'.repeat(MAX_PLACEHOLDER_CHARS + 100) : `${stage}:${field}`);
  const names = ['plan', 'build'];
  const out = await renderTemplate('T={{task}} P={{ previous.name }} R={{previous.result}} S={{stages.plan.files}}', { task: 'fix', stageIndex: 1, names, value });
  assert.equal(out, 'T=fix P=plan R=0:result S=0:files');
  const long = await renderTemplate('{{previous.diff}}', { task: '', stageIndex: 1, names, value });
  assert.ok(long.length <= MAX_PLACEHOLDER_CHARS && long.endsWith('[truncated]'));
  assert.equal(await renderTemplate('go', { task: '', gateMessage: ' keep it small ', stageIndex: 1, names, value }), 'go\n\nNote from the user: keep it small');
  assert.equal(await renderTemplate('go ({{gate.message}})', { task: '', gateMessage: 'small', stageIndex: 1, names, value }), 'go (small)');
});

test('plan → gate → implement in a worktree → review: results and diffs flow forward', async (t) => {
  const { node, workspace } = await setup(t, { git: true });
  const global = record(node, GLOBAL_CHANNEL, node.bus.lastSeq(GLOBAL_CHANNEL));
  const { pipeline: started } = await node.call('pipeline.start', { workspaceId: workspace.id, spec: REVIEW_SPEC, task: 'add a feature file' });
  assert.ok(started.id.startsWith('pl_'));
  assert.equal(started.title, 'add a feature file');
  assert.equal(started.stages[0]!.status, 'running');

  // Stage 1 finishes; the run waits at the implement gate.
  const gated = await until(node, started.id, (p) => p.status === 'waiting', 'gate');
  assert.deepEqual(gated.gate && { stage: gated.gate.stage, reason: gated.gate.reason }, { stage: 1, reason: 'gate' });
  assert.match(gated.gate!.message, /implement \(codex\) after plan/);
  assert.equal(gated.stages[0]!.status, 'done');
  assert.match(gated.stages[0]!.summary ?? '', /^Plan: add feature\.txt/);
  assert.equal(gated.stages[1]!.status, 'pending');
  const plan = node.sessions.get(gated.stages[0]!.sessionId!).session;
  assert.equal(plan.group, started.id);
  assert.equal(plan.title, 'add a feature file · plan');
  assert.equal(plan.permissionMode, 'plan');
  assert.equal(plan.workspaceId, workspace.id);
  assert.equal(promptOf(node, plan.id), 'PLAN add a feature file');
  await global.waitFor('pipeline.updated', (e) => e.data.pipeline.id === started.id && e.data.pipeline.status === 'waiting');

  // Gates only open for a waiting run; approve with a note.
  const { pipeline: approved } = await node.call('pipeline.gate', { pipelineId: started.id, decision: 'approve', message: 'keep it tiny' });
  assert.equal(approved.status, 'running');
  const done = await until(node, started.id, (p) => p.status === 'done', 'done');
  await rejects(node.call('pipeline.gate', { pipelineId: started.id, decision: 'approve' }), 'conflict');

  assert.deepEqual(done.stages.map((s) => s.status), ['done', 'done', 'done']);
  assert.ok(done.worktreeId);
  const wt = node.workspaces.get(done.worktreeId!);
  assert.equal(wt.kind, 'worktree');
  assert.equal(wt.parentWorkspaceId, workspace.id);
  assert.match(wt.branch ?? '', /^pipeline\/add-a-feature-file-[0-9a-z]{6}$/);
  assert.ok(existsSync(join(wt.path, 'feature.txt')), 'implement ran in the worktree');
  assert.equal(readFileSync(join(workspace.path, 'README.md'), 'utf8'), 'hello\n', 'the repo checkout is untouched');

  const impl = node.sessions.get(done.stages[1]!.sessionId!).session;
  assert.equal(impl.agent, 'codex');
  assert.equal(impl.workspaceId, wt.id);
  assert.equal(impl.group, started.id);
  const implPrompt = promptOf(node, impl.id);
  assert.match(implPrompt, /^IMPLEMENT add a feature file\n\nThe plan:\nPlan: add feature\.txt/);
  assert.match(implPrompt, /Note from the user: keep it tiny$/);
  assert.equal(done.stages[1]!.changedFiles, 2);

  const review = node.sessions.get(done.stages[2]!.sessionId!).session;
  assert.equal(review.workspaceId, wt.id);
  const reviewPrompt = promptOf(node, review.id);
  assert.match(reviewPrompt, /Plan:\nPlan: add feature\.txt/);
  assert.match(reviewPrompt, /Files:\nmodified README\.md\ncreated feature\.txt/);
  assert.match(reviewPrompt, /\+see feature\.txt/, 'git diff of the worktree');
  assert.match(reviewPrompt, /\+\+\+ b\/feature\.txt\n@@ -0,0 \+1 @@\n\+the feature/, 'new file from its file.changed diff');
  assert.doesNotMatch(reviewPrompt, /Note from the user/, 'the gate note goes to the gated stage only');

  const { pipelines } = await node.call('pipelines.list', { workspaceId: workspace.id });
  assert.deepEqual(pipelines.map((p) => p.id), [started.id]);
  assert.deepEqual((await node.call('pipelines.list', { workspaceId: 'w_other' })).pipelines, []);

  await node.call('pipeline.delete', { pipelineId: started.id });
  await global.waitFor('pipeline.removed', (e) => e.data.pipelineId === started.id);
  await rejects(node.call('pipeline.get', { pipelineId: started.id }), 'not_found');
  assert.ok(node.sessions.has(impl.id), 'deleting a pipeline keeps its sessions');
});

test('a failing stage fails the run; reject at a gate and cancel end it as cancelled', async (t) => {
  const { node, workspace } = await setup(t);
  const two = (first: string, gate = false): PipelineSpec => ({
    stages: [
      { name: 'one', agent: 'claude', prompt: first },
      { name: 'two', agent: 'claude', prompt: 'after {{previous.result}}', ...(gate ? { gate: true } : {}) },
    ],
  });

  const { pipeline: f } = await node.call('pipeline.start', { workspaceId: workspace.id, spec: two('/fail nope'), task: 'x' });
  const failed = await until(node, f.id, (p) => p.status === 'failed', 'failed');
  assert.deepEqual(failed.stages.map((s) => s.status), ['failed', 'cancelled']);
  assert.match(failed.error ?? '', /stage one: the turn ended with error: nope/);

  const { pipeline: r } = await node.call('pipeline.start', { workspaceId: workspace.id, spec: two('hello', true), task: 'x' });
  await until(node, r.id, (p) => p.status === 'waiting', 'gate');
  await rejects(node.call('pipeline.delete', { pipelineId: r.id }), 'conflict');
  const { pipeline: rejected } = await node.call('pipeline.gate', { pipelineId: r.id, decision: 'reject', message: 'wrong plan' });
  assert.equal(rejected.status, 'cancelled');
  assert.match(rejected.error ?? '', /rejected at the gate before two: wrong plan/);
  assert.deepEqual(rejected.stages.map((s) => s.status), ['done', 'cancelled']);

  const { pipeline: c } = await node.call('pipeline.start', { workspaceId: workspace.id, spec: two('/slow 3000'), task: 'x' });
  const sid = c.stages[0]!.sessionId!;
  await waitFor(() => node.sessions.isBusy(sid), 2000, 'stage busy');
  const { pipeline: cancelled } = await node.call('pipeline.cancel', { pipelineId: c.id });
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(cancelled.stages.map((s) => s.status), ['cancelled', 'cancelled']);
  await waitFor(() => node.sessions.get(sid).session.status === 'ended', 5000, 'stage session stopped');
  await rejects(node.call('pipeline.cancel', { pipelineId: c.id }), 'conflict');

  // A stage session deleted under the run fails it.
  const { pipeline: d } = await node.call('pipeline.start', { workspaceId: workspace.id, spec: two('/slow 3000'), task: 'x' });
  await node.call('session.delete', { sessionId: d.stages[0]!.sessionId! });
  const gone = await until(node, d.id, (p) => p.status === 'failed', 'failed after delete');
  assert.match(gone.error ?? '', /deleted/);
});

test('start refuses worktree stages outside git, unknown workspaces and missing agents', async (t) => {
  const { node, workspace } = await setup(t);
  await rejects(
    node.call('pipeline.start', { workspaceId: workspace.id, spec: { stages: [{ name: 'a', agent: 'claude', prompt: 'x', where: 'worktree' }] }, task: 'x' }),
    'bad_request',
    /not a git repository/,
  );
  await rejects(node.call('pipeline.start', { workspaceId: workspace.id, spec: { stages: [{ name: 'a', agent: 'opencode', prompt: 'x' }] }, task: 'x' }), 'agent_unavailable');
  await rejects(node.call('pipeline.start', { workspaceId: workspace.id, spec: { stages: [{ name: 'a', agent: 'claude', prompt: 'x' }] }, task: ' ' }), 'bad_request');
  await rejects(node.call('pipeline.start', { workspaceId: 'w_nope', spec: { stages: [{ name: 'a', agent: 'claude', prompt: 'x' }] }, task: 'x' }), 'not_found');
  await rejects(node.call('pipeline.get', { pipelineId: 'pl_nope' }), 'not_found');
  await rejects(node.call('pipelines.list', { machineId: 'm_other' }), 'not_found');
});

test('a run waiting at its gate survives a node restart', async (t) => {
  const env = await setup(t);
  const spec: PipelineSpec = { stages: [{ name: 'one', agent: 'claude', prompt: 'hi' }, { name: 'two', agent: 'claude', gate: true, prompt: 'then {{previous.result}}' }] };
  const { pipeline } = await env.node.call('pipeline.start', { workspaceId: env.workspace.id, spec, task: 't' });
  await until(env.node, pipeline.id, (p) => p.status === 'waiting', 'gate');
  const node = await env.restart();
  const { pipeline: after } = await node.call('pipeline.get', { pipelineId: pipeline.id });
  assert.equal(after.status, 'waiting');
  await node.call('pipeline.gate', { pipelineId: pipeline.id, decision: 'approve' });
  const done = await until(node, pipeline.id, (p) => p.status === 'done', 'done after restart');
  assert.equal(promptOf(node, done.stages[1]!.sessionId!), 'then echo: hi');

  // A stage cut off by a restart fails the run (its turn completes as interrupted).
  const { pipeline: slow } = await node.call('pipeline.start', { workspaceId: env.workspace.id, spec: { stages: [{ name: 'one', agent: 'claude', prompt: '/slow 3000' }] }, task: 't' });
  await waitFor(() => node.sessions.isBusy(slow.stages[0]!.sessionId!), 2000, 'stage busy');
  const node2 = await env.restart();
  const cut = await until(node2, slow.id, (p) => p.status === 'failed', 'failed after restart');
  assert.match(cut.error ?? '', /stage one: the turn was interrupted/);
});

test('the run budget gates the next stage once metered spend reaches it', async (t) => {
  const { node, workspace } = await setup(t, { usage: { costUsd: 0.4 } });
  const spec: PipelineSpec = {
    budgetUsd: 0.3,
    stages: [
      { name: 'one', agent: 'claude', prompt: 'a' },
      { name: 'two', agent: 'claude', gate: true, prompt: 'b' },
    ],
  };
  const { pipeline } = await node.call('pipeline.start', { workspaceId: workspace.id, spec, task: 't' });
  const first = await until(node, pipeline.id, (p) => p.status === 'waiting', 'budget gate');
  const one: SessionInfo = node.sessions.get(first.stages[0]!.sessionId!).session;
  assert.equal(one.billing, 'metered');
  assert.equal(first.gate?.reason, 'budget');
  assert.match(first.gate?.message ?? '', /\$0\.40 reached the pipeline's cap of \$0\.30/);
  // Over budget approved: the stage's own gate is asked next.
  await node.call('pipeline.gate', { pipelineId: pipeline.id, decision: 'approve' });
  const second = await until(node, pipeline.id, (p) => p.status === 'waiting' && p.gate?.reason === 'gate', 'own gate');
  assert.equal(second.gate?.stage, 1);
  await node.call('pipeline.gate', { pipelineId: pipeline.id, decision: 'approve' });
  await until(node, pipeline.id, (p) => p.status === 'done', 'done');
});
