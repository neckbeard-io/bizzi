import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { InputBlock } from '@bizzi/protocol';
import { autoTitle, cleanSuggestedTitle, createNode, isPlaceholderTitle, type BizziNode } from '../src/index.ts';
import { CONTINUE_AFTER_RESTART } from '../src/sessions.ts';
import { isBizziNote, retitlePrompt } from '../src/titles.ts';
import { FakeAdapter } from '../src/testing/index.ts';
import { tempDir, waitFor } from './helpers.ts';

const text = (t: string): InputBlock[] => [{ type: 'text', text: t }];

test('autoTitle: the gist of the first line, markdown stripped, cut at a word', () => {
  assert.equal(autoTitle(text('  fix the   login redirect loop  ')), 'fix the login redirect loop');
  assert.equal(autoTitle(text('\n\n## Add dark mode\nmore detail here')), 'Add dark mode');
  assert.equal(autoTitle(text('- [ ] item one')), '[ ] item one');
  assert.equal(autoTitle(text('```ts\nconst x = 1\n```')), 'const x = 1');
  assert.equal(autoTitle(text('---\n> quoted ask')), 'quoted ask');
  assert.equal(autoTitle(text('please refactor the session manager so that every turn goes through a single queue')), 'refactor the session manager');
  const long = autoTitle(text('rewrite every adapter around one shared queue with retries backoff and metrics for each provider'))!;
  assert.ok(long.length <= 50, long);
  assert.ok(long.endsWith('…'), long);
  assert.ok(!/\s…$/.test(long), long);
  assert.equal(autoTitle([{ type: 'file', path: '/tmp/dir/spec.md' }]), 'Attached spec.md');
  assert.equal(autoTitle([{ type: 'image', mediaType: 'image/png', dataBase64: 'AA==' }]), undefined);
  assert.equal(autoTitle(text('   \n  ')), undefined);
});

test('cleanSuggestedTitle and isPlaceholderTitle', () => {
  assert.equal(cleanSuggestedTitle('"Fix login redirect loop."\n'), 'Fix login redirect loop');
  assert.equal(cleanSuggestedTitle('<think>hmm</think>\nTitle: Add dark mode'), 'Add dark mode');
  assert.equal(cleanSuggestedTitle('**Speed up tests**'), 'Speed up tests');
  assert.equal(cleanSuggestedTitle('  \n...'), undefined);
  assert.ok(isPlaceholderTitle('New session - 2026-11-26T10:00:00.000Z'));
  assert.ok(isPlaceholderTitle('Child session - 2026-11-26T10:00:00.000Z'));
  assert.ok(!isPlaceholderTitle('New session for the API'));
});

async function setup(t: { after: (fn: () => unknown) => void }, suggest?: (text: string) => Promise<string | undefined>) {
  const dir = tempDir();
  const fake = new FakeAdapter();
  const node: BizziNode = await createNode({
    dataDir: dir.path,
    adapters: [fake],
    version: '0.0.0-test',
    machineName: 'test-machine',
    interruptGraceMs: 200,
    ...(suggest ? { suggestTitle: (text: string) => suggest(text) } : {}),
  });
  t.after(async () => {
    await node.close();
    dir.cleanup();
  });
  const { workspace } = await node.call('workspace.create', { path: dir.path + '/ws', create: true });
  const { session } = await node.call('session.create', { workspaceId: workspace.id, agent: 'claude' });
  await waitFor(() => node.sessions.get(session.id).session.status === 'idle');
  const title = () => node.sessions.get(session.id).session.title;
  const send = async (t: string) => {
    await node.call('session.send', { sessionId: session.id, input: text(t) });
    await waitFor(() => node.sessions.get(session.id).session.status === 'idle');
  };
  return { node, fake, session, title, send, dir, workspace };
}

test('untitled session is titled from its first message; later messages keep it', async (t) => {
  const { title, send } = await setup(t);
  assert.equal(title(), undefined);
  await send('Fix the flaky upload test\nIt fails on CI about once a day.');
  assert.equal(title(), 'Fix the flaky upload test');
  await send('now also add a retry');
  assert.equal(title(), 'Fix the flaky upload test');
});

test('a given title, a rename and agent titles win over automatic ones; placeholders are ignored', async (t) => {
  const { node, fake, session, title, send, workspace } = await setup(t);
  fake.sessions[0]!.emitEvent({ type: 'session.info', data: { title: 'New session - 2026-11-26T10:00:00.000Z' } });
  await send('first ask');
  assert.equal(title(), 'first ask');
  fake.sessions[0]!.emitEvent({ type: 'session.info', data: { title: 'Agent summary' } });
  await waitFor(() => title() === 'Agent summary');
  await node.call('session.set', { sessionId: session.id, title: '' });
  assert.equal(title(), undefined);
  await send('cleared by the user, stays cleared');
  assert.equal(title(), undefined);

  const named = (await node.call('session.create', { workspaceId: workspace.id, agent: 'claude', title: 'Mine' })).session;
  await waitFor(() => node.sessions.get(named.id).session.status === 'idle');
  await node.call('session.send', { sessionId: named.id, input: text('hello') });
  await waitFor(() => node.sessions.get(named.id).session.status === 'idle');
  assert.equal(node.sessions.get(named.id).session.title, 'Mine');
});

