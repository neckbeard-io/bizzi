import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BizziError } from '@bizzi/protocol';
import type { SessionEventBody, StartSessionOptions } from '@bizzi/protocol';
import { ClaudeAdapter, createAdapters } from '../src/index.ts';
import type { ClaudeAdapterOptions } from '../src/index.ts';
import type { ClaudeSession } from '../src/session.ts';
import {
  assistant,
  collector,
  fakeQueryFn,
  init,
  result,
  silentLogger,
  streamText,
  tick,
  toolResult,
  toolUse,
  waitFor,
} from './fake.ts';
import type { Script } from './fake.ts';

const base: StartSessionOptions = { sessionId: 's_1', mode: 'structured', cwd: '/tmp/ws' };

async function setup(script: Script, start: Partial<StartSessionOptions> = {}, adapterOpts: ClaudeAdapterOptions = {}) {
  const fq = fakeQueryFn(script);
  const adapter = new ClaudeAdapter({ claudePath: null, queryFn: fq.queryFn, ...adapterOpts });
  const c = collector();
  const session = (await adapter.start({ ...base, ...start }, c.emit, { logger: silentLogger })) as ClaudeSession;
  return { adapter, session, c, fq: fq.last() };
}

/** Events after the start-up session.info. */
const body = (events: SessionEventBody[]) => events.slice(1);

test('createAdapters returns the claude adapter with structured-only capabilities', () => {
  const [a] = createAdapters();
  assert.ok(a);
  assert.equal(a.agent, 'claude');
  const caps = a.capabilities('structured');
  assert.deepEqual(caps.modes, ['structured']);
  assert.equal(caps.streaming, 'token');
  assert.equal(caps.approvals, 'per-tool');
  assert.equal(caps.editableApprovals, true);
  assert.equal(caps.steer, true);
  assert.equal(caps.usage, 'tokens+cost');
  assert.deepEqual(caps.permissionModes, ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk', 'auto']);
  assert.deepEqual(a.capabilities('terminal').modes, []);
});

test('terminal mode is rejected', async () => {
  const adapter = new ClaudeAdapter({ claudePath: null, queryFn: fakeQueryFn(() => {}).queryFn });
  await assert.rejects(
    adapter.start({ ...base, mode: 'terminal' }, () => {}, { logger: silentLogger }),
    (e: unknown) => e instanceof BizziError && e.code === 'unsupported',
  );
});

test('launch options: preset system prompt + append, MCP, settings, resume/fork, executable', async () => {
  const { fq } = await setup(() => {}, {
    systemPromptAppend: 'RULES',
    model: 'haiku',
    permissionMode: 'plan',
    effort: 'low',
    env: { FOO: 'bar' },
    mcpServers: {
      mem: { type: 'stdio', command: 'bizzi-mcp', args: ['--x'] },
      web: { type: 'http', url: 'http://localhost:1/mcp', headers: { a: 'b' } },
    },
  }, { claudePath: process.execPath });
  const o = fq.options;
  assert.deepEqual(o.systemPrompt, { type: 'preset', preset: 'claude_code', append: 'RULES' });
  assert.deepEqual(o.settingSources, ['user', 'project', 'local']);
  assert.equal(o.cwd, '/tmp/ws');
  assert.equal(o.model, 'haiku');
  assert.equal(o.permissionMode, 'plan');
  assert.equal(o.effort, 'low');
  assert.equal(o.includePartialMessages, true);
  assert.equal(o.pathToClaudeCodeExecutable, process.execPath);
  assert.equal(o.env?.FOO, 'bar');
  assert.deepEqual(o.mcpServers, {
    mem: { type: 'stdio', command: 'bizzi-mcp', args: ['--x'] },
    web: { type: 'http', url: 'http://localhost:1/mcp', headers: { a: 'b' } },
  });
  assert.match(String(o.sessionId), /^[0-9a-f-]{36}$/);
  assert.equal(o.resume, undefined);

  const resumed = await setup(() => {}, { resumeRef: 'abc' });
  assert.equal(resumed.fq.options.resume, 'abc');
  assert.equal(resumed.fq.options.sessionId, undefined);
  assert.equal(resumed.session.agentSessionRef(), 'abc');

  const forked = await setup(() => {}, { resumeRef: 'abc', fork: true } as Partial<StartSessionOptions>);
  assert.equal(forked.fq.options.forkSession, true);
  assert.notEqual(forked.session.agentSessionRef(), 'abc');
  assert.equal(forked.fq.options.sessionId, forked.session.agentSessionRef());
});

test('a text turn maps to exact normalized events', async () => {
  const { session, c, fq } = await setup((fq, u) => {
    fq.emit(
      init(String(fq.options.sessionId)),
      ...streamText('msg_1', 0, ['Hel', 'lo']),
      assistant('msg_1', { type: 'text', text: 'Hello' }),
      result([u.uuid!], 0.01),
    );
  });
  const ref = session.agentSessionRef();
  assert.deepEqual(c.events[0], { type: 'session.info', data: { agentSessionRef: ref } });
  await session.send('t_1', [{ type: 'text', text: 'hi' }]);
  await waitFor(() => c.of('turn.completed').length === 1);
  assert.equal(fq.received[0]?.message.content, 'hi');
  assert.deepEqual(body(c.events), [
    { type: 'session.info', data: { model: 'claude-haiku-5-5', permissionMode: 'default' } },
    { type: 'message.delta', data: { messageId: 'msg_1:t0', role: 'assistant', text: 'Hel' } },
    { type: 'message.delta', data: { messageId: 'msg_1:t0', role: 'assistant', text: 'lo' } },
    { type: 'message.completed', data: { messageId: 'msg_1:t0', role: 'assistant', text: 'Hello' } },
    {
      type: 'usage.updated',
      data: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 20, costUsd: 0.01, contextWindow: 200000 },
    },
    {
      type: 'turn.completed',
      data: {
        turnId: 't_1',
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 20, costUsd: 0.01, contextWindow: 200000 },
      },
    },
  ]);
  await session.stop();
});

