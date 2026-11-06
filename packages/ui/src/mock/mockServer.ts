// In-memory scripted fake of the bizzi core, for `?mock=1` (dev/demo without a core) and UI tests.
// It speaks the real wire protocol through a WebSocket-like object, so the client code path is the same.
import { BizziError, GLOBAL_CHANNEL, PROTOCOL_VERSION, parseChannel, sessionChannel } from '@bizzi/protocol';
import type {
  ApprovalDecisionKind,
  ChannelEvent,
  GlobalEventBody,
  InputBlock,
  MethodName,
  PlanItem,
  RequestMsg,
  SessionEventBody,
  SessionInfo,
  SessionStatus,
  Usage,
  WorkspaceInfo,
} from '@bizzi/protocol';
import { stringToBase64 } from '@bizzi/client';
import type { SocketFactory, WebSocketLike } from '@bizzi/client';
import {
  AGENTS,
  ASSISTANT_REPLY,
  CAPS_BY_AGENT,
  CHECKOUT_DIFF,
  FILES,
  MACHINE,
  NOTES_DIFF,
  OTHER_MACHINES,
  REVIEW_REPLY,
  SESSIONS,
  WORKSPACES,
  iso,
} from './fixtures.ts';

export interface MockOptions {
  /** Multiplier for every delay (0 = instant, for tests). */
  speed?: number;
  /** Start streaming a demo turn in s_demo shortly after it is first opened. */
  autoplay?: boolean;
}

class Aborted extends Error {}

interface Run {
  turnId: string;
  aborted: boolean;
  approvals: Map<string, (d: ApprovalDecisionKind) => void>;
}

let idCounter = 0;
const id = (p: string): string => `${p}_mock${(++idCounter).toString(36)}${Date.now().toString(36).slice(-4)}`;

export class MockCore {
  readonly speed: number;
  readonly autoplay: boolean;
  readonly sockets = new Set<MockSocket>();
  private readonly logs = new Map<string, ChannelEvent[]>();
  private readonly workspaces = new Map<string, WorkspaceInfo>();
  private readonly sessions = new Map<string, SessionInfo>();
  private readonly runs = new Map<string, Run>();
  private readonly termLine = new Map<string, string>();
  private readonly pendingStatic = new Map<string, string>();
  private autoplayed = false;

  constructor(opts: MockOptions = {}) {
    this.speed = opts.speed ?? 1;
    this.autoplay = opts.autoplay ?? true;
    for (const w of WORKSPACES) this.workspaces.set(w.id, { ...w });
    for (const s of SESSIONS) this.sessions.set(s.id, { ...s });
    this.seedHistory();
  }

  // ---------------------------------------------------------------- event log

  private log(ch: string): ChannelEvent[] {
    let l = this.logs.get(ch);
    if (!l) this.logs.set(ch, (l = []));
    return l;
  }

  emit(ch: string, body: SessionEventBody | GlobalEventBody, ts?: string): void {
    const l = this.log(ch);
    const ev = { ...body, ch, seq: l.length + 1, ts: ts ?? new Date().toISOString() } as ChannelEvent;
    l.push(ev);
    const text = JSON.stringify(ev);
    for (const s of this.sockets) if (s.subs.has(ch)) s.deliver(text);
    const p = parseChannel(ch);
    if (p?.kind === 'session') {
      const sess = this.sessions.get(p.sessionId);
      if (sess) sess.lastSeq = ev.seq;
    }
  }

  private emitS(sessionId: string, body: SessionEventBody, ts?: string): void {
    this.emit(sessionChannel(sessionId), body, ts);
  }

  private setStatus(sessionId: string, status: SessionStatus): void {
    const s = this.sessions.get(sessionId);
    if (!s || s.status === status) return;
    s.status = status;
    s.updatedAt = new Date().toISOString();
    this.emit(GLOBAL_CHANNEL, { type: 'session.updated', data: { session: { ...s } } });
  }

