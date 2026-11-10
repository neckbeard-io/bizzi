// A scripted stand-in for `codex app-server`, spawned with `node fake-app-server.ts app-server`.
// The first word of the turn's input text selects the script:
//   stream   — full streaming turn (reasoning, message, plan, command, file change, usage)
//   early    — like stream, but notifications precede the turn/start response
//   approve  — command needing approval; outcome depends on the client's decision
//   hang     — streams a delta, then waits for turn/interrupt or turn/steer
//   crash    — the process dies mid-turn
//   ask      — item/tool/requestUserInput; the reply is echoed as a message delta
//   askauto  — item/tool/requestUserInput withdrawn by the server (serverRequest/resolved)
//   elicit   — mcpServer/elicitation/request (form); the reply is echoed as a message delta
//   compact  — usage, a context compaction (item + legacy notification), smaller usage, a rate-limit update
// FAKE_AUTH=chatgpt: a ChatGPT login with rate limits. FAKE_COMPACT_LIMIT: config's auto-compact limit.
// Token usage grows with each turn (usage(100 * turn number)).
// Every client message is echoed back as a `fake/received` notification so tests can inspect params.

import { createInterface } from 'node:readline';

const THREAD = 'thr_fake_1';
const FORK = 'thr_fork_1';
let thread = THREAD;
const interrupted = new Set<string>();
type Msg = { id?: string | number; method?: string; params?: any; result?: any; error?: any };

if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.0.0-fake\n');
  process.exit(0);
}
if (!process.argv.includes('app-server')) {
  process.stderr.write('usage: fake-app-server app-server\n');
  process.exit(2);
}

let nextServerReqId = 1000;
let turnSeq = 0;
let activeTurn: string | undefined;
const waiting = new Map<string | number, (m: Msg) => void>();

function send(m: Msg): void {
  process.stdout.write(JSON.stringify(m) + '\n');
}
function notify(method: string, params: unknown): void {
  send({ method, params });
}
function serverRequest(method: string, params: unknown): Promise<Msg> {
  const id = nextServerReqId++;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    send({ id, method, params });
  });
}
const tick = () => new Promise((r) => setTimeout(r, 5));

function turnObj(id: string, status: string, error: unknown = null) {
  return { id, rootTurnId: id, items: [], itemsView: 'full', status, error, startedAt: 0, completedAt: null, durationMs: null };
}

function threadObj(id: string) {
  return {
    id,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    preview: '',
    ephemeral: false,
    modelProvider: 'openai',
    model: 'gpt-fake',
    reasoningEffort: null,
    createdAt: 0,
    updatedAt: 0,
    status: { type: 'idle' },
    path: null,
    cwd: '/tmp',
    cliVersion: '0.0.0-fake',
    source: 'vscode',
    name: null,
    turns: [],
  };
}