test('thinking + multiple text blocks in one API message get distinct ids', async () => {
  const { session, c } = await setup((fq, u) => {
    fq.emit(
      ...streamText('m', 0, ['hmm'], 'thinking'),
      assistant('m', { type: 'thinking', thinking: 'hmm', signature: 's' }),
      ...streamText('m', 1, ['A']).slice(0),
      assistant('m', { type: 'text', text: 'A' }),
      toolUse('m', 'toolu_1', 'Read', { file_path: '/w/a.ts' }),
      ...streamText('m', 3, ['B']),
      assistant('m', { type: 'text', text: 'B' }),
      result([u.uuid!], 0),
    );
  });
  await session.send('t', [{ type: 'text', text: 'x' }]);
  await waitFor(() => c.of('turn.completed').length === 1);
  assert.deepEqual(c.of('reasoning.delta'), [{ messageId: 'm:r0', text: 'hmm' }]);
  assert.deepEqual(c.of('reasoning.completed'), [{ messageId: 'm:r0', text: 'hmm' }]);
  assert.deepEqual(
    c.of('message.delta').map((d) => [d.messageId, d.text]),
    [['m:t0', 'A'], ['m:t1', 'B']],
  );
  assert.deepEqual(
    c.of('message.completed').map((d) => [d.messageId, d.text]),
    [['m:t0', 'A'], ['m:t1', 'B']],
  );
  await session.stop();
});

