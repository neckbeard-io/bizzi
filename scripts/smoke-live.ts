// Live end-to-end smoke test: starts `bizzi serve` in a temp data dir, creates a workspace and a structured
// session for the given agent, runs one turn that should use the bizzi-memory MCP server, auto-approves
// tool requests, and checks the memory landed in the knowledge store.
//
//   node scripts/smoke-live.ts [agent=claude] [model=haiku]
//
// Uses the agent's real login and spends a few cents at most.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import type { ServeReady } from '@bizzi/protocol';

const agent = process.argv[2] ?? 'claude';
const model = process.argv[3] ?? 'haiku';
const root = mkdtempSync(join(tmpdir(), 'bizzi-smoke-'));
const dataDir = join(root, 'data');
const workspaceDir = join(root, 'ws');
const fact = `smoke fact ${Date.now()}`;

const serve = spawn(process.execPath, ['apps/cli/src/main.ts', 'serve', '--port', '0', '--data-dir', dataDir, '--name', 'smoke'], {
  stdio: ['ignore', 'pipe', 'inherit'],
  env: { ...process.env, BIZZI_LOG_LEVEL: 'warn' },
});
const ready = await new Promise<ServeReady>((resolve, reject) => {
  createInterface({ input: serve.stdout! }).once('line', (l) => resolve(JSON.parse(l) as ServeReady));
  serve.once('exit', (c) => reject(new Error(`serve exited ${c}`)));
});

const ws = new WebSocket(ready.url);
await new Promise((r, j) => {
  ws.onopen = r;
  ws.onerror = j;
});
let nextId = 0;
const pending = new Map<string, (m: any) => void>();
const listeners: ((e: any) => void)[] = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(String(m.data));
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)!(msg);
    pending.delete(msg.id);
  } else if (msg.ch) for (const l of listeners) l(msg);
};
function call(method: string, params: unknown): Promise<any> {
  const id = `r_${++nextId}`;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) =>
    pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result))),
  );
}

let ok = false;
try {
  await call('hello', { protocol: 'bizzi/1', client: { name: 'smoke', version: '0' }, token: ready.token });
  const { agents } = await call('agents.list', {});
  for (const a of agents) console.log(`agent ${a.agent.padEnd(8)} installed=${a.installed} version=${a.version ?? '-'} auth=${a.auth}`);
  const { workspace } = await call('workspace.create', { path: workspaceDir, create: true, name: 'smoke' });
  const { session } = await call('session.create', { workspaceId: workspace.id, agent, model });
  const ch = `session:${session.id}`;
  const done = new Promise<any>((resolve) => {
    listeners.push((e) => {
      if (e.ch !== ch) return;
      if (e.type === 'approval.requested') {
        console.log(`  approve: ${e.data.title}`);
        void call('approval.respond', { sessionId: session.id, approvalId: e.data.approvalId, decision: 'allow' });
      } else if (e.type === 'tool.started') console.log(`  tool: ${e.data.kind} ${e.data.title}`);
      else if (e.type === 'message.completed') console.log(`  assistant: ${e.data.text.slice(0, 200)}`);
      else if (e.type === 'error') console.log(`  error: ${e.data.message}`);
      else if (e.type === 'turn.completed') resolve(e.data);
    });
  });
  await call('subscribe', { ch, since: 0 });
  await call('session.send', {
    sessionId: session.id,
    input: [
      {
        type: 'text',
        text: `Use the bizzi-memory memory_add tool to save a memory with title "${fact}", body "written by the bizzi smoke test", kind fact, scope workspace. Then reply with the single word done.`,
      },
    ],
  });
  const result = await Promise.race([done, new Promise((_, j) => setTimeout(() => j(new Error('turn timed out')), 180_000))]);
  console.log(`turn: ${(result as any).stopReason} cost=$${(result as any).usage?.costUsd ?? '?'}`);

  const db = new DatabaseSync(join(dataDir, 'knowledge.db'), { readOnly: true });
  const row = db.prepare('SELECT title, status FROM items WHERE title = ?').get(fact) as { title: string; status: string } | undefined;
  db.close();
  console.log(row ? `knowledge: saved (${row.status})` : 'knowledge: NOT saved');
  ok = (result as any).stopReason === 'end_turn' && !!row;
} catch (err) {
  console.error(err);
} finally {
  ws.close();
  serve.kill('SIGTERM');
  await new Promise((r) => serve.once('exit', r));
  rmSync(root, { recursive: true, force: true });
}
console.log(ok ? 'SMOKE OK' : 'SMOKE FAILED');
process.exit(ok ? 0 : 1);
