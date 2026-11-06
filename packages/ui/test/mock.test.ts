import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BizziClient, BizziStore, createManualScheduler, selectInbox, timelineItems } from '@bizzi/client';
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

test('mock server drives a full scripted session through the real client', async (t) => {
  const core = new MockCore({ speed: 0, autoplay: false });
  const client = new BizziClient({ createSocket: createMockSocketFactory(core) });
  const scheduler = createManualScheduler();
  const store = new BizziStore(client, { scheduler });
  t.after(() => {
    store.dispose();
    client.close();
  });

  await client.connect('mock://local', 'demo');
  const flushUntil = (cond: () => boolean): Promise<void> =>
    waitFor(() => {
      scheduler.flush();
      return cond();
    });

  await flushUntil(() => store.getState().sessionsLoaded && store.getState().agents !== null);
  // s_review waits for approval, so the store watches it and the inbox shows it.
  await flushUntil(() => selectInbox(store.getState()).length === 1);

  await store.openSession('s_demo');
  await flushUntil(() => (store.getState().timelines['s_demo']?.lastSeq ?? 0) > 5);
  const { turnId } = await store.send('s_demo', 'fix it');
  assert.ok(turnId);

  // The scripted turn stops at an editable approval.
  await flushUntil(() => (store.getState().timelines['s_demo']?.pendingApprovals.length ?? 0) === 1);
  const tl = store.getState().timelines['s_demo'];
  const approvalId = tl?.pendingApprovals[0];
  assert.ok(approvalId);
  const ap = tl.items[`ap:${approvalId}`];
  assert.ok(ap?.kind === 'approval' && ap.request.editable);

  await store.respondApproval('s_demo', approvalId, { decision: 'allow' });
  await flushUntil(() => store.getState().timelines['s_demo']?.activeTurnId === null);

  const done = store.getState().timelines['s_demo'];
  assert.ok(done);
  const kinds = timelineItems(done).map((i) => i.kind);
  for (const k of ['turn', 'reasoning', 'tool', 'approval', 'file', 'message', 'turn-end']) assert.ok(kinds.includes(k as never), `has ${k}`);
  assert.equal(done.plan?.every((p) => p.status === 'completed'), true);
  assert.ok(done.usage?.costUsd);
  const last = timelineItems(done).filter((i) => i.kind === 'message').at(-1);
  assert.ok(last?.kind === 'message' && !last.streaming && last.text.includes('| Run |'));
  assert.equal(store.getState().sessions['s_demo']?.status, 'idle');
});

test('mock terminal echoes input through term.output', async (t) => {
  const core = new MockCore({ speed: 0, autoplay: false });
  const client = new BizziClient({ createSocket: createMockSocketFactory(core) });
  const store = new BizziStore(client, { scheduler: createManualScheduler() });
  t.after(() => {
    store.dispose();
    client.close();
  });
  await client.connect('mock://local');
  await store.openSession('s_term');
  let out = '';
  store.terminal.subscribe('s_term', (c) => (out += new TextDecoder().decode(c)));
  await store.termInput('s_term', 'pwd\r');
  await waitFor(() => out.includes('/Users/dev/src/acme-shop\r\n'));
});

test('mock rejects a bad token as unauthorized', async () => {
  const client = new BizziClient({ createSocket: createMockSocketFactory(new MockCore({ speed: 0, autoplay: false })) });
  await assert.rejects(client.connect('mock://local', 'bad'), /invalid token/);
  assert.equal(client.getConnection().state, 'closed');
});