  private sleep(ms: number, run?: Run): Promise<void> {
    const d = ms * this.speed;
    return new Promise((resolve, reject) => {
      const done = (): void => (run?.aborted ? reject(new Aborted()) : resolve());
      if (d <= 0) queueMicrotask(done);
      else setTimeout(done, d);
    });
  }

  // ---------------------------------------------------------------- seeded history

  private seedHistory(): void {
    // s_demo: one completed turn.
    const s = 's_demo';
    let m = -28;
    const at = (): string => iso((m += 0.2));
    this.emitS(s, { type: 'session.info', data: { model: 'opus', permissionMode: 'default', effort: 'high', commands: [{ name: '/review' }, { name: '/compact' }] } }, at());
    this.emitS(s, { type: 'turn.started', data: { turnId: 't_seed1', input: [{ type: 'text', text: 'The checkout spec fails about 1 in 20 runs on CI. Can you find out why?' }] } }, at());
    this.emitS(s, { type: 'reasoning.completed', data: { messageId: 'rs_seed1', text: 'Intermittent failures in a spec that touches payments usually mean a timing race with a mock. I should read the spec and the mock first.' } }, at());
    this.emitS(s, { type: 'plan.updated', data: { items: [{ text: 'Reproduce the flake locally', status: 'in_progress' }, { text: 'Find the race', status: 'pending' }, { text: 'Fix and verify 100×', status: 'pending' }] } }, at());
    this.emitS(s, { type: 'tool.started', data: { toolId: 'tc_seed1', kind: 'read', name: 'Read', title: 'src/checkout/checkout.spec.ts', input: { file_path: 'src/checkout/checkout.spec.ts' } } }, at());
    this.emitS(s, { type: 'tool.completed', data: { toolId: 'tc_seed1', status: 'ok', output: FILES['src/checkout/checkout.spec.ts'] ?? '' } }, at());
    this.emitS(s, { type: 'tool.started', data: { toolId: 'tc_seed2', kind: 'shell', name: 'Bash', title: 'for i in $(seq 50); do npx vitest run checkout || break; done', input: { command: 'for i in $(seq 50); do npx vitest run checkout || break; done' } } }, at());
    this.emitS(s, { type: 'tool.completed', data: { toolId: 'tc_seed2', status: 'error', output: ' ✓ checkout.spec.ts (1 test) 41ms\n ✓ checkout.spec.ts (1 test) 39ms\n ✗ checkout.spec.ts > marks the order paid\n   AssertionError: expected "pending" to be "paid"\n', error: 'exit code 1' } }, at());
    this.emitS(s, { type: 'message.completed', data: { messageId: 'msg_seed1', role: 'assistant', text: 'Reproduced on run 3: the assertion sees `pending`. The spec sleeps 50 ms instead of waiting for the payment mock to settle. Next I will look at how the mock resolves.' } }, at());
    this.emitS(s, { type: 'plan.updated', data: { items: [{ text: 'Reproduce the flake locally', status: 'completed' }, { text: 'Find the race', status: 'in_progress' }, { text: 'Fix and verify 100×', status: 'pending' }] } }, at());
    this.emitS(s, { type: 'usage.updated', data: { inputTokens: 18_420, outputTokens: 1_210, cacheReadTokens: 12_000, costUsd: 0.14, contextWindow: 200_000 } }, at());
    this.emitS(s, { type: 'turn.completed', data: { turnId: 't_seed1', stopReason: 'end_turn', usage: { inputTokens: 18_420, outputTokens: 1_210, costUsd: 0.14 } } }, at());

    // s_review: waiting on an approval.
    const r = 's_review';
    m = -88;
    this.emitS(r, { type: 'session.info', data: { model: 'gpt-5.5-codex', permissionMode: 'on-request', effort: 'medium' } }, at());
    this.emitS(r, { type: 'turn.started', data: { turnId: 't_rev1', input: [{ type: 'text', text: 'Refactor the payment retry logic into a reusable helper and run the integration tests.' }] } }, at());
    this.emitS(r, { type: 'tool.started', data: { toolId: 'tc_rev1', kind: 'edit', name: 'apply_patch', title: 'src/payments/client.ts' } }, at());
    this.emitS(r, { type: 'tool.completed', data: { toolId: 'tc_rev1', status: 'ok', output: 'Success. Updated 1 file.' } }, at());
    this.emitS(r, { type: 'file.changed', data: { path: 'src/payments/client.ts', change: 'modified', diff: '@@ -1,5 +1,9 @@\n+import { withRetry } from "./retry";\n+\n export const payments = {\n   async charge(amount: number, card: string) {\n-    return fetch("/api/charge", { method: "POST", body: JSON.stringify({ amount, card }) });\n+    return withRetry(() =>\n+      fetch("/api/charge", { method: "POST", body: JSON.stringify({ amount, card }) }),\n+    );\n   },\n };\n' } }, at());
    this.emitS(r, { type: 'message.completed', data: { messageId: 'msg_rev1', role: 'assistant', text: REVIEW_REPLY } }, at());
    this.emitS(r, { type: 'tool.started', data: { toolId: 'tc_rev2', kind: 'shell', name: 'commandExecution', title: 'docker compose up -d payments-sandbox', input: { command: ['docker', 'compose', 'up', '-d', 'payments-sandbox'], cwd: '/Users/dev/src/acme-shop' } } }, at());
    this.emitS(r, { type: 'approval.requested', data: { approvalId: 'ap_rev1', toolId: 'tc_rev2', kind: 'shell', title: 'Run: docker compose up -d payments-sandbox', description: 'Starts the local payment sandbox container needed by the integration suite.', input: { command: ['docker', 'compose', 'up', '-d', 'payments-sandbox'] }, editable: false, options: ['allow', 'allow_always', 'deny'] } }, at());
    this.pendingStatic.set('ap_rev1', 's_review');

    // s_notes: a finished research turn.
    const n = 's_notes';
    m = -60 * 26;
    this.emitS(n, { type: 'turn.started', data: { turnId: 't_n1', input: [{ type: 'text', text: 'Summarize the three CRDT papers in this folder in a table.' }] } }, at());
    this.emitS(n, { type: 'message.completed', data: { messageId: 'msg_n1', role: 'assistant', text: '| Paper | Year | Key idea |\n|---|---|---|\n| Shapiro et al. | 2011 | Convergent and commutative replicated data types |\n| Kleppmann & Beresford | 2017 | A JSON CRDT |\n| Weidner et al. | 2023 | Fugue: minimal interleaving in text CRDTs |\n' } }, at());
    this.emitS(n, { type: 'turn.completed', data: { turnId: 't_n1', stopReason: 'end_turn', usage: { inputTokens: 52_000, outputTokens: 900, costUsd: 0.09 } } }, at());

    // s_term: a shell with some output.
    this.emitS('s_term', { type: 'term.output', data: { dataBase64: stringToBase64('\x1b[1;32mdev@mbp\x1b[0m:\x1b[1;34m~/src/acme-shop\x1b[0m$ git log --oneline -3\r\n\x1b[33mfd3be0d\x1b[0m Add checkout retries\r\n\x1b[33m9a01c2e\x1b[0m Bump vitest\r\n\x1b[33m2be44f1\x1b[0m Initial commit\r\n') } }, iso(-14));
    this.termPrompt('s_term');
  }

