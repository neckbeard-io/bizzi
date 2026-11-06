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
});
