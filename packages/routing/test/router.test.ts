import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MachineInfo, SessionInfo, WorkspaceInfo } from '@bizzi/protocol';
import { Router, buildTargets, confidence, parseExplicit, remoteScorers, routerOptionsFromEnv, scoreOptions, type LogprobBackend } from '../src/index.ts';

function machine(id: string, name: string, over: Partial<MachineInfo> = {}): MachineInfo {
  return {
    id,
    name,
    hostname: `${name}.local`,
    os: 'darwin',
    arch: 'arm64',
    headful: false,
    alwaysOn: false,
    tags: [],
    online: true,
    roles: ['node'],
    bizziVersion: '0.0.0',
    ...over,
  };
}
function workspace(id: string, machineId: string, name: string, over: Partial<WorkspaceInfo> = {}): WorkspaceInfo {
  return { id, machineId, name, path: `/src/${name}`, kind: 'git', createdAt: '2026-11-01T00:00:00.000Z', ...over };
}
function session(workspaceId: string, updatedAt: string, over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: `s_${workspaceId}_${updatedAt}`,
    machineId: 'm',
    workspaceId,
    agent: 'claude',
    mode: 'structured',
    status: 'idle',
    createdAt: updatedAt,
    updatedAt,
    lastSeq: 0,
    ...over,
  };
}

const LAPTOP = machine('m_L', 'laptop', { tags: ['prod-access'], description: 'Work laptop with VPN and kube contexts.' });
const MINI = machine('m_M', 'mac-mini', { tags: ['gui'], headful: true });
const VPS = machine('m_V', 'vps', { alwaysOn: true, online: false });
const WS = [
  workspace('w_1', 'm_L', 'acme-shop'),
  workspace('w_2', 'm_M', 'acme-shop'),
  workspace('w_3', 'm_L', 'bizzi'),
  workspace('w_4', 'm_V', 'infra'),
  workspace('w_5', 'm_L', 'bizzi-wt', { kind: 'worktree', branch: 'fix' }),
];
const INPUT = { machines: [LAPTOP, MINI, VPS], workspaces: WS, sessions: [session('w_3', '2026-11-20T00:00:00.000Z'), session('w_2', '2026-11-10T00:00:00.000Z')] };