  private termPrompt(sessionId: string): void {
    this.emitS(sessionId, { type: 'term.output', data: { dataBase64: stringToBase64('\x1b[1;32mdev@mbp\x1b[0m:\x1b[1;34m~/src/acme-shop\x1b[0m$ ') } });
  }

  // ---------------------------------------------------------------- requests

  async handle(sock: MockSocket, req: RequestMsg): Promise<unknown> {
    const p = req.params as Record<string, unknown>;
    const method = req.method as MethodName;
    if (method === 'hello') {
      if (p.token === 'bad') throw new BizziError('unauthorized', 'invalid token');
      sock.authed = true;
      return { protocol: PROTOCOL_VERSION, serverVersion: '0.0.1-mock', machine: MACHINE };
    }
    if (!sock.authed) throw new BizziError('unauthorized', 'hello first');
    switch (method) {
      case 'subscribe': {
        const ch = String(p.ch);
        const since = typeof p.since === 'number' ? p.since : 0;
        sock.subs.add(ch);
        const log = this.log(ch);
        for (const ev of log) if (ev.seq > since) sock.deliver(JSON.stringify(ev));
        const ps = parseChannel(ch);
        if (ps?.kind === 'session' && ps.sessionId === 's_demo' && this.autoplay && !this.autoplayed) {
          this.autoplayed = true;
          setTimeout(() => this.startTurn('s_demo', [{ type: 'text', text: 'Great, please fix it and verify it 100 times.' }]), 900 * this.speed);
        }
        return { ch, lastSeq: log.length };
      }
      case 'unsubscribe':
        sock.subs.delete(String(p.ch));
        return {};
      case 'machines.list':
        return { machines: [MACHINE, ...OTHER_MACHINES] };
      case 'agents.list':
        await this.sleep(p.refresh ? 600 : 50);
        return { agents: AGENTS };
      case 'workspaces.list':
        return { workspaces: [...this.workspaces.values()] };
      case 'workspace.create': {
        const path = String(p.path ?? '').trim();
        if (!path.startsWith('/')) throw new BizziError('bad_request', 'path must be absolute');
        const name = (typeof p.name === 'string' && p.name) || path.split('/').filter(Boolean).pop() || path;
        const w: WorkspaceInfo = { id: id('w'), machineId: MACHINE.id, name, path, kind: p.create ? 'dir' : 'git', createdAt: new Date().toISOString() };
        this.workspaces.set(w.id, w);
        this.emit(GLOBAL_CHANNEL, { type: 'workspace.created', data: { workspace: w } });
        return { workspace: w };
      }
      case 'workspace.remove': {
        const wid = String(p.workspaceId);
        if (!this.workspaces.delete(wid)) throw new BizziError('not_found', 'no such workspace');
        this.emit(GLOBAL_CHANNEL, { type: 'workspace.removed', data: { workspaceId: wid } });
        return {};
      }
      case 'sessions.list': {
        const all = [...this.sessions.values()].map((s) => ({ ...s }));
        return { sessions: p.workspaceId ? all.filter((s) => s.workspaceId === p.workspaceId) : all };
      }
      case 'session.get': {
        const s = this.session(p.sessionId);
        return { session: { ...s }, capabilities: CAPS_BY_AGENT[s.agent] };
      }
      case 'session.create': {
        const ws = this.workspaces.get(String(p.workspaceId));
        if (!ws) throw new BizziError('not_found', 'no such workspace');
        const agent = String(p.agent) as SessionInfo['agent'];
        const listing = AGENTS.find((a) => a.agent === agent);
        if (!listing?.installed) throw new BizziError('agent_unavailable', `${agent} is not installed`);
        const mode = (p.mode as SessionInfo['mode'] | undefined) ?? 'structured';
        const now = new Date().toISOString();
        const s: SessionInfo = { id: id('s'), machineId: MACHINE.id, workspaceId: ws.id, agent, mode, status: mode === 'terminal' ? 'running' : 'idle', createdAt: now, updatedAt: now, lastSeq: 0 };
        if (typeof p.title === 'string' && p.title) s.title = p.title;
        else s.title = mode === 'terminal' ? `${agent} terminal` : 'New session';
        if (typeof p.model === 'string' && p.model) s.model = p.model;
        if (typeof p.permissionMode === 'string' && p.permissionMode) s.permissionMode = p.permissionMode;
        if (typeof p.effort === 'string' && p.effort) s.effort = p.effort;
        this.sessions.set(s.id, s);
        this.emit(GLOBAL_CHANNEL, { type: 'session.created', data: { session: { ...s } } });
        if (mode === 'terminal') {
          this.emitS(s.id, { type: 'term.output', data: { dataBase64: stringToBase64(`bizzi mock terminal (${agent}) in ${ws.path}\r\n`) } });
          this.termPrompt(s.id);
        }
        return { session: { ...s } };
      }
      case 'session.send': {
        const s = this.session(p.sessionId);
        if (s.mode === 'terminal') throw new BizziError('unsupported', 'terminal sessions take term.input');
        if (this.runs.has(s.id)) throw new BizziError('conflict', 'a turn is already running; steer or interrupt');
        const turnId = this.startTurn(s.id, p.input as InputBlock[]);
        return { turnId };
      }
      case 'session.steer': {
        const s = this.session(p.sessionId);
        if (!CAPS_BY_AGENT[s.agent]?.steer) throw new BizziError('unsupported', 'steer not supported');
        const input = p.input as InputBlock[];
        const text = input.map((b) => (b.type === 'text' ? b.text : '')).join(' ');
        this.emitS(s.id, { type: 'message.completed', data: { messageId: id('msg'), role: 'user', text } });
        return {};
      }
      case 'session.interrupt': {
        const run = this.runs.get(String(p.sessionId));
        if (run) {
          run.aborted = true;
          for (const resolve of run.approvals.values()) resolve('deny');
        }
        return {};
      }
      case 'session.stop': {
        const s = this.session(p.sessionId);
        const run = this.runs.get(s.id);
        if (run) run.aborted = true;
        this.emitS(s.id, { type: 'session.status', data: { status: 'ended', reason: 'stopped by user' } });
        this.setStatus(s.id, 'ended');
        return {};
      }
      case 'session.set': {
        const s = this.session(p.sessionId);
        const patch: { model?: string; permissionMode?: string; effort?: string } = {};
        if (typeof p.model === 'string') s.model = patch.model = p.model;
        if (typeof p.permissionMode === 'string') s.permissionMode = patch.permissionMode = p.permissionMode;
        if (typeof p.effort === 'string') s.effort = patch.effort = p.effort;
        s.updatedAt = new Date().toISOString();
        this.emitS(s.id, { type: 'session.info', data: patch });
        this.emit(GLOBAL_CHANNEL, { type: 'session.updated', data: { session: { ...s } } });
        return { session: { ...s } };
      }
      case 'approval.respond': {
        const sid = String(p.sessionId);
        const aid = String(p.approvalId);
        const decision = p.decision as ApprovalDecisionKind;
        const run = this.runs.get(sid);
        const waiter = run?.approvals.get(aid);
        if (waiter) {
          waiter(decision);
          return {};
        }
        if (this.pendingStatic.get(aid) === sid) {
          this.pendingStatic.delete(aid);
          void this.finishReview(sid, aid, decision);
          return {};
        }
        throw new BizziError('not_found', 'no such pending approval');
      }
      case 'term.input': {
        this.termInput(String(p.sessionId), String(p.dataBase64));
        return {};
      }
      case 'term.resize':
        return {};
      case 'fs.list':
        return { entries: this.fsList(String(p.path ?? '')) };
      case 'fs.read': {
        const path = String(p.path).replace(/^\/+/, '');
        const content = FILES[path];
        if (content === undefined) throw new BizziError('not_found', `no such file: ${path}`);
        return { content, encoding: 'utf8', truncated: false };
      }
      case 'git.status': {
        const ws = this.workspaces.get(String(p.workspaceId));
        if (!ws || ws.kind !== 'git') return { isRepo: false, files: [] };
        return {
          isRepo: true,
          branch: 'fix/flaky-checkout',
          ahead: 1,
          behind: 0,
          files: [
            { path: 'src/checkout/checkout.spec.ts', status: ' M' },
            { path: 'notes.txt', status: '??' },
          ],
        };
      }
      case 'git.diff': {
        if (p.path === 'src/checkout/checkout.spec.ts') return { diff: CHECKOUT_DIFF };
        if (p.path === 'notes.txt') return { diff: NOTES_DIFF };
        if (p.path) return { diff: '' };
        return { diff: CHECKOUT_DIFF + NOTES_DIFF };
      }
      default:
        throw new BizziError('unsupported', `mock does not implement ${method}`);
    }
  }