test('the title model replaces the automatic title, unless someone named the session first', async (t) => {
  const asked: string[] = [];
  let release: (v: string) => void = () => {};
  const { node, session, title, send, workspace } = await setup(t, (text) => {
    asked.push(text);
    return asked.length === 1 ? Promise.resolve('"Flaky upload test fix."') : new Promise((r) => (release = r));
  });
  await send('the upload test is flaky, please look');
  await waitFor(() => title() === 'Flaky upload test fix');
  assert.deepEqual(asked, ['the upload test is flaky, please look']);
  await send('second message');
  assert.equal(asked.length, 1, 'only the first message is summarized');

  // Renamed while the model is thinking: the late answer is dropped.
  const other = (await node.call('session.create', { workspaceId: workspace.id, agent: 'claude' })).session;
  await waitFor(() => node.sessions.get(other.id).session.status === 'idle');
  await node.call('session.send', { sessionId: other.id, input: text('another task') });
  await waitFor(() => asked.length === 2);
  await node.call('session.set', { sessionId: other.id, title: 'Renamed' });
  release('Model title');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(node.sessions.get(other.id).session.title, 'Renamed');
  assert.equal(node.sessions.get(session.id).session.title, 'Flaky upload test fix');
});

test('a failing title model keeps the title from the message', async (t) => {
  const { title, send } = await setup(t, () => Promise.reject(new Error('no key')));
  await send('Speed up the test suite');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(title(), 'Speed up the test suite');
});

test('bizzi’s own messages never title a session; the user’s next message does', async (t) => {
  assert.ok(isBizziNote(CONTINUE_AFTER_RESTART));
  assert.ok(!isBizziNote('fix the [bizzi] tag parser'));
  const { title, send } = await setup(t);
  // As older nodes sent it: a plain turn, no `auto` mark.
  await send(CONTINUE_AFTER_RESTART);
  assert.equal(title(), undefined);
  await send('Fix the flaky upload test');
  assert.equal(title(), 'Fix the flaky upload test');
});

test('after /clear the next message titles the session again, unless the user named it', async (t) => {
  const { node, session, title, send, workspace } = await setup(t);
  await send('Fix the flaky upload test');
  await node.call('session.clear', { sessionId: session.id });
  await waitFor(() => node.sessions.get(session.id).session.status === 'idle');
  assert.equal(title(), 'Fix the flaky upload test', 'kept until the next message says what is next');
  await send('Now add dark mode to the settings page');
  assert.equal(title(), 'add dark mode to the settings page');
  await send('and the sidebar too');
  assert.equal(title(), 'add dark mode to the settings page');

  const named = (await node.call('session.create', { workspaceId: workspace.id, agent: 'claude', title: 'Mine' })).session;
  await waitFor(() => node.sessions.get(named.id).session.status === 'idle');
  await node.call('session.send', { sessionId: named.id, input: text('hello') });
  await waitFor(() => node.sessions.get(named.id).session.status === 'idle');
  await node.call('session.set', { sessionId: named.id, title: 'Mine' });
  await node.call('session.clear', { sessionId: named.id });
  await waitFor(() => node.sessions.get(named.id).session.status === 'idle');
  await node.call('session.send', { sessionId: named.id, input: text('something else entirely') });
  await waitFor(() => node.sessions.get(named.id).session.status === 'idle');
  assert.equal(node.sessions.get(named.id).session.title, 'Mine');
});

test('with a title model, an automatic title follows the conversation from the original request', async (t) => {
  const asked: string[] = [];
  const { node, session, title, send } = await setup(t, async (text) => {
    asked.push(text);
    return asked.length === 1 ? 'Flaky upload test' : 'Upload retries and backoff';
  });
  await send('the upload test is flaky, please look');
  await waitFor(() => title() === 'Flaky upload test');
  const before = node.sessions.get(session.id).session.updatedAt;
  await send('ok, now add retries to the uploader');
  await send('use exponential backoff');
  assert.equal(asked.length, 1);
  await send('and cap it at five attempts');
  await waitFor(() => title() === 'Upload retries and backoff');
  assert.equal(
    asked[1],
    retitlePrompt('the upload test is flaky, please look', ['ok, now add retries to the uploader', 'use exponential backoff', 'and cap it at five attempts']),
  );
  assert.match(asked[1]!, /^First message:\nthe upload test is flaky/);
  assert.ok(node.sessions.get(session.id).session.updatedAt >= before);
});

test('at load, sessions named after bizzi’s restart message or never named take their first message', async (t) => {
  const dir = tempDir();
  t.after(dir.cleanup);
  const open = (fake = new FakeAdapter()) => createNode({ dataDir: dir.path, adapters: [fake], version: '0.0.0-test', machineName: 'test-machine', interruptGraceMs: 200 });
  const fake = new FakeAdapter();
  const n1 = await open(fake);
  const { workspace } = await n1.call('workspace.create', { path: dir.path + '/ws', create: true });
  const { session } = await n1.call('session.create', { workspaceId: workspace.id, agent: 'claude' });
  await waitFor(() => n1.sessions.get(session.id).session.status === 'idle');
  await n1.call('session.send', { sessionId: session.id, input: text(CONTINUE_AFTER_RESTART) });
  await waitFor(() => n1.sessions.get(session.id).session.status === 'idle');
  await n1.call('session.send', { sessionId: session.id, input: text('Speed up the test suite') });
  await waitFor(() => n1.sessions.get(session.id).session.status === 'idle');
  // As an older node left it: titled from bizzi's message.
  fake.sessions[0]!.emitEvent({ type: 'session.info', data: { title: autoTitle(text(CONTINUE_AFTER_RESTART))! } });
  await waitFor(() => n1.sessions.get(session.id).session.title?.startsWith('[bizzi]'));
  const updatedAt = n1.sessions.get(session.id).session.updatedAt;
  await n1.close();

  const n2 = await open();
  t.after(() => n2.close());
  assert.equal(n2.sessions.get(session.id).session.title, 'Speed up the test suite');
  assert.equal(n2.sessions.get(session.id).session.updatedAt, updatedAt, 'the repair keeps its place in lists');
});
