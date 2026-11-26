import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BizziError } from '@bizzi/protocol';
import { createAdapters, CodexAdapter, CODEX_STRUCTURED_CAPABILITIES } from '../src/index.ts';
import { ctx, EventLog, fakeAdapter, startOpts, testLogger } from './helpers.ts';

const text = (t: string) => [{ type: 'text' as const, text: t }];

test('createAdapters returns one codex adapter with structured capabilities', () => {
  const adapters = createAdapters({ codexPath: '/nonexistent/codex' });
  assert.equal(adapters.length, 1);
  const a = adapters[0] as CodexAdapter;
  assert.equal(a.agent, 'codex');
  assert.deepEqual(a.capabilities('structured'), CODEX_STRUCTURED_CAPABILITIES);
  assert.deepEqual(a.capabilities('terminal').modes, []);
  assert.deepEqual(a.capabilities('structured').permissionModes, ['read-only', 'auto', 'untrusted', 'full-access']);
});

test('probe: missing binary does not throw', async () => {
  const p = await createAdapters({ codexPath: '/nonexistent/codex' })[0]!.probe();
  assert.equal(p.installed, false);
  assert.equal(p.auth, 'unknown');
});

test('probe: version and auth via account/read', async () => {
  const loggedOut = await fakeAdapter().probe();
  assert.equal(loggedOut.installed, true);
  assert.equal(loggedOut.version, '0.0.0-fake');
  assert.equal(loggedOut.auth, 'missing');

  const loggedIn = await fakeAdapter({ env: { FAKE_AUTH: 'chatgpt' } }).probe();
  assert.equal(loggedIn.auth, 'ok');
  assert.equal(loggedIn.account, 'dev@example.com');
});

test('handshake: initialize, initialized, thread/start with overrides; session.info', async () => {
  const log = new EventLog();
  const s = await fakeAdapter().start(
    startOpts({
      model: 'gpt-x',
      effort: 'high',
      permissionMode: 'auto',
      systemPromptAppend: 'Follow the rules.',
      mcpServers: {
        'bizzi-memory': { type: 'stdio', command: 'node', args: ['mem.js'], env: { A: '1' } },
        web: { type: 'http', url: 'http://localhost:1/mcp', headers: { Authorization: 'x' } },
      },
    }),
    log.emit,
    ctx(),
  );
  try {
    assert.equal(s.agentSessionRef(), 'thr_fake_1');
    const info = await log.waitFor('session.info', (d) => d.agentSessionRef !== undefined);
    assert.deepEqual(info, { agentSessionRef: 'thr_fake_1', model: 'gpt-x', permissionMode: 'auto', effort: 'high' });

    const init = log.received('initialize')[0] as { clientInfo: { name: string } };
    assert.equal(init.clientInfo.name, 'bizzi');
    assert.equal(log.received('initialized').length, 1);
    const ts = log.received('thread/start')[0] as Record<string, any>;
    assert.equal(ts.model, 'gpt-x');
    assert.equal(ts.approvalPolicy, 'on-request');
    assert.equal(ts.sandbox, 'workspace-write');
    assert.equal(ts.developerInstructions, 'Follow the rules.');
    assert.deepEqual(ts.config, {
      'mcp_servers.bizzi-memory': { command: 'node', args: ['mem.js'], env: { A: '1' } },
      'mcp_servers.web': { url: 'http://localhost:1/mcp', http_headers: { Authorization: 'x' } },
      model_reasoning_effort: 'high',
    });
  } finally {
    await s.stop();
  }
  assert.deepEqual(log.ofType('session.status').at(-1), { status: 'ended' });
});

test('unknown permission mode is rejected', async () => {
  await assert.rejects(
    fakeAdapter().start(startOpts({ permissionMode: 'yolo' }), new EventLog().emit, ctx()),
    (e: unknown) => e instanceof BizziError && e.code === 'bad_request',
  );
});