test('tool calls: kinds, titles, results, file changes, plan, subagents', async () => {
  const { session, c } = await setup((fq, u) => {
    fq.emit(
      toolUse('m1', 'tb', 'Bash', { command: 'npm test', description: 'Run tests' }),
      toolResult('tb', 'all good'),
      toolUse('m1', 'te', 'Edit', { file_path: '/w/a.ts', old_string: 'a', new_string: 'b' }),
      toolResult('te', 'ok', false, {
        filePath: '/w/a.ts',
        structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }],
        originalFile: 'a',
      }),
      toolUse('m1', 'tw', 'Write', { file_path: '/w/new.ts', content: 'x' }),
      toolResult('tw', 'ok', false, { type: 'create', filePath: '/w/new.ts', structuredPatch: [], originalFile: null }),
      toolUse('m1', 'tg', 'Grep', { pattern: 'TODO', path: 'src' }),
      toolResult('tg', [{ type: 'text', text: 'none' }], true),
      toolUse('m1', 'tm', 'mcp__bizzi__memory_search', { query: 'x' }),
      toolUse('m1', 'tf', 'WebFetch', { url: 'https://example.com', prompt: 'p' }),
      toolUse('m1', 'td', 'TodoWrite', {
        todos: [
          { content: 'one', status: 'completed', activeForm: 'x' },
          { content: 'two', status: 'in_progress', activeForm: 'y' },
        ],
      }),
      toolUse('m1', 'ta', 'Task', { description: 'Find files', prompt: 'p', subagent_type: 'Explore' }),
      { type: 'system', subtype: 'task_started', task_id: 'k1', tool_use_id: 'ta', description: 'Find files', subagent_type: 'Explore', task_type: 'local_agent', uuid: 'x', session_id: 's' },
      toolUse('m2', 'tr', 'Read', { file_path: '/w/b.ts' }, 'ta'),
      { type: 'system', subtype: 'task_progress', task_id: 'k1', tool_use_id: 'ta', description: 'Find files', summary: 'Reading b.ts', usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 }, uuid: 'x', session_id: 's' },
      { type: 'system', subtype: 'task_notification', task_id: 'k1', tool_use_id: 'ta', status: 'completed', output_file: '', summary: 'done', uuid: 'x', session_id: 's' },
      toolUse('m1', 'tc', 'TaskCreate', { subject: 'Write docs', description: 'd' }),
      toolResult('tc', 'ok', false, { task: { id: '7', subject: 'Write docs' } }),
      toolUse('m1', 'tu', 'TaskUpdate', { taskId: '7', status: 'in_progress' }),
      toolResult('tu', 'ok', false, { success: true, taskId: '7', updatedFields: ['status'] }),
      { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' }, uuid: 'x', session_id: 's' },
      result([u.uuid!], 0.02),
    );
  });
  await session.send('t', [{ type: 'text', text: 'go' }]);
  await waitFor(() => c.of('turn.completed').length === 1);
  assert.deepEqual(
    c.of('tool.started').map((t) => [t.toolId, t.kind, t.name, t.title, t.parentToolId]),
    [
      ['tb', 'shell', 'Bash', 'npm test', undefined],
      ['te', 'edit', 'Edit', '/w/a.ts', undefined],
      ['tw', 'write', 'Write', '/w/new.ts', undefined],
      ['tg', 'search', 'Grep', 'TODO in src', undefined],
      ['tm', 'mcp', 'mcp__bizzi__memory_search', 'bizzi: memory_search', undefined],
      ['tf', 'web', 'WebFetch', 'https://example.com', undefined],
      ['td', 'other', 'TodoWrite', 'Update todo list', undefined],
      ['ta', 'task', 'Task', 'Find files (Explore)', undefined],
      ['tr', 'read', 'Read', '/w/b.ts', 'ta'],
      ['tc', 'other', 'TaskCreate', 'Add task: Write docs', undefined],
      ['tu', 'other', 'TaskUpdate', 'Update task 7 → in_progress', undefined],
    ],
  );
  assert.deepEqual(c.of('tool.completed'), [
    { toolId: 'tb', status: 'ok', output: 'all good' },
    { toolId: 'te', status: 'ok', output: 'ok' },
    { toolId: 'tw', status: 'ok', output: 'ok' },
    { toolId: 'tg', status: 'error', error: 'none' },
    { toolId: 'tc', status: 'ok', output: 'ok' },
    { toolId: 'tu', status: 'ok', output: 'ok' },
  ]);
  assert.deepEqual(c.of('file.changed'), [
    { path: '/w/a.ts', change: 'modified', diff: '--- a/w/a.ts\n+++ b/w/a.ts\n@@ -1,1 +1,1 @@\n-a\n+b' },
    { path: '/w/new.ts', change: 'created' },
  ]);
  assert.deepEqual(c.of('plan.updated'), [
    { items: [{ text: 'one', status: 'completed' }, { text: 'two', status: 'in_progress' }] },
    { items: [{ text: 'one', status: 'completed' }, { text: 'two', status: 'in_progress' }, { id: '7', text: 'Write docs', status: 'pending' }] },
    { items: [{ text: 'one', status: 'completed' }, { text: 'two', status: 'in_progress' }, { id: '7', text: 'Write docs', status: 'in_progress' }] },
  ]);
  assert.deepEqual(c.of('subagent.started'), [{ subagentId: 'k1', name: 'Explore', description: 'Find files', parentToolId: 'ta' }]);
  assert.deepEqual(c.of('subagent.completed'), [{ subagentId: 'k1', status: 'ok' }]);
  assert.deepEqual(c.of('tool.updated'), [{ toolId: 'ta', progress: 'Reading b.ts' }]);
  const raw = c.of('agent.raw');
  assert.equal(raw.length, 1);
  assert.equal((raw[0]?.payload as { type: string }).type, 'rate_limit_event');
  await session.stop();
});

