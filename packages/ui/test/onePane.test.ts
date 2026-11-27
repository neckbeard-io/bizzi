import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentListing, MachineInfo, RouteSuggestion, SessionInfo, WorkspaceInfo } from '@bizzi/protocol';
import {
  applyCompletion,
  chooseAgent,
  completions,
  continues,
  decisionFor,
  machineToken,
  otherTargets,
  parseRuleWords,
  parseTokens,
  planRoute,
  routeReason,
  tokenAt,
} from '../src/lib/onePane.ts';
import type { CompletionInput } from '../src/lib/onePane.ts';
import { parseHash, routeHref } from '../src/lib/router.ts';

function machine(id: string, name: string, over: Partial<MachineInfo> = {}): MachineInfo {
  return { id, name, hostname: `${name.replace(/\s+/g, '-')}.local`, os: 'darwin', arch: 'arm64', headful: false, alwaysOn: false, tags: [], online: true, roles: ['node'], bizziVersion: '0', ...over };
}
function ws(id: string, machineId: string, name: string, over: Partial<WorkspaceInfo> = {}): WorkspaceInfo {
  return { id, machineId, name, path: `/src/${name}`, kind: 'git', createdAt: '2026-11-01T00:00:00Z', ...over };
}
function agent(kind: AgentListing['agent'], over: Partial<AgentListing> = {}): AgentListing {
  return { agent: kind, installed: true, auth: 'ok', ...over };
}
function session(over: Partial<SessionInfo> = {}): SessionInfo {
  return { id: 's_1', machineId: 'm_L', workspaceId: 'w_shopL', agent: 'claude', mode: 'structured', status: 'idle', createdAt: '2026-11-20T00:00:00Z', updatedAt: '2026-11-20T00:00:00Z', lastSeq: 1, ...over };
}

const LAPTOP = machine('m_L', 'laptop', { tags: ['prod-access'] });
const MINI = machine('m_M', 'mac-mini', { tags: ['gui'] });
const VPS = machine('m_V', 'vps', { online: false });
const SPACED = machine('m_S', 'this laptop', { hostname: 'mbp.local' });
const WS = [
  ws('w_shopL', 'm_L', 'acme-shop'),
  ws('w_shopM', 'm_M', 'acme-shop'),
  ws('w_bizzi', 'm_L', 'bizzi'),
  ws('w_infra', 'm_V', 'infra'),
  ws('w_wt', 'm_L', 'bizzi-fix', { kind: 'worktree' }),
  ws('w_sp', 'm_L', 'my notes'),
];
const INPUT: CompletionInput = {
  machines: [LAPTOP, MINI, VPS, SPACED],
  workspaces: WS,
  agents: { m_L: [agent('claude'), agent('codex'), agent('shell')], m_M: [agent('claude'), agent('codex', { installed: false })] },
  online: (id) => id !== 'm_V',
};

const labels = (text: string, caret = text.length) => {
  const t = tokenAt(text, caret);
  assert.ok(t, `a token at ${caret} in ${JSON.stringify(text)}`);
  return completions(text, t, INPUT).map((c) => `${c.label}${c.detail ? ` (${c.detail})` : ''}${c.disabled ? ` [${c.reason}]` : ''}`);
};

test('tokenAt finds the @ # / word under the caret, and nothing else', () => {
  assert.deepEqual(tokenAt('fix @mac', 8), { sigil: '@', query: 'mac', start: 4, end: 8 });
  assert.deepEqual(tokenAt('fix #acme-shop now', 7), { sigil: '#', query: 'ac', start: 4, end: 14 });
  assert.deepEqual(tokenAt('/', 1), { sigil: '/', query: '', start: 0, end: 1 });
  assert.equal(tokenAt('fix @mac', 4), null, 'caret before the sigil');
  assert.equal(tokenAt('see /Users/dev', 14), null, 'a path is not an agent');
  assert.equal(tokenAt('mail me@x.io', 12), null, 'an address is not a machine');
  assert.equal(tokenAt('plain words', 5), null);
});

test('@ completes machines: online first, offline disabled, untypeable names disabled or written as the hostname', () => {
  assert.deepEqual(labels('@'), ['laptop (prod-access)', 'mac-mini (gui)', 'this laptop', 'vps [offline]']);
  assert.deepEqual(labels('ask @m'), ['mac-mini (gui)', 'this laptop']);
  const t = tokenAt('@mbp', 4)!;
  assert.deepEqual(completions('@mbp', t, INPUT).map((c) => c.insert), ['@mbp.local']);
  assert.equal(machineToken({ name: 'a b', hostname: 'a b' }), null);
});

