import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { BizziClient, BizziStore, createManualScheduler, selectPipelineGates, selectPipelines } from '@bizzi/client';
import { parseHash, routeHref } from '../src/lib/router.ts';
import { MockCore, createMockSocketFactory } from '../src/mock/mockServer.ts';

function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (cond()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timed out'));
      setTimeout(tick, 2);
    };
    tick();
  });
}

async function connect(t: TestContext) {
  const core = new MockCore({ speed: 0, autoplay: false });
  const client = new BizziClient({ createSocket: createMockSocketFactory(core) });
  const scheduler = createManualScheduler();
  const store = new BizziStore(client, { scheduler });
  t.after(() => {
    store.dispose();
    client.close();
    core.dispose();
  });
  await client.connect('mock://local', 'demo');
  const until = (cond: () => boolean): Promise<void> =>
    waitFor(() => {
      scheduler.flush();
      return cond();
    });
  await until(() => store.getState().sessionsLoaded && Object.keys(store.getState().pipelines).length > 0);
  return { store, until };
}

test('pipeline route round-trips', () => {
  const r = { name: 'pipeline', pipelineId: 'pl_x' } as const;
  assert.deepEqual(parseHash(routeHref(r)), r);
  assert.deepEqual(parseHash('#/pipeline'), { name: 'workspaces' });
});

test('mock pipeline: seeded run waits at its gate; approving runs it to done', async (t) => {
  const { store, until } = await connect(t);
  const [p] = selectPipelines(store.getState(), 'w_acme');
  assert.equal(p?.id, 'pl_auth');
  assert.deepEqual(selectPipelineGates(store.getState()).map((x) => x.id), ['pl_auth']);
  await store.gatePipeline(p!, 'approve');
  await until(() => store.getState().pipelines['pl_auth']?.status === 'done');
  assert.deepEqual(store.getState().pipelines['pl_auth']!.stages.map((s) => s.status), ['done', 'done', 'done']);
  assert.deepEqual(selectPipelineGates(store.getState()), []);
});
