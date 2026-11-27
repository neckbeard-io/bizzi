import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sessionChannel, type AgentAdapter, type ChannelEvent } from '@bizzi/protocol';
import { createNode } from '../src/node.ts';
import { CONTINUE_AFTER_RESTART, MAX_AUTO_RESUMES, MAX_PLANNED_RESUMES } from '../src/sessions.ts';
import { Store } from '../src/store.ts';
import { FakeAdapter } from '../src/testing/index.ts';
import { tempDir, waitFor } from './helpers.ts';

function node(dataDir: string, adapters: AgentAdapter[], resumeInterrupted = true) {
  return createNode({ dataDir, adapters, version: '0.0.0-test', machineName: 'test-machine', interruptGraceMs: 200, resumeInterrupted, resumeDelayMs: 0 });
}

const turnsStarted = (events: ChannelEvent[]) => events.filter((e) => e.type === 'turn.started').map((e) => (e.data as { input: { text?: string }[] }).input[0]?.text);

/** A node with one idle session and one cut off mid-turn (waiting on an approval), then shut down. */
async function interruptedRun(dir: string): Promise<{ busy: string; quiet: string; ref: string }> {
  const n1 = await node(dir, [new FakeAdapter()]);
  const { workspace } = await n1.call('workspace.create', { path: dir + '/ws', create: true });
  const { session: busy } = await n1.call('session.create', { workspaceId: workspace.id, agent: 'claude' });
  const { session: quiet } = await n1.call('session.create', { workspaceId: workspace.id, agent: 'claude' });
  await waitFor(() => n1.sessions.list().every((s) => s.status === 'idle'));
  await n1.call('session.send', { sessionId: quiet.id, input: [{ type: 'text', text: 'hello' }] });
  await waitFor(() => n1.sessions.get(quiet.id).session.status === 'idle' && n1.sessions.get(quiet.id).session.agentSessionRef);
  await n1.call('session.send', { sessionId: busy.id, input: [{ type: 'text', text: '/approve deploy' }] });
  await waitFor(() => n1.sessions.get(busy.id).session.status === 'waiting_approval');
  const ref = n1.sessions.get(busy.id).session.agentSessionRef!;
  await n1.close();
  return { busy: busy.id, quiet: quiet.id, ref };
}

test('a turn cut off by a shutdown continues on its own after the restart; idle sessions stay put', async (t) => {
  const dir = tempDir();
  t.after(dir.cleanup);
  const { busy, quiet, ref } = await interruptedRun(dir.path);

  const fake2 = new FakeAdapter();
  const n2 = await node(dir.path, [fake2]);
  t.after(() => n2.close());
  await waitFor(() => fake2.starts.length === 1, 5000, 'the interrupted session to start');
  assert.equal(fake2.starts[0]?.resumeRef, ref, 'resumed the same conversation');
  await waitFor(() => turnsStarted(n2.bus.replay(sessionChannel(busy))).includes(CONTINUE_AFTER_RESTART));
  const events = n2.bus.replay(sessionChannel(busy));
  assert.ok(events.some((e) => e.type === 'session.restarted'), 'the restart divider closes as usual');
  // bizzi's own message is marked as such and never names the session.
  const cont = events.find((e) => e.type === 'turn.started' && (e.data as { input: { text?: string }[] }).input[0]?.text === CONTINUE_AFTER_RESTART);
  assert.equal((cont?.data as { auto?: boolean }).auto, true);
  assert.equal(n2.sessions.get(busy).session.title, '/approve deploy');
  await waitFor(() => n2.sessions.get(busy).session.status === 'idle');
  assert.equal(turnsStarted(n2.bus.replay(sessionChannel(quiet))).includes(CONTINUE_AFTER_RESTART), false, 'an idle session is not poked');
});

test('a node killed mid-turn (turn still open at load) resumes it too', async (t) => {
  const dir = tempDir();
  t.after(dir.cleanup);
  const { busy } = await interruptedRun(dir.path);
  killMidTurn(dir.path, busy);

  const fake2 = new FakeAdapter();
  const n2 = await node(dir.path, [fake2]);
  t.after(() => n2.close());
  await waitFor(() => turnsStarted(n2.bus.replay(sessionChannel(busy))).includes(CONTINUE_AFTER_RESTART));
  assert.equal(fake2.starts.length, 1);
});

/** What a SIGKILL leaves: the turn never closed, so no interruptedTurn mark was written. */
function killMidTurn(dir: string, id: string, extra: Record<string, unknown> = {}): void {
  const store = new Store(dir);
  for (const row of store.listSessions()) {
    if (row.info.id !== id) continue;
    store.putSession({ info: { ...row.info, status: 'running' }, state: { ...row.state, interruptedTurn: undefined, currentTurnId: 't_killed', ...extra } });
  }
  store.close();
}