test('approval round-trip: editedInput reaches the SDK, events in order', async () => {
  let decision: unknown;
  const { session, c } = await setup(async (fq, u) => {
    fq.emit(toolUse('m', 'toolu_1', 'Bash', { command: 'rm -rf build' }));
    decision = await fq.ask('Bash', { command: 'rm -rf build' }, { toolUseID: 'toolu_1', title: 'Claude wants to run rm -rf build', decisionReason: 'dangerous' });
    fq.emit(toolResult('toolu_1', 'removed'), result([u.uuid!], 0));
  });
  await session.send('t', [{ type: 'text', text: 'clean' }]);
  await waitFor(() => c.of('approval.requested').length === 1);
  const req = c.of('approval.requested')[0]!;
  assert.deepEqual({ ...req, approvalId: 'X' }, {
    approvalId: 'X',
    toolId: 'toolu_1',
    kind: 'shell',
    title: 'Claude wants to run rm -rf build',
    description: 'dangerous',
    input: { command: 'rm -rf build' },
    editable: true,
    options: ['allow', 'allow_always', 'deny'],
  });
  await session.respondApproval(req.approvalId, { decision: 'allow', editedInput: { command: 'rm -rf build/tmp' } });
  await waitFor(() => c.of('turn.completed').length === 1);
  assert.deepEqual(decision, { behavior: 'allow', updatedInput: { command: 'rm -rf build/tmp' } });
  assert.deepEqual(c.of('approval.resolved'), [{ approvalId: req.approvalId, decision: 'allow' }]);
  const order = c.events.map((e) => e.type).filter((t) => t.startsWith('approval') || t.startsWith('tool'));
  assert.deepEqual(order, ['tool.started', 'approval.requested', 'approval.resolved', 'tool.completed']);
  await assert.rejects(session.respondApproval(req.approvalId, { decision: 'allow' }), (e: unknown) => e instanceof BizziError && e.code === 'not_found');
  await session.stop();
});

test('approval allow_always applies SDK suggestions; deny marks the tool denied', async () => {
  const decisions: unknown[] = [];
  const suggestions = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'localSettings' }];
  const { session, c } = await setup(async (fq, u) => {
    decisions.push(await fq.ask('Bash', { command: 'npm test' }, { toolUseID: 'a1', suggestions }));
    decisions.push(await fq.ask('Write', { file_path: '/w/x', content: 'y' }, { toolUseID: 'a2' }));
    fq.emit(toolResult('a2', 'User denied', true), result([u.uuid!], 0));
  });
  await session.send('t', [{ type: 'text', text: 'x' }]);
  await waitFor(() => c.of('approval.requested').length === 1);
  await session.respondApproval(c.of('approval.requested')[0]!.approvalId, { decision: 'allow_always' });
  await waitFor(() => c.of('approval.requested').length === 2);
  const second = c.of('approval.requested')[1]!;
  assert.equal(second.kind, 'write');
  assert.equal(second.title, '/w/x');
  await session.respondApproval(second.approvalId, { decision: 'deny', message: 'not that file' });
  await waitFor(() => c.of('turn.completed').length === 1);
  assert.deepEqual(decisions, [
    { behavior: 'allow', updatedInput: { command: 'npm test' }, updatedPermissions: suggestions },
    { behavior: 'deny', message: 'not that file' },
  ]);
  assert.deepEqual(c.of('approval.resolved').map((r) => r.decision), ['allow_always', 'deny']);
  assert.deepEqual(c.of('tool.completed'), [{ toolId: 'a2', status: 'denied', error: 'User denied' }]);
  await session.stop();
});

