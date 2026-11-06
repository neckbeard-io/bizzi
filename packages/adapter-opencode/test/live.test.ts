// Live tests against the real `opencode` binary. Gated: BIZZI_LIVE=1.
//
//   BIZZI_LIVE=1 npm test -w @bizzi/adapter-opencode
//   BIZZI_OPENCODE_MODEL=provider/model   model for the prompt tests (default: server default,
//                                         only when probe() finds a configured provider)
//   BIZZI_OPENCODE_SHARED_DATA=1          use the user's OpenCode data dir instead of a temp one
//
// Always runs a private server on an ephemeral port; never touches the background service.
// Model calls are tiny and only happen when a provider is already configured.

import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { OpenCodeAdapter } from '../src/index.ts';
import type { OpenCodeSession } from '../src/session.ts';
import { ctx, Recorder } from './helpers.ts';

const LIVE = process.env.BIZZI_LIVE === '1';
const root = realpathSync(mkdtempSync(join(tmpdir(), 'bizzi-oc-live-')));
const env: Record<string, string> =
  process.env.BIZZI_OPENCODE_SHARED_DATA === '1' ? {} : { XDG_DATA_HOME: join(root, 'data'), XDG_STATE_HOME: join(root, 'state') };

describe('live opencode', { skip: !LIVE && 'set BIZZI_LIVE=1' }, () => {
  let adapter: OpenCodeAdapter;
  let model: string | undefined = process.env.BIZZI_OPENCODE_MODEL;
  let canPrompt = false;

  before(async () => {
    adapter = new OpenCodeAdapter({
      env,
      permissions: [{ action: 'shell', resource: '*', effect: 'ask' }],
      startupTimeoutMs: 60_000,
    });
    const probe = await adapter.probe();
    console.log('probe:', JSON.stringify(probe));
    assert.equal(probe.installed, true, 'opencode must be installed');
    canPrompt = probe.auth === 'ok' || Boolean(model);
  });

  after(async () => {
    await adapter?.dispose();
  });

  test('private server + session create/resume', async () => {
    const rec = new Recorder();
    const s = (await adapter.start({ sessionId: 's_live1', mode: 'structured', cwd: root }, rec.emit, ctx)) as OpenCodeSession;
    const ref = s.agentSessionRef()!;
    assert.match(ref, /^ses/);
    const info = await adapter.server.client!.getSession(ref);
    assert.equal(info.location.directory, root);
    assert.match(adapter.server.version ?? '', /^2\./);
    await s.stop();
    const rec2 = new Recorder();
    const resumed = await adapter.start({ sessionId: 's_live1', mode: 'structured', cwd: root, resumeRef: ref }, rec2.emit, ctx);
    assert.equal(resumed.agentSessionRef(), ref);
    await resumed.stop();
  });

  test('tiny prompt: streaming, system-append, shell approval, interrupt', { timeout: 240_000 }, async (t) => {
    if (!canPrompt) return t.skip('no provider configured');
    const rec = new Recorder();
    const s = (await adapter.start(
      {
        sessionId: 's_live2',
        mode: 'structured',
        cwd: root,
        ...(model ? { model } : {}),
        systemPromptAppend: 'House rule: end every reply with the exact token BZZ-OK.',
      },
      rec.emit,
      ctx,
    )) as OpenCodeSession;
    model ??= rec.of('session.info')[0]?.model;
    console.log('model:', model);

    // 1. plain turn
    await s.send('t1', [{ type: 'text', text: 'Reply with one short sentence saying hello.' }]);
    const t1 = await rec.waitFor('turn.completed', (d) => d.turnId === 't1', 120_000);
    console.log('t1:', JSON.stringify(t1));
    assert.equal(t1.stopReason, 'end_turn');
    assert.ok(rec.of('message.delta').length > 0, 'token streaming');
    const reply = rec.of('message.completed').map((m) => m.text).join('');
    console.log('reply:', reply.trim());
    assert.ok((t1.usage?.inputTokens ?? 0) > 0, 'usage reported');
    if (!reply.includes('BZZ-OK')) console.log('note: model did not echo the system-append token');

    // 2. shell approval round-trip
    await s.send('t2', [{ type: 'text', text: 'Use the shell tool to run exactly: echo live-ok . Then reply in one word.' }]);
    const ap = await rec.waitFor('approval.requested', undefined, 120_000);
    console.log('approval:', JSON.stringify(ap));
    assert.equal(ap.kind, 'shell');
    await s.respondApproval(ap.approvalId, { decision: 'allow' });
    const t2 = await rec.waitFor('turn.completed', (d) => d.turnId === 't2', 120_000);
    assert.equal(t2.stopReason, 'end_turn');
    const shell = rec.of('tool.completed').find((x) => x.toolId === ap.toolId);
    console.log('shell tool:', JSON.stringify(shell));
    assert.equal(shell?.status, 'ok');
    assert.match(shell?.output ?? '', /live-ok/);

    // 3. interrupt
    const n = rec.of('message.delta').length + rec.of('reasoning.delta').length;
    await s.send('t3', [{ type: 'text', text: 'Write a 500-word essay about lighthouses. No tools.' }]);
    const deadline = Date.now() + 60_000;
    while (rec.of('message.delta').length + rec.of('reasoning.delta').length === n && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await s.interrupt();
    const t3 = await rec.waitFor('turn.completed', (d) => d.turnId === 't3', 30_000);
    assert.equal(t3.stopReason, 'interrupted');
    await s.stop();
    console.log('event types:', [...new Set(rec.types())].join(', '));
  });

  test('question round-trip via the question tool', { timeout: 300_000 }, async (t) => {
    if (!canPrompt) return t.skip('no provider configured');
    // Models don't always reach for the tool; two tries, then skip rather than fail.
    for (let attempt = 1; attempt <= 2; attempt++) {
      const rec = new Recorder();
      const s = (await adapter.start({ sessionId: `s_live_q${attempt}`, mode: 'structured', cwd: root, ...(model ? { model } : {}) }, rec.emit, ctx)) as OpenCodeSession;
      try {
        await s.send('tq', [{ type: 'text', text: 'Use your question tool to ask me: tea or coffee? Then reply with just my answer.' }]);
        const first = await Promise.race([
          rec.waitFor('question.asked', undefined, 120_000).then((q) => ({ q })),
          rec.waitFor('turn.completed', undefined, 120_000).then(() => ({ q: undefined })),
        ]);
        if (!first.q) {
          console.log(`attempt ${attempt}: model answered without the question tool`);
          continue;
        }
        const q = first.q;
        console.log('question:', JSON.stringify(q));
        const item = q.questions?.[0];
        assert.ok(item, 'questions[] carried');
        const pick = item.options?.find((o) => /coffee/i.test(o.label))?.label ?? 'Coffee';
        await s.respondQuestion!(q.questionId, { [item.id]: pick });
        const done = await rec.waitFor('turn.completed', undefined, 120_000);
        assert.equal(done.stopReason, 'end_turn');
        assert.deepEqual(rec.of('question.resolved'), [{ questionId: q.questionId, answers: { [item.id]: pick } }]);
        const reply = rec.of('message.completed').map((m) => m.text).join(' ');
        console.log('reply:', reply.trim());
        assert.match(reply, /coffee/i);
        return;
      } finally {
        await s.stop();
      }
    }
    t.skip('model did not use the question tool in 2 attempts');
  });

  test('fork carries the conversation into a new session', { timeout: 300_000 }, async (t) => {
    if (!canPrompt) return t.skip('no provider configured');
    const rec = new Recorder();
    const a = await adapter.start({ sessionId: 's_live_f', mode: 'structured', cwd: root, ...(model ? { model } : {}) }, rec.emit, ctx);
    await a.send('t1', [{ type: 'text', text: 'Remember the code word: pelican. Reply with the single word ok.' }]);
    assert.equal((await rec.waitFor('turn.completed', undefined, 120_000)).stopReason, 'end_turn');
    const src = a.agentSessionRef()!;
    await a.stop();
    const rec2 = new Recorder();
    const f = await adapter.start({ sessionId: 's_live_f2', mode: 'structured', cwd: root, resumeRef: src, fork: true }, rec2.emit, ctx);
    assert.notEqual(f.agentSessionRef(), src);
    await f.send('t2', [{ type: 'text', text: 'What was the code word? Reply with that single word.' }]);
    const done = await rec2.waitFor('turn.completed', undefined, 120_000);
    assert.equal(done.stopReason, 'end_turn');
    const reply = rec2.of('message.completed').map((m) => m.text).join(' ');
    console.log('fork:', JSON.stringify({ source: src, fork: f.agentSessionRef(), reply: reply.trim() }));
    assert.match(reply, /pelican/i);
    const forkInfo = await adapter.server.client!.getSession(f.agentSessionRef()!);
    assert.equal(forkInfo.fork?.sessionID, src);
    await f.stop();
  });
});
