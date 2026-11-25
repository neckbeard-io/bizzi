// Fork to another machine (topology.md §6): carry a session's work to machine B as a new session there.
//
// The source node snapshots the workspace (a git repository: the branch plus uncommitted and untracked
// changes as one snapshot commit, built in a temporary index so nothing in the work tree or the real
// index changes; a plain directory: a commit in a shadow repository under the node's data dir), sends
// it to B through the hub as a git bundle (thin when B already has part of the history), and asks B to
// start a session seeded with a brief from the original's timeline. The original keeps running.
//
//   A: session.forkTo ──▶ hub ──▶ B: fork.prepare   (where it lands, which commits B already has)
//   A: snapshot + bundle
//   A ──▶ hub ──▶ B: fork.receive (bundle, brief) → branch + worktree / clone / directory, new session

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
  AGENT_KINDS,
  BizziError,
  sessionChannel,
  type AgentKind,
  type ChannelEvent,
  type ForkSessionSpec,
  type ForkSource,
  type ForkTarget,
  type ForkTransfer,
  type Logger,
  type MachineInfo,
  type MethodParams,
  type MethodResult,
  type NodeCaller,
  type SessionInfo,
  type WorkspaceInfo,
} from '@bizzi/protocol';
import type { AdapterRegistry } from './agents.ts';
import type { EventBus } from './bus.ts';
import { branchExists, gitToplevel, isValidBranchName, normalizeRemoteUrl, originUrl, runGitWith, type GitResult } from './git.ts';
import type { HubPort } from './hub-port.ts';
import { linkedWorkspace } from './orchestration.ts';
import type { Sessions } from './sessions.ts';
import { expandHome, sanitizeBranch, type Workspaces } from './workspaces.ts';

/** Largest bundle sent through the hub (base64 adds a third; the links carry up to 64 MiB a frame). */
export const MAX_FORK_BUNDLE_BYTES = 32 * 1024 * 1024;
const PREPARE_TIMEOUT_MS = 60_000;
const RECEIVE_TIMEOUT_MS = 300_000;
const MAX_HEADS = 256;
/** Snapshot commits are bizzi's, not the user's: a fixed identity, so they work without git config. */
const IDENT = {
  GIT_AUTHOR_NAME: 'bizzi',
  GIT_AUTHOR_EMAIL: 'bizzi@localhost',
  GIT_COMMITTER_NAME: 'bizzi',
  GIT_COMMITTER_EMAIL: 'bizzi@localhost',
};

export interface ForksDeps {
  sessions: Sessions;
  workspaces: Workspaces;
  registry: AdapterRegistry;
  bus: EventBus;
  hub: HubPort;
  machine: MachineInfo;
  /** The node's data directory: shadow repositories for plain-directory workspaces live under it. */
  dataDir: string;
  logger: Logger;
}

interface Snapshot {
  /** Where git runs, plus GIT_DIR/GIT_WORK_TREE for shadow repositories. */
  cwd: string;
  env: Record<string, string>;
  commit: string;
  sourceBranch?: string;
  uncommitted: boolean;
  /** A temporary ref pointing at `commit` (bundles need a ref); deleted afterwards. */
  ref: string;
}

export class Forks {
  readonly #d: ForksDeps;
  readonly #log: Logger;

  constructor(deps: ForksDeps) {
    this.#d = deps;
    this.#log = deps.logger.child({ component: 'fork' });
  }

  // --- source side --------------------------------------------------------------------------------------

