import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { BizziError, sessionChannel, type BizziError as BE, type SessionInfo } from '@bizzi/protocol';
import { parseSince, trailingQuestion, type BizziNode } from '../src/index.ts';
import { makeNode, tempDir, waitFor } from './helpers.ts';

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', GIT_CONFIG_NOSYSTEM: '1' };

function makeRepo(root: string): string {
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, env: GIT_ENV });
  git('init', '-q');
  writeFileSync(join(repo, 'README.md'), 'hello\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return realpathSync(repo);
}

async function setup(t: import('node:test').TestContext) {
  const tmp = tempDir();
  const node = await makeNode(join(tmp.path, 'data'));
  t.after(async () => {
    await node.close();
    tmp.cleanup();
  });
  return { node, tmp };
}

async function settled(node: BizziNode, id: string, status: SessionInfo['status'] = 'idle'): Promise<void> {
  await waitFor(() => node.sessions.get(id).session.status === status && (status !== 'idle' || !node.sessions.isBusy(id)), 5000, `${id} ${status}`);
}

async function say(node: BizziNode, id: string, text: string, status?: SessionInfo['status']): Promise<void> {
  await settled(node, id);
  await node.call('session.send', { sessionId: id, input: [{ type: 'text', text }] });
  await settled(node, id, status);
}

test('trailingQuestion: a reply that ends by asking the user', () => {
  assert.equal(trailingQuestion('Done. Want me to open a PR?'), 'Want me to open a PR?');
  assert.equal(trailingQuestion('Pushed it.\n\n**Should I merge it now?**'), 'Should I merge it now?');
  assert.equal(trailingQuestion('Shall I merge? I will wait.'), 'Shall I merge?');
  assert.equal(trailingQuestion('Why did it fail? Because of X. Fixed it. All green.'), undefined);
  assert.equal(trailingQuestion('Is this right?\n\nAll done.'), undefined);
  assert.equal(trailingQuestion('Run this:\n\n```\nfoo?\n```'), undefined);
  assert.equal(trailingQuestion(''), undefined);
});

test('parseSince: ISO times and durations', () => {
  const now = Date.parse('2026-11-27T12:00:00Z');
  assert.equal(parseSince('2h', now), now - 7_200_000);
  assert.equal(parseSince('90m', now), now - 5_400_000);
  assert.equal(parseSince('1d', now), now - 86_400_000);
  assert.equal(parseSince('2026-11-27T00:00:00Z', now), Date.parse('2026-11-27T00:00:00Z'));
  assert.throws(() => parseSince('yesterday'), (e: unknown) => e instanceof BizziError && (e as BE).code === 'bad_request');
});