/** A fetch that answers chat completions with the given letter probabilities and records each request. */
function fakeBackend(letters: Record<string, number>, over: Partial<LogprobBackend> = {}) {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    const top = Object.entries(letters).map(([token, p]) => ({ token, logprob: Math.log(p) }));
    return new Response(JSON.stringify({ choices: [{ logprobs: { content: [{ token: top[0]?.token, top_logprobs: top }] } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const backend: LogprobBackend = { url: 'https://llm.example/v1/', model: 'vllm/qwen', apiKey: 'sk-test', body: { chat_template_kwargs: { enable_thinking: false } }, fetch: f, ...over };
  return { backend, calls };
}

test('targets: online machines only, no worktrees, most recently active first, described for the classifier', () => {
  const t = buildTargets(INPUT);
  assert.deepEqual(
    t.map((x) => x.label),
    ['laptop · bizzi', 'mac-mini · acme-shop', 'laptop · acme-shop'],
  );
  assert.equal(t[2]!.detail, 'laptop · acme-shop: tags prod-access; Work laptop with VPN and kube contexts.; folder /src/acme-shop');
  assert.equal(t[1]!.detail, 'mac-mini · acme-shop: tags gui; has a GUI; folder /src/acme-shop');
});

test('targets: recent session titles describe a workspace (newest first, at most three, no helpers)', () => {
  const sessions = [
    session('w_2', '2026-11-01T00:00:00.000Z', { title: 'Cart layout on iPhone SE' }),
    session('w_2', '2026-11-03T00:00:00.000Z', { title: 'Simulator screenshots for the PR' }),
    session('w_2', '2026-11-04T00:00:00.000Z', { title: 'Helper: review', spawnedBy: 's_x' }),
    session('w_2', '2026-11-02T00:00:00.000Z', { title: 'Safari  flexbox\nbug' }),
    session('w_2', '2026-10-01T00:00:00.000Z', { title: 'Oldest' }),
  ];
  const t = buildTargets({ machines: [MINI], workspaces: [WS[1]!], sessions });
  assert.equal(
    t[0]!.detail,
    'mac-mini · acme-shop: tags gui; has a GUI; folder /src/acme-shop; recent work: "Simulator screenshots for the PR", "Safari flexbox bug", "Cart layout on iPhone SE"',
  );
});

test('explicit tokens: @machine, #workspace, /agent; unknown tokens stay in the text', () => {
  const all = buildTargets(INPUT);
  const a = parseExplicit('@Mac-Mini fix the cart page /codex', all);
  assert.deepEqual([a.targets.map((t) => t.label), a.narrowed, a.agent, a.text], [['mac-mini · acme-shop'], true, 'codex', 'fix the cart page']);
  const b = parseExplicit('#acme-shop flaky test, see #123 and /usr/bin, mail me@x.io', all);
  assert.deepEqual(b.targets.map((t) => t.label), ['mac-mini · acme-shop', 'laptop · acme-shop']);
  assert.equal(b.text, 'flaky test, see #123 and /usr/bin, mail me@x.io');
  assert.equal(parseExplicit('@laptop.local #bizzi', all).targets[0]!.label, 'laptop · bizzi', 'hostname works too');
  assert.equal(parseExplicit('@nowhere hi', all).narrowed, false);
});

test('explicit tokens combine, survive trailing punctuation, and stop on conflicts and offline machines', () => {
  const all = buildTargets(INPUT, { includeOffline: true });
  const parse = (text: string) => parseExplicit(text, all, INPUT.machines);
  for (const text of ['@mac-mini #acme-shop fix cart', '#acme-shop @mac-mini fix cart']) {
    const r = parse(text);
    assert.deepEqual([r.targets.map((t) => t.label), r.text, r.problem], [['mac-mini · acme-shop'], 'fix cart', undefined], text);
  }
  const dot = parse('fix the cart on @mac-mini.');
  assert.deepEqual([dot.targets.map((t) => t.label), dot.text], [['mac-mini · acme-shop'], 'fix the cart on.']);
  assert.equal(parse('(see #bizzi)').targets[0]?.label, 'laptop · bizzi');

  const conflict = parse('@mac-mini #bizzi fix it');
  assert.deepEqual([conflict.targets, conflict.problem, conflict.text], [[], 'no workspace matches @mac-mini and #bizzi', 'fix it']);
  assert.equal(parse('@laptop @mac-mini hi').problem, 'no workspace matches @laptop and @mac-mini');

  const off = parse('@vps restart nginx');
  assert.deepEqual([off.targets, off.problem, off.text], [[], 'vps is offline', 'restart nginx']);
  assert.equal(parse('#infra bump the chart').problem, '#infra is only on vps, which is offline');
  assert.equal(parseExplicit('@vps hi', all, [...INPUT.machines, machine('m_E', 'empty')]).problem, 'vps is offline');
  assert.equal(parseExplicit('@empty hi', all, [...INPUT.machines, machine('m_E', 'empty')]).problem, 'empty has no workspaces');
});

test('Router: a token that leaves several targets asks the user; problems come back as none with the reason', async () => {
  const off = await new Router().suggest('#acme-shop flaky test', INPUT);
  assert.deepEqual([off.source, off.confident, off.note], ['explicit', false, '#acme-shop matches 2 workspaces']);
  assert.deepEqual(off.candidates.map((c) => [c.label, c.probability]), [
    ['mac-mini · acme-shop', 0.5],
    ['laptop · acme-shop', 0.5],
  ]);

  const { backend } = fakeBackend({ B: 0.95, A: 0.05 });
  const scored = await new Router({ backend }).suggest('#acme-shop needs a GUI', INPUT);
  assert.deepEqual([scored.source, scored.candidates[0]?.label, scored.offered], ['classifier', 'laptop · acme-shop', 2]);

  const failing = new Router({ backend: { ...backend, fetch: (async () => new Response('nope', { status: 502 })) as unknown as typeof fetch } });
  const f = await failing.suggest('#acme-shop flaky test', INPUT);
  assert.deepEqual([f.source, f.confident, f.candidates.length], ['explicit', false, 2]);
  assert.match(f.note ?? '', /^#acme-shop matches 2 workspaces; routing classifier answered 502/);

  const problems: [string, string][] = [
    ['@vps restart nginx', 'vps is offline'],
    ['@mac-mini #bizzi fix it', 'no workspace matches @mac-mini and #bizzi'],
  ];
  for (const [text, note] of problems) {
    const s = await new Router({ backend }).suggest(text, INPUT);
    assert.deepEqual([s.source, s.candidates, s.note], ['none', [], note], text);
  }
});

test('confidence is 1 - entropy/ln(N)', () => {
  assert.equal(confidence([1, 0, 0]), 1);
  assert.equal(Math.round(confidence([1, 1, 1, 1]) * 1000), 0);
  // The earlier H200 check: 0.83 / 0.16 over six options read as 0.73 (the exact tail wasn't recorded).
  const c = confidence([0.83, 0.16, 0.01, 0, 0, 0]);
  assert.ok(c > 0.71 && c < 0.74, String(c));
});

test('scoreOptions: request shape and letter probabilities from top_logprobs', async () => {
  const { backend, calls } = fakeBackend({ B: 0.9, ' A': 0.05, '**': 0.04, C: 0.01 });
  const r = await scoreOptions(backend, 'cart page broken', ['first', 'second', 'third']);
  const [call] = calls;
  assert.equal(call!.url, 'https://llm.example/v1/chat/completions');
  assert.equal(call!.headers.authorization, 'Bearer sk-test');
  assert.deepEqual(
    [call!.body.model, call!.body.max_tokens, call!.body.logprobs, call!.body.top_logprobs, call!.body.chat_template_kwargs],
    ['vllm/qwen', 1, true, 20, { enable_thinking: false }],
  );
  assert.match(call!.body.messages[0].content, /A\. first\nB\. second\nC\. third/);
  assert.equal(r.letterMass.toFixed(2), '0.96');
  assert.deepEqual(r.probabilities.map((p) => p.toFixed(3)), ['0.052', '0.938', '0.010']);
});

test('Router: classifier ranks, caps at the option limit, and sets confident from the threshold', async () => {
  const { backend, calls } = fakeBackend({ C: 0.97, B: 0.03 });
  const router = new Router({ backend: { ...backend, maxOptions: 3 }, threshold: 0.8 });
  const s = await router.suggest('why are checkout 502s up in prod? /claude', INPUT);
  assert.equal(s.source, 'classifier');
  assert.deepEqual(s.candidates.map((c) => [c.label, c.probability]), [
    ['laptop · acme-shop', 0.97],
    ['mac-mini · acme-shop', 0.03],
    ['laptop · bizzi', 0],
  ]);
  assert.equal(s.confident, true);
  assert.equal(s.agent, 'claude');
  assert.equal(s.offered, 3);
  assert.equal(s.classifier?.model, 'vllm/qwen');
  assert.match(calls[0]!.body.messages[1].content, /Request: why are checkout 502s up in prod\?\n/);

  const unsure = await new Router({ backend: fakeBackend({ A: 0.55, B: 0.45 }).backend }).suggest('fix the flaky test', INPUT);
  assert.equal(unsure.confident, false);
});

test('Router: explicit and single targets skip the classifier; failures fall back to none with a note', async () => {
  const { backend, calls } = fakeBackend({ A: 1 });
  const router = new Router({ backend });
  const ex = await router.suggest('#bizzi resize handle jitters', INPUT);
  assert.deepEqual([ex.source, ex.candidates[0]?.workspaceId, ex.confidence, ex.text], ['explicit', 'w_3', 1, 'resize handle jitters']);
  const single = await router.suggest('anything', { machines: [LAPTOP], workspaces: [WS[0]!] });
  assert.equal(single.source, 'single');
  assert.equal(calls.length, 0);

  const off = await new Router().suggest('hello', INPUT);
  assert.deepEqual([off.source, off.note, off.offered], ['none', 'no routing classifier configured', 3]);

  const broken = new Router({ backend: { ...backend, fetch: (async () => new Response('nope', { status: 502 })) as unknown as typeof fetch } });
  const b = await broken.suggest('hello', INPUT);
  assert.equal(b.source, 'none');
  assert.match(b.note ?? '', /answered 502/);

  const noLogprobs = new Router({
    backend: { ...backend, fetch: (async () => new Response(JSON.stringify({ choices: [{ message: { content: 'A' } }] }))) as unknown as typeof fetch },
  });
  assert.match((await noLogprobs.suggest('hello', INPUT)).note ?? '', /no logprobs/);
  await assert.rejects(router.suggest('  ', INPUT), /text is required/);
});

test('routerOptionsFromEnv', () => {
  assert.deepEqual(routerOptionsFromEnv({}), {});
  assert.deepEqual(
    routerOptionsFromEnv({
      BIZZI_ROUTER_URL: 'https://h200/v1',
      BIZZI_ROUTER_MODEL: 'vllm/qwen3.8-27b',
      BIZZI_ROUTER_API_KEY: 'k',
      BIZZI_ROUTER_BODY: '{"chat_template_kwargs":{"enable_thinking":false}}',
      BIZZI_ROUTER_THRESHOLD: '0.7',
    }),
    {
      threshold: 0.7,
      backend: { url: 'https://h200/v1', model: 'vllm/qwen3.8-27b', apiKey: 'k', body: { chat_template_kwargs: { enable_thinking: false } } },
    },
  );
  assert.throws(() => routerOptionsFromEnv({ BIZZI_ROUTER_URL: 'x' }), /BIZZI_ROUTER_MODEL/);
  assert.throws(() => routerOptionsFromEnv({ BIZZI_ROUTER_URL: 'x', BIZZI_ROUTER_MODEL: 'm', BIZZI_ROUTER_BODY: '[1]' }), /JSON object/);
  assert.throws(() => routerOptionsFromEnv({ BIZZI_ROUTER_THRESHOLD: '2' }), /between 0 and 1/);
});

test('remoteScorers: online machines with a classifier, the preferred one first, then always-on; results are checked', async () => {
  const withRouting = (m: MachineInfo, maxOptions = 20) => ({ ...m, routing: { model: `${m.name}-qwen`, maxOptions } });
  const calls: string[] = [];
  const call = async (machineId: string, p: { options: string[] }) => {
    calls.push(machineId);
    if (machineId === 'm_bad') return { probabilities: [1], letterMass: 1, ms: 1 };
    return { probabilities: p.options.map(() => 1 / p.options.length), letterMass: 0.99, ms: 1 };
  };
  const machines = [
    withRouting(machine('m_L', 'laptop')),
    withRouting(machine('m_V', 'vps', { alwaysOn: true })),
    withRouting(machine('m_O', 'old', { online: false })),
    machine('m_M', 'mac-mini'),
    withRouting(machine('m_bad', 'zz-bad'), 4),
  ];
  assert.deepEqual(remoteScorers(machines, call).map((s) => s.via), ['m_V', 'm_L', 'm_bad']);
  assert.deepEqual(remoteScorers(machines, call, 'LAPTOP.local').map((s) => s.via), ['m_L', 'm_V', 'm_bad']);
  const [bad] = remoteScorers(machines, call, 'zz-bad');
  assert.deepEqual([bad!.model, bad!.limit], ['zz-bad-qwen', 4]);
  await assert.rejects(bad!.score('x', ['a', 'b']), /zz-bad returned a malformed route.score result/);

  // The router tries at most two, in order, and reports which machine answered.
  calls.length = 0;
  const router = new Router();
  const s = await router.suggest('hello', INPUT, { remote: remoteScorers(machines, call, 'zz-bad') });
  assert.deepEqual([s.source, s.classifier?.via, s.classifier?.model], ['classifier', 'm_V', 'vps-qwen']);
  assert.deepEqual(calls, ['m_bad', 'm_V']);
  assert.deepEqual(routerOptionsFromEnv({ BIZZI_ROUTER_VIA: ' lab-box ' }), { via: 'lab-box' });
});