test('AskUserQuestion: answer via message fills answers', async () => {
  let decision: unknown;
  const input = { questions: [{ question: 'Which DB?', header: 'DB', multiSelect: false, options: [{ label: 'pg', description: '' }, { label: 'sqlite', description: '' }] }] };
  const { session, c } = await setup(async (fq, u) => {
    decision = await fq.ask('AskUserQuestion', input, { toolUseID: 'q1' });
    fq.emit(result([u.uuid!], 0));
  });
  await session.send('t', [{ type: 'text', text: 'x' }]);
  await waitFor(() => c.of('approval.requested').length === 1);
  const req = c.of('approval.requested')[0]!;
  assert.equal(req.title, 'Which DB?');
  assert.equal(req.description, 'Which DB? [pg / sqlite]');
  assert.deepEqual(req.options, ['allow', 'deny']);
  await session.respondApproval(req.approvalId, { decision: 'allow', message: 'sqlite' });
  await waitFor(() => c.of('turn.completed').length === 1);
  assert.deepEqual(decision, { behavior: 'allow', updatedInput: { ...input, answers: { 'Which DB?': 'sqlite' } } });
  await session.stop();
});

test('interrupt: pending approval denied, turn completes as interrupted', async () => {
  let decision: unknown;
  const { session, c, fq } = await setup(async (fq) => {
    fq.emit(toolUse('m', 'b1', 'Bash', { command: 'sleep 100' }));
    decision = await fq.ask('Bash', { command: 'sleep 100' }, { toolUseID: 'b1' });
  });
  fq.onInterrupt = () => {
    const u = fq.received[0]!.uuid!;
    fq.emit(
      toolResult('b1', 'The user doesn\'t want to proceed', true),
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] }, parent_tool_use_id: null, session_id: 's', uuid: 'iu' },
      result([u], 0.001, { subtype: 'error_during_execution', is_error: true, errors: [], terminal_reason: 'aborted_tools' }),
    );
  };
  await session.send('t', [{ type: 'text', text: 'x' }]);
  await waitFor(() => c.of('approval.requested').length === 1);
  await session.interrupt();
  await waitFor(() => c.of('turn.completed').length === 1);
  assert.deepEqual(decision, { behavior: 'deny', message: 'Interrupted by the user.', interrupt: true });
  assert.deepEqual(c.of('approval.resolved').map((r) => [r.decision, r.by]), [['deny', 'bizzi']]);
  assert.deepEqual(c.of('tool.completed'), [{ toolId: 'b1', status: 'denied', error: 'The user doesn\'t want to proceed' }]);
  const done = c.of('turn.completed')[0]!;
  assert.equal(done.turnId, 't');
  assert.equal(done.stopReason, 'interrupted');
  await session.stop();
  assert.equal(c.of('turn.completed').length, 1);
});

test('interrupt without an SDK result completes after the grace period; late result is dropped', async () => {
  const { session, c, fq } = await setup(() => {}, {}, { interruptGraceMs: 20 });
  await session.send('t1', [{ type: 'text', text: 'x' }]);
  await waitFor(() => fq.received.length === 1);
  await session.interrupt();
  await waitFor(() => c.of('turn.completed').length === 1);
  assert.equal(c.of('turn.completed')[0]!.stopReason, 'interrupted');
  fq.emit(result([fq.received[0]!.uuid!], 0));
  await tick();
  assert.equal(c.of('turn.completed').length, 1);
  await session.send('t2', [{ type: 'text', text: 'y' }]);
  await waitFor(() => fq.received.length === 2);
  fq.emit(result([fq.received[1]!.uuid!], 0));
  await waitFor(() => c.of('turn.completed').length === 2);
  assert.deepEqual(c.of('turn.completed').map((t) => [t.turnId, t.stopReason]), [['t1', 'interrupted'], ['t2', 'end_turn']]);
  await session.stop();
});