test('sessions overview: every session, last prompt and reply, waiting on the user, filters and paging', async (t) => {
  const { node, tmp } = await setup(t);
  const repo = makeRepo(tmp.path);
  const { workspace: ws } = await node.call('workspace.create', { path: repo });
  const { workspace: other } = await node.call('workspace.create', { path: join(tmp.path, 'other'), create: true });
  const { workspace: wt } = await node.call('worktree.create', { workspaceId: ws.id, branch: 'feat/x' });

  const { session: me } = await node.call('session.create', { workspaceId: ws.id, agent: 'claude' });
  const { session: asks } = await node.call('session.create', { workspaceId: wt.id, agent: 'claude' });
  const { session: q } = await node.call('session.create', { workspaceId: other.id, agent: 'claude' });
  const { session: plain } = await node.call('session.create', { workspaceId: other.id, agent: 'claude' });
  await say(node, asks.id, 'Should I open the PR?');
  await say(node, q.id, '/ask Which database?', 'waiting_input');
  await say(node, plain.id, 'hello there');
  // bizzi's own continuation prompt is not the user's last prompt.
  node.bus.append(sessionChannel(plain.id), {
    type: 'turn.steered',
    data: { turnId: 't_x', input: [{ type: 'text', text: '[bizzi] bizzi restarted while you were working…' }] },
  });
  const h = await node.orchestration.startHelper(me.id, { agent: 'claude', prompt: 'look around' });
  await settled(node, h.session.id);

  const all = await node.history.overview(me.id);
  assert.equal(all.source, 'node');
  assert.equal(all.total, 5);
  const by = new Map(all.sessions.map((s) => [s.sessionId, s]));
  assert.equal(by.get(me.id)!.self, true);
  assert.deepEqual(by.get(me.id)!.helpers, [h.session.id]);
  assert.equal(by.get(h.session.id)!.parentId, me.id);
  assert.equal(by.get(h.session.id)!.scope, 'child');

  const a = by.get(asks.id)!;
  assert.equal(a.lastPrompt?.text, 'Should I open the PR?');
  assert.equal(a.lastReply?.text, 'echo: Should I open the PR?');
  assert.deepEqual(a.waiting, { asks: { heuristic: true, question: 'echo: Should I open the PR?' } });
  assert.equal(a.workspace.path, wt.path);
  assert.equal(a.workspace.branch, 'feat/x');
  assert.equal(a.turnOpen, false);
  assert.equal(by.get(me.id)!.workspace.branch, 'main', 'repo branch from git');

  assert.deepEqual(by.get(q.id)!.waiting?.questions, ['Which database?']);
  assert.equal(by.get(plain.id)!.lastPrompt?.text, 'hello there');
  assert.equal(by.get(plain.id)!.waiting, undefined);

  // A repo workspace includes its worktrees; by path too.
  const inRepo = await node.history.overview(me.id, { workspace: repo });
  assert.deepEqual(new Set(inRepo.sessions.map((s) => s.sessionId)), new Set([me.id, asks.id, h.session.id]));
  const inWt = await node.history.overview(me.id, { workspace: wt.id });
  assert.deepEqual(inWt.sessions.map((s) => s.sessionId), [asks.id]);
  await assert.rejects(node.history.overview(me.id, { workspace: '/nope' }), /no workspace/);

  const waiting = await node.history.overview(me.id, { waitingOnly: true });
  assert.deepEqual(new Set(waiting.sessions.map((s) => s.sessionId)), new Set([asks.id, q.id]));
  const st = await node.history.overview(me.id, { status: ['waiting_input'] });
  assert.deepEqual(st.sessions.map((s) => s.sessionId), [q.id]);
  assert.equal((await node.history.overview(me.id, { agent: 'codex' })).total, 0);
  assert.equal((await node.history.overview(me.id, { updatedSince: '2099-01-01T00:00:00Z' })).total, 0);
  assert.equal((await node.history.overview(me.id, { updatedSince: '1h' })).total, 5);

  // Paging: newest first, nextOffset until the end.
  const p1 = await node.history.overview(me.id, { limit: 2 });
  assert.equal(p1.sessions.length, 2);
  assert.equal(p1.nextOffset, 2);
  const p2 = await node.history.overview(me.id, { limit: 2, offset: 2 });
  const p3 = await node.history.overview(me.id, { limit: 2, offset: 4 });
  assert.equal(p3.nextOffset, undefined);
  assert.deepEqual([...p1.sessions, ...p2.sessions, ...p3.sessions].map((s) => s.sessionId), all.sessions.map((s) => s.sessionId));

  // Ended sessions only when asked for.
  await node.call('session.stop', { sessionId: plain.id });
  await settled(node, plain.id, 'ended');
  assert.equal((await node.history.overview(me.id)).total, 4);
  assert.deepEqual((await node.history.overview(me.id, { status: ['ended'] })).sessions.map((s) => s.sessionId), [plain.id]);

  // Another machine needs a hub link.
  await assert.rejects(node.history.overview(me.id, { machine: 'elsewhere' }), /hub link/);
  assert.equal((await node.history.overview(me.id, { machine: node.machine.name })).total, 4);
});