  private session(sessionId: unknown): SessionInfo {
    const s = this.sessions.get(String(sessionId));
    if (!s) throw new BizziError('not_found', 'no such session');
    return s;
  }

  private fsList(dir: string): { name: string; type: 'file' | 'dir'; size?: number }[] {
    const prefix = dir.replace(/^\/+|\/+$/g, '');
    const seen = new Map<string, { name: string; type: 'file' | 'dir'; size?: number }>();
    for (const [path, content] of Object.entries(FILES)) {
      if (prefix && !path.startsWith(prefix + '/')) continue;
      const rest = prefix ? path.slice(prefix.length + 1) : path;
      const [head, ...tail] = rest.split('/');
      if (!head) continue;
      if (tail.length > 0) seen.set(head, { name: head, type: 'dir' });
      else seen.set(head, { name: head, type: 'file', size: content.length });
    }
    return [...seen.values()].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  }

  // ---------------------------------------------------------------- terminal echo

  private termInput(sessionId: string, b64: string): void {
    const bin = atob(b64);
    const data = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    let line = this.termLine.get(sessionId) ?? '';
    let out = '';
    for (const ch of data) {
      if (ch === '\r') {
        out += '\r\n';
        const cmd = line.trim();
        line = '';
        if (cmd === 'ls') out += 'README.md  notes.txt  package.json  src\r\n';
        else if (cmd === 'pwd') out += '/Users/dev/src/acme-shop\r\n';
        else if (cmd === 'date') out += new Date().toString() + '\r\n';
        else if (cmd) out += `mock: ${cmd}: try ls, pwd or date\r\n`;
        this.emitS(sessionId, { type: 'term.output', data: { dataBase64: stringToBase64(out) } });
        this.termPrompt(sessionId);
        out = '';
        continue;
      }
      if (ch === '\x7f') {
        if (line.length > 0) {
          line = line.slice(0, -1);
          out += '\b \b';
        }
        continue;
      }
      if (ch >= ' ') {
        line += ch;
        out += ch;
      }
    }
    this.termLine.set(sessionId, line);
    if (out) this.emitS(sessionId, { type: 'term.output', data: { dataBase64: stringToBase64(out) } });
  }