test('turn streaming maps items to bizzi events', async () => {
  const log = new EventLog();
  const s = await fakeAdapter().start(startOpts(), log.emit, ctx());
  try {
    await s.send('t_1', text('stream please'));
    const done = await log.waitFor('turn.completed');
    assert.equal(done.turnId, 't_1');
    assert.equal(done.stopReason, 'end_turn');
    assert.deepEqual(done.usage, { inputTokens: 100, outputTokens: 100, cacheReadTokens: 100, contextWindow: 200000 });

    const tsParams = log.received('turn/start')[0] as Record<string, any>;
    assert.deepEqual(tsParams.input, [{ type: 'text', text: 'stream please', text_elements: [] }]);

    assert.deepEqual(log.ofType('reasoning.delta'), [{ messageId: 'rs_1', text: 'Thinking' }]);
    assert.deepEqual(log.ofType('reasoning.completed'), [{ messageId: 'rs_1', text: 'Thinking', summary: true }]);
    assert.deepEqual(
      log.ofType('message.delta').map((d) => d.text),
      ['Hel', 'lo'],
    );
    assert.deepEqual(log.ofType('message.completed'), [{ messageId: 'msg_1', role: 'assistant', text: 'Hello' }]);
    assert.deepEqual(log.ofType('plan.updated'), [
      {
        items: [
          { text: 'look', status: 'completed' },
          { text: 'fix', status: 'in_progress' },
          { text: 'test', status: 'pending' },
        ],
      },
    ]);
    const started = log.ofType('tool.started');
    assert.deepEqual(
      started.map((t) => [t.toolId, t.kind, t.title]),
      [
        ['call_cmd', 'shell', 'ls -la'],
        ['call_patch', 'edit', '/tmp/a.txt (+1 more)'],
      ],
    );
    assert.deepEqual(log.ofType('tool.updated'), [{ toolId: 'call_cmd', output: 'file-a\n' }]);
    const completed = log.ofType('tool.completed');
    assert.deepEqual(completed[0], { toolId: 'call_cmd', status: 'ok', output: 'file-a\n' });
    assert.equal(completed[1]?.toolId, 'call_patch');
    assert.equal(completed[1]?.status, 'ok');
    assert.deepEqual(log.ofType('file.changed'), [
      { path: '/tmp/a.txt', change: 'modified', diff: '@@ -1 +1 @@\n-a\n+b\n' },
      { path: '/tmp/new.txt', change: 'created', diff: '+new\n' },
    ]);
    assert.deepEqual(log.ofType('usage.updated'), [
      { inputTokens: 100, outputTokens: 100, cacheReadTokens: 100, contextWindow: 200000 },
    ]);
    const raw = log.ofType('agent.raw').map((r) => (r.payload as { method: string }).method);
    assert.ok(raw.includes('some/unknown'));

    // Event order: file.changed precedes the fileChange tool.completed, which precedes turn.completed.
    const types = log.events.map((e) => e.type);
    assert.ok(types.lastIndexOf('file.changed') < types.lastIndexOf('tool.completed'));
    assert.equal(types.at(-1), 'turn.completed');
  } finally {
    await s.stop();
  }
});

test('notifications arriving before the turn/start response are buffered, not lost', async () => {
  const log = new EventLog();
  const s = await fakeAdapter().start(startOpts(), log.emit, ctx());
  try {
    await s.send('t_early', text('early'));
    const done = await log.waitFor('turn.completed');
    assert.equal(done.turnId, 't_early');
    assert.equal(done.stopReason, 'end_turn');
    assert.deepEqual(
      log.ofType('message.delta').map((d) => d.text),
      ['Hel', 'lo'],
    );
    assert.equal(log.ofType('tool.completed').length, 2);
    assert.equal(log.ofType('file.changed').length, 2);
  } finally {
    await s.stop();
  }
});