test('# completes workspaces: no worktrees, duplicates show their machine, filtered by @machine', () => {
  assert.deepEqual(labels('#'), ['acme-shop (laptop)', 'acme-shop (mac-mini)', 'bizzi', 'infra [vps is offline]']);
  assert.deepEqual(labels('#shop'), ['acme-shop (laptop)', 'acme-shop (mac-mini)']);
  assert.deepEqual(labels('@mac-mini fix #'), ['acme-shop (mac-mini)']);
  assert.deepEqual(labels('#zzz'), []);
});

test('picking a duplicate workspace inserts the machine too, unless one is named already', () => {
  const text = 'fix #acme';
  const t = tokenAt(text, text.length)!;
  const [laptop, mini] = completions(text, t, INPUT);
  assert.equal(mini!.insert, '@mac-mini #acme-shop');
  assert.deepEqual(applyCompletion(text, t, mini!), { text: 'fix @mac-mini #acme-shop ', caret: 25 });
  assert.equal(laptop!.insert, '@laptop #acme-shop');
  const named = '@laptop #acme';
  const t2 = tokenAt(named, named.length)!;
  assert.equal(completions(named, t2, INPUT)[0]!.insert, '#acme-shop');
  // In the middle of the text: the whole word is replaced and the existing space reused.
  const mid = 'run #bi now';
  assert.deepEqual(applyCompletion(mid, tokenAt(mid, 7)!, { insert: '#bizzi' }), { text: 'run #bizzi now', caret: 11 });
});

test('/ completes agents installed on the target machine', () => {
  assert.deepEqual(labels('@mac-mini /'), ['claude', 'codex [not installed on mac-mini]', 'opencode [not installed on mac-mini]', 'agy [not installed on mac-mini]', 'api [not installed on mac-mini]']);
  assert.deepEqual(labels('#bizzi /c'), ['claude', 'codex', 'opencode [not installed on laptop]']);
  // No target yet: any online machine; the shell is never offered.
  assert.deepEqual(labels('/'), ['claude (laptop, mac-mini)', 'codex (laptop)', 'opencode', 'agy', 'api']);
});

test('parseTokens reads what the server would consume', () => {
  const p = parseTokens('on @Mac-Mini. #acme-shop /codex #123 me@x.io', INPUT.machines, WS);
  assert.deepEqual([p.machines.map((m) => m.id), p.workspaces, p.agent, p.any], [['m_M'], ['acme-shop'], 'codex', true]);
  assert.equal(parseTokens('fix #123 for @nobody', INPUT.machines, WS).any, false);
  const typing = 'fix @mac';
  assert.equal(parseTokens(typing, INPUT.machines, WS, tokenAt(typing, typing.length)!).any, false);
});

const sug = (over: Partial<RouteSuggestion>): RouteSuggestion => ({ source: 'classifier', candidates: [], confidence: 0, confident: false, text: 'x', offered: 2, ...over });
const A = { machineId: 'm_L', workspaceId: 'w_shopL', label: 'laptop · acme-shop', probability: 0.83 };
const B = { machineId: 'm_M', workspaceId: 'w_shopM', label: 'mac-mini · acme-shop', probability: 0.16 };

test('planRoute: confident and online sends; otherwise asks with the online candidates and a reason', () => {
  const online = INPUT.online;
  assert.deepEqual(planRoute(sug({ candidates: [A, B], confidence: 0.9, confident: true }), online), { kind: 'send', target: A });
  assert.deepEqual(planRoute(sug({ candidates: [A, B], confidence: 0.55 }), online), { kind: 'ask', choices: [A, B], note: 'not sure: 83% laptop · acme-shop, 16% mac-mini · acme-shop' });
  const note = '#acme-shop matches 2 workspaces';
  assert.deepEqual(planRoute(sug({ source: 'explicit', candidates: [A, B], note }), online), { kind: 'ask', choices: [A, B], note });
  assert.deepEqual(planRoute(sug({ source: 'none', note: 'vps is offline' }), online), { kind: 'ask', choices: [], note: 'vps is offline' });
  // A confident pick whose machine went offline since: ask, never send silently.
  const gone = { ...B, machineId: 'm_V', label: 'vps · infra' };
  assert.deepEqual(planRoute(sug({ candidates: [gone], confidence: 1, confident: true, source: 'explicit' }), online), { kind: 'ask', choices: [], note: 'vps is offline' });
  assert.equal(routeReason(sug({ candidates: [A], classifier: { model: 'qwen', ms: 1, letterMass: 1 } })), 'qwen 83%');
  assert.equal(routeReason(sug({ source: 'rule', rule: { id: 'r', label: 'prod → prod-access' } })), 'rule: prod → prod-access');
});