  // ---------------------------------------------------------------- scripted turns

  startTurn(sessionId: string, input: InputBlock[]): string {
    const turnId = id('t');
    const run: Run = { turnId, aborted: false, approvals: new Map() };
    this.runs.set(sessionId, run);
    this.emitS(sessionId, { type: 'turn.started', data: { turnId, input } });
    this.setStatus(sessionId, 'running');
    void this.playTurn(sessionId, run).catch((e: unknown) => {
      if (!(e instanceof Aborted)) this.emitS(sessionId, { type: 'error', data: { message: String(e), fatal: false } });
    });
    return turnId;
  }

  private async stream(sessionId: string, run: Run, type: 'message.delta' | 'reasoning.delta', messageId: string, text: string): Promise<void> {
    let i = 0;
    while (i < text.length) {
      const n = 2 + Math.floor(Math.random() * 6);
      const chunk = text.slice(i, i + n);
      i += n;
      if (type === 'message.delta') this.emitS(sessionId, { type, data: { messageId, role: 'assistant', text: chunk } });
      else this.emitS(sessionId, { type, data: { messageId, text: chunk } });
      await this.sleep(14, run);
    }
  }

  private plan(sessionId: string, statuses: PlanItem['status'][]): void {
    const texts = ['Reproduce the flake locally', 'Find the race', 'Fix and verify 100×'];
    this.emitS(sessionId, { type: 'plan.updated', data: { items: texts.map((text, i) => ({ text, status: statuses[i] ?? 'pending' })) } });
  }