test('multi-turn: sends while busy queue up; one turn.completed per turn, usage per turn', async () => {
  let n = 0;
  const { session, c, fq } = await setup(async (fq, u) => {
    n++;
    await tick();
    const text = typeof u.message.content === 'string' ? u.message.content : '';
    fq.emit(assistant(`m${n}`, { type: 'text', text: `re: ${text}` }), result([u.uuid!], 0.01 * n));
  });
  await session.send('t1', [{ type: 'text', text: 'one' }]);
  await session.send('t2', [{ type: 'text', text: 'two' }]);
  assert.equal(fq.received.length <= 1, true, 'second message is held until the first turn completes');
  await waitFor(() => c.of('turn.completed').length === 2);
  assert.deepEqual(c.of('message.completed').map((m) => m.text), ['re: one', 're: two']);
  const done = c.of('turn.completed');
  assert.deepEqual(done.map((d) => [d.turnId, d.stopReason]), [['t1', 'end_turn'], ['t2', 'end_turn']]);
  assert.equal(done[0]!.usage?.costUsd, 0.01);
  assert.ok(Math.abs((done[1]!.usage?.costUsd ?? 0) - 0.01) < 1e-9, 'cost is the per-turn delta of the cumulative total');
  assert.notEqual(fq.received[0]!.uuid, fq.received[1]!.uuid);
  await session.stop();
});

test('steer: folded into the running turn, or completed by the follow-up SDK turn', async () => {
  // folded: the CLI consumes both uuids in one result
  {
    const { session, c, fq } = await setup(() => {});
    await session.send('t', [{ type: 'text', text: 'long task' }]);
    await waitFor(() => fq.received.length === 1);
    await session.steer([{ type: 'text', text: 'also this' }]);
    await waitFor(() => fq.received.length === 2);
    assert.equal(fq.received[1]!.priority, 'next');
    fq.emit(result([fq.received[0]!.uuid!, fq.received[1]!.uuid!], 0.01));
    await waitFor(() => c.of('turn.completed').length === 1);
    await session.stop();
  }
  // not folded: first result lacks the steer uuid, so the turn stays open until the next result
  {
    const { session, c, fq } = await setup(() => {});
    await session.send('t', [{ type: 'text', text: 'long task' }]);
    await waitFor(() => fq.received.length === 1);
    await session.steer([{ type: 'text', text: 'also this' }]);
    await waitFor(() => fq.received.length === 2);
    fq.emit(result([fq.received[0]!.uuid!], 0.01));
    await tick();
    assert.equal(c.of('turn.completed').length, 0);
    fq.emit(result([fq.received[1]!.uuid!], 0.03));
    await waitFor(() => c.of('turn.completed').length === 1);
    const usage = c.of('turn.completed')[0]!.usage!;
    assert.equal(usage.inputTokens, 20);
    assert.ok(Math.abs(usage.costUsd! - 0.03) < 1e-9);
    await session.stop();
  }
  // no turn in flight
  {
    const { session } = await setup(() => {});
    await assert.rejects(session.steer([{ type: 'text', text: 'x' }]), (e: unknown) => e instanceof BizziError && e.code === 'conflict');
    await session.stop();
  }
});

test('result errors map to stop reasons', async () => {
  const cases: [object, string, string | undefined][] = [
    [{ subtype: 'error_max_turns', is_error: true, errors: [] }, 'max_turns', 'error_max_turns'],
    [{ subtype: 'error_during_execution', is_error: true, errors: ['boom'] }, 'error', 'boom'],
    [{ subtype: 'success', is_error: true, result: 'API Error: 500' }, 'error', 'API Error: 500'],
    [{ stop_reason: 'refusal' }, 'refusal', undefined],
  ];
  for (const [extra, stopReason, error] of cases) {
    const { session, c } = await setup((fq, u) => fq.emit(result([u.uuid!], 0, extra)));
    await session.send('t', [{ type: 'text', text: 'x' }]);
    await waitFor(() => c.of('turn.completed').length === 1);
    const done = c.of('turn.completed')[0]!;
    assert.equal(done.stopReason, stopReason);
    assert.equal(done.error, error);
    await session.stop();
  }
});

