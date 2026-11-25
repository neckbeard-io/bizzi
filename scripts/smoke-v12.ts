// Offline end-to-end smoke for protocol 1.2, everything through a real hub as a paired device:
//   hub (bizzi hub serve) ← node (bizzi serve --connect --fake) in temp dirs, no agent logins needed.
// Covers worktree.create/remove on a git workspace, a shell session with session.markSeen seen by a
// second device, a command widget dropped at runtime (widget.updated via the hub) that feeds usage.list
// through billing.account, hub-stored themes, orchestration settings, agents.list decorations, and the
// bizzi-agents MCP endpoint called by a (fake) structured agent with its own session token, and the
// workspace picker (fs.browse / fs.complete / fs.suggest), and a pipeline (plan → gate → implement in a
// worktree → review) started on device A and approved on device B.
//
//   node scripts/smoke-v12.ts            # or: npm run smoke:v12

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reviewPipeline } from '@bizzi/client';
import { pairWithHub, requestToken, type PairedDevice } from '@bizzi/hub';
import { check, Client, Procs, step, until, validateTraffic } from './smoke-lib.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'bizzi-v12smoke-')));
const procs = new Procs();
const HELLO = { protocol: 'bizzi/1', client: { name: 'smoke-v12', version: '0' } };

async function connect(device: PairedDevice, hubUrl: string): Promise<Client> {
  const { token } = await requestToken({ hubUrl, deviceId: device.credential.deviceId, privateKey: device.credential.privateKey });
  const c = await Client.open(device.response.clientUrl);
  await c.call('hello', { ...HELLO, token });
  return c;
}