  private usage(sessionId: string, u: Usage): void {
    this.emitS(sessionId, { type: 'usage.updated', data: { contextWindow: 200_000, ...u } });
  }

  private async playTurn(sessionId: string, run: Run): Promise<void> {
    const S = sessionId;
    try {
      const rsn = id('rs');
      await this.sleep(300, run);
      await this.stream(S, run, 'reasoning.delta', rsn, 'The spec sleeps instead of awaiting the mock. The mock already exposes settled(); awaiting it removes the race without slowing the test.');
      this.emitS(S, { type: 'reasoning.completed', data: { messageId: rsn, text: 'The spec sleeps instead of awaiting the mock. The mock already exposes settled(); awaiting it removes the race without slowing the test.' } });
      this.plan(S, ['completed', 'completed', 'in_progress']);

      const read = id('tc');
      this.emitS(S, { type: 'tool.started', data: { toolId: read, kind: 'read', name: 'Read', title: 'src/payments/mock.ts', input: { file_path: 'src/payments/mock.ts' } } });
      await this.sleep(400, run);
      this.emitS(S, { type: 'tool.completed', data: { toolId: read, status: 'ok', output: FILES['src/payments/mock.ts'] ?? '' } });

      const edit = id('tc');
      const editInput = { file_path: 'src/checkout/checkout.spec.ts', old_string: '  await sleep(50);', new_string: '  await payments.settled();' };
      this.emitS(S, { type: 'tool.started', data: { toolId: edit, kind: 'edit', name: 'Edit', title: 'src/checkout/checkout.spec.ts', input: editInput } });
      const ap = id('ap');
      const decision = await new Promise<ApprovalDecisionKind>((resolve) => {
        run.approvals.set(ap, resolve);
        this.emitS(S, { type: 'approval.requested', data: { approvalId: ap, toolId: edit, kind: 'edit', title: 'Edit src/checkout/checkout.spec.ts', description: 'Replace the sleep with an explicit wait on the payment mock.', input: editInput, editable: true, options: ['allow', 'allow_always', 'deny'] } });
        this.setStatus(S, 'waiting_approval');
      });
      run.approvals.delete(ap);
      this.emitS(S, { type: 'approval.resolved', data: { approvalId: ap, decision, by: 'you' } });
      if (run.aborted) throw new Aborted();
      this.setStatus(S, 'running');
      if (decision === 'deny') {
        this.emitS(S, { type: 'tool.completed', data: { toolId: edit, status: 'denied' } });
        this.emitS(S, { type: 'message.completed', data: { messageId: id('msg'), role: 'assistant', text: 'Understood, I left the spec unchanged. Tell me how you would like to proceed.' } });
        this.finish(S, run, 'end_turn');
        return;
      }
      await this.sleep(250, run);
      this.emitS(S, { type: 'tool.completed', data: { toolId: edit, status: 'ok', output: 'The file src/checkout/checkout.spec.ts has been updated.' } });
      this.emitS(S, { type: 'file.changed', data: { path: 'src/checkout/checkout.spec.ts', change: 'modified', diff: CHECKOUT_DIFF } });
      this.usage(S, { inputTokens: 24_900, outputTokens: 1_880, cacheReadTokens: 18_000, costUsd: 0.21 });

      const test = id('tc');
      this.emitS(S, { type: 'tool.started', data: { toolId: test, kind: 'shell', name: 'Bash', title: 'for i in $(seq 100); do npx vitest run checkout -s || exit 1; done', input: { command: 'for i in $(seq 100); do npx vitest run checkout -s || exit 1; done' } } });
      for (let i = 1; i <= 10; i++) {
        await this.sleep(120, run);
        this.emitS(S, { type: 'tool.updated', data: { toolId: test, output: ` ✓ run ${i * 10 - 9}–${i * 10}: checkout.spec.ts (1 test)\n`, progress: `${i * 10}/100` } });
      }
      this.emitS(S, { type: 'tool.completed', data: { toolId: test, status: 'ok' } });
      this.plan(S, ['completed', 'completed', 'completed']);

      const msg = id('msg');
      await this.stream(S, run, 'message.delta', msg, ASSISTANT_REPLY);
      this.emitS(S, { type: 'message.completed', data: { messageId: msg, role: 'assistant', text: ASSISTANT_REPLY } });
      this.usage(S, { inputTokens: 31_200, outputTokens: 2_640, cacheReadTokens: 24_000, costUsd: 0.27 });
      this.finish(S, run, 'end_turn', { inputTokens: 12_780, outputTokens: 1_430, costUsd: 0.13 });
    } catch (e) {
      if (e instanceof Aborted) {
        this.finish(S, run, 'interrupted');
        return;
      }
      throw e;
    }
  }