test('session peek: the session_read summary for any session, no ownership needed', async (t) => {
  const { node, tmp } = await setup(t);
  const { workspace } = await node.call('workspace.create', { path: join(tmp.path, 'ws'), create: true });
  const { session: s } = await node.call('session.create', { workspaceId: workspace.id, agent: 'claude', title: 'Some work' });
  await say(node, s.id, '/tool ls');
  const r = await node.history.peek(s.id);
  assert.equal(r.sessionId, s.id);
  assert.equal(r.title, 'Some work');
  assert.equal(r.finalMessage, 'done');
  assert.equal(r.lastPrompt?.text, '/tool ls');
  assert.equal(r.workspace.path, workspace.path);
  assert.equal(r.tools.total, 1);
  await assert.rejects(node.history.peek('s_nope'), /no session/);
});

// ---- full-text history (bizzi-memory history_search / handoff_brief)

test('history index: prompts and replies indexed on append, backfilled once, dropped with the session', async () => {
  const { Store, ftsQuery, historyDoc } = await import('../src/store.ts');
  const tmp = tempDir();
  try {
    const store = new Store(tmp.path);
    assert.equal(store.ftsAvailable, true, 'Node 26 sqlite has FTS5');
    assert.equal(store.historyBackfilled, 0);
    let seq = 0;
    const put = (ch: string, type: string, data: unknown) => store.insertEvent({ ch, seq: ++seq, ts: new Date(1_800_000_000_000 + seq).toISOString(), type, data } as never);
    put('session:s_a', 'turn.started', { turnId: 't1', input: [{ type: 'text', text: 'Please fix the flaky reconnection test' }, { type: 'image', mediaType: 'image/png', dataBase64: 'AAAA' }] });
    put('session:s_a', 'message.delta', { messageId: 'm1', text: 'reconnection' });
    put('session:s_a', 'message.completed', { messageId: 'm1', role: 'assistant', text: 'Fixed the reconnection test; opened PR #12.' });
    put('session:s_a', 'message.completed', { messageId: 'm2', role: 'assistant', text: 'subagent says reconnection', parentToolId: 'x' });
    put('session:s_a', 'turn.started', { turnId: 't2', input: [{ type: 'text', text: '[bizzi] bizzi restarted… reconnection' }], auto: true });
    put('session:s_b', 'turn.started', { turnId: 't3', input: [{ type: 'text', text: 'Bump the reconnect timeout' }] });

    // Porter stemming: "reconnection" finds "reconnect" too. Subagent text, deltas and bizzi's own prompts aren't indexed.
    const hits = store.searchHistory({ query: 'reconnection', limit: 10, offset: 0 });
    assert.deepEqual(hits.map((h) => [h.ch, h.role]).sort(), [['session:s_a', 'assistant'], ['session:s_a', 'user'], ['session:s_b', 'user']]);
    assert.match(hits.find((h) => h.ch === 'session:s_a' && h.role === 'user')!.snippet, /\[reconnection\]/);
    // Porter stemming and prefixes; channel and role filters; phrases; OR.
    assert.equal(store.searchHistory({ query: 'reconnect*', limit: 10, offset: 0 }).length, 3);
    assert.equal(store.searchHistory({ query: 'reconnect*', channels: ['session:s_b'], limit: 10, offset: 0 }).length, 1);
    assert.equal(store.searchHistory({ query: 'reconnect*', role: 'assistant', limit: 10, offset: 0 }).length, 1);
    assert.equal(store.searchHistory({ query: '"flaky reconnection"', limit: 10, offset: 0 }).length, 1);
    assert.equal(store.searchHistory({ query: 'timeout OR flaky', limit: 10, offset: 0 }).length, 2);
    assert.equal(store.searchHistory({ query: 'reconnect*', channels: [], limit: 10, offset: 0 }).length, 0);
    // User text can't break the query syntax.
    assert.equal(ftsQuery('a" OR NEAR( b*'), '"a" OR "NEAR(" AND "b"*');
    assert.doesNotThrow(() => store.searchHistory({ query: 'NEAR( "unclosed AND -', limit: 5, offset: 0 }));
    assert.throws(() => ftsQuery('   '), /empty/);
    assert.equal(historyDoc('turn.started', { input: [], agent: true }), undefined);

    // The one-time backfill: forget the index, reopen, everything comes back once.
    store.setMeta('history.indexed', '0');
    store.close();
    const again = new Store(tmp.path);
    assert.equal(again.historyBackfilled, 3);
    assert.equal(again.searchHistory({ query: 'reconnect*', limit: 10, offset: 0 }).length, 3);
    again.close();
    const third = new Store(tmp.path);
    assert.equal(third.historyBackfilled, 0, 'only once');
    third.deleteSession('s_a', 'session:s_a');
    assert.deepEqual(third.searchHistory({ query: 'reconnect*', limit: 10, offset: 0 }).map((h) => h.ch), ['session:s_b']);
    third.close();
  } finally {
    tmp.cleanup();
  }
});

