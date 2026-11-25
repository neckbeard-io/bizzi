import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { GLOBAL_CHANNEL, NO_CAPABILITIES } from '@bizzi/protocol';
import type { PipelineInfo, SessionInfo } from '@bizzi/protocol';
import {
  BizziClient,
  BizziStore,
  createManualScheduler,
  isPipelineGroup,
  reviewPipeline,
  selectFanoutGroups,
  selectPipeline,
  selectPipelineGates,
  selectPipelines,
  selectWaitingCount,
} from '../src/index.ts';
import { FakeServer, MACHINE, waitFor } from './fake-server.ts';

const STAGE: SessionInfo = {
  id: 's_plan',
  machineId: MACHINE.id,
  workspaceId: 'w_1',
  agent: 'claude',
  mode: 'structured',
  status: 'idle',
  title: 'fix it · plan',
  group: 'pl_1',
  createdAt: '2026-11-25T00:00:00Z',
  updatedAt: '2026-11-25T00:00:00Z',
  lastSeq: 5,
  seenThrough: 5,
};

function pipeline(over: Partial<PipelineInfo> = {}): PipelineInfo {
  return {
    id: 'pl_1',
    machineId: MACHINE.id,
    workspaceId: 'w_1',
    title: 'fix it',
    task: 'fix it',
    spec: reviewPipeline({ planner: 'claude', implementer: 'codex', reviewer: 'claude' }),
    status: 'running',
    current: 0,
    stages: [
      { name: 'plan', agent: 'claude', status: 'running', sessionId: 's_plan', workspaceId: 'w_1' },
      { name: 'implement', agent: 'codex', status: 'pending' },
      { name: 'review', agent: 'claude', status: 'pending' },
    ],
    createdAt: '2026-11-25T00:00:00Z',
    updatedAt: '2026-11-25T00:00:01Z',
    ...over,
  };
}

async function setup(t: TestContext, list: PipelineInfo[] | null) {
  const server = await FakeServer.start();
  server.handlers.set('sessions.list', () => ({ sessions: [STAGE] }));
  server.handlers.set('session.get', () => ({ session: STAGE, capabilities: NO_CAPABILITIES }));
  if (list) server.handlers.set('pipelines.list', () => ({ pipelines: list }));
  const client = new BizziClient({ backoff: { baseMs: 10, maxMs: 20 }, requestTimeoutMs: 1000 });
  const scheduler = createManualScheduler();
  const store = new BizziStore(client, { scheduler });
  t.after(async () => {
    store.dispose();
    client.close();
    await server.stop();
  });
  await client.connect(server.url, 'secret');
  const until = (cond: () => boolean): Promise<void> =>
    waitFor(() => {
      scheduler.flush();
      return cond();
    });
  await until(() => store.getState().sessionsLoaded);
  return { server, store, until };
}

test('reviewPipeline: read-only planner and reviewer, implementer in the worktree behind a gate', () => {
  const spec = reviewPipeline({ planner: 'claude', implementer: 'codex', reviewer: 'opencode', reviewerModel: ' local/qwen ' });
  assert.deepEqual(spec.stages.map((s) => [s.name, s.agent, s.permissionMode, s.where, s.gate]), [
    ['plan', 'claude', 'plan', undefined, undefined],
    ['implement', 'codex', undefined, 'worktree', true],
    ['review', 'opencode', 'plan', 'worktree', undefined],
  ]);
  assert.equal(spec.stages[2]!.model, 'local/qwen');
  assert.match(spec.stages[2]!.prompt, /\{\{previous\.diff\}\}/);
  assert.equal(reviewPipeline({ planner: 'claude', implementer: 'claude', reviewer: 'claude', gateImplement: false, gateReview: true }).stages.map((s) => Boolean(s.gate)).join(), 'false,false,true');
  assert.ok(isPipelineGroup('pl_1') && !isPipelineGroup('fo_1') && !isPipelineGroup(undefined));
});

test('store: pipelines load per machine, events update them, gates count as waiting, fan-out skips stage groups', async (t) => {
  const { server, store, until } = await setup(t, [pipeline()]);
  await until(() => Object.keys(store.getState().pipelines).length === 1);
  assert.deepEqual(selectPipelines(store.getState(), 'w_1').map((p) => p.id), ['pl_1']);
  assert.deepEqual(selectPipelines(store.getState(), 'w_2'), []);
  assert.deepEqual(selectFanoutGroups(store.getState()), [], 'stage sessions are not a fan-out');
  const model = selectPipeline(store.getState(), 'pl_1');
  assert.equal(model?.stages[0]!.session?.id, 's_plan');
  assert.equal(model?.stages[1]!.where, 'worktree');
  assert.equal(model?.stages[1]!.gate, true);
  assert.equal(selectWaitingCount(store.getState()), 0);

  const waiting = pipeline({
    status: 'waiting',
    current: 1,
    gate: { stage: 1, reason: 'gate', message: 'Start implement (codex) after plan?', since: '2026-11-25T00:01:00Z' },
    updatedAt: '2026-11-25T00:01:00Z',
    stages: [
      { name: 'plan', agent: 'claude', status: 'done', sessionId: 's_plan', summary: 'Plan: …' },
      { name: 'implement', agent: 'codex', status: 'pending' },
      { name: 'review', agent: 'claude', status: 'pending' },
    ],
  });
  server.push(GLOBAL_CHANNEL, { type: 'pipeline.updated', data: { pipeline: waiting } });
  await until(() => store.getState().pipelines['pl_1']?.status === 'waiting');
  assert.deepEqual(selectPipelineGates(store.getState()).map((p) => p.id), ['pl_1']);
  assert.equal(selectWaitingCount(store.getState()), 1);
  assert.equal(selectPipeline(store.getState(), 'pl_1')?.stages[1]!.gated, true);
  // An older copy (a late response) doesn't win.
  store.putPipeline(pipeline({ updatedAt: '2026-11-25T00:00:30Z' }));
  store.flush();
  assert.equal(store.getState().pipelines['pl_1']?.status, 'waiting');

  // Gate through the store: the request names the pipeline's machine.
  let seen: unknown;
  server.handlers.set('pipeline.gate', (p) => {
    seen = p;
    return { pipeline: { ...waiting, status: 'running', gate: undefined, updatedAt: '2026-11-25T00:02:00Z' } as PipelineInfo };
  });
  const after = await store.gatePipeline(waiting, 'approve', '  small please ');
  assert.deepEqual(seen, { machineId: MACHINE.id, pipelineId: 'pl_1', decision: 'approve', message: 'small please' });
  assert.equal(after.status, 'running');
  store.flush();
  assert.equal(selectWaitingCount(store.getState()), 0);

  server.push(GLOBAL_CHANNEL, { type: 'pipeline.removed', data: { pipelineId: 'pl_1', machineId: MACHINE.id } });
  await until(() => Object.keys(store.getState().pipelines).length === 0);
});

test('store: a node without pipelines (unsupported) is not a machine error', async (t) => {
  const { store, until } = await setup(t, null);
  await until(() => store.getState().sessionsLoaded);
  await new Promise((r) => setTimeout(r, 30));
  store.flush();
  assert.deepEqual(store.getState().pipelines, {});
  assert.deepEqual(store.getState().machineErrors, {});
});