  private finish(sessionId: string, run: Run, stopReason: 'end_turn' | 'interrupted', usage?: Usage): void {
    this.runs.delete(sessionId);
    const data: { turnId: string; stopReason: 'end_turn' | 'interrupted'; usage?: Usage } = { turnId: run.turnId, stopReason };
    if (usage) data.usage = usage;
    this.emitS(sessionId, { type: 'turn.completed', data });
    this.setStatus(sessionId, 'idle');
  }

  private async finishReview(sessionId: string, approvalId: string, decision: ApprovalDecisionKind): Promise<void> {
    const S = sessionId;
    this.emitS(S, { type: 'approval.resolved', data: { approvalId, decision, by: 'you' } });
    this.setStatus(S, 'running');
    await this.sleep(300);
    if (decision === 'deny') {
      this.emitS(S, { type: 'tool.completed', data: { toolId: 'tc_rev2', status: 'denied' } });
    } else {
      this.emitS(S, { type: 'tool.updated', data: { toolId: 'tc_rev2', output: '[+] Running 1/1\n ✔ Container payments-sandbox  Started\n' } });
      this.emitS(S, { type: 'tool.completed', data: { toolId: 'tc_rev2', status: 'ok' } });
    }
    const text = decision === 'deny' ? 'Skipping the integration suite. The unit tests pass.' : 'Sandbox is up; the integration suite passes (42 tests).';
    this.emitS(S, { type: 'message.completed', data: { messageId: id('msg'), role: 'assistant', text } });
    this.emitS(S, { type: 'turn.completed', data: { turnId: 't_rev1', stopReason: 'end_turn', usage: { inputTokens: 40_100, outputTokens: 3_200 } } });
    this.setStatus(S, 'idle');
  }
}