test('process death: fatal error, failed status, every pending turn completed', async () => {
  const { session, c, fq } = await setup(() => {});
  session.onStderr('panic: something broke\n');
  await session.send('t1', [{ type: 'text', text: 'x' }]);
  await session.send('t2', [{ type: 'text', text: 'y' }]);
  await waitFor(() => fq.received.length === 1);
  fq.crash('Claude Code process exited with code 1');
  await waitFor(() => c.of('session.status').length === 1);
  const err = c.of('error')[0]!;
  assert.equal(err.fatal, true);
  assert.equal(err.code, 'agent_exited');
  assert.match(err.message, /exited with code 1/);
  assert.match(err.message, /panic: something broke/);
  assert.deepEqual(c.of('turn.completed').map((t) => [t.turnId, t.stopReason]), [['t1', 'error'], ['t2', 'error']]);
  assert.equal(c.of('session.status')[0]!.status, 'failed');
  await assert.rejects(session.send('t3', [{ type: 'text', text: 'z' }]), (e: unknown) => e instanceof BizziError && e.code === 'agent_unavailable');
  await session.stop();
});

test('stream ending without stop() is treated as process death', async () => {
  const { session, c, fq } = await setup(() => {});
  await session.send('t1', [{ type: 'text', text: 'x' }]);
  await waitFor(() => fq.received.length === 1);
  fq.exit();
  await waitFor(() => c.of('session.status').length === 1);
  assert.equal(c.of('session.status')[0]!.status, 'failed');
  assert.deepEqual(c.of('turn.completed').map((t) => t.stopReason), ['error']);
});

test('stop: completes the in-flight turn, emits ended once, closes the query', async () => {
  const { session, c, fq } = await setup(() => {});
  await session.send('t1', [{ type: 'text', text: 'x' }]);
  await session.stop();
  await session.stop();
  await tick();
  assert.deepEqual(c.of('turn.completed').map((t) => [t.turnId, t.stopReason]), [['t1', 'interrupted']]);
  assert.deepEqual(c.of('session.status'), [{ status: 'ended' }]);
  assert.equal(c.of('error').length, 0);
  assert.ok(fq.calls.some((x) => x.method === 'close'));
});

test('set(): model, permission mode and effort go through the SDK controls', async () => {
  const { session, c, fq } = await setup(() => {});
  await session.set({ model: 'opus', permissionMode: 'acceptEdits', effort: 'high' });
  assert.deepEqual(fq.calls.map((x) => [x.method, x.args[0]]), [
    ['setPermissionMode', 'acceptEdits'],
    ['setModel', 'opus'],
    ['applyFlagSettings', { effortLevel: 'high' }],
  ]);
  assert.deepEqual(c.events.at(-1), { type: 'session.info', data: { permissionMode: 'acceptEdits', model: 'opus', effort: 'high' } });
  await assert.rejects(session.set({ effort: 'extreme' }), (e: unknown) => e instanceof BizziError && e.code === 'bad_request');
  await session.stop();
});

test('init updates session.info only on change; status permission mode changes are reported', async () => {
  const { session, c } = await setup((fq, u) => {
    fq.emit(
      init(String(fq.options.sessionId)),
      init(String(fq.options.sessionId)),
      { type: 'system', subtype: 'status', status: null, permissionMode: 'plan', uuid: 'x', session_id: 's' },
      result([u.uuid!], 0),
    );
  });
  await session.send('t', [{ type: 'text', text: 'x' }]);
  await waitFor(() => c.of('turn.completed').length === 1);
  assert.deepEqual(c.of('session.info').slice(1), [
    { model: 'claude-haiku-5-5', permissionMode: 'default' },
    { permissionMode: 'plan' },
  ]);
  await session.stop();
});

test('image and file input become SDK content blocks', async () => {
  const { session, fq } = await setup(() => {});
  await session.send('t', [
    { type: 'text', text: 'look' },
    { type: 'image', mediaType: 'image/png', dataBase64: 'AAAA' },
    { type: 'file', path: '/w/my file.ts' },
  ]);
  await waitFor(() => fq.received.length === 1);
  assert.deepEqual(fq.received[0]!.message.content, [
    { type: 'text', text: 'look' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    { type: 'text', text: '@"/w/my file.ts"' },
  ]);
  await session.stop();
});