test('history search and briefs: scoped to the caller\'s project, prompts, files, PRs, open questions', async (t) => {
  const { node, tmp } = await setup(t);
  const repo = makeRepo(tmp.path);
  const { workspace: ws } = await node.call('workspace.create', { path: repo });
  const { workspace: wt } = await node.call('worktree.create', { workspaceId: ws.id, branch: 'feat/y' });
  const { workspace: other } = await node.call('workspace.create', { path: join(tmp.path, 'other'), create: true });
  const { session: me } = await node.call('session.create', { workspaceId: wt.id, agent: 'claude' });
  const { session: done } = await node.call('session.create', { workspaceId: ws.id, agent: 'claude', title: 'Release work' });
  const { session: away } = await node.call('session.create', { workspaceId: other.id, agent: 'claude' });
  await say(node, done.id, 'tag the release and open https://github.com/acme/app/pull/77 please');
  await say(node, done.id, 'then gh pr merge 78 as well. Ready to ship?');
  await say(node, away.id, 'release notes for the other project');

  // Node method (any session on the node, or a workspace family).
  const all = await node.call('history.search', { query: 'release' });
  assert.equal(all.fullText, true);
  assert.deepEqual(new Set(all.hits.map((h) => h.sessionId)), new Set([done.id, away.id]));
  const inRepo = await node.call('history.search', { query: 'release', workspaceId: ws.id, role: 'user' });
  assert.deepEqual(inRepo.hits.map((h) => [h.sessionId, h.role, h.title]), [[done.id, 'user', 'Release work']]);
  assert.match(inRepo.hits[0]!.snippet, /\[release\]/);
  const paged = await node.call('history.search', { query: 'release', limit: 1 });
  assert.equal(paged.hits.length, 1);
  assert.equal(paged.nextOffset, 1);

  // For an agent: its project (the repo of its worktree, with every worktree), never the other project.
  const mine = node.history.searchFor(me.id, { query: 'release' });
  assert.deepEqual(new Set(mine.hits.map((h) => h.sessionId)), new Set([done.id]));
  assert.equal(node.history.searchFor(me.id, { query: 'release', scope: 'workspace' }).hits.length, 0, 'workspace = just its worktree');

  const brief = await node.history.briefFor(me.id, done.id);
  assert.equal(brief.title, 'Release work');
  assert.equal(brief.asked.first, 'tag the release and open https://github.com/acme/app/pull/77 please');
  assert.deepEqual(brief.asked.later, ['then gh pr merge 78 as well. Ready to ship?']);
  assert.deepEqual(brief.did.prs, ['https://github.com/acme/app/pull/77', '#78']);
  assert.equal(brief.did.turns, 2);
  assert.equal(brief.ended.lastReply, 'echo: then gh pr merge 78 as well. Ready to ship?');
  assert.equal(brief.open.asks, 'Ready to ship?');
  assert.equal(brief.workspace.branch, 'main');
  assert.match(brief.text, /## Asked[\s\S]*## Did[\s\S]*PRs mentioned: https:\/\/github.com\/acme\/app\/pull\/77, #78[\s\S]*## Open/);
  await assert.rejects(node.history.briefFor(me.id, away.id), /no session .* in this project/);
  const viaMethod = await node.call('history.brief', { sessionId: away.id });
  assert.equal(viaMethod.brief.asked.first, 'release notes for the other project');
});
