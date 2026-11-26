import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { BizziError, type StartSessionOptions } from '@bizzi/protocol';
import { createAdapters, OpenCodeAdapter, OPENCODE_CAPABILITIES } from '../src/index.ts';
import type { OpenCodeSession } from '../src/session.ts';
import { FakeOpenCode } from './fake-server.ts';
import { ctx, Recorder, until } from './helpers.ts';

const PASSWORD = 'test-password';
const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'bizzi-oc-')));

let fake: FakeOpenCode;
let adapter: OpenCodeAdapter;

before(async () => {
  fake = new FakeOpenCode({ password: PASSWORD });
  await fake.start();
  adapter = new OpenCodeAdapter({ serverUrl: fake.url, serverPassword: PASSWORD, healthIntervalMs: 0, interruptFallbackMs: 500 });
});

after(async () => {
  await adapter.dispose();
  await fake.close();
});

beforeEach(() => {
  fake.requests.length = 0;
});

function opts(extra: Partial<StartSessionOptions> = {}): StartSessionOptions {
  return { sessionId: 's_test', mode: 'structured', cwd, ...extra };
}

async function start(extra: Partial<StartSessionOptions> = {}): Promise<{ s: OpenCodeSession; rec: Recorder }> {
  const rec = new Recorder();
  const s = (await adapter.start(opts(extra), rec.emit, ctx)) as OpenCodeSession;
  return { s, rec };
}

function reqs(method: string, re: RegExp) {
  return fake.requests.filter((r) => r.method === method && re.test(r.path));
}

describe('discovery and capabilities', () => {
  test('createAdapters returns one opencode adapter', () => {
    const list = createAdapters({ serverUrl: 'http://127.0.0.1:1' });
    assert.equal(list.length, 1);
    assert.equal(list[0]!.agent, 'opencode');
    assert.equal(list[0]!.capabilities('structured').streaming, 'token');
    assert.deepEqual(list[0]!.capabilities('terminal').modes, []);
  });

  test('listModels: provider/model ids, variants as efforts', async () => {
    assert.deepEqual(await adapter.listModels(), [
      { id: 'fake/fake-model', label: 'Fake', efforts: ['low', 'high'] },
      { id: 'fake/other', label: 'Other' },
    ]);
  });

  test('terminal mode is rejected', async () => {
    await assert.rejects(adapter.start(opts({ mode: 'terminal' }), () => {}, ctx), (e: unknown) => e instanceof BizziError && e.code === 'unsupported');
  });

  test('capability manifest', () => {
    assert.deepEqual(OPENCODE_CAPABILITIES.permissionModes, ['build', 'plan']);
    assert.equal(OPENCODE_CAPABILITIES.approvals, 'per-tool');
    assert.equal(OPENCODE_CAPABILITIES.mcpInjection, 'launch');
    assert.equal(OPENCODE_CAPABILITIES.instructionInjection, 'system-append');
    assert.equal(OPENCODE_CAPABILITIES.fork, true);
    assert.equal(OPENCODE_CAPABILITIES.questions, true);
  });
});