function threadResponse(id: string, params: any) {
  const sandboxMode = params?.sandbox ?? 'read-only';
  const sandbox =
    sandboxMode === 'workspace-write'
      ? { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
      : sandboxMode === 'danger-full-access'
        ? { type: 'dangerFullAccess' }
        : { type: 'readOnly', networkAccess: false };
  return {
    thread: threadObj(id),
    model: params?.model ?? 'gpt-fake',
    modelProvider: 'openai',
    serviceTier: null,
    disabledPluginIds: [],
    cwd: params?.cwd ?? '/tmp',
    instructionSources: [],
    approvalPolicy: params?.approvalPolicy ?? 'on-request',
    approvalsReviewer: 'user',
    sandbox,
    reasoningEffort: params?.config?.model_reasoning_effort ?? null,
  };
}

function rateSnapshot(over: Record<string, unknown> = {}) {
  return {
    limitId: 'codex',
    limitName: null,
    normalModelSlug: null,
    primary: null,
    secondary: null,
    credits: null,
    individualLimit: null,
    spendControlReached: null,
    planType: 'pro',
    rateLimitReachedType: null,
    ...over,
  };
}

const usage = (n: number) => ({
  total: { totalTokens: n * 3, inputTokens: n * 2, cachedInputTokens: n, cacheWriteInputTokens: 0, outputTokens: n, reasoningOutputTokens: 0 },
  last: { totalTokens: n, inputTokens: n, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
  modelContextWindow: 200000,
});

async function streamBody(turnId: string): Promise<void> {
  const base = { threadId: thread, turnId };
  notify('turn/started', { threadId: thread, turn: turnObj(turnId, 'inProgress') });
  notify('item/started', { ...base, startedAtMs: 0, item: { type: 'reasoning', id: 'rs_1', summary: [], content: [] } });
  notify('item/reasoning/summaryTextDelta', { ...base, itemId: 'rs_1', delta: 'Thinking', summaryIndex: 0 });
  notify('item/completed', { ...base, completedAtMs: 0, item: { type: 'reasoning', id: 'rs_1', summary: ['Thinking'], content: [] } });
  notify('item/started', {
    ...base,
    startedAtMs: 0,
    item: { type: 'agentMessage', id: 'msg_1', text: '', phase: null, memoryCitation: null, delivery: null, questions: null },
  });
  notify('item/agentMessage/delta', { ...base, itemId: 'msg_1', delta: 'Hel' });
  notify('item/agentMessage/delta', { ...base, itemId: 'msg_1', delta: 'lo' });
  notify('item/completed', {
    ...base,
    completedAtMs: 0,
    item: { type: 'agentMessage', id: 'msg_1', text: 'Hello', phase: null, memoryCitation: null, delivery: null, questions: null },
  });
  notify('turn/plan/updated', {
    ...base,
    explanation: null,
    plan: [
      { step: 'look', status: 'completed' },
      { step: 'fix', status: 'inProgress' },
      { step: 'test', status: 'pending' },
    ],
  });
  const cmd = {
    type: 'commandExecution',
    id: 'call_cmd',
    pluginId: null,
    scriptPath: null,
    command: 'ls -la',
    cwd: '/tmp',
    processId: null,
    source: 'agent',
    status: 'inProgress',
    commandActions: [],
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null,
  };
  notify('item/started', { ...base, startedAtMs: 0, item: cmd });
  notify('item/commandExecution/outputDelta', { ...base, itemId: 'call_cmd', delta: 'file-a\n' });
  notify('item/completed', { ...base, completedAtMs: 0, item: { ...cmd, status: 'completed', aggregatedOutput: 'file-a\n', exitCode: 0 } });
  const fc = {
    type: 'fileChange',
    id: 'call_patch',
    changes: [
      { path: '/tmp/a.txt', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-a\n+b\n' },
      { path: '/tmp/new.txt', kind: { type: 'add' }, diff: '+new\n' },
    ],
    status: 'inProgress',
  };
  notify('item/started', { ...base, startedAtMs: 0, item: fc });
  notify('item/completed', { ...base, completedAtMs: 0, item: { ...fc, status: 'completed' } });
  notify('thread/tokenUsage/updated', { ...base, tokenUsage: usage(100 * turnSeq) });
  notify('some/unknown', { ...base, foo: 1 });
  notify('turn/completed', { threadId: thread, turn: turnObj(turnId, 'completed') });
}

async function handle(m: Msg): Promise<void> {
  if (m.id !== undefined && m.method === undefined) {
    const w = waiting.get(m.id);
    waiting.delete(m.id);
    w?.(m);
    return;
  }
  notify('fake/received', { method: m.method, params: m.params ?? null });
  if (m.id === undefined) return; // client notification (initialized)
  const id = m.id;
  switch (m.method) {
    case 'initialize':
      return send({ id, result: { userAgent: 'fake', codexHome: '/tmp/fake', platformFamily: 'unix', platformOs: 'macos' } });
    case 'account/read':
      if (process.env.FAKE_AUTH === 'chatgpt') {
        return send({
          id,
          result: {
            account: { type: 'chatgpt', email: 'dev@example.com', planType: 'pro', workspaceName: null },
            requiresOpenaiAuth: true,
          },
        });
      }
      return send({ id, result: { account: null, requiresOpenaiAuth: true } });
    case 'account/rateLimits/read':
      if (process.env.FAKE_AUTH !== 'chatgpt') return send({ id, error: { code: -32600, message: 'not a chatgpt login' } });
      return send({
        id,
        result: {
          ordinaryUsageAllowed: true,
          rateLimits: rateSnapshot({ primary: { usedPercent: 18, windowDurationMins: 300, resetsAt: 4102444800 }, secondary: { usedPercent: 31.5, windowDurationMins: 10080, resetsAt: 4103049600 } }),
          rateLimitsByLimitId: null,
          rateLimitResetCredits: null,
          accountId: 'acct_fake',
          rateLimitUpsell: null,
        },
      });
    case 'config/read':
      if (!process.env.FAKE_COMPACT_LIMIT) return send({ id, error: { code: -32601, message: 'method not found: config/read' } });
      return send({ id, result: { config: { model_auto_compact_token_limit: Number(process.env.FAKE_COMPACT_LIMIT) }, origins: {}, layers: null } });
    case 'mcpServerStatus/list':
      return send({
        id,
        result: {
          data: [
            { name: 'bizzi_mem', tools: { recall: { name: 'recall', description: 'd'.repeat(400), inputSchema: { type: 'object' } } } },
            { name: 'other', tools: { big: { name: 'big', description: 'x'.repeat(40000), inputSchema: {} } } },
          ],
          nextCursor: null,
        },
      });
    case 'thread/start':
      return send({ id, result: threadResponse(THREAD, m.params) });
    case 'thread/resume':
      if (m.params?.threadId !== THREAD) {
        return send({ id, error: { code: -32600, message: `no rollout found for thread id ${m.params?.threadId}` } });
      }
      return send({ id, result: threadResponse(THREAD, m.params) });
    case 'thread/fork':
      if (m.params?.threadId !== THREAD) {
        return send({ id, error: { code: -32600, message: `no rollout found for thread id ${m.params?.threadId}` } });
      }
      thread = FORK;
      return send({ id, result: { ...threadResponse(FORK, m.params), thread: { ...threadObj(FORK), forkedFromId: THREAD } } });
    case 'turn/start': {
      const turnId = `turn_${++turnSeq}`;
      activeTurn = turnId;
      const text: string = m.params?.input?.[0]?.text ?? '';
      const script = text.split(/\s+/)[0];
      const base = { threadId: thread, turnId };
      switch (script) {
        case 'early':
          await streamBody(turnId);
          await tick();
          return send({ id, result: { turn: turnObj(turnId, 'inProgress') } });
        case 'approve': {
          send({ id, result: { turn: turnObj(turnId, 'inProgress') } });
          notify('turn/started', { threadId: thread, turn: turnObj(turnId, 'inProgress') });
          const cmd = {
            type: 'commandExecution',
            id: 'call_rm',
            pluginId: null,
            scriptPath: null,
            command: 'rm -rf build',
            cwd: '/tmp',
            processId: null,
            source: 'agent',
            status: 'inProgress',
            commandActions: [],
            aggregatedOutput: null,
            exitCode: null,
            durationMs: null,
          };
          notify('item/started', { ...base, startedAtMs: 0, item: cmd });
          const reply = await serverRequest('item/commandExecution/requestApproval', {
            kind: 'command',
            ...base,
            itemId: 'call_rm',
            startedAtMs: 0,
            environmentId: null,
            reason: 'needs write access',
            command: 'rm -rf build',
            cwd: '/tmp',
          });
          const decision = reply.result?.decision;
          notify('serverRequest/resolved', { threadId: thread, requestId: nextServerReqId - 1 });
          const accepted = decision === 'accept' || decision === 'acceptForSession';
          notify('item/completed', {
            ...base,
            completedAtMs: 0,
            item: { ...cmd, status: accepted ? 'completed' : 'declined', exitCode: accepted ? 0 : null, aggregatedOutput: accepted ? '' : null },
          });
          notify('item/agentMessage/delta', { ...base, itemId: 'msg_d', delta: `decision:${JSON.stringify(decision)}` });
          notify('turn/completed', { threadId: thread, turn: turnObj(turnId, 'completed') });
          return;
        }
        case 'ask':
        case 'askauto': {
          send({ id, result: { turn: turnObj(turnId, 'inProgress') } });
          notify('turn/started', { threadId: thread, turn: turnObj(turnId, 'inProgress') });
          const params = {
            ...base,
            itemId: 'call_ask',
            isBlocking: script === 'ask',
            autoResolutionMs: null,
            questions: [
              {
                id: 'q_db',
                header: 'Database',
                question: 'Which database?',
                isOther: false,
                isSecret: false,
                options: [
                  { label: 'Postgres', description: 'server' },
                  { label: 'SQLite', description: '' },
                ],
              },
              { id: 'q_name', header: 'Name', question: 'Project name?', isOther: true, isSecret: false, options: null },
            ],
          };
          if (script === 'askauto') {
            const reqId = nextServerReqId;
            void serverRequest('item/tool/requestUserInput', params);
            await tick();
            notify('serverRequest/resolved', { threadId: thread, requestId: reqId });
            await tick();
            notify('turn/completed', { threadId: thread, turn: turnObj(turnId, 'completed') });
            return;
          }
          const reply = await serverRequest('item/tool/requestUserInput', params);
          await tick();
          if (interrupted.has(turnId)) return;
          notify('item/agentMessage/delta', { ...base, itemId: 'msg_q', delta: `reply:${JSON.stringify(reply.result)}` });
          notify('turn/completed', { threadId: thread, turn: turnObj(turnId, 'completed') });
          return;
        }
        case 'elicit': {
          send({ id, result: { turn: turnObj(turnId, 'inProgress') } });
          notify('turn/started', { threadId: thread, turn: turnObj(turnId, 'inProgress') });
          const reply = await serverRequest('mcpServer/elicitation/request', {
            threadId: thread,
            turnId,
            serverName: 'deploy',
            mode: 'form',
            _meta: null,
            message: 'Deployment settings',
            requestedSchema: {
              type: 'object',
              properties: {
                env: { type: 'string', title: 'Environment', oneOf: [{ const: 'prod', title: 'Production' }, { const: 'stg', title: 'Staging' }] },
                replicas: { type: 'integer', title: 'Replicas', description: 'How many replicas?' },
                confirm: { type: 'boolean', title: 'Confirm' },
                regions: { type: 'array', title: 'Regions', items: { type: 'string', enum: ['us', 'eu'] } },
                note: { type: 'string', title: 'Note' },
              },
              required: ['env', 'replicas'],
            },
          });
          await tick();
          if (interrupted.has(turnId)) return;
          notify('item/agentMessage/delta', { ...base, itemId: 'msg_e', delta: `reply:${JSON.stringify(reply.result)}` });
          notify('turn/completed', { threadId: thread, turn: turnObj(turnId, 'completed') });
          return;
        }
        case 'compact': {
          send({ id, result: { turn: turnObj(turnId, 'inProgress') } });
          notify('turn/started', { threadId: thread, turn: turnObj(turnId, 'inProgress') });
          notify('thread/tokenUsage/updated', { ...base, tokenUsage: usage(150000) });
          notify('item/started', { ...base, startedAtMs: 0, item: { type: 'contextCompaction', id: 'cc_1' } });
          notify('item/completed', { ...base, completedAtMs: 0, item: { type: 'contextCompaction', id: 'cc_1' } });
          notify('thread/compacted', { threadId: thread, turnId });
          notify('thread/tokenUsage/updated', { ...base, tokenUsage: { ...usage(150000), last: { ...usage(9000).last } } });
          notify('account/rateLimits/updated', { rateLimits: rateSnapshot({ primary: { usedPercent: 85, windowDurationMins: 300, resetsAt: 4102444800 }, planType: null }) });
          notify('turn/completed', { threadId: thread, turn: turnObj(turnId, 'completed') });
          return;
        }
        case 'hang':
          send({ id, result: { turn: turnObj(turnId, 'inProgress') } });
          notify('turn/started', { threadId: thread, turn: turnObj(turnId, 'inProgress') });
          notify('item/agentMessage/delta', { ...base, itemId: 'msg_h', delta: 'working' });
          return;
        case 'lateask':
          // The turn ends first; an MCP elicitation arrives between turns.
          send({ id, result: { turn: turnObj(turnId, 'inProgress') } });
          notify('turn/completed', { threadId: thread, turn: turnObj(turnId, 'completed') });
          await tick();
          await serverRequest('mcpServer/elicitation/request', {
            threadId: thread,
            turnId: null,
            serverName: 'late',
            mode: 'form',
            _meta: null,
            message: 'Proceed?',
            requestedSchema: { type: 'object', properties: {} },
          });
          return;
        case 'askcrash':
          send({ id, result: { turn: turnObj(turnId, 'inProgress') } });
          void serverRequest('item/tool/requestUserInput', {
            ...base,
            itemId: 'call_ask',
            isBlocking: true,
            autoResolutionMs: null,
            questions: [{ id: 'q', header: 'Q', question: 'Continue?', isOther: true, isSecret: false, options: null }],
          });
          setTimeout(() => process.exit(3), 50);
          return;
        case 'crash':
          send({ id, result: { turn: turnObj(turnId, 'inProgress') } });
          notify('turn/started', { threadId: thread, turn: turnObj(turnId, 'inProgress') });
          await tick();
          process.stderr.write('\u001b[31mERROR\u001b[0m boom: simulated crash\n');
          setTimeout(() => process.exit(3), 10);
          return;
        default:
          send({ id, result: { turn: turnObj(turnId, 'inProgress') } });
          await tick();
          await streamBody(turnId);
          return;
      }
    }
    case 'turn/steer': {
      if (m.params?.expectedTurnId !== activeTurn) {
        return send({ id, error: { code: -32600, message: 'expectedTurnId does not match active turn' } });
      }
      send({ id, result: { turnId: activeTurn } });
      const base = { threadId: thread, turnId: activeTurn };
      notify('item/agentMessage/delta', { ...base, itemId: 'msg_h', delta: ` steered:${m.params.input?.[0]?.text}` });
      notify('turn/completed', { threadId: thread, turn: turnObj(activeTurn as string, 'completed') });
      return;
    }
    case 'turn/interrupt':
      interrupted.add(m.params.turnId);
      send({ id, result: {} });
      notify('turn/completed', { threadId: thread, turn: turnObj(m.params.turnId, 'interrupted') });
      return;
    default:
      return send({ id, error: { code: -32601, message: `method not found: ${m.method}` } });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  void handle(JSON.parse(line) as Msg);
});
rl.on('close', () => process.exit(0));