function git(cwd: string, ...args: string[]): string {
  const env = { ...process.env, GIT_AUTHOR_NAME: 's', GIT_AUTHOR_EMAIL: 's@example.invalid', GIT_COMMITTER_NAME: 's', GIT_COMMITTER_EMAIL: 's@example.invalid' };
  return execFileSync('git', ['-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args], { cwd, env, encoding: 'utf8' });
}

/** Sends one turn to a structured session and resolves with its events once turn.completed arrives. */
async function turn(c: Client, sessionId: string, text: string): Promise<any[]> {
  const ch = `session:${sessionId}`;
  const events: any[] = [];
  const done = c.next(
    (e) => {
      if (e.ch === ch) events.push(e);
      return e.ch === ch && e.type === 'turn.completed';
    },
    `turn "${text.slice(0, 40)}"`,
    60_000,
  );
  await c.call('session.send', { sessionId, input: [{ type: 'text', text }] });
  await done;
  return events;
}

function mcpResult(events: any[]): any {
  const done = events.find((e) => e.type === 'tool.completed');
  check(done, 'the fake agent called the MCP tool');
  check(done.data.status === 'ok', `MCP tool ok (${done.data.status}: ${done.data.error ?? done.data.output})`);
  return JSON.parse(done.data.output);
}

let ok = false;
try {
  // ---- hub + two devices
  const hub = await procs.start(['hub', 'serve', '--host', '127.0.0.1', '--port', '0', '--data-dir', join(root, 'hub')]);
  const hubUrl: string = hub.ready.url;
  const setupCode = readFileSync(join(root, 'hub', 'setup-code'), 'utf8').trim();
  const phone = await pairWithHub({ hubUrl, code: setupCode, kind: 'device', name: 'smoke-phone' });
  const a = await connect(phone, hubUrl);
  const { code: laptopCode } = await a.call('pairing.create', { kind: 'device', name: 'smoke-laptop' });
  const laptop = await pairWithHub({ hubUrl, code: laptopCode, kind: 'device', name: 'smoke-laptop' });
  const b = await connect(laptop, hubUrl);
  await a.call('subscribe', { ch: 'global', since: 0 });
  await b.call('subscribe', { ch: 'global', since: 0 });
  step(`hub up at ${hubUrl}; two devices paired`);

  // ---- node with fake adapters, widgets in a temp dir
  const widgetsDir = join(root, 'widgets');
  const { code } = await a.call('pairing.create', { kind: 'node', name: 'smoke-node' });
  const node = await procs.start(
    ['serve', '--port', '0', '--data-dir', join(root, 'node'), '--name', 'smoke-node', '--fake', '--widgets-dir', widgetsDir, '--connect', phone.response.nodeUrl],
    { BIZZI_PAIR_CODE: code },
  );
  const machineId: string = node.ready.machineId;
  await until(async () => (await a.call('machines.list', {})).machines.some((m: any) => m.id === machineId && m.online), 'node online');
  step(`node ${machineId} online through the hub`);

  // ---- agents.list: support and policy decorations
  const { agents } = await a.call('agents.list', { machineId });
  const shell = agents.find((x: any) => x.agent === 'shell');
  check(shell?.installed, 'shell agent listed');
  const decorated = agents.filter((x: any) => x.updatePolicy && x.restartPolicy);
  check(decorated.length > 0, 'agents.list carries update/restart policies');
  step(`agents.list: ${agents.map((x: any) => `${x.agent}${x.installed ? '' : '(missing)'}${x.support ? `[${x.support}]` : ''}`).join(' ')}; policies on ${decorated.length}`);
  const { agent: pinned } = await a.call('agent.policy.set', { machineId, agent: 'claude', update: 'pinned', restart: 'manual' });
  check(pinned.updatePolicy === 'pinned' && pinned.restartPolicy === 'manual', 'agent.policy.set round-trips');
  step('agent.policy.set → pinned/manual');

  // ---- git workspace and worktrees
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q');
  writeFileSync(join(repo, 'README.md'), '# smoke\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  const { workspace: ws } = await a.call('workspace.create', { machineId, path: repo, name: 'repo' });
  check(ws.kind === 'git', `workspace kind git (got ${ws.kind})`);
  const seenByB = b.next((e) => e.type === 'workspace.created' && e.data.workspace.kind === 'worktree', 'workspace.created (worktree) on device B');
  const { workspace: wt } = await a.call('worktree.create', { workspaceId: ws.id, branch: 'smoke/wt' });
  check(wt.kind === 'worktree' && wt.parentWorkspaceId === ws.id && wt.branch === 'smoke/wt', 'worktree workspace shape');
  check(existsSync(join(wt.path, 'README.md')), 'worktree checked out');
  await seenByB;
  const listed = (await b.call('workspaces.list', { machineId })).workspaces.find((w: any) => w.id === wt.id);
  check(listed?.parentWorkspaceId === ws.id, 'device B lists the worktree under its repo');
  step(`worktree.create → ${wt.path} (branch ${wt.branch})`);
  writeFileSync(join(wt.path, 'dirty.txt'), 'x\n');
  let refused = '';
  try {
    await a.call('worktree.remove', { workspaceId: wt.id });
  } catch (err) {
    refused = (err as any).code;
  }
  check(refused === 'conflict', `worktree.remove refuses uncommitted changes (got ${refused || 'success'})`);
  const removedOnB = b.next((e) => e.type === 'workspace.removed' && e.data.workspaceId === wt.id, 'workspace.removed on device B');
  await a.call('worktree.remove', { workspaceId: wt.id, force: true });
  await removedOnB;
  check(!existsSync(wt.path), 'worktree directory removed');
  check(!(await b.call('workspaces.list', { machineId })).workspaces.some((w: any) => w.id === wt.id), 'hub forgot the worktree workspace');
  check(git(repo, 'branch', '--list', 'smoke/wt').includes('smoke/wt'), 'branch kept');
  step('worktree.remove: refused while dirty, then forced; branch kept');

  // ---- workspace picker: fs.browse / fs.complete / fs.suggest through the hub
  const tree = join(root, 'browse');
  mkdirSync(join(tree, 'apps', 'web', '.git'), { recursive: true });
  mkdirSync(join(tree, 'apps', 'Worker'), { recursive: true });
  mkdirSync(join(tree, '.cache'), { recursive: true });
  writeFileSync(join(tree, 'apps', 'readme.txt'), 'x\n');
  const browsed = await a.call('fs.browse', { machineId, path: join(tree, 'apps') });
  check(browsed.path === join(tree, 'apps') && browsed.parent === tree, `fs.browse path/parent (${browsed.path})`);
  check(
    JSON.stringify(browsed.entries.map((e: any) => [e.name, Boolean(e.git)])) === JSON.stringify([['web', true], ['Worker', false]]),
    `fs.browse lists directories only, with repo marks (${JSON.stringify(browsed.entries)})`,
  );
  const top = await a.call('fs.browse', { machineId, path: tree });
  check(!top.entries.some((e: any) => e.name === '.cache'), 'fs.browse hides dot-directories by default');
  check((await a.call('fs.browse', { machineId, path: tree, showHidden: true })).entries.some((e: any) => e.name === '.cache' && e.hidden), 'fs.browse showHidden');
  const home = await a.call('fs.browse', { machineId });
  check(home.path === home.home && home.path.length > 1, 'fs.browse defaults to home');
  const rootListing = await b.call('fs.browse', { machineId, path: root });
  check(rootListing.entries.some((e: any) => e.name === 'repo' && e.git && e.workspaceId === ws.id), 'fs.browse marks the existing workspace');
  const comp = await a.call('fs.complete', { machineId, prefix: join(tree, 'apps', 'w') });
  check(comp.base === join(tree, 'apps') + '/', `fs.complete base (${comp.base})`);
  check(comp.completions[0]?.name === 'web', `fs.complete exact-case match first (${comp.completions.map((e: any) => e.name).join(',')})`);
  const tilde = await a.call('fs.complete', { machineId, prefix: '~/', limit: 3 });
  check(tilde.base === '~/' && tilde.completions.length <= 3, 'fs.complete keeps ~/ and honours limit');
  const { entries: suggested } = await a.call('fs.suggest', { machineId });
  check(suggested[0]?.suggest === 'home' && suggested.some((e: any) => e.suggest === 'recent' && e.path === root), 'fs.suggest: home and the parent of the repo workspace');
  let missing = '';
  try {
    await a.call('fs.browse', { machineId, path: join(tree, 'nope') });
  } catch (err) {
    missing = (err as any).code;
  }
  check(missing === 'not_found', `fs.browse of a missing path → not_found (got ${missing || 'success'})`);
  step(`fs.browse/complete/suggest through the hub: ${browsed.entries.length} dirs, completion ${comp.base}${comp.completions[0]?.name}/, ${suggested.length} suggestions`);

  // ---- shell session + markSeen across devices
  const { session: sh } = await a.call('session.create', { workspaceId: ws.id, agent: 'shell', mode: 'terminal', cols: 80, rows: 24 });
  const shCh = `session:${sh.id}`;
  const out = a.next((e) => e.ch === shCh && e.type === 'term.output' && Buffer.from(e.data.dataBase64, 'base64').toString().includes('smoke-echo'), 'shell output');
  await a.call('subscribe', { ch: shCh, since: 0 });
  await a.call('term.input', { sessionId: sh.id, dataBase64: Buffer.from('smoke-echo\r').toString('base64') });
  const outEv = await out;
  const seenOnB = b.next((e) => e.type === 'session.updated' && e.data.session.id === sh.id && e.data.session.seenThrough === outEv.seq, 'session.updated with seenThrough on device B');
  const { seenThrough } = await a.call('session.markSeen', { sessionId: sh.id, seq: outEv.seq });
  check(seenThrough === outEv.seq, `markSeen returns seq (${seenThrough} vs ${outEv.seq})`);
  await seenOnB;
  const back = await a.call('session.markSeen', { sessionId: sh.id, seq: 1 });
  check(back.seenThrough === outEv.seq, 'markSeen never moves backwards');
  const viaB = (await b.call('sessions.list', { workspaceId: ws.id })).sessions.find((s: any) => s.id === sh.id);
  check(viaB?.seenThrough === outEv.seq, 'device B sessions.list shows seenThrough');
  step(`shell session ${sh.id}: markSeen ${outEv.seq} seen by device B`);

  // ---- command widget dropped at runtime → widget.updated via the hub, billing → usage.list
  const widgetSeen = b.next((e) => e.type === 'widget.updated' && e.data.widget.id === 'smoke-spend' && e.data.widget.value === 12.5, 'widget.updated on device B', 20_000);
  writeFileSync(
    join(widgetsDir, 'smoke-spend.json'),
    JSON.stringify({
      label: 'spend',
      kind: 'meter',
      every: '1h',
      format: 'usd',
      source: { type: 'command', command: [process.execPath, '-e', 'console.log(JSON.stringify({ value: 12.5, max: 50 }))'] },
      billing: { account: 'claude-via-smoke', label: 'smoke litellm' },
    }),
  );
  const wEv = await widgetSeen;
  check(wEv.data.widget.machineId === machineId && wEv.data.widget.max === 50, 'widget value relayed with machineId');
  const { widgets } = await a.call('widgets.list', {});
  check(widgets.some((w: any) => w.id === 'smoke-spend' && w.value === 12.5), 'widgets.list on the hub');
  const accounts = await until(async () => {
    const r = await a.call('usage.list', {});
    return r.accounts.find((u: any) => u.accountId === 'claude-via-smoke');
  }, 'usage.list account from the widget');
  check(accounts.agent === 'claude' && accounts.spend?.usd === 12.5 && accounts.spend?.capUsd === 50, 'usage.list spend from billing.account');
  check(accounts.machines.includes(machineId), 'usage.list names the machine');
  const refreshed = await a.call('widget.refresh', { machineId, widgetId: 'smoke-spend' });
  check(refreshed.widget.value === 12.5, 'widget.refresh through the hub');
  step(`widget smoke-spend → widget.updated on device B, usage.list ${accounts.label}: $${accounts.spend.usd}/$${accounts.spend.capUsd}`);
  const widgetGone = b.next((e) => e.type === 'widget.removed' && e.data.widgetId === 'smoke-spend' && e.data.machineId === machineId, 'widget.removed on device B', 20_000);
  rmSync(join(widgetsDir, 'smoke-spend.json'));
  await widgetGone;
  check(!(await a.call('widgets.list', {})).widgets.some((w: any) => w.id === 'smoke-spend'), 'hub widget cache dropped the widget');
  step('widget file deleted → widget.removed on device B');

  // ---- themes on the hub
  const { theme } = await a.call('theme.save', { name: 'Smoke Dark', data: { mode: 'dark', tones: { bg: '#000000' } } });
  check((await b.call('themes.list', {})).themes.some((t: any) => t.id === theme.id && t.name === 'Smoke Dark'), 'device B sees the saved theme');
  await a.call('theme.delete', { id: theme.id });
  check(!(await b.call('themes.list', {})).themes.some((t: any) => t.id === theme.id), 'theme deleted');
  step(`themes: saved ${theme.id}, listed on device B, deleted`);

  // ---- user-wide prefs on the hub (theme choice synced across devices)
  const prefsSeen = b.next((e) => e.type === 'prefs.updated' && e.data.prefs.themeId === 'nord', 'prefs.updated on device B');
  await a.call('prefs.set', { prefs: { themeId: 'nord' } });
  await prefsSeen;
  check((await b.call('prefs.get', {})).prefs.themeId === 'nord', 'device B reads the shared theme choice');
  step('prefs: theme choice set on device A → prefs.updated on device B');

  // ---- orchestration settings (machine and workspace)
  const { settings: before } = await a.call('orchestration.settings.get', { machineId });
  const { settings: after } = await a.call('orchestration.settings.set', { machineId, settings: { maxHelpersPerParent: 2 } });
  check(after.maxHelpersPerParent === 2 && after.maxDepth === before.maxDepth, 'machine settings merge');
  const { settings: wsSet } = await a.call('orchestration.settings.set', { workspaceId: ws.id, settings: { onLimit: 'queue' } });
  check(wsSet.onLimit === 'queue' && wsSet.maxHelpersPerParent === 2, 'workspace override over machine settings');
  const { settings: wsGet } = await b.call('orchestration.settings.get', { workspaceId: ws.id });
  check(wsGet.onLimit === 'queue', 'workspace settings visible to device B');
  const { settings: machineGet } = await b.call('orchestration.settings.get', { machineId });
  check(machineGet.onLimit === before.onLimit, 'workspace override does not leak to the machine');
  step(`orchestration settings: machine maxHelpersPerParent ${before.maxHelpersPerParent}→2, workspace onLimit queue`);

  // ---- bizzi-agents MCP: a fake structured agent calls the tools with its own session token
  const { session: parent } = await a.call('session.create', { workspaceId: ws.id, agent: 'claude' });
  await a.call('subscribe', { ch: `session:${parent.id}`, since: 0 });
  const started = mcpResult(await turn(a, parent.id, '/mcp bizzi-agents session_start {"agent":"claude","prompt":"hello helper","title":"smoke helper"}'));
  const helperId: string = started.structuredContent?.sessionId;
  check(helperId, `session_start returned a sessionId (${JSON.stringify(started).slice(0, 200)})`);
  const helpers = (await b.call('sessions.list', { machineId, spawnedBy: parent.id })).sessions;
  check(helpers.length === 1 && helpers[0].id === helperId && helpers[0].depth === 1, 'device B lists the helper via spawnedBy');
  const waited = mcpResult(await turn(a, parent.id, `/mcp bizzi-agents session_wait {"sessionId":"${helperId}","until":"done","timeout":20}`));
  check(waited.structuredContent?.reached === true, `session_wait reached (${JSON.stringify(waited.structuredContent)})`);
  const read = mcpResult(await turn(a, parent.id, `/mcp bizzi-agents session_read {"sessionId":"${helperId}"}`));
  check(JSON.stringify(read).includes('echo: hello helper'), `session_read has the helper's answer (${JSON.stringify(read).slice(0, 300)})`);
  const listedMcp = mcpResult(await turn(a, parent.id, '/mcp bizzi-agents sessions_list'));
  check(listedMcp.structuredContent?.helpers?.length === 1, 'sessions_list shows one helper');
  step(`bizzi-agents: session_start → ${helperId}, session_wait done, session_read "echo: hello helper"`);
  await a.call('session.stop', { sessionId: parent.id });
  await until(async () => {
    const { session } = await b.call('session.get', { sessionId: helperId });
    return session.status === 'ended' || session.status === 'failed';
  }, 'child helper stopped with its parent');
  step('session.stop on the parent cascades to its child helper');

  // ---- pipelines (docs/pipelines.md): the built-in planner → implementer → reviewer, through the hub
  const plSpec = reviewPipeline({ planner: 'claude', implementer: 'claude', reviewer: 'claude' });
  const gateOnB = b.next((e) => e.type === 'pipeline.updated' && e.data.pipeline.status === 'waiting', 'pipeline gate on device B', 20_000);
  const { pipeline: pl } = await a.call('pipeline.start', { workspaceId: ws.id, spec: plSpec, task: 'add a smoke file' });
  check(pl.id.startsWith('pl_') && pl.machineId === machineId, `pipeline.start through the hub (${pl.id})`);
  const gateEv = await gateOnB;
  check(gateEv.data.pipeline.id === pl.id && gateEv.data.pipeline.gate?.stage === 1 && gateEv.data.pipeline.stages[0].status === 'done', 'run waits at the implement gate after the plan');
  check((await b.call('pipelines.list', { machineId })).pipelines.some((p: any) => p.id === pl.id && p.status === 'waiting'), 'device B lists the waiting run');
  step(`pipeline ${pl.id}: plan done, waiting at "${gateEv.data.pipeline.gate.message}"`);
  const doneOnA = a.next((e) => e.type === 'pipeline.updated' && e.data.pipeline.id === pl.id && e.data.pipeline.status === 'done', 'pipeline done on device A', 30_000);
  await b.call('pipeline.gate', { machineId, pipelineId: pl.id, decision: 'approve', message: 'smoke note' });
  const plDone = (await doneOnA).data.pipeline;
  check(plDone.stages.every((s: any) => s.status === 'done'), `every stage done (${plDone.stages.map((s: any) => s.status).join(',')})`);
  const plWt = (await a.call('workspaces.list', { machineId })).workspaces.find((w: any) => w.id === plDone.worktreeId);
  check(plWt?.kind === 'worktree' && plWt.parentWorkspaceId === ws.id && existsSync(plWt.path), 'implement and review ran in the pipeline worktree');
  const implId: string = plDone.stages[1].sessionId;
  const { session: implSession } = await b.call('session.get', { sessionId: implId });
  check(implSession.group === pl.id && implSession.workspaceId === plWt.id, 'stage session carries the pipeline as group, in the worktree');
  const implCh = `session:${implId}`;
  const implTurn = a.next((e) => e.ch === implCh && e.type === 'turn.started', 'implement prompt');
  await a.call('subscribe', { ch: implCh, since: 0 });
  const implText: string = (await implTurn).data.input[0].text;
  check(implText.includes('echo: Plan this task') && implText.includes('add a smoke file'), 'implement prompt carries the task and the plan stage result');
  check(implText.endsWith('Note from the user: smoke note'), 'the gate note reaches the implement stage');
  const removedPl = b.next((e) => e.type === 'pipeline.removed' && e.data.pipelineId === pl.id, 'pipeline.removed on device B');
  await a.call('pipeline.delete', { machineId, pipelineId: pl.id });
  await removedPl;
  step(`pipeline approved on device B → implement (gate note in its prompt) and review in ${plWt.branch}; deleted`);

  // ---- everything both devices sent and received matches docs/protocol.schema.json
  const schema = JSON.parse(readFileSync(new URL('../docs/protocol.schema.json', import.meta.url), 'utf8'));
  const frames = [...a.traffic, ...b.traffic];
  const problems = validateTraffic(schema, frames);
  for (const p of problems) console.error(`  schema: ${p}`);
  check(problems.length === 0, `${problems.length} frame(s) don't match docs/protocol.schema.json`);
  step(`${frames.length} frames match docs/protocol.schema.json`);

  a.close();
  b.close();
  ok = true;
} catch (err) {
  console.error(err);
} finally {
  await procs.stopAll();
  rmSync(root, { recursive: true, force: true });
}
console.log(ok ? 'V12 SMOKE OK' : 'V12 SMOKE FAILED');
process.exit(ok ? 0 : 1);