/** A WebSocket-like endpoint connected to a MockCore. */
export class MockSocket implements WebSocketLike {
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  authed = false;
  readonly subs = new Set<string>();
  private readonly core: MockCore;

  constructor(core: MockCore) {
    this.core = core;
    core.sockets.add(this);
    setTimeout(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.onopen?.({});
    }, 5 * core.speed);
  }

  deliver(text: string): void {
    if (this.readyState !== 1) return;
    // Async like a real socket; keeps ordering because timers with equal delay run FIFO.
    queueMicrotask(() => {
      if (this.readyState === 1) this.onmessage?.({ data: text });
    });
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('socket not open');
    const req = JSON.parse(data) as RequestMsg;
    this.core.handle(this, req).then(
      (result) => this.deliver(JSON.stringify({ id: req.id, result })),
      (e: unknown) => {
        const err = e instanceof BizziError ? e.toObject() : { code: 'internal', message: String(e) };
        this.deliver(JSON.stringify({ id: req.id, error: err }));
      },
    );
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.core.sockets.delete(this);
    setTimeout(() => this.onclose?.({ code, reason }), 0);
  }

  /** Simulate a network drop. */
  drop(): void {
    this.close(1006, 'mock drop');
  }
}

export function createMockSocketFactory(core: MockCore = new MockCore()): SocketFactory {
  return () => new MockSocket(core);
}