function setState(dir: string, id: string, extra: Record<string, unknown>): void {
  const store = new Store(dir);
  for (const row of store.listSessions()) if (row.info.id === id) store.putSession({ info: row.info, state: { ...row.state, ...extra } });
  store.close();
}

test(`after ${MAX_AUTO_RESUMES} automatic resumes after crashes in a row, bizzi leaves a notice instead`, async (t) => {
  const dir = tempDir();
  t.after(dir.cleanup);
  const { busy } = await interruptedRun(dir.path);
  killMidTurn(dir.path, busy, { autoResumes: MAX_AUTO_RESUMES });

  const fake2 = new FakeAdapter();
  const n2 = await node(dir.path, [fake2]);
  t.after(() => n2.close());
  const notice = await waitFor(() => n2.bus.replay(sessionChannel(busy)).find((e) => e.type === 'error' && (e.data as { code?: string }).code === 'resume_skipped'));
  assert.match((notice.data as { message: string }).message, /Send a message to continue/);
  assert.equal(fake2.starts.length, 0, 'nothing was started');

  // A message from someone resets the count.
  await n2.call('session.send', { sessionId: busy, input: [{ type: 'text', text: 'carry on' }] });
  await waitFor(() => n2.sessions.get(busy).session.status === 'idle');
  await n2.close();
  const after = new Store(dir.path);
  t.after(() => after.close());
  assert.equal(after.listSessions().find((r) => r.info.id === busy)?.state.autoResumes, undefined);
});

test('clean stops have their own, higher cap: crash resumes do not hold back a planned restart', async (t) => {
  const dir = tempDir();
  t.after(dir.cleanup);
  const { busy } = await interruptedRun(dir.path);
  setState(dir.path, busy, { autoResumes: MAX_AUTO_RESUMES, plannedResumes: MAX_PLANNED_RESUMES - 1 });

  const fake2 = new FakeAdapter();
  const n2 = await node(dir.path, [fake2]);
  await waitFor(() => turnsStarted(n2.bus.replay(sessionChannel(busy))).includes(CONTINUE_AFTER_RESTART));
  // Cut it off again mid-turn: this time it is at the planned cap.
  await waitFor(() => n2.sessions.get(busy).session.status === 'idle');
  await n2.call('session.send', { sessionId: busy, input: [{ type: 'text', text: '/approve deploy' }] });
  await waitFor(() => n2.sessions.get(busy).session.status === 'waiting_approval');
  await n2.close();
  // That send reset the counts; put the session back at the planned cap.
  setState(dir.path, busy, { plannedResumes: MAX_PLANNED_RESUMES });

  const fake3 = new FakeAdapter();
  const n3 = await node(dir.path, [fake3]);
  t.after(() => n3.close());
  await waitFor(() => n3.bus.replay(sessionChannel(busy)).find((e) => e.type === 'error' && (e.data as { code?: string }).code === 'resume_skipped'));
  assert.equal(fake3.starts.length, 0, 'nothing was started');
});

test('resumeInterrupted: false leaves cut-off sessions for the next message', async (t) => {
  const dir = tempDir();
  t.after(dir.cleanup);
  await interruptedRun(dir.path);
  const fake2 = new FakeAdapter();
  const n2 = await node(dir.path, [fake2], false);
  t.after(() => n2.close());
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(fake2.starts.length, 0);
});

test('a rename, a close and a fresh-start mark survive a restart', async (t) => {
  const dir = tempDir();
  t.after(dir.cleanup);
  const n1 = await node(dir.path, [new FakeAdapter()]);
  const { workspace } = await n1.call('workspace.create', { path: dir.path + '/ws', create: true });
  const { session: renamed } = await n1.call('session.create', { workspaceId: workspace.id, agent: 'claude' });
  const { session: stopped } = await n1.call('session.create', { workspaceId: workspace.id, agent: 'claude' });
  await waitFor(() => n1.sessions.list().every((s) => s.status === 'idle'));
  await n1.call('session.set', { sessionId: renamed.id, title: 'my name' });
  await n1.call('session.stop', { sessionId: stopped.id });
  await n1.close();

  const store = new Store(dir.path);
  t.after(() => store.close());
  const rows = new Map(store.listSessions().map((r) => [r.info.id, r]));
  assert.equal(rows.get(renamed.id)?.state.titleByUser, true, 'agent titles keep away from a renamed session');
  assert.equal(rows.get(stopped.id)?.state.closed, true, 'the close marker is stored, not inferred');
});