for (const [decision, expected, toolStatus] of [
  ['allow', 'accept', 'ok'],
  ['allow_always', 'acceptForSession', 'ok'],
  ['deny', 'decline', 'denied'],
] as const) {
  test(`command approval round-trip: ${decision} -> ${expected}`, async () => {
    const log = new EventLog();
    const s = await fakeAdapter().start(startOpts(), log.emit, ctx());
    try {
      await s.send('t_ap', text('approve'));
      const req = await log.waitFor('approval.requested');
      assert.equal(req.kind, 'shell');
      assert.equal(req.title, 'rm -rf build');
      assert.equal(req.description, 'needs write access');
      assert.equal(req.toolId, 'call_rm');
      assert.equal(req.editable, false);
      assert.deepEqual(req.options, ['allow', 'allow_always', 'deny']);
      assert.match(req.approvalId, /^ap_/);

      await s.respondApproval(req.approvalId, { decision });
      const resolved = await log.waitFor('approval.resolved');
      assert.deepEqual(resolved, { approvalId: req.approvalId, decision });
      await log.waitFor('turn.completed');
      assert.equal(log.ofType('message.delta').at(-1)?.text, `decision:"${expected}"`);
      assert.equal(log.ofType('tool.completed').at(-1)?.status, toolStatus);
      // serverRequest/resolved after our reply must not produce a second approval.resolved
      assert.equal(log.ofType('approval.resolved').length, 1);
      await assert.rejects(s.respondApproval(req.approvalId, { decision }), (e: unknown) => e instanceof BizziError && e.code === 'not_found');
    } finally {
      await s.stop();
    }
  });
}

test('interrupt sends turn/interrupt and completes with stopReason interrupted', async () => {
  const log = new EventLog();
  const s = await fakeAdapter().start(startOpts(), log.emit, ctx());
  try {
    await s.send('t_int', text('hang'));
    await log.waitFor('message.delta');
    await s.interrupt();
    const done = await log.waitFor('turn.completed');
    assert.deepEqual(done, { turnId: 't_int', stopReason: 'interrupted' });
    const params = log.received('turn/interrupt')[0] as Record<string, unknown>;
    assert.deepEqual(params, { threadId: 'thr_fake_1', turnId: 'turn_1' });
    // A second interrupt with no active turn is a no-op.
    await s.interrupt();
  } finally {
    await s.stop();
  }
});

test('interrupt issued before turn/start answers is sent once the turn id is known', async () => {
  const log = new EventLog();
  const s = await fakeAdapter().start(startOpts(), log.emit, ctx());
  try {
    const sending = s.send('t_int2', text('hang'));
    await s.interrupt();
    await sending;
    const done = await log.waitFor('turn.completed');
    assert.equal(done.stopReason, 'interrupted');
    assert.equal(log.received('turn/interrupt').length, 1);
  } finally {
    await s.stop();
  }
});

test('steer forwards input to the active turn with expectedTurnId', async () => {
  const log = new EventLog();
  const s = await fakeAdapter().start(startOpts(), log.emit, ctx());
  try {
    await assert.rejects(s.steer!(text('nope')), (e: unknown) => e instanceof BizziError && e.code === 'conflict');
    await s.send('t_steer', text('hang'));
    await log.waitFor('message.delta');
    await s.steer!(text('also do X'));
    const done = await log.waitFor('turn.completed');
    assert.equal(done.turnId, 't_steer');
    const p = log.received('turn/steer')[0] as Record<string, any>;
    assert.equal(p.expectedTurnId, 'turn_1');
    assert.deepEqual(p.input, [{ type: 'text', text: 'also do X', text_elements: [] }]);
    assert.equal(log.ofType('message.delta').at(-1)?.text, ' steered:also do X');
  } finally {
    await s.stop();
  }
});

test('set() applies model / effort / permission mode as overrides on the next turn/start', async () => {
  const log = new EventLog();
  const s = await fakeAdapter().start(startOpts(), log.emit, ctx());
  try {
    await s.set!({ model: 'gpt-next', effort: 'low', permissionMode: 'full-access' });
    assert.deepEqual(log.ofType('session.info').at(-1), { model: 'gpt-next', permissionMode: 'full-access', effort: 'low' });
    await s.send('t_a', text('stream'));
    await log.waitFor('turn.completed', (d) => d.turnId === 't_a');
    const first = log.received('turn/start')[0] as Record<string, any>;
    assert.equal(first.model, 'gpt-next');
    assert.equal(first.effort, 'low');
    assert.equal(first.approvalPolicy, 'never');
    assert.deepEqual(first.sandboxPolicy, { type: 'dangerFullAccess' });

    await s.send('t_b', text('stream'));
    await log.waitFor('turn.completed', (d) => d.turnId === 't_b');
    const second = log.received('turn/start')[1] as Record<string, any>;
    assert.equal(second.model, undefined, 'overrides persist server-side; not resent');

    await assert.rejects(s.set!({ permissionMode: 'bogus' }), (e: unknown) => e instanceof BizziError && e.code === 'bad_request');
  } finally {
    await s.stop();
  }
});

