// Live tests against the installed Claude Code. Run with BIZZI_LIVE=1 (costs a few cents).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionEventBody } from '@bizzi/protocol';
import { ClaudeAdapter } from '../src/index.ts';
import { collector, silentLogger, waitFor } from './fake.ts';

const LIVE = process.env.BIZZI_LIVE === '1';
const MODEL = process.env.BIZZI_CLAUDE_MODEL ?? 'haiku';
const dump = (events: SessionEventBody[]) => {
  if (process.env.BIZZI_LIVE_DUMP) for (const e of events) console.log(JSON.stringify(e).slice(0, 300));
};

test('live: probe finds the installed claude', { skip: !LIVE }, async () => {
  const p = await new ClaudeAdapter().probe();
  console.log('probe:', JSON.stringify(p));
  assert.equal(p.installed, true);
  assert.ok(p.version);
});

test('live: one short turn', { skip: !LIVE, timeout: 120_000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bizzi-live-'));
  const c = collector();
  const session = await new ClaudeAdapter().start(
    { sessionId: 's_live1', mode: 'structured', cwd, model: MODEL, permissionMode: 'default' },
    c.emit,
    { logger: silentLogger },
  );
  try {
    await session.send('t_1', [{ type: 'text', text: 'Reply with the single word ok' }]);
    await waitFor(() => c.of('turn.completed').length === 1, 110_000);
    dump(c.events);
    const done = c.of('turn.completed')[0]!;
    assert.equal(done.stopReason, 'end_turn', done.error ?? '');
    assert.ok((done.usage?.costUsd ?? 0) > 0);
    assert.ok((done.usage?.outputTokens ?? 0) > 0);
    const text = c.of('message.completed').map((m) => m.text).join(' ');
    assert.match(text, /\bok\b/i);
    assert.ok(c.of('message.delta').length >= 1, 'token deltas streamed');
    assert.ok(session.agentSessionRef());
    assert.ok(c.of('session.info').some((i) => i.model), 'model reported');
    console.log('turn:', JSON.stringify({ text, usage: done.usage, ref: session.agentSessionRef() }));
  } finally {
    if (!c.of('turn.completed').length) dump(c.events);
    await session.stop();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('live: resume and fork a session', { skip: !LIVE, timeout: 240_000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bizzi-live-'));
  const adapter = new ClaudeAdapter();
  const run = async (opts: Record<string, unknown>, text: string) => {
    const c = collector();
    const s = await adapter.start({ sessionId: 's_live_r', mode: 'structured', cwd, model: MODEL, ...opts }, c.emit, { logger: silentLogger });
    await s.send('t', [{ type: 'text', text }]);
    await waitFor(() => c.of('turn.completed').length === 1, 110_000);
    await s.stop();
    return { ref: s.agentSessionRef(), c };
  };
  try {
    const a = await run({}, 'Remember the code word: pelican. Reply with the single word ok');
    const b = await run({ resumeRef: a.ref }, 'What was the code word? Reply with that single word.');
    assert.equal(b.ref, a.ref);
    assert.match(b.c.of('message.completed').map((m) => m.text).join(' '), /pelican/i);
    const f = await run({ resumeRef: a.ref, fork: true }, 'What was the code word? Reply with that single word.');
    assert.notEqual(f.ref, a.ref);
    assert.match(f.c.of('message.completed').map((m) => m.text).join(' '), /pelican/i);
    const cost = (r: { c: ReturnType<typeof collector> }) => ({ turn: r.c.of('turn.completed')[0]?.usage, total: r.c.of('usage.updated').at(-1) });
    console.log('resume/fork:', JSON.stringify({ original: a.ref, resumed: b.ref, forked: f.ref }));
    console.log('usage:', JSON.stringify({ a: cost(a), b: cost(b), f: cost(f) }));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('live: approval round-trip in default permission mode', { skip: !LIVE, timeout: 180_000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bizzi-live-'));
  const c = collector();
  const session = await new ClaudeAdapter().start(
    { sessionId: 's_live2', mode: 'structured', cwd, model: MODEL, permissionMode: 'default' },
    c.emit,
    { logger: silentLogger },
  );
  try {
    // Plain `echo bizzi` is read-only, so Claude Code auto-allows it without asking; redirecting
    // into a file makes it a write that needs approval. The approval also edits the command.
    await session.send('t_1', [
      { type: 'text', text: 'Run the shell command `echo bizzi > bizzi.txt` with the Bash tool, then reply with the single word done.' },
    ]);
    await waitFor(() => c.of('approval.requested').length >= 1 || c.of('turn.completed').length === 1, 120_000);
    const req = c.of('approval.requested')[0];
    assert.ok(req, `no approval requested; events: ${c.events.map((e) => e.type).join(',')}`);
    assert.equal(req.kind, 'shell');
    assert.equal(req.editable, true);
    assert.match(JSON.stringify(req.input), /echo bizzi/);
    const editedInput = { ...(req.input as object), command: 'echo bizzi-edited > bizzi.txt' };
    await session.respondApproval(req.approvalId, { decision: 'allow', editedInput });
    await waitFor(() => c.of('turn.completed').length === 1, 120_000);
    dump(c.events);
    const done = c.of('turn.completed')[0]!;
    assert.equal(done.stopReason, 'end_turn', done.error ?? '');
    assert.deepEqual(c.of('approval.resolved').map((r) => r.decision), ['allow']);
    const tool = c.of('tool.completed').find((t) => t.toolId === req.toolId);
    assert.equal(tool?.status, 'ok');
    assert.equal(readFileSync(join(cwd, 'bizzi.txt'), 'utf8').trim(), 'bizzi-edited');
    console.log('approval:', JSON.stringify({ title: req.title, tool, final: c.of('message.completed').at(-1)?.text }));
  } finally {
    if (!c.of('turn.completed').length) dump(c.events);
    await session.stop();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('live: steer mid-turn, then interrupt a second turn', { skip: !LIVE, timeout: 240_000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bizzi-live-'));
  const c = collector();
  const session = await new ClaudeAdapter().start(
    { sessionId: 's_live3', mode: 'structured', cwd, model: MODEL, permissionMode: 'acceptEdits' },
    c.emit,
    { logger: silentLogger },
  );
  const approveAll = setInterval(() => {
    for (const r of c.of('approval.requested')) {
      if (!c.of('approval.resolved').some((x) => x.approvalId === r.approvalId)) {
        session.respondApproval(r.approvalId, { decision: 'allow' }).catch(() => {});
      }
    }
  }, 50);
  try {
    await session.send('t_1', [{ type: 'text', text: 'Run `sleep 8; echo bizzi` with the Bash tool, then reply with its output.' }]);
    await waitFor(() => c.of('tool.started').length >= 1, 120_000);
    await session.steer!([{ type: 'text', text: 'Also end your reply with the word banana.' }]);
    await waitFor(() => c.of('turn.completed').length === 1, 120_000);
    const first = c.of('turn.completed')[0]!;
    assert.equal(first.stopReason, 'end_turn', first.error ?? '');
    assert.match(c.of('message.completed').map((m) => m.text).join(' '), /banana/i);

    const toolsBefore = c.of('tool.started').length;
    await session.send('t_2', [{ type: 'text', text: 'Run `sleep 30` with the Bash tool.' }]);
    await waitFor(() => c.of('tool.started').length > toolsBefore, 120_000);
    await session.interrupt();
    await waitFor(() => c.of('turn.completed').length === 2, 60_000);
    dump(c.events);
    assert.deepEqual(c.of('turn.completed').map((t) => [t.turnId, t.stopReason]), [['t_1', 'end_turn'], ['t_2', 'interrupted']]);
    console.log('steer/interrupt:', JSON.stringify(c.of('turn.completed')));
  } finally {
    clearInterval(approveAll);
    if (c.of('turn.completed').length < 2) dump(c.events);
    await session.stop();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('live: AskUserQuestion round-trip', { skip: !LIVE, timeout: 180_000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'bizzi-live-'));
  const c = collector();
  const session = await new ClaudeAdapter().start(
    { sessionId: 's_live4', mode: 'structured', cwd, model: MODEL, permissionMode: 'default' },
    c.emit,
    { logger: silentLogger },
  );
  try {
    await session.send('t_1', [
      {
        type: 'text',
        text: 'Use your AskUserQuestion tool to ask me one multiple-choice question: which color I prefer, options Red and Blue. After I answer, reply with only the color I chose.',
      },
    ]);
    await waitFor(() => c.of('question.asked').length >= 1 || c.of('turn.completed').length === 1, 120_000);
    const q = c.of('question.asked')[0];
    assert.ok(q, `no question asked; events: ${c.events.map((e) => e.type).join(',')}`);
    assert.equal(c.of('approval.requested').length, 0);
    const item = q.questions?.[0];
    assert.ok(item?.options?.length, 'question has options');
    const blue = item.options.find((o) => /blue/i.test(o.label))?.label ?? item.options.at(-1)!.label;
    await session.respondQuestion!(q.questionId, { [item.id]: blue });
    await waitFor(() => c.of('turn.completed').length === 1, 120_000);
    dump(c.events);
    const done = c.of('turn.completed')[0]!;
    assert.equal(done.stopReason, 'end_turn', done.error ?? '');
    assert.deepEqual(c.of('question.resolved'), [{ questionId: q.questionId, answers: { [item.id]: blue } }]);
    const final = c.of('message.completed').at(-1)?.text ?? '';
    assert.match(final, new RegExp(blue, 'i'));
    console.log('question:', JSON.stringify({ question: q, final }));
  } finally {
    if (!c.of('turn.completed').length) dump(c.events);
    await session.stop();
    rmSync(cwd, { recursive: true, force: true });
  }
});