test('otherTargets: every workspace on an online machine, no worktrees', () => {
  assert.deepEqual(otherTargets(INPUT.machines, WS, INPUT.online).map((c) => c.label), ['laptop · acme-shop', 'laptop · bizzi', 'laptop · my notes', 'mac-mini · acme-shop']);
});

test('chooseAgent: /agent if installed, else the workspace\'s last agent, else a logged-in one', () => {
  const agents = INPUT.agents.m_L;
  const base = { agents, sessions: [] as SessionInfo[], workspaceId: 'w_shopL', machineName: 'laptop' };
  assert.deepEqual(chooseAgent({ ...base, explicit: 'codex' }), { agent: 'codex' });
  assert.deepEqual(chooseAgent({ ...base, explicit: 'agy' }), { error: "agy isn't installed on laptop" });
  const sessions = [session({ agent: 'codex', updatedAt: '2026-11-21T00:00:00Z' }), session({ id: 's_2', agent: 'claude' }), session({ id: 's_h', agent: 'claude', spawnedBy: 's_1', updatedAt: '2026-11-22T00:00:00Z' })];
  assert.deepEqual(chooseAgent({ ...base, sessions }), { agent: 'codex' });
  assert.deepEqual(chooseAgent({ ...base, agents: [agent('claude', { auth: 'missing' }), agent('codex')] }), { agent: 'codex' });
  assert.deepEqual(chooseAgent({ ...base, agents: [agent('shell')] }), { error: 'no agent is installed on laptop' });
  assert.deepEqual(chooseAgent({ ...base, agents: undefined }), { error: "can't tell which agents laptop has yet" });
});

test('continues: a follow-up stays in the live session unless a token changes the target', () => {
  const none = parseTokens('and the tests too', INPUT.machines, WS);
  assert.equal(continues(session(), none, true), true);
  assert.equal(continues(session({ status: 'running' }), none, true), true);
  assert.equal(continues(session({ status: 'ended' }), none, true), false);
  assert.equal(continues(session(), none, false), false, 'machine offline');
  assert.equal(continues(session({ mode: 'terminal' }), none, true), false);
  assert.equal(continues(session(), parseTokens('/codex review it', INPUT.machines, WS), true), false);
  assert.equal(continues(undefined, none, true), false);
});

test('decisionFor records what was offered, where it went and whether that was an override', () => {
  const s = sug({ candidates: [A, B], confidence: 0.55, classifier: { model: 'qwen', via: 'm_M', ms: 300, letterMass: 1 } });
  const top = decisionFor('fix the flaky test', s, A, 'claude', 's_9');
  assert.deepEqual([top.via, top.overridden, top.sessionId, top.classifier], ['suggested', false, 's_9', { model: 'qwen', via: 'm_M' }]);
  const picked = decisionFor('fix the flaky test', s, B, 'claude');
  assert.deepEqual([picked.via, picked.overridden, picked.chosen], ['picked', true, { machineId: 'm_M', workspaceId: 'w_shopM', label: 'mac-mini · acme-shop', agent: 'claude' }]);
  const other = decisionFor('x', s, { machineId: 'm_L', workspaceId: 'w_bizzi', label: 'laptop · bizzi', probability: 0 }, undefined);
  assert.deepEqual([other.via, other.overridden], ['other', true]);
  // Nothing offered: a label, but not an override.
  const nothing = decisionFor('x', sug({ source: 'none', note: 'no routing classifier configured' }), A, undefined);
  assert.deepEqual([nothing.via, nothing.overridden], ['other', false]);
});

test('rule words and the ask route', () => {
  assert.deepEqual(parseRuleWords('Prod, production,, prod  logs '), ['prod', 'production', 'prod logs']);
  assert.deepEqual(parseHash('#/ask'), { name: 'ask' });
  assert.deepEqual(parseHash('#/ask/s_1'), { name: 'ask', sessionId: 's_1' });
  assert.equal(routeHref({ name: 'ask', sessionId: 's 1' }), '#/ask/s%201');
});