test('send while a turn is running is a conflict', async () => {
  const log = new EventLog();
  const s = await fakeAdapter().start(startOpts(), log.emit, ctx());
  try {
    await s.send('t_1', text('hang'));
    await assert.rejects(s.send('t_2', text('stream')), (e: unknown) => e instanceof BizziError && e.code === 'conflict');
  } finally {
    await s.stop();
  }
  // stop() completes the running turn.
  assert.deepEqual(log.ofType('turn.completed'), [{ turnId: 't_1', stopReason: 'interrupted' }]);
});

test('process crash: fatal error, turn completed with error, session failed', async () => {
  const log = new EventLog();
  const logger = testLogger();
  const s = await fakeAdapter().start(startOpts(), log.emit, ctx(logger));
  await s.send('t_crash', text('crash'));
  const status = await log.waitFor('session.status', (d) => d.status === 'failed');
  assert.match(status.reason ?? '', /exited with code 3/);
  const err = log.ofType('error').find((e) => e.fatal);
  assert.ok(err, 'fatal error emitted');
  assert.match(err.message, /boom: simulated crash/);
  assert.doesNotMatch(err.message, /\u001b\[/, 'ANSI codes stripped');
  const done = log.ofType('turn.completed');
  assert.equal(done.length, 1);
  assert.equal(done[0]?.turnId, 't_crash');
  assert.equal(done[0]?.stopReason, 'error');
  assert.ok(logger.lines.some((l) => l.msg === 'codex stderr'));
  await assert.rejects(s.send('t_after', text('stream')), (e: unknown) => e instanceof BizziError && e.code === 'agent_unavailable');
  await s.stop(); // idempotent, no 'ended' after 'failed'
  assert.equal(log.ofType('session.status').filter((x) => x.status === 'ended').length, 0);
});

test('resume: thread/resume with resumeRef; unknown ref fails with not_found', async () => {
  const log = new EventLog();
  const s = await fakeAdapter().start(startOpts({ resumeRef: 'thr_fake_1', permissionMode: 'read-only' }), log.emit, ctx());
  try {
    assert.equal(s.agentSessionRef(), 'thr_fake_1');
    const p = log.received('thread/resume')[0] as Record<string, any>;
    assert.equal(p.threadId, 'thr_fake_1');
    assert.equal(p.excludeTurns, true);
    assert.equal(p.sandbox, 'read-only');
    assert.equal(log.received('thread/start').length, 0);
    assert.equal((await log.waitFor('session.info')).permissionMode, 'read-only');
  } finally {
    await s.stop();
  }

  await assert.rejects(
    fakeAdapter().start(startOpts({ resumeRef: 'thr_missing' }), new EventLog().emit, ctx()),
    (e: unknown) => e instanceof BizziError && e.code === 'not_found' && /no rollout found/.test(e.message),
  );
});

test('start fails cleanly when the binary does not speak app-server', async () => {
  const a = new CodexAdapter({ codexPath: process.execPath, codexArgsPrefix: ['-e', 'process.exit(7)'], requestTimeoutMs: 5000 });
  await assert.rejects(
    a.start(startOpts(), new EventLog().emit, ctx()),
    (e: unknown) => e instanceof BizziError && e.code === 'agent_unavailable' && /code 7/.test(e.message),
  );
});

test('terminal mode is unsupported', async () => {
  await assert.rejects(
    fakeAdapter().start(startOpts({ mode: 'terminal' }), new EventLog().emit, ctx()),
    (e: unknown) => e instanceof BizziError && e.code === 'unsupported',
  );
});

test('listModels: every page of model/list, hidden models left out', async () => {
  assert.deepEqual(await fakeAdapter().listModels(), [
    { id: 'gpt-a', label: 'GPT-A', description: 'gpt-a model', isDefault: true, efforts: ['low', 'high'] },
    { id: 'gpt-b', label: 'GPT-B', description: 'gpt-b model' },
  ]);
  await assert.rejects(createAdapters({ codexPath: '/nonexistent/codex' })[0]!.listModels!(), { code: 'agent_unavailable' });
});