  async forkTo(p: MethodParams<'session.forkTo'>): Promise<MethodResult<'session.forkTo'>> {
    const { sessions, workspaces, hub } = this.#d;
    const src = sessions.get(p.sessionId).session;
    if (typeof p.toMachineId !== 'string' || !p.toMachineId) throw new BizziError('bad_request', 'toMachineId is required');
    const agent = p.agent ?? src.agent;
    if (!AGENT_KINDS.includes(agent)) throw new BizziError('bad_request', `unknown agent ${String(agent)}`);
    for (const k of ['toWorkspaceId', 'toPath', 'title', 'prompt', 'branch'] as const) {
      if (p[k] !== undefined && typeof p[k] !== 'string') throw new BizziError('bad_request', `${k} must be a string`);
    }
    const ws = workspaces.get(src.workspaceId);
    const machine = await this.#targetMachine(p.toMachineId);

    const source: ForkSource = { kind: ws.kind === 'dir' ? 'dir' : 'git', name: ws.name };
    if (ws.projectId) source.projectId = ws.projectId;
    if (source.kind === 'git') {
      const url = await originUrl(ws.path);
      if (url) {
        source.gitRemote = normalizeRemoteUrl(url);
        source.gitRemoteUrl = url;
      }
    }
    const target: ForkTarget = {};
    if (p.toWorkspaceId) target.toWorkspaceId = p.toWorkspaceId;
    if (p.toPath) target.toPath = p.toPath;

    const prep = await hub.request<MethodResult<'fork.prepare'>>(
      'fork.prepare',
      { machineId: machine.id, ...target, source, agent },
      { timeoutMs: PREPARE_TIMEOUT_MS },
    );
    const landing: ForkTarget = prep.path ? { toPath: prep.path } : prep.workspaceId ? { toWorkspaceId: prep.workspaceId } : target;

    const tmp = await mkdtemp(join(os.tmpdir(), 'bizzi-fork-'));
    let snap: Snapshot | undefined;
    try {
      snap = source.kind === 'git' ? await snapshotGit(ws.path, tmp, src.id) : await snapshotDir(this.#shadowDir(ws.path), ws.path, tmp, src.id);
      const haves = await existingCommits(snap, Array.isArray(prep.heads) ? prep.heads.slice(0, MAX_HEADS) : []);
      const missing = await git(snap, ['rev-list', '--count', snap.commit, ...(haves.length ? ['--not', ...haves] : [])]);
      let bundleBase64: string | undefined;
      let bytes = 0;
      if (Number(missing.stdout.trim()) > 0 || !landing.toWorkspaceId) {
        const file = join(tmp, 'fork.bundle');
        const b = await git(snap, ['bundle', 'create', file, snap.ref, ...(landing.toWorkspaceId && haves.length ? ['--not', ...haves] : [])]);
        if (b.code !== 0) throw new BizziError('internal', `git bundle failed: ${b.stderr.trim() || b.code}`);
        bytes = (await stat(file)).size;
        if (bytes > MAX_FORK_BUNDLE_BYTES) {
          throw new BizziError(
            'conflict',
            `the workspace state is ${mb(bytes)} as a bundle, more than the ${mb(MAX_FORK_BUNDLE_BYTES)} a fork sends through the hub; push the branch to a shared remote and fork into a workspace that has it`,
            { bytes, max: MAX_FORK_BUNDLE_BYTES },
          );
        }
        bundleBase64 = (await readFile(file)).toString('base64');
      }

      const transfer: ForkTransfer = { kind: source.kind === 'git' ? 'git' : 'snapshot', commit: snap.commit, uncommitted: snap.uncommitted, bytes };
      if (snap.sourceBranch) transfer.sourceBranch = snap.sourceBranch;
      if (source.kind === 'git') {
        const branch = p.branch?.trim() || `fork/${sanitizeBranch(snap.sourceBranch ?? ws.name)}-${src.id.slice(-6).toLowerCase()}`;
        if (!(await isValidBranchName(snap.cwd, branch))) throw new BizziError('bad_request', `invalid branch name: ${branch}`);
        transfer.branch = branch;
      }

      const spec: ForkSessionSpec = { agent, forkedFrom: src.id, title: p.title?.trim() || `${src.title || 'Session'} (fork)` };
      if (agent === src.agent) {
        if (src.model) spec.model = src.model;
        if (src.permissionMode) spec.permissionMode = src.permissionMode;
        if (src.effort) spec.effort = src.effort;
      }
      const brief = buildBrief({
        session: src,
        machine: this.#d.machine,
        to: machine,
        workspace: ws,
        events: this.#d.bus.replay(sessionChannel(src.id), 0),
        pending: sessions.pending(src.id),
        transfer,
        ...(p.prompt?.trim() ? { prompt: p.prompt.trim() } : {}),
      });
      const res = await hub.request<MethodResult<'fork.receive'>>(
        'fork.receive',
        {
          machineId: machine.id,
          ...landing,
          source,
          transfer,
          ...(bundleBase64 !== undefined ? { bundleBase64, bundleRef: snap.ref } : {}),
          session: spec,
          brief,
        },
        { timeoutMs: RECEIVE_TIMEOUT_MS },
      );
      this.#log.log('info', 'forked to machine', { sessionId: src.id, machineId: machine.id, newSessionId: res.session.id, bytes, kind: transfer.kind });
      try {
        sessions.emit(src.id, {
          type: 'agent.raw',
          data: {
            agent: src.agent,
            payload: {
              type: 'bizzi.forkTo',
              machineId: machine.id,
              sessionId: res.session.id,
              message: `Forked to ${machine.name} as session ${res.session.id}${transfer.branch ? ` on branch ${transfer.branch}` : ''}.`,
            },
          },
        });
      } catch {
        // the source may have been deleted meanwhile
      }
      return { ...res, transfer };
    } finally {
      if (snap) await git(snap, ['update-ref', '-d', snap.ref]).catch(() => undefined);
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // --- target side (called through the hub) ---------------------------------------------------------------

  async prepare(caller: NodeCaller | undefined, p: MethodParams<'fork.prepare'>): Promise<MethodResult<'fork.prepare'>> {
    callerMachine(caller);
    const source = checkSource(p.source);
    this.#assertStartable(p.agent);
    if (p.toPath !== undefined) return { path: await freshDir(p.toPath), heads: [] };
    if (source.kind === 'dir') {
      throw new BizziError('bad_request', `a plain-directory workspace forks into a new directory: pass toPath (a new or empty directory on ${this.#d.machine.name})`);
    }
    const repo = await this.#targetRepo(p.toWorkspaceId, source);
    const r = await runGitWith(repo.path, ['for-each-ref', '--sort=-committerdate', `--count=${MAX_HEADS}`, '--format=%(objectname)', 'refs/heads', 'refs/remotes', 'refs/tags']);
    const heads = r.code === 0 ? [...new Set(r.stdout.split('\n').map((l) => l.trim()).filter(isSha))] : [];
    return { workspaceId: repo.id, heads };
  }

  async receive(caller: NodeCaller | undefined, p: MethodParams<'fork.receive'>): Promise<MethodResult<'fork.receive'>> {
    const from = callerMachine(caller);
    const source = checkSource(p.source);
    const t = p.transfer;
    if (!t || typeof t !== 'object' || !isSha(t.commit)) throw new BizziError('bad_request', 'transfer.commit must be a commit id');
    const spec = p.session;
    if (!spec || typeof spec !== 'object' || typeof spec.forkedFrom !== 'string') throw new BizziError('bad_request', 'session is required');
    this.#assertStartable(spec.agent);
    if (typeof p.brief !== 'string' || !p.brief.trim()) throw new BizziError('bad_request', 'brief is required');
    if (p.bundleBase64 !== undefined && (typeof p.bundleBase64 !== 'string' || typeof p.bundleRef !== 'string' || !p.bundleRef.startsWith('refs/'))) {
      throw new BizziError('bad_request', 'bundleBase64 needs bundleRef');
    }

    const tmp = await mkdtemp(join(os.tmpdir(), 'bizzi-fork-in-'));
    try {
      let bundle: string | undefined;
      if (p.bundleBase64 !== undefined) {
        const buf = Buffer.from(p.bundleBase64, 'base64');
        if (buf.length > MAX_FORK_BUNDLE_BYTES) throw new BizziError('bad_request', 'bundle too large');
        bundle = join(tmp, 'fork.bundle');
        await writeFile(bundle, buf);
      }
      const workspace = source.kind === 'git' ? await this.#receiveGit(p, source, t, bundle) : await this.#receiveDir(p, source, t, bundle, tmp);
      const params: MethodParams<'session.create'> = { workspaceId: workspace.id, agent: spec.agent };
      if (spec.model) params.model = spec.model;
      if (spec.permissionMode) params.permissionMode = spec.permissionMode;
      if (spec.effort) params.effort = spec.effort;
      if (spec.title) params.title = spec.title;
      const session = await this.#d.sessions.create(params, undefined, { forkedFrom: spec.forkedFrom, forkedFromMachineId: from });
      try {
        await this.#d.sessions.send(session.id, [{ type: 'text', text: p.brief }]);
      } catch (err) {
        this.#log.log('warn', 'fork brief could not be sent', { sessionId: session.id, err });
      }
      this.#log.log('info', 'fork received', { sessionId: session.id, from, forkedFrom: spec.forkedFrom, workspaceId: workspace.id });
      return { session: this.#d.sessions.get(session.id).session, workspace };
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // --- internals ------------------------------------------------------------------------------------------

  async #receiveGit(p: MethodParams<'fork.receive'>, source: ForkSource, t: ForkTransfer, bundle: string | undefined): Promise<WorkspaceInfo> {
    const branch = t.branch;
    if (typeof branch !== 'string' || !branch) throw new BizziError('bad_request', 'transfer.branch is required for a git fork');
    if (p.toPath !== undefined) {
      if (!bundle) throw new BizziError('bad_request', 'a fork into a new directory needs the bundle');
      const path = await freshDir(p.toPath);
      await mkdir(path, { recursive: true });
      await must(runGitWith(path, ['init', '-q']), 'git init');
      if (!(await isValidBranchName(path, branch))) throw new BizziError('bad_request', `invalid branch name: ${branch}`);
      await must(runGitWith(path, ['fetch', '-q', '--no-tags', bundle, `${p.bundleRef}:refs/heads/${branch}`]), 'git fetch from the bundle');
      await must(runGitWith(path, ['checkout', '-q', branch]), 'git checkout');
      if (source.gitRemoteUrl) await runGitWith(path, ['remote', 'add', 'origin', source.gitRemoteUrl]).catch(() => undefined);
      return this.#d.workspaces.create({ path, name: source.name });
    }
    const repo = await this.#targetRepo(p.toWorkspaceId, source);
    const top = (await gitToplevel(repo.path)) ?? repo.path;
    if (!(await isValidBranchName(top, branch))) throw new BizziError('bad_request', `invalid branch name: ${branch}`);
    if (await branchExists(top, branch)) throw new BizziError('conflict', `branch ${branch} already exists on ${this.#d.machine.name}; pick another branch`);
    if (bundle) {
      await must(runGitWith(top, ['fetch', '-q', '--no-tags', bundle, `${p.bundleRef}:refs/heads/${branch}`]), 'git fetch from the bundle');
    } else {
      await must(runGitWith(top, ['cat-file', '-e', `${t.commit}^{commit}`]), `commit ${t.commit.slice(0, 12)} on ${this.#d.machine.name}`);
      await must(runGitWith(top, ['branch', branch, t.commit]), 'git branch');
    }
    return this.#d.workspaces.createWorktree({ workspaceId: repo.id, branch });
  }

  async #receiveDir(p: MethodParams<'fork.receive'>, source: ForkSource, t: ForkTransfer, bundle: string | undefined, tmp: string): Promise<WorkspaceInfo> {
    if (p.toPath === undefined) throw new BizziError('bad_request', 'a plain-directory fork needs toPath');
    if (!bundle) throw new BizziError('bad_request', 'a plain-directory fork needs the bundle');
    const path = await freshDir(p.toPath);
    await mkdir(path, { recursive: true });
    const shadow = this.#shadowDir(await realpath(path));
    await mkdir(shadow, { recursive: true });
    await must(runGitWith(shadow, ['init', '-q', '--bare']), 'git init (shadow)');
    const env = { GIT_DIR: shadow, GIT_WORK_TREE: path, GIT_INDEX_FILE: join(tmp, 'index') };
    await must(runGitWith(path, ['fetch', '-q', '--no-tags', bundle, `${p.bundleRef}:refs/heads/snapshots`], { env }), 'git fetch from the bundle');
    await must(runGitWith(path, ['read-tree', t.commit], { env }), 'git read-tree');
    await must(runGitWith(path, ['checkout-index', '-a', '-f'], { env }), 'git checkout-index');
    return this.#d.workspaces.create({ path, name: source.name });
  }

  /** The repository workspace a git fork lands in: the given one, else the one linked to the source. */
  async #targetRepo(toWorkspaceId: string | undefined, source: ForkSource): Promise<WorkspaceInfo> {
    const workspaces = this.#d.workspaces;
    if (toWorkspaceId !== undefined) {
      let ws = workspaces.get(toWorkspaceId);
      if (ws.kind === 'worktree' && ws.parentWorkspaceId) ws = workspaces.get(ws.parentWorkspaceId);
      if (ws.kind !== 'git') throw new BizziError('bad_request', `workspace ${ws.name} is not a git repository; pass toPath for a new directory instead`);
      return ws;
    }
    const linked = await linkedWorkspace(workspaces.list(), source);
    if (linked) return linked;
    throw new BizziError(
      'bad_request',
      `no workspace on ${this.#d.machine.name} is linked to ${source.name} (same project or origin); pass toWorkspaceId, or toPath for a fresh clone`,
    );
  }

  async #targetMachine(ref: string): Promise<MachineInfo> {
    const self = this.#d.machine;
    if (ref === self.id || ref.toLowerCase() === self.name.toLowerCase()) {
      throw new BizziError('bad_request', 'that is this machine; use session.fork to fork here');
    }
    const { machines } = await this.#d.hub.request<{ machines: MachineInfo[] }>('machines.list', {});
    const m = machines.find((x) => x.id === ref) ?? machines.find((x) => x.name.toLowerCase() === ref.toLowerCase());
    if (!m) throw new BizziError('not_found', `machine ${ref} not found`);
    if (m.id === self.id) throw new BizziError('bad_request', 'that is this machine; use session.fork to fork here');
    if (!m.online) throw new BizziError('machine_offline', `machine ${m.name} is offline`, { machineId: m.id, lastSeenAt: m.lastSeenAt });
    return m;
  }

  #assertStartable(agent: AgentKind | undefined): void {
    if (!agent || !AGENT_KINDS.includes(agent)) throw new BizziError('bad_request', `unknown agent ${String(agent)}`);
    const mode = this.#d.registry.defaultMode(agent);
    if (!mode || !this.#d.registry.select(agent, mode)) throw new BizziError('agent_unavailable', `${agent} is not available on ${this.#d.machine.name}`);
    this.#d.registry.assertStartable(agent, mode);
  }

  /** Shadow repository for a plain directory: `<dataDir>/shadow/<hash of the path>.git`. */
  #shadowDir(path: string): string {
    const h = createHash('sha256').update(path).digest('hex').slice(0, 24);
    return join(this.#d.dataDir, 'shadow', `${h}.git`);
  }
}

// --- snapshots -----------------------------------------------------------------------------------------------

function git(s: Snapshot, args: string[], input?: string): Promise<GitResult> {
  return runGitWith(s.cwd, args, { env: s.env, ...(input !== undefined ? { input } : {}) });
}

async function must(p: Promise<GitResult>, what: string): Promise<GitResult> {
  const r = await p;
  if (r.code !== 0) throw new BizziError('internal', `${what} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  return r;
}

/**
 * The work tree of a repository as a commit: HEAD when clean, else a snapshot commit on top of HEAD with
 * every uncommitted and untracked (not ignored) change. Built in a temporary index: the work tree, the
 * real index and the branch are untouched.
 */
export async function snapshotGit(dir: string, tmp: string, label: string): Promise<Snapshot> {
  const top = (await gitToplevel(dir)) ?? dir;
  const env = { ...IDENT, GIT_INDEX_FILE: join(tmp, 'index') };
  const s: Snapshot = { cwd: top, env, commit: '', uncommitted: false, ref: '' };
  const head = (await runGitWith(top, ['rev-parse', '-q', '--verify', 'HEAD^{commit}'])).stdout.trim();
  const branch = (await runGitWith(top, ['symbolic-ref', '-q', '--short', 'HEAD'])).stdout.trim();
  if (branch) s.sourceBranch = branch;
  if (head) await must(git(s, ['read-tree', head]), 'git read-tree');
  await must(git(s, ['add', '-A']), 'git add');
  const tree = (await must(git(s, ['write-tree']), 'git write-tree')).stdout.trim();
  const headTree = head ? (await runGitWith(top, ['rev-parse', `${head}^{tree}`])).stdout.trim() : '';
  if (head && tree === headTree) {
    s.commit = head;
  } else {
    const msg = `bizzi fork snapshot of session ${label}\n\nUncommitted and untracked changes${branch ? ` on ${branch}` : ''}, carried to another machine.`;
    s.commit = (await must(git(s, ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', msg]), 'git commit-tree')).stdout.trim();
    s.uncommitted = true;
  }
  s.ref = `refs/bizzi/fork/${label}-${Date.now().toString(36)}`;
  await must(git(s, ['update-ref', s.ref, s.commit]), 'git update-ref');
  return s;
}

/** A plain directory as a commit in its shadow repository (history kept on `refs/heads/snapshots`). */
export async function snapshotDir(shadow: string, dir: string, tmp: string, label: string): Promise<Snapshot> {
  const st = await stat(shadow).catch(() => undefined);
  if (!st) {
    await mkdir(shadow, { recursive: true });
    await must(runGitWith(shadow, ['init', '-q', '--bare']), 'git init (shadow)');
  }
  const env = { ...IDENT, GIT_DIR: shadow, GIT_WORK_TREE: dir, GIT_INDEX_FILE: join(tmp, 'index') };
  const s: Snapshot = { cwd: dir, env, commit: '', uncommitted: true, ref: '' };
  const prev = (await git(s, ['rev-parse', '-q', '--verify', 'refs/heads/snapshots'])).stdout.trim();
  await must(git(s, ['add', '-A']), 'git add');
  const tree = (await must(git(s, ['write-tree']), 'git write-tree')).stdout.trim();
  s.commit = (await must(git(s, ['commit-tree', tree, ...(prev ? ['-p', prev] : []), '-m', `bizzi fork snapshot of session ${label}`]), 'git commit-tree')).stdout.trim();
  await must(git(s, ['update-ref', 'refs/heads/snapshots', s.commit]), 'git update-ref');
  s.ref = `refs/bizzi/fork/${label}-${Date.now().toString(36)}`;
  await must(git(s, ['update-ref', s.ref, s.commit]), 'git update-ref');
  return s;
}

/** The subset of `shas` that are commits in the snapshot's repository (the bundle can exclude those). */
async function existingCommits(s: Snapshot, shas: string[]): Promise<string[]> {
  const list = shas.filter(isSha);
  if (list.length === 0) return [];
  const r = await git(s, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], list.join('\n') + '\n');
  if (r.code !== 0) return [];
  const out: string[] = [];
  for (const line of r.stdout.split('\n')) {
    const [sha, type] = line.trim().split(' ');
    if (sha && type === 'commit' && isSha(sha)) out.push(sha);
  }
  return out;
}

// --- the brief -----------------------------------------------------------------------------------------------

/**
 * What the new session is told (topology.md §6): where the work came from, the goal, the plan, files
 * touched, where it left off and open questions, from the original's timeline. No transcript.
 */
export function buildBrief(o: {
  session: SessionInfo;
  machine: MachineInfo;
  to: MachineInfo;
  workspace: WorkspaceInfo;
  events: ChannelEvent[];
  pending: ReturnType<Sessions['pending']>;
  transfer: ForkTransfer;
  prompt?: string;
}): string {
  const prompts: string[] = [];
  let plan: { text: string; status: string }[] = [];
  let last: string | undefined;
  const files = new Map<string, string>();
  for (const ev of o.events) {
    switch (ev.type) {
      case 'turn.started': {
        const text = ev.data.input.map((b) => (b.type === 'text' ? b.text : b.type === 'file' ? `[file ${b.path}]` : '[image]')).join('\n').trim();
        if (text) prompts.push(text);
        break;
      }
      case 'plan.updated':
        plan = ev.data.items.map((i) => ({ text: i.text, status: i.status }));
        break;
      case 'message.completed':
        if (ev.data.role === 'assistant' && !ev.data.parentToolId && ev.data.text.trim()) last = ev.data.text.trim();
        break;
      case 'file.changed':
        files.set(ev.data.path, files.get(ev.data.path) === 'created' && ev.data.change !== 'deleted' ? 'created' : ev.data.change);
        break;
    }
  }
  const t = o.transfer;
  const state =
    t.kind === 'git'
      ? `It is checked out here on branch \`${t.branch}\` at ${t.commit.slice(0, 12)}${t.sourceBranch ? ` (from \`${t.sourceBranch}\`)` : ''}${t.uncommitted ? '; the last commit is a bizzi snapshot of the uncommitted and untracked changes, so you may want to amend or reset it before committing your own work' : ''}.`
      : `It is a copy of the directory as it was (a snapshot, not a git repository).`;
  const out: string[] = [
    `# Continuing work from ${o.machine.name}`,
    '',
    `This session is a fork of "${o.session.title || 'Untitled session'}" (${o.session.agent}, session ${o.session.id}), which ran on ${o.machine.name} in ${o.workspace.path}. You are on ${o.to.name}; the original session stays where it was. The workspace state came with the fork. ${state}`,
  ];
  if (prompts.length > 0) out.push('', '## Goal', '', clip(prompts[0]!, 4000));
  if (plan.length > 0) {
    out.push('', '## Plan', '');
    for (const i of plan.slice(0, 50)) out.push(`- [${i.status === 'completed' ? 'x' : i.status === 'in_progress' ? '~' : ' '}] ${clip(i.text, 300)}`);
  }
  if (files.size > 0) {
    out.push('', '## Files touched', '');
    const list = [...files].slice(0, 100);
    for (const [path, change] of list) out.push(`- ${path} (${change})`);
    if (files.size > list.length) out.push(`- … and ${files.size - list.length} more`);
  }
  if (prompts.length > 1) {
    out.push('', '## Later requests', '');
    for (const p of prompts.slice(1).slice(-5)) out.push(`- ${clip(p.replace(/\s+/g, ' '), 400)}`);
  }
  if (last) out.push('', '## Where it left off', '', clip(last, 4000));
  const questions = [...o.pending.questions.map((q) => q.text), ...o.pending.approvals.map((a) => `approval pending: ${a.title || a.kind}`)].filter(Boolean);
  if (questions.length > 0) {
    out.push('', '## Open questions', '');
    for (const q of questions.slice(0, 10)) out.push(`- ${clip(q, 400)}`);
  }
  out.push('', '## Next', '', o.prompt ?? 'Check the state of the workspace, then carry on toward the goal from where the original session left off.');
  return out.join('\n');
}

// --- small helpers ---------------------------------------------------------------------------------------------

function callerMachine(caller: NodeCaller | undefined): string {
  if (!caller || typeof caller !== 'object' || typeof caller.machineId !== 'string' || !caller.machineId) {
    throw new BizziError('bad_request', 'caller is required (fork.* calls come through the hub)');
  }
  return caller.machineId;
}

function checkSource(v: unknown): ForkSource {
  const s = v as ForkSource | undefined;
  if (!s || typeof s !== 'object' || (s.kind !== 'git' && s.kind !== 'dir') || typeof s.name !== 'string') {
    throw new BizziError('bad_request', 'source must be { kind: git | dir, name }');
  }
  for (const k of ['projectId', 'gitRemote', 'gitRemoteUrl'] as const) {
    if (s[k] !== undefined && typeof s[k] !== 'string') throw new BizziError('bad_request', `source.${k} must be a string`);
  }
  return s;
}

/** An absolute path that doesn't exist yet or is an empty directory (forks never overwrite files). */
async function freshDir(p: string): Promise<string> {
  if (typeof p !== 'string' || !p.trim()) throw new BizziError('bad_request', 'toPath must be a path');
  const raw = expandHome(p.trim());
  if (!isAbsolute(raw)) throw new BizziError('bad_request', 'toPath must be absolute');
  const abs = resolve(raw);
  const st = await stat(abs).catch(() => undefined);
  if (st) {
    if (!st.isDirectory()) throw new BizziError('conflict', `${abs} exists and is not a directory`);
    if ((await readdir(abs)).length > 0) throw new BizziError('conflict', `${abs} is not empty; a fork never overwrites files`);
  }
  return abs;
}

function isSha(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(s);
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

function mb(n: number): string {
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}