describe('session start', () => {
  test('creates a located session with model, agent, injections', async () => {
    const { s, rec } = await start({
      model: 'fake/fake-model',
      effort: 'high',
      permissionMode: 'plan',
      systemPromptAppend: 'Follow the bizzi rules.',
      env: { FOO: 'bar' },
      mcpServers: {
        'bizzi-memory': { type: 'stdio', command: 'node', args: ['mem.js'], env: { K: 'v' } },
        remote: { type: 'http', url: 'https://mcp.example/mcp', headers: { A: 'b' } },
      },
    });
    const create = reqs('POST', /^\/api\/session$/)[0]!;
    assert.deepEqual(create.body, {
      location: { directory: cwd },
      agent: 'plan',
      model: { providerID: 'fake', id: 'fake-model', variant: 'high' },
      metadata: { bizziSessionId: 's_test' },
    });
    const ref = s.agentSessionRef()!;
    assert.match(ref, /^ses_/);
    assert.equal(fake.session(ref).instructions.bizzi, 'Follow the bizzi rules.');
    assert.deepEqual(reqs('PUT', /\/environment$/)[0]!.body, { variables: { FOO: 'bar' } });
    const mcp = reqs('PUT', /^\/api\/experimental\/mcp\//);
    assert.deepEqual(
      mcp.map((r) => [r.path, r.query['location[directory]'], r.body]),
      [
        ['/api/experimental/mcp/bizzi-memory', cwd, { config: { type: 'local', command: ['node', 'mem.js'], environment: { K: 'v' } } }],
        ['/api/experimental/mcp/remote', cwd, { config: { type: 'remote', url: 'https://mcp.example/mcp', oauth: false, headers: { A: 'b' } } }],
      ],
    );
    assert.deepEqual(rec.of('session.info')[0], { agentSessionRef: ref, model: 'fake/fake-model', effort: 'high', permissionMode: 'plan' });
    await s.stop();
    assert.equal(reqs('DELETE', /^\/api\/experimental\/mcp\//).length, 2, 'MCP registrations released on stop');
  });

  test('resume uses the existing session; unknown ref is not_found', async () => {
    const { s: first } = await start();
    const ref = first.agentSessionRef()!;
    await first.stop();
    const { s, rec } = await start({ resumeRef: ref, permissionMode: 'plan' });
    assert.equal(s.agentSessionRef(), ref);
    assert.equal(reqs('POST', /^\/api\/session$/).length, 1, 'no second create');
    assert.equal(reqs('POST', /\/agent$/).length, 1);
    assert.equal(rec.of('session.info')[0]!.agentSessionRef, ref);
    await s.stop();
    await assert.rejects(start({ resumeRef: 'ses_missing' }), (e: unknown) => e instanceof BizziError && e.code === 'not_found');
  });

  test('bad model string is bad_request', async () => {
    await assert.rejects(start({ model: 'no-provider' }), (e: unknown) => e instanceof BizziError && e.code === 'bad_request');
  });
});

describe('turns', () => {
  test('streams text and reasoning, completes with usage and cost', async () => {
    const { s, rec } = await start({ model: 'fake/fake-model' });
    await s.send('t_1', [{ type: 'text', text: 'scenario:basic hi' }]);
    const done = await rec.waitFor('turn.completed');
    assert.equal(done.turnId, 't_1');
    assert.equal(done.stopReason, 'end_turn');
    assert.deepEqual(done.usage, { inputTokens: 100, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.0012, contextWindow: 128000 });
    const deltas = rec.of('message.delta');
    assert.deepEqual(deltas.map((d) => d.text), ['Hello', ' from', ' fake']);
    const [msg] = rec.of('message.completed');
    assert.equal(msg!.text, 'Hello from fake');
    assert.equal(msg!.messageId, deltas[0]!.messageId);
    assert.deepEqual(rec.of('reasoning.completed').map((r) => r.text), ['Thinking']);
    const prompt = reqs('POST', /\/prompt$/)[0]!;
    assert.deepEqual(prompt.body, { text: 'scenario:basic hi' });
    await s.stop();
  });

  test('images and files become prompt attachments', async () => {
    const { s, rec } = await start();
    await s.send('t_2', [
      { type: 'text', text: 'look' },
      { type: 'image', mediaType: 'image/png', dataBase64: 'AAAA' },
      { type: 'file', path: 'src/a.ts' },
    ]);
    await rec.waitFor('turn.completed');
    assert.deepEqual(reqs('POST', /\/prompt$/)[0]!.body, {
      text: 'look',
      files: [
        { uri: 'data:image/png;base64,AAAA', name: 'image' },
        { uri: `file://${cwd}/src/a.ts`, name: 'a.ts' },
      ],
    });
    await s.stop();
  });

  test('second send while a turn runs is a conflict', async () => {
    const { s, rec } = await start();
    await s.send('t_3', [{ type: 'text', text: 'scenario:silent' }]);
    await assert.rejects(s.send('t_4', [{ type: 'text', text: 'again' }]), (e: unknown) => e instanceof BizziError && e.code === 'conflict');
    await s.steer!([{ type: 'text', text: 'also do X' }]);
    assert.equal(reqs('POST', /\/prompt$/)[1]!.body && (reqs('POST', /\/prompt$/)[1]!.body as { delivery: string }).delivery, 'steer');
    await s.stop();
    assert.equal((await rec.waitFor('turn.completed')).stopReason, 'interrupted');
  });

  test('execution failure → error + turn.completed(error)', async () => {
    const { s, rec } = await start();
    await s.send('t_5', [{ type: 'text', text: 'scenario:fail' }]);
    const done = await rec.waitFor('turn.completed');
    assert.equal(done.stopReason, 'error');
    assert.equal(done.error, 'Model unavailable: nope/bogus');
    assert.deepEqual(rec.of('error')[0], { message: 'Model unavailable: nope/bogus', code: 'provider.no-route' });
    await s.stop();
  });
});

describe('tool lifecycle', () => {
  test('maps tools, subagents, files, todos', async () => {
    const { s, rec } = await start();
    await s.send('t_tools', [{ type: 'text', text: 'scenario:tools' }]);
    const done = await rec.waitFor('turn.completed');
    assert.equal(done.stopReason, 'end_turn');

    const started = rec.of('tool.started');
    const byId = Object.fromEntries(started.map((t) => [t.toolId, t]));
    assert.deepEqual(
      started.map((t) => [t.toolId, t.kind, t.name, t.title]),
      [
        ['call_shell', 'shell', 'shell', 'echo hi'],
        ['call_read', 'read', 'read', `${cwd}/a.txt`],
        ['call_grep', 'search', 'grep', 'TODO in src'],
        ['call_glob', 'search', 'glob', '**/*.ts'],
        ['call_fetch', 'web', 'webfetch', 'https://example.com'],
        ['call_write', 'write', 'write', `${cwd}/new.txt`],
        ['call_edit', 'edit', 'edit', 'b.txt'],
        ['call_mcp', 'mcp', 'execute', 'search memory'],
        ['call_todo', 'other', 'todowrite', 'todowrite'],
        ['call_sub', 'task', 'subagent', 'Look around'],
        ['call_child_read', 'read', 'read', 'c.txt'],
      ],
    );
    assert.deepEqual(byId.call_shell!.input, { command: 'echo hi' });
    assert.equal(byId.call_child_read!.parentToolId, 'call_sub');

    const completed = Object.fromEntries(rec.of('tool.completed').map((t) => [t.toolId, t]));
    assert.equal(completed.call_shell!.status, 'ok');
    assert.equal(completed.call_shell!.output, 'hi\n');
    assert.equal(completed.call_fetch!.status, 'error');
    assert.equal(completed.call_fetch!.error, 'network down');
    assert.equal(completed.call_sub!.status, 'ok');
    assert.equal(completed.call_child_read!.status, 'ok');
    // every started tool completed, after it started
    for (const t of started) {
      const si = rec.events.findIndex((e) => e.type === 'tool.started' && e.data.toolId === t.toolId);
      const ci = rec.events.findIndex((e) => e.type === 'tool.completed' && e.data.toolId === t.toolId);
      assert.ok(ci > si, `${t.toolId} completed after start`);
    }

    assert.deepEqual(rec.of('file.changed'), [
      { path: `${cwd}/new.txt`, change: 'modified' },
      { path: `${cwd}/b.txt`, change: 'modified' },
    ]);
    assert.deepEqual(rec.of('plan.updated'), [{ items: [{ text: 'one', status: 'completed' }, { text: 'two', status: 'in_progress' }] }]);
    const [sub] = rec.of('subagent.started');
    assert.equal(sub!.parentToolId, 'call_sub');
    assert.equal(sub!.name, 'general');
    assert.equal(sub!.description, 'Look around');
    assert.deepEqual(rec.of('subagent.completed'), [{ subagentId: sub!.subagentId, status: 'ok' }]);
    // child text is not surfaced as the parent's message
    assert.deepEqual(rec.of('message.completed').map((m) => m.text), ['All done.']);
    // usage sums main + subagent steps
    assert.equal(done.usage!.inputTokens, 120);
    assert.equal(done.usage!.costUsd, 1);
    // unmapped events pass through as agent.raw
    assert.ok(rec.of('agent.raw').some((r) => (r.payload as { type: string }).type === 'session.retry.scheduled'));
    await s.stop();
  });
});

describe('permissions', () => {
  for (const [decision, reply, status] of [
    ['allow', 'once', 'ok'],
    ['allow_always', 'always', 'ok'],
    ['deny', 'reject', 'denied'],
  ] as const) {
    test(`round-trip: ${decision} → ${reply}`, async () => {
      const { s, rec } = await start();
      await s.send('t_perm', [{ type: 'text', text: 'scenario:permission' }]);
      const req = await rec.waitFor('approval.requested');
      assert.equal(req.kind, 'shell');
      assert.equal(req.title, 'Run rm -rf build');
      assert.equal(req.toolId, 'call_rm');
      assert.deepEqual(req.input, { command: 'rm -rf build' });
      assert.equal(req.editable, false);
      assert.deepEqual(req.options, ['allow', 'allow_always', 'deny']);
      await s.respondApproval(req.approvalId, { decision, message: decision === 'deny' ? 'not today' : undefined });
      const r = reqs('POST', /\/permission\/.+\/reply$/)[0]!;
      assert.deepEqual(r.body, decision === 'deny' ? { decision: reply, message: 'not today' } : { decision: reply });
      const done = await rec.waitFor('turn.completed');
      assert.equal(done.stopReason, 'end_turn');
      assert.deepEqual(rec.of('approval.resolved'), [{ approvalId: req.approvalId, decision }], 'resolved exactly once');
      const tool = rec.of('tool.completed').find((t) => t.toolId === 'call_rm')!;
      assert.equal(tool.status, status);
      if (decision === 'deny') assert.equal(tool.error, 'not today');
      await s.stop();
    });
  }

  test('unknown approval id is not_found', async () => {
    const { s } = await start();
    await assert.rejects(s.respondApproval('per_nope', { decision: 'allow' }), (e: unknown) => e instanceof BizziError && e.code === 'not_found');
    await s.stop();
  });
});

describe('interrupt', () => {
  test('aborts a running turn', async () => {
    const { s, rec } = await start();
    await s.send('t_long', [{ type: 'text', text: 'scenario:long' }]);
    await rec.waitFor('message.delta');
    await rec.waitFor('tool.started');
    await s.interrupt();
    const done = await rec.waitFor('turn.completed');
    assert.equal(done.stopReason, 'interrupted');
    assert.equal(reqs('POST', /\/interrupt$/).length, 1);
    assert.equal(rec.of('tool.completed').find((t) => t.toolId === 'call_sleep')!.status, 'cancelled');
    assert.equal(rec.of('message.completed').length, 1, 'open text flushed');
    assert.equal(rec.of('turn.completed').length, 1);
    await s.stop();
  });

  test('interrupt with nothing running closes the turn', async () => {
    const { s, rec } = await start();
    await s.interrupt(); // no turn: no-op
    assert.equal(rec.of('turn.completed').length, 0);
    await s.send('t_q', [{ type: 'text', text: 'scenario:silent' }]);
    fake.session(s.agentSessionRef()!).running = false; // server says nothing to interrupt
    await s.interrupt();
    assert.equal((await rec.waitFor('turn.completed')).stopReason, 'interrupted');
    await s.stop();
  });
});

describe('set()', () => {
  test('switches model, effort and agent; validates', async () => {
    const { s, rec } = await start({ model: 'fake/fake-model' });
    await s.set!({ model: 'fake/other' });
    await s.set!({ permissionMode: 'plan' });
    await s.set!({ model: 'fake/fake-model', effort: 'low' });
    assert.deepEqual(
      reqs('POST', /\/model$/).map((r) => r.body),
      [{ model: { providerID: 'fake', id: 'other' } }, { model: { providerID: 'fake', id: 'fake-model', variant: 'low' } }],
    );
    assert.deepEqual(reqs('POST', /\/agent$/).map((r) => r.body), [{ agent: 'plan' }]);
    await until(() => rec.of('session.info').length >= 4, 2000, 'session.info events');
    assert.deepEqual(rec.of('session.info').slice(1), [{ model: 'fake/other' }, { permissionMode: 'plan' }, { model: 'fake/fake-model', effort: 'low' }]);
    await assert.rejects(s.set!({ model: 'fake/nope' }), (e: unknown) => e instanceof BizziError && e.code === 'bad_request');
    await assert.rejects(s.set!({ effort: 'ultra' }), (e: unknown) => e instanceof BizziError && e.code === 'bad_request');
    await assert.rejects(s.set!({ permissionMode: 'general' }), (e: unknown) => e instanceof BizziError && e.code === 'bad_request');
    await s.stop();
  });
});

describe('stream gap', () => {
  test('reconciles a turn that finished while the stream was down', async () => {
    const { s, rec } = await start();
    const ref = s.agentSessionRef()!;
    await s.send('t_gap', [{ type: 'text', text: 'scenario:silent' }]);
    await until(() => fake.session(ref).running, 2000, 'running');
    const now = Date.now() + 10;
    fake.messages.set(ref, [
      { id: 'msg_idle', type: 'idle', time: { created: now + 2 }, outcome: 'succeeded' },
      {
        id: 'msg_a',
        type: 'assistant',
        time: { created: now + 1 },
        agent: 'build',
        model: { id: 'fake-model', providerID: 'fake' },
        content: [
          { type: 'text', text: 'Recovered answer' },
          { type: 'tool', id: 'call_x', name: 'read', state: { status: 'completed', input: { path: 'x' }, content: [{ type: 'text', text: 'x' }] } },
        ],
        tokens: { input: 5, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        cost: 0,
      },
    ]);
    fake.session(ref).running = false;
    fake.dropStreams();
    const done = await rec.waitFor('turn.completed', undefined, 8000);
    assert.equal(done.stopReason, 'end_turn');
    assert.equal(done.usage!.inputTokens, 5);
    assert.deepEqual(rec.of('message.completed').map((m) => m.text), ['Recovered answer']);
    assert.equal(rec.of('tool.completed')[0]!.toolId, 'call_x');
    await until(() => fake.streamCount > 0, 5000, 'stream reconnected');
    await s.stop();
  });
});

describe('real 2.0.25 capture replay', () => {
  test('permission turn, interrupt, failure and subagent map cleanly', async () => {
    const { s, rec } = await start();
    const run = async (turnId: string) => {
      const n = rec.of('turn.completed').length;
      await s.send(turnId, [{ type: 'text', text: 'scenario:replay' }]);
      await until(() => rec.of('turn.completed').length > n, 5000, `${turnId} completion`);
      return rec.of('turn.completed')[n]!;
    };
    const t1 = await run('t_r1');
    assert.equal(t1.stopReason, 'end_turn');
    assert.equal(t1.usage!.inputTokens, 6922 + 10848 + 11084 + 11222);
    assert.deepEqual(
      rec.of('approval.requested').map((a) => [a.kind, a.title]),
      [
        ['edit', 'Edit hello.txt'],
        ['shell', 'Run echo bizzi-hello'],
        ['edit', 'Edit hello.txt'],
      ],
    );
    assert.deepEqual(rec.of('approval.resolved').map((a) => a.decision), ['allow', 'deny', 'allow_always']);
    const tools = rec.of('tool.completed');
    assert.deepEqual(tools.map((t) => t.status), ['ok', 'denied', 'ok', 'ok']);
    assert.equal(tools[0]!.output, 'bizzi-hello\n');
    const [changed] = rec.of('file.changed');
    assert.equal(changed!.path, `${cwd}/hello.txt`, 'permission metadata paths are relative to the session directory');
    assert.equal(changed!.change, 'created');
    assert.match(changed!.diff!, /\+hi/);
    assert.match(rec.of('message.completed').at(-1)!.text, /DONE/);

    const t2 = await run('t_r2');
    assert.equal(t2.stopReason, 'interrupted');

    const t3 = await run('t_r3');
    assert.equal(t3.stopReason, 'error');
    assert.equal(t3.error, 'Model unavailable: nope/bogus');

    const t4 = await run('t_r4');
    assert.equal(t4.stopReason, 'end_turn');
    const sub = rec.of('subagent.started').at(-1)!;
    assert.equal(sub.name, 'general');
    assert.equal(sub.parentToolId, 'chatcmpl-tool-9b001958aa778837');
    assert.deepEqual(rec.of('subagent.completed').at(-1), { subagentId: sub.subagentId, status: 'ok' });
    const childRead = rec.of('tool.started').find((t) => t.toolId === 'chatcmpl-tool-ab1231e49c53d225')!;
    assert.equal(childRead.parentToolId, 'chatcmpl-tool-9b001958aa778837');
    // deltas concatenate to their completed message
    for (const m of rec.of('message.completed')) {
      const joined = rec.of('message.delta').filter((d) => d.messageId === m.messageId).map((d) => d.text).join('');
      if (joined) assert.equal(joined, m.text);
    }
    await s.stop();
  });
});
