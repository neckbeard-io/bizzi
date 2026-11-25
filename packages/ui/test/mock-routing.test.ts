import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BizziClient, BizziStore, createManualScheduler } from '@bizzi/client';
import { MockCore, createMockSocketFactory } from '../src/mock/mockServer.ts';
import { decisionFor, planRoute } from '../src/lib/onePane.ts';

test('mock one-pane routing: tokens, rules, the keyword classifier and recorded decisions', async (t) => {
  const core = new MockCore({ speed: 0, autoplay: false });
  const client = new BizziClient({ createSocket: createMockSocketFactory(core) });
  const store = new BizziStore(client, { scheduler: createManualScheduler(), autoLoad: false });
  t.after(() => {
    store.dispose();
    client.close();
    core.dispose();
  });
  await client.connect('mock://local', 'demo');
  const online = (id: string) => id !== 'm_server';

  const clear = await store.suggestRoute('fix the flaky checkout test');
  assert.deepEqual([clear.source, clear.confident, clear.candidates[0]?.label], ['classifier', true, 'this laptop · acme-shop']);
  assert.equal(planRoute(clear, online).kind, 'send');

  const named = await store.suggestRoute('@mac-mini #extensions /codex tidy the CSS');
  assert.deepEqual([named.source, named.agent, named.text, named.candidates[0]?.workspaceId], ['explicit', 'codex', 'tidy the CSS', 'w_ext']);

  const offline = await store.suggestRoute('#infra bump the chart');
  assert.deepEqual([offline.source, offline.note], ['none', 'server-a is offline']);

  // The seeded rule sends prod questions to prod-access machines (only the laptop).
  const prod = await store.suggestRoute('why are production 502s up?');
  assert.equal(prod.rule?.id, 'rr_demo');

  const d = decisionFor('fix the flaky checkout test', clear, { machineId: 'm_mini', workspaceId: 'w_ext', label: 'mac-mini · extensions', probability: 0 }, 'claude', 's_x');
  await store.recordRoute(d);
  const { decisions, total } = await store.listRouteDecisions({ overridden: true });
  assert.deepEqual([total, decisions[0]?.via], [1, 'picked']);
  const rules = await store.setRouteRules([...(await store.getRouteRules()), { id: '', match: ['screenshot*'], tag: 'gui' }]);
  assert.equal(rules.length, 2);
  assert.ok(rules[1]!.id);
});
