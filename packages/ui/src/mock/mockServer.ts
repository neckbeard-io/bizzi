// In-memory scripted fake of the bizzi core, for `?mock=1` (dev/demo without a core) and UI tests.
// It speaks the real wire protocol through a WebSocket-like object, so the client code path is the same.
// By default it plays a hub with two machines (this laptop online, server-a offline); `role: 'node'`
// makes it a single node instead.
import { BizziError, GLOBAL_CHANNEL, LABEL_COLORS, PROTOCOL_VERSION, isLabelColor, isLabelIcon, isMachineTag, normalizePairingCode, parseChannel, sessionChannel } from '@bizzi/protocol';
import type {
  AgentKind,
  ApprovalDecisionKind,
  ChannelEvent,
  DeviceInfo,
  DeviceKind,
  Ed25519PublicJwk,
  GlobalEventBody,
  InputBlock,
  MachineInfo,
  MachineRole,
  MethodName,
  PlanItem,
  QuestionAnswers,
  RequestMsg,
  SessionEventBody,
  SessionInfo,
  SessionMode,
  SessionStatus,
  Usage,
  WorkspaceInfo,
} from '@bizzi/protocol';
import { base64ToBytes, base64UrlToBytes, bytesToBase64, stringToBase64, verifySignature } from '@bizzi/client';
import type { FetchLike, SocketFactory, WebSocketLike } from '@bizzi/client';
import {
  ASSISTANT_REPLY,
  CAPS_BY_AGENT,
  CHECKOUT_DIFF,
  DEMO_CONTEXT,
  FILES,
  GIT_STATUS,
  HUB_MACHINE,
  HUB_ORIGIN,
  LEAD_CONTEXT,
  MACHINE,
  MINI,
  MOCK_SETUP_CODE,
  NOTES_DIFF,
  REVIEW_REPLY,
  SERVER,
  SESSIONS,
  UNSEEN_SESSIONS,
  WORKSPACES,
  iso,
} from './fixtures.ts';
import { FANOUT_DIFFS, FANOUT_GIT, FANOUT_SESSIONS, FANOUT_WORKSPACES, fanoutHistory } from './fanout.ts';
import { MockPipelines } from './pipelines.ts';
import type { MockHost, MockModule } from './host.ts';
import { MockFs } from './fs.ts';
import { MockKnowledge } from './knowledge.ts';
import { MockProvision } from './provision.ts';
import { MockRouting } from './routing.ts';
import { MockThemes } from './themes.ts';
import { MockUsage } from './usage.ts';

export interface MockOptions {
  /** Multiplier for every delay (0 = instant, for tests). */
  speed?: number;
  /** Start streaming a demo turn in s_demo shortly after it is first opened. */
  autoplay?: boolean;
  /** 'hub' (default): two machines behind a hub, devices and pairing. 'node': a single node. */
  role?: MachineRole;
  /** Scripted demo switches, e.g. ['install', 'login']. */
  demo?: Iterable<string>;
}

class Aborted extends Error {}

interface Run {
  turnId: string;
  aborted: boolean;
  approvals: Map<string, (d: ApprovalDecisionKind) => void>;
}

let idCounter = 0;
const id = (p: string): string => `${p}_mock${(++idCounter).toString(36)}${Date.now().toString(36).slice(-4)}`;

const PLAN_QUESTION_ID = 'q_plan1';

export class MockCore implements MockHost {
  readonly speed: number;
  readonly autoplay: boolean;
  readonly role: MachineRole;
  readonly demo: ReadonlySet<string>;
  readonly sockets = new Set<MockSocket>();
  private readonly logs = new Map<string, ChannelEvent[]>();
  private readonly machineMap = new Map<string, MachineInfo>();
  private readonly workspaceMap = new Map<string, WorkspaceInfo>();
  private readonly sessionMap = new Map<string, SessionInfo>();
  private readonly runs = new Map<string, Run>();
  private readonly termLine = new Map<string, string>();
  private readonly termHandlers = new Map<string, (data: string) => void>();
  private readonly pendingStatic = new Map<string, string>();
  private readonly modules: MockModule[];
  private readonly provision: MockProvision;
  private readonly usageModule: MockUsage;
  private readonly fs: MockFs;
  /** git.status per workspace (mutable: worktrees add entries). */
  private readonly git = new Map<string, { branch: string; ahead: number; behind: number; files: { path: string; status: string }[] }>();
  private autoplayed = false;
  // hub: devices, pairing codes, tokens
  readonly devices = new Map<string, DeviceInfo & { publicKey?: Ed25519PublicJwk }>();
  private readonly pairingCodes = new Map<string, { kind: DeviceKind; name?: string; expiresAt: number }>();
  private readonly nonces = new Map<string, string>();
  private readonly tokens = new Map<string, string>();

  constructor(opts: MockOptions = {}) {
    this.speed = opts.speed ?? 1;
    this.autoplay = opts.autoplay ?? true;
    this.role = opts.role ?? 'hub';
    this.demo = new Set(opts.demo ?? []);
    this.machineMap.set(MACHINE.id, { ...MACHINE });
    this.machineMap.set(SERVER.id, { ...SERVER, lastSeenAt: new Date(Date.now() - 2 * 3600_000 - 14 * 60_000).toISOString() });
    this.machineMap.set(MINI.id, { ...MINI });
    for (const w of [...WORKSPACES, ...FANOUT_WORKSPACES]) this.workspaceMap.set(w.id, { ...w });
    for (const s of [...SESSIONS, ...FANOUT_SESSIONS]) this.sessionMap.set(s.id, { ...s, ...(s.budget ? { budget: { ...s.budget } } : {}) });
    for (const [wid, g] of Object.entries({ ...GIT_STATUS, ...FANOUT_GIT })) this.git.set(wid, { ...g, files: [...g.files] });
    this.seedDevices();
    this.seedHistory();
    // Everything seeded has been seen, except the sessions that finished while you were away.
    for (const x of this.sessionMap.values()) x.seenThrough = UNSEEN_SESSIONS.has(x.id) ? Math.max(0, x.lastSeq - 1) : x.lastSeq;
    this.provision = new MockProvision(this);
    this.usageModule = new MockUsage(this, { live: this.autoplay && this.speed > 0 });
    this.fs = new MockFs(this);
    this.modules = [this.provision, new MockKnowledge(this), new MockThemes(this), this.usageModule, this.fs, new MockPipelines(this), new MockRouting(this)];
  }

  /** Stop background timers (tests). */
  dispose(): void {
    this.usageModule.dispose();
  }

  // ---------------------------------------------------------------- MockHost

  machines(): MachineInfo[] {
    return [...this.machineMap.values()];
  }

  workspaces(): WorkspaceInfo[] {
    return [...this.workspaceMap.values()];
  }

  sessions(): SessionInfo[] {
    return [...this.sessionMap.values()];
  }

  /** The machine a MachineTarget call addresses. Hubs route by id; a node only answers for itself. */
  requireOnline(machineId: unknown): MachineInfo {
    const m = this.targetMachine(machineId);
    if (!m.online) throw new BizziError('machine_offline', `${m.name} is offline`);
    return m;
  }

  private targetMachine(machineId: unknown): MachineInfo {
    const mid = typeof machineId === 'string' && machineId ? machineId : MACHINE.id;
    if (this.role === 'node' && mid !== MACHINE.id) throw new BizziError('not_found', `this node is ${MACHINE.id}, not ${mid}`);
    const m = this.machineMap.get(mid);
    if (!m) throw new BizziError('not_found', `no such machine: ${mid}`);
    return m;
  }

  createSession(init: { id?: string; machineId: string; workspaceId: string; agent: AgentKind; mode: SessionMode; title: string; status?: SessionStatus }): SessionInfo {
    const now = new Date().toISOString();
    const s: SessionInfo = {
      id: init.id ?? id('s'),
      machineId: init.machineId,
      workspaceId: init.workspaceId,
      agent: init.agent,
      mode: init.mode,
      status: init.status ?? (init.mode === 'terminal' ? 'running' : 'idle'),
      title: init.title,
      createdAt: now,
      updatedAt: now,
      lastSeq: 0,
      seenThrough: 0,
    };
    this.sessionMap.set(s.id, s);
    this.emit(GLOBAL_CHANNEL, { type: 'session.created', data: { session: { ...s } } });
    return s;
  }

  setSessionStatus(sessionId: string, status: SessionStatus): void {
    this.setStatus(sessionId, status);
  }

  termWrite(sessionId: string, text: string): void {
    this.emitS(sessionId, { type: 'term.output', data: { dataBase64: stringToBase64(text) } });
  }

  onTermInput(sessionId: string, handler: (data: string) => void): void {
    this.termHandlers.set(sessionId, handler);
  }

  emitSession(sessionId: string, body: SessionEventBody): void {
    this.emitS(sessionId, body);
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
      const sess = this.sessionMap.get(p.sessionId);
      if (sess) sess.lastSeq = ev.seq;
    }
  }

  private emitS(sessionId: string, body: SessionEventBody, ts?: string): void {
    this.emit(sessionChannel(sessionId), body, ts);
  }

  private setStatus(sessionId: string, status: SessionStatus): void {
    const s = this.sessionMap.get(sessionId);
    if (!s || s.status === status) return;
    s.status = status;
    s.updatedAt = new Date().toISOString();
    this.emit(GLOBAL_CHANNEL, { type: 'session.updated', data: { session: { ...s } } });
  }

  sleep(ms: number, run?: Run): Promise<void> {
    const d = ms * this.speed;
    return new Promise((resolve, reject) => {
      const done = (): void => (run?.aborted ? reject(new Aborted()) : resolve());
      if (d <= 0) queueMicrotask(done);
      else setTimeout(done, d);
    });
  }

  /** Flip a machine online/offline (demo + tests); emits machine.updated like a hub would. */
  setMachineOnline(machineId: string, online: boolean): void {
    const m = this.machineMap.get(machineId);
    if (!m || m.online === online) return;
    const next: MachineInfo = { ...m, online };
    if (!online) next.lastSeenAt = new Date().toISOString();
    this.machineMap.set(machineId, next);
    this.emit(GLOBAL_CHANNEL, { type: 'machine.updated', data: { machine: { ...next } } });
  }

  // ---------------------------------------------------------------- seeded history

  private seedDevices(): void {
    const ago = (min: number): string => new Date(Date.now() - min * 60_000).toISOString();
    const list: DeviceInfo[] = [
      { id: 'd_mac', name: 'MacBook Pro (desktop app)', kind: 'device', owner: true, createdAt: ago(60 * 24 * 21), lastSeenAt: ago(0) },
      { id: 'd_pixel', name: 'Pixel 9', kind: 'device', createdAt: ago(60 * 24 * 9), lastSeenAt: ago(47) },
      { id: 'd_node_laptop', name: 'this laptop', kind: 'node', machineId: MACHINE.id, createdAt: ago(60 * 24 * 21), lastSeenAt: ago(0) },
      { id: 'd_node_server', name: 'server-a', kind: 'node', machineId: SERVER.id, createdAt: ago(60 * 24 * 20), lastSeenAt: ago(134) },
      { id: 'd_ipad', name: 'Old iPad', kind: 'device', createdAt: ago(60 * 24 * 60), lastSeenAt: ago(60 * 24 * 30), revoked: true },
    ];
    for (const d of list) this.devices.set(d.id, d);
  }

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
    this.emitS(s, { type: 'turn.steered', data: { turnId: 't_seed1', input: [{ type: 'text', text: 'Only run the checkout spec, not the whole suite.' }] } }, at());
    this.emitS(s, { type: 'tool.completed', data: { toolId: 'tc_seed2', status: 'error', output: ' ✓ checkout.spec.ts (1 test) 41ms\n ✓ checkout.spec.ts (1 test) 39ms\n ✗ checkout.spec.ts > marks the order paid\n   AssertionError: expected "pending" to be "paid"\n', error: 'exit code 1' } }, at());
    this.emitS(s, { type: 'message.completed', data: { messageId: 'msg_seed1', role: 'assistant', text: 'Reproduced on run 3: the assertion sees `pending`. The spec sleeps 50 ms instead of waiting for the payment mock to settle. Next I will look at how the mock resolves.' } }, at());
    this.emitS(s, { type: 'plan.updated', data: { items: [{ text: 'Reproduce the flake locally', status: 'completed' }, { text: 'Find the race', status: 'in_progress' }, { text: 'Fix and verify 100×', status: 'pending' }] } }, at());
    this.emitS(s, { type: 'usage.updated', data: { inputTokens: 18_420, outputTokens: 1_210, cacheReadTokens: 12_000, costUsd: 0.14, contextWindow: 200_000 } }, at());
    this.emitS(s, { type: 'context.updated', data: DEMO_CONTEXT }, at());
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
    this.emitS(r, { type: 'context.updated', data: { used: 61_000, window: 272_000, usable: 245_000 } }, at());
    this.emitS(r, { type: 'approval.requested', data: { approvalId: 'ap_rev1', toolId: 'tc_rev2', kind: 'shell', title: 'Run: docker compose up -d payments-sandbox', description: 'Starts the local payment sandbox container needed by the integration suite.', input: { command: ['docker', 'compose', 'up', '-d', 'payments-sandbox'] }, editable: false, options: ['allow', 'allow_always', 'deny'] } }, at());
    this.emitS(r, { type: 'session.status', data: { status: 'waiting_approval', prompt: 'approval', source: 'adapter' } }, at());
    this.pendingStatic.set('ap_rev1', 's_review');

    // s_plan: Claude asks structured questions (AskUserQuestion).
    const q = 's_plan';
    m = -12;
    this.emitS(q, { type: 'session.info', data: { model: 'sonnet', permissionMode: 'plan' } }, at());
    this.emitS(q, { type: 'turn.started', data: { turnId: 't_plan1', input: [{ type: 'text', text: 'Plan how we move the shop from session cookies to OAuth. Ask me what you need to know.' }] } }, at());
    this.emitS(q, { type: 'reasoning.completed', data: { messageId: 'rs_plan1', text: 'Before planning I need the identity provider, which flows matter, and how to treat existing sessions.' } }, at());
    this.emitS(q, { type: 'message.completed', data: { messageId: 'msg_plan1', role: 'assistant', text: 'I read `src/auth/` and the session middleware. A few decisions shape the plan:' } }, at());
    this.emitS(q, { type: 'tool.started', data: { toolId: 'tc_plan1', kind: 'other', name: 'AskUserQuestion', title: '3 questions' } }, at());
    this.emitS(
      q,
      {
        type: 'question.asked',
        data: {
          questionId: PLAN_QUESTION_ID,
          text: 'Which identity provider should the shop use?',
          options: ['Auth0', 'Keycloak', 'Google'],
          questions: [
            {
              id: 'provider',
              header: 'Provider',
              text: 'Which identity provider should the shop use?',
              options: [
                { label: 'Auth0', description: 'Hosted, quickest to set up; per-user pricing.' },
                { label: 'Keycloak', description: 'Self-hosted on server-a next to Postgres.' },
                { label: 'Google', description: 'Only for staff accounts; customers keep passwords.' },
              ],
            },
            {
              id: 'flows',
              header: 'Flows',
              text: 'Which flows must work on day one?',
              multiSelect: true,
              options: [{ label: 'Web login' }, { label: 'Mobile app (PKCE)' }, { label: 'Admin SSO' }, { label: 'API tokens' }],
            },
            { id: 'sessions', header: 'Migration', text: 'Anything special about existing sessions?', allowText: true },
          ],
        },
      },
      at(),
    );
    this.emitS(q, { type: 'session.status', data: { status: 'waiting_input', prompt: 'input', source: 'adapter' } }, at());
    this.pendingStatic.set(PLAN_QUESTION_ID, q);

    // s_notes: a finished research turn, then a turn whose approval was canceled by an interrupt.
    const n = 's_notes';
    m = -60 * 26;
    this.emitS(n, { type: 'turn.started', data: { turnId: 't_n1', input: [{ type: 'text', text: 'Summarize the three CRDT papers in this folder in a table.' }] } }, at());
    this.emitS(n, { type: 'message.completed', data: { messageId: 'msg_n1', role: 'assistant', text: '| Paper | Year | Key idea |\n|---|---|---|\n| Shapiro et al. | 2011 | Convergent and commutative replicated data types |\n| Kleppmann & Beresford | 2017 | A JSON CRDT |\n| Weidner et al. | 2023 | Fugue: minimal interleaving in text CRDTs |\n' } }, at());
    this.emitS(n, { type: 'turn.completed', data: { turnId: 't_n1', stopReason: 'end_turn', usage: { inputTokens: 52_000, outputTokens: 900, costUsd: 0.09 } } }, at());
    this.emitS(n, { type: 'turn.started', data: { turnId: 't_n2', input: [{ type: 'text', text: 'Also download the newest Fugue follow-up from arXiv.' }] } }, at());
    this.emitS(n, { type: 'tool.started', data: { toolId: 'tc_n2', kind: 'web', name: 'webfetch', title: 'https://arxiv.org/a/weidner_m_1' } }, at());
    this.emitS(n, { type: 'approval.requested', data: { approvalId: 'ap_n2', toolId: 'tc_n2', kind: 'web', title: 'Fetch https://arxiv.org/a/weidner_m_1', editable: false, options: ['allow', 'deny'] } }, at());
    this.emitS(n, { type: 'approval.resolved', data: { approvalId: 'ap_n2', decision: 'cancelled' } }, at());
    this.emitS(n, { type: 'tool.completed', data: { toolId: 'tc_n2', status: 'cancelled' } }, at());
    this.emitS(n, { type: 'turn.completed', data: { turnId: 't_n2', stopReason: 'interrupted' } }, at());

    // s_infra (server-a, offline): history served from the hub replica.
    const f = 's_infra';
    m = -60 * 5;
    this.emitS(f, { type: 'session.info', data: { model: 'opus' } }, at());
    this.emitS(f, { type: 'turn.started', data: { turnId: 't_f1', input: [{ type: 'text', text: 'Upgrade the Postgres container from 16 to 17 and check the app still boots.' }] } }, at());
    this.emitS(f, { type: 'tool.started', data: { toolId: 'tc_f1', kind: 'shell', name: 'Bash', title: 'docker compose exec db pg_dumpall > /data/backup/pre-17.sql' } }, at());
    this.emitS(f, { type: 'tool.completed', data: { toolId: 'tc_f1', status: 'ok', output: '' } }, at());
    this.emitS(f, { type: 'tool.started', data: { toolId: 'tc_f2', kind: 'edit', name: 'Edit', title: 'docker-compose.yml' } }, at());
    this.emitS(f, { type: 'tool.completed', data: { toolId: 'tc_f2', status: 'ok' } }, at());
    this.emitS(f, { type: 'file.changed', data: { path: 'docker-compose.yml', change: 'modified', diff: '@@ -3,3 +3,3 @@\n   db:\n-    image: postgres:16\n+    image: postgres:17\n     volumes:\n' } }, at());
    this.emitS(f, { type: 'message.completed', data: { messageId: 'msg_f1', role: 'assistant', text: 'Backed up all databases, bumped the image to `postgres:17` and ran `pg_upgrade`. The app boots and the health check is green.' } }, at());
    this.emitS(f, { type: 'turn.completed', data: { turnId: 't_f1', stopReason: 'end_turn', usage: { inputTokens: 33_000, outputTokens: 2_100, costUsd: 0.31 } } }, at());

    // s_lead: a Claude parent that started two helpers through bizzi's agent-to-agent tools (spec §12.1).
    const L = 's_lead';
    m = -40;
    this.emitS(L, { type: 'session.info', data: { model: 'opus', permissionMode: 'acceptEdits' } }, at());
    this.emitS(L, { type: 'turn.started', data: { turnId: 't_lead1', input: [{ type: 'text', text: 'Implement OAuth login with PKCE in a worktree. Have Codex review it and use the local model to map the session middleware first.' }] } }, at());
    this.emitS(L, { type: 'message.completed', data: { messageId: 'msg_lead1', role: 'assistant', text: 'I will map the middleware with a budgetless helper first, then implement on `feat/oauth` and ask Codex for a review.' } }, at());
    this.emitS(L, { type: 'tool.started', data: { toolId: 'tc_lead1', kind: 'other', name: 'bizzi.session_start', title: 'opencode · Map the session middleware', input: { agent: 'opencode', prompt: 'Map the session middleware', scope: 'child' } } }, at());
    this.emitS(L, { type: 'tool.completed', data: { toolId: 'tc_lead1', status: 'ok', output: 'sessionId: s_helper_explore' } }, at());
    this.emitS(L, { type: 'tool.started', data: { toolId: 'tc_lead2', kind: 'other', name: 'bizzi.session_start', title: 'codex · Review the OAuth change', input: { agent: 'codex', worktree: 'feat/oauth', scope: 'child', budget: { usd: 2 } } } }, at());
    this.emitS(L, { type: 'tool.completed', data: { toolId: 'tc_lead2', status: 'ok', output: 'sessionId: s_helper_review' } }, at());
    this.emitS(L, { type: 'tool.started', data: { toolId: 'tc_lead3', kind: 'other', name: 'bizzi.session_wait', title: 'wait for s_helper_review (done)' } }, at());
    this.emitS(L, { type: 'usage.updated', data: { inputTokens: 41_000, outputTokens: 3_900, costUsd: 0.62, contextWindow: 200_000 } }, at());
    this.emitS(L, { type: 'context.updated', data: LEAD_CONTEXT }, at());

    const E = 's_helper_explore';
    m = -29;
    this.emitS(E, { type: 'session.info', data: { model: 'qwen3.8-27b (h200)' } }, at());
    this.emitS(E, { type: 'turn.started', data: { turnId: 't_ex1', input: [{ type: 'text', text: 'Map the session middleware: where sessions are created, read and destroyed.' }] } }, at());
    this.emitS(E, { type: 'message.completed', data: { messageId: 'msg_ex1', role: 'assistant', text: 'Sessions are created in `src/auth/session.ts` (login), read by `requireSession()` in 14 routes and destroyed on logout and password change.' } }, at());
    this.emitS(E, { type: 'turn.completed', data: { turnId: 't_ex1', stopReason: 'end_turn', usage: { inputTokens: 88_000, outputTokens: 2_400 } } }, at());
    this.emitS(E, { type: 'usage.updated', data: { inputTokens: 88_000, outputTokens: 2_400, contextWindow: 131_072 } }, at());
    this.emitS(E, { type: 'context.updated', data: { used: 90_400, window: 131_072 } }, at());

    const V = 's_helper_review';
    m = -30;
    this.emitS(V, { type: 'session.info', data: { model: 'gpt-5.5-codex' } }, at());
    this.emitS(V, { type: 'turn.started', data: { turnId: 't_rv1', input: [{ type: 'text', text: 'Review the OAuth change on feat/oauth. Report findings with file and line.' }] } }, at());
    this.emitS(V, { type: 'tool.started', data: { toolId: 'tc_rv1', kind: 'read', name: 'read', title: 'src/auth/oauth.ts' } }, at());
    this.emitS(V, { type: 'tool.completed', data: { toolId: 'tc_rv1', status: 'ok' } }, at());
    this.emitS(V, { type: 'message.completed', data: { messageId: 'msg_rv1', role: 'assistant', text: 'Two findings so far: the PKCE verifier is logged at debug level, and the state parameter is not checked on callback.' } }, at());
    this.emitS(V, { type: 'usage.updated', data: { inputTokens: 152_000, outputTokens: 6_100, costUsd: 2.0, contextWindow: 272_000 } }, at());
    this.emitS(V, { type: 'context.updated', data: { used: 158_000, window: 272_000, usable: 245_000 } }, at());
    this.emitS(V, { type: 'turn.completed', data: { turnId: 't_rv1', stopReason: 'end_turn' } }, at());
    this.emitS(V, { type: 'session.status', data: { status: 'waiting_input', prompt: 'budget', reason: '$2.00 budget reached', source: 'bizzi:budget' } }, at());

    // s_ext (mac-mini): finished while you were away.
    const X = 's_ext';
    m = -60 * 3;
    this.emitS(X, { type: 'turn.started', data: { turnId: 't_x1', input: [{ type: 'text', text: 'Remove the unused selectors from the theme stylesheet.' }] } }, at());
    this.emitS(X, { type: 'tool.started', data: { toolId: 'tc_x1', kind: 'edit', name: 'apply_patch', title: 'src/theme.css' } }, at());
    this.emitS(X, { type: 'tool.completed', data: { toolId: 'tc_x1', status: 'ok' } }, at());
    this.emitS(X, { type: 'message.completed', data: { messageId: 'msg_x1', role: 'assistant', text: 'Removed five unused selectors from `src/theme.css`; the visual snapshots are unchanged.' } }, at());
    this.emitS(X, { type: 'turn.completed', data: { turnId: 't_x1', stopReason: 'end_turn', usage: { inputTokens: 21_000, outputTokens: 900 } } }, at());

    // s_term: a shell with some output.
    this.emitS('s_term', { type: 'session.status', data: { status: 'running', source: 'osc7501' } }, iso(-15));
    this.emitS('s_term', { type: 'term.output', data: { dataBase64: stringToBase64('\x1b[1;32mdev@mbp\x1b[0m:\x1b[1;34m~/src/acme-shop\x1b[0m$ git log --oneline -3\r\n\x1b[33mfd3be0d\x1b[0m Add checkout retries\r\n\x1b[33m9a01c2e\x1b[0m Bump vitest\r\n\x1b[33m2be44f1\x1b[0m Initial commit\r\n') } }, iso(-14));
    this.termPrompt('s_term');

    // A fan-out of three runs on the flaky checkout spec (spec §12), one worktree each.
    for (const [sid, body, ts] of fanoutHistory()) this.emitS(sid, body, ts);
  }

  private termPrompt(sessionId: string): void {
    this.emitS(sessionId, { type: 'term.output', data: { dataBase64: stringToBase64('\x1b[1;32mdev@mbp\x1b[0m:\x1b[1;34m~/src/acme-shop\x1b[0m$ ') } });
  }

  // ---------------------------------------------------------------- requests

  async handle(sock: MockSocket, req: RequestMsg): Promise<unknown> {
    const p = req.params as Record<string, unknown>;
    const method = req.method as MethodName;
    if (method === 'hello') {
      this.checkToken(p.token);
      sock.authed = true;
      return this.role === 'hub'
        ? { protocol: PROTOCOL_VERSION, serverVersion: '0.0.1-mock', machine: HUB_MACHINE, role: 'hub' }
        : { protocol: PROTOCOL_VERSION, serverVersion: '0.0.1-mock', machine: this.machineMap.get(MACHINE.id), role: 'node' };
    }
    if (!sock.authed) throw new BizziError('unauthorized', 'hello first');
    const mod = this.modules.find((x) => x.handles(method));
    if (mod) return mod.handle(method, p);
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
        return { machines: this.machines().map((m) => ({ ...m })) };
      case 'machine.set': {
        const m = this.requireOnline(p.machineId);
        const next: MachineInfo = { ...m };
        if (p.tags !== undefined) {
          if (!Array.isArray(p.tags)) throw new BizziError('bad_request', 'tags must be an array of strings');
          const tags = [...new Set(p.tags.map((t) => String(t).trim().toLowerCase()))];
          const bad = tags.find((t) => !isMachineTag(t));
          if (bad !== undefined) throw new BizziError('bad_request', `invalid tag ${JSON.stringify(bad)}`);
          next.tags = tags;
        }
        if (p.description !== undefined) {
          const text = String(p.description).trim();
          if (text) next.description = text;
          else delete next.description;
        }
        if (p.color !== undefined) {
          if (p.color === '') delete next.color;
          else if (isLabelColor(p.color)) next.color = p.color;
          else throw new BizziError('bad_request', `color must be one of ${LABEL_COLORS.join(', ')}`);
        }
        this.machineMap.set(m.id, next);
        this.emit(GLOBAL_CHANNEL, { type: 'machine.updated', data: { machine: { ...next } } });
        return { machine: { ...next } };
      }
      case 'workspaces.list': {
        // The hub answers from its replica, so offline machines still list their workspaces.
        const m = this.targetMachine(p.machineId);
        return { workspaces: this.workspaces().filter((w) => w.machineId === m.id) };
      }
      case 'workspace.create': {
        const m = this.requireOnline(p.machineId);
        const path = String(p.path ?? '').trim();
        if (!path.startsWith('/')) throw new BizziError('bad_request', 'path must be absolute');
        const name = (typeof p.name === 'string' && p.name) || path.split('/').filter(Boolean).pop() || path;
        const known = this.fs.isRepo(m.id, path);
        if (known === undefined && !p.create) throw new BizziError('not_found', `directory ${path} does not exist`);
        const existing = this.workspaces().find((w) => w.machineId === m.id && w.path === path);
        if (existing) return { workspace: existing };
        const w: WorkspaceInfo = { id: id('w'), machineId: m.id, name, path, kind: known ? 'git' : 'dir', createdAt: new Date().toISOString() };
        if (known === undefined) this.fs.mkdir(m.id, path);
        this.workspaceMap.set(w.id, w);
        this.emit(GLOBAL_CHANNEL, { type: 'workspace.created', data: { workspace: w } });
        return { workspace: w };
      }
      case 'workspace.remove': {
        const wid = String(p.workspaceId);
        const w = this.workspaceMap.get(wid);
        if (!w) throw new BizziError('not_found', 'no such workspace');
        this.requireOnline(w.machineId);
        this.workspaceMap.delete(wid);
        this.emit(GLOBAL_CHANNEL, { type: 'workspace.removed', data: { workspaceId: wid } });
        return {};
      }
      case 'workspace.set': {
        // Like the node (spec §11.1): name, color and icon; '' clears color or icon.
        const w = this.workspaceOnline(p.workspaceId);
        const next: WorkspaceInfo = { ...w };
        if (p.name !== undefined) {
          const name = String(p.name).trim();
          if (!name || name.length > 200) throw new BizziError('bad_request', 'name must be 1–200 characters');
          next.name = name;
        }
        if (p.color !== undefined) {
          if (p.color === '') delete next.color;
          else if (isLabelColor(p.color)) next.color = p.color;
          else throw new BizziError('bad_request', `color must be one of ${LABEL_COLORS.join(', ')}`);
        }
        if (p.icon !== undefined) {
          const icon = String(p.icon).trim();
          if (!icon) delete next.icon;
          else if (isLabelIcon(icon)) next.icon = icon;
          else throw new BizziError('bad_request', 'icon must be one or two characters or an emoji, without spaces');
        }
        this.workspaceMap.set(w.id, next);
        this.emit(GLOBAL_CHANNEL, { type: 'workspace.updated', data: { workspace: { ...next } } });
        return { workspace: { ...next } };
      }
      case 'worktree.create': {
        const from = this.workspaceOnline(p.workspaceId);
        const root = from.kind === 'worktree' && from.parentWorkspaceId ? (this.workspaceMap.get(from.parentWorkspaceId) ?? from) : from;
        if (root.kind === 'dir') throw new BizziError('bad_request', `${root.name} is not a git repository`);
        const branch = String(p.branch ?? '').trim();
        if (!/^[\w][\w./-]*$/.test(branch) || branch.includes('..')) throw new BizziError('bad_request', 'branch must be a valid git branch name');
        if ([...this.workspaceMap.values()].some((w) => w.kind === 'worktree' && w.parentWorkspaceId === root.id && w.branch === branch)) {
          throw new BizziError('conflict', `${branch} is already checked out in a worktree`);
        }
        await this.sleep(400);
        const slug = branch.replace(/[^\w.-]+/g, '-');
        const w: WorkspaceInfo = {
          id: id('w'),
          machineId: root.machineId,
          name: (typeof p.name === 'string' && p.name.trim()) || `${root.name} · ${branch}`,
          path: (typeof p.path === 'string' && p.path.trim()) || `${root.path}.worktrees/${slug}`,
          kind: 'worktree',
          parentWorkspaceId: root.id,
          branch,
          createdAt: new Date().toISOString(),
        };
        if (root.projectId) w.projectId = root.projectId;
        this.workspaceMap.set(w.id, w);
        this.git.set(w.id, { branch, ahead: 0, behind: 0, files: [] });
        this.emit(GLOBAL_CHANNEL, { type: 'workspace.created', data: { workspace: { ...w } } });
        return { workspace: { ...w } };
      }
      case 'worktree.remove': {
        const w = this.workspaceOnline(p.workspaceId);
        if (w.kind !== 'worktree') throw new BizziError('bad_request', `${w.name} is not a worktree`);
        const live = this.sessions().filter((x) => x.workspaceId === w.id && x.status !== 'ended' && x.status !== 'failed');
        if (live.length > 0) throw new BizziError('conflict', `worktree is used by ${live.length} live session(s); stop them first`, { sessions: live.map((x) => x.id) });
        const paths = this.git.get(w.id)?.files.map((f) => f.path) ?? [];
        if (paths.length > 0 && p.force !== true) throw new BizziError('conflict', `worktree has uncommitted changes (${paths.join(', ')}); commit them or pass force`, { paths });
        this.workspaceMap.delete(w.id);
        this.git.delete(w.id);
        this.emit(GLOBAL_CHANNEL, { type: 'workspace.removed', data: { workspaceId: w.id } });
        return {};
      }
      case 'sessions.list': {
        const m = this.targetMachine(p.machineId);
        let all = this.sessions()
          .filter((s) => s.machineId === m.id)
          .map((s) => ({ ...s }));
        if (typeof p.spawnedBy === 'string') all = all.filter((s) => s.spawnedBy === p.spawnedBy);
        return { sessions: p.workspaceId ? all.filter((s) => s.workspaceId === p.workspaceId) : all };
      }
      case 'session.markSeen': {
        const s = this.session(p.sessionId);
        const seq = typeof p.seq === 'number' ? Math.min(p.seq, s.lastSeq) : s.lastSeq;
        if (seq > (s.seenThrough ?? 0)) {
          s.seenThrough = seq;
          this.emit(GLOBAL_CHANNEL, { type: 'session.updated', data: { session: { ...s } } });
        }
        return { seenThrough: s.seenThrough ?? 0 };
      }
      case 'session.restart': {
        const s = this.liveSession(p.sessionId);
        const installed = this.provision.agents.get(s.machineId)?.find((a) => a.agent === s.agent)?.version;
        if (!installed || s.agentVersion === installed) throw new BizziError('conflict', 'the session already runs the installed version');
        void this.restartSession(s, installed);
        return {};
      }
      case 'session.get': {
        const s = this.session(p.sessionId);
        return { session: { ...s }, capabilities: CAPS_BY_AGENT[s.agent] };
      }
      case 'session.create': {
        const ws = this.workspaceMap.get(String(p.workspaceId));
        if (!ws) throw new BizziError('not_found', 'no such workspace');
        this.requireOnline(ws.machineId);
        const agent = String(p.agent) as SessionInfo['agent'];
        const listing = this.provision.agents.get(ws.machineId)?.find((a) => a.agent === agent);
        if (!listing?.installed) throw new BizziError('agent_unavailable', `${agent} is not installed`);
        const mode = (p.mode as SessionInfo['mode'] | undefined) ?? 'structured';
        if (mode === 'structured' && listing.support === 'unsupported') {
          throw new BizziError('agent_unavailable', `${listing.supportReason ?? `${agent} ${listing.version ?? ''} is not supported.`} Start it in terminal mode instead.`);
        }
        const title = typeof p.title === 'string' && p.title ? p.title : mode === 'terminal' ? `${agent} terminal` : 'New session';
        const now = new Date().toISOString();
        const s: SessionInfo = { id: id('s'), machineId: ws.machineId, workspaceId: ws.id, agent, mode, status: mode === 'terminal' ? 'running' : 'idle', title, createdAt: now, updatedAt: now, lastSeq: 0, seenThrough: 0, depth: 0 };
        if (listing.version) s.agentVersion = listing.version;
        if (listing.billing) s.billing = listing.billing;
        if (p.budget && typeof p.budget === 'object') s.budget = { ...(p.budget as SessionInfo['budget']) };
        if (typeof p.model === 'string' && p.model) s.model = p.model;
        if (typeof p.permissionMode === 'string' && p.permissionMode) s.permissionMode = p.permissionMode;
        if (typeof p.effort === 'string' && p.effort) s.effort = p.effort;
        if (typeof p.group === 'string' && p.group) s.group = p.group;
        this.sessionMap.set(s.id, s);
        this.emit(GLOBAL_CHANNEL, { type: 'session.created', data: { session: { ...s } } });
        if (mode === 'terminal') {
          this.emitS(s.id, { type: 'term.output', data: { dataBase64: stringToBase64(`bizzi mock terminal (${agent}) in ${ws.path}\r\n`) } });
          this.termPrompt(s.id);
        }
        return { session: { ...s } };
      }
      case 'session.fork': {
        const src = this.liveSession(p.sessionId);
        if (!CAPS_BY_AGENT[src.agent]?.fork) throw new BizziError('unsupported', `${src.agent} cannot fork sessions`);
        const now = new Date().toISOString();
        const title = typeof p.title === 'string' && p.title ? p.title : `${src.title ?? 'Session'} (fork)`;
        const s: SessionInfo = { ...src, id: id('s'), status: 'idle', title, forkedFrom: src.id, createdAt: now, updatedAt: now, lastSeq: 0, seenThrough: 0 };
        delete s.agentSessionRef;
        delete s.spawnedBy;
        delete s.scope;
        this.sessionMap.set(s.id, s);
        // The fork continues the conversation: copy the finished part of the source's history.
        for (const ev of this.log(sessionChannel(src.id))) {
          if (ev.type === 'approval.requested' || ev.type === 'question.asked' || ev.type === 'session.status') continue;
          const { ch: _ch, seq: _seq, ts, ...body } = ev;
          this.emitS(s.id, body as SessionEventBody, ts);
        }
        this.emit(GLOBAL_CHANNEL, { type: 'session.created', data: { session: { ...s } } });
        return { session: { ...s } };
      }
      case 'session.delete': {
        const s = this.liveSession(p.sessionId);
        const run = this.runs.get(s.id);
        if (run) run.aborted = true;
        this.sessionMap.delete(s.id);
        this.logs.delete(sessionChannel(s.id));
        this.emit(GLOBAL_CHANNEL, { type: 'session.removed', data: { sessionId: s.id, workspaceId: s.workspaceId } });
        return {};
      }
      case 'session.send': {
        const s = this.liveSession(p.sessionId);
        if (s.mode === 'terminal') throw new BizziError('unsupported', 'terminal sessions take term.input');
        if (this.runs.has(s.id)) throw new BizziError('conflict', 'a turn is already running; steer or interrupt');
        const turnId = this.startTurn(s.id, p.input as InputBlock[]);
        return { turnId };
      }
      case 'session.steer': {
        const s = this.liveSession(p.sessionId);
        if (!CAPS_BY_AGENT[s.agent]?.steer) throw new BizziError('unsupported', 'steer not supported');
        const run = this.runs.get(s.id);
        if (!run) throw new BizziError('conflict', 'no turn is running');
        this.emitS(s.id, { type: 'turn.steered', data: { turnId: run.turnId, input: p.input as InputBlock[] } });
        return {};
      }
      case 'session.interrupt': {
        this.liveSession(p.sessionId);
        const run = this.runs.get(String(p.sessionId));
        if (run) {
          run.aborted = true;
          for (const resolve of run.approvals.values()) resolve('deny');
        }
        return {};
      }
      case 'session.stop': {
        const s = this.liveSession(p.sessionId);
        const run = this.runs.get(s.id);
        if (run) run.aborted = true;
        this.emitS(s.id, { type: 'session.status', data: { status: 'ended', reason: 'stopped by user' } });
        this.setStatus(s.id, 'ended');
        return {};
      }
      case 'session.set': {
        const s = this.liveSession(p.sessionId);
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
        this.liveSession(sid);
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
      case 'question.respond': {
        const s = this.liveSession(p.sessionId);
        const qid = String(p.questionId);
        if (this.pendingStatic.get(qid) !== s.id) throw new BizziError('not_found', 'no such pending question');
        this.pendingStatic.delete(qid);
        void this.finishPlan(s.id, qid, p.cancel === true ? null : ((p.answers as QuestionAnswers | undefined) ?? {}));
        return {};
      }
      case 'term.input': {
        const s = this.liveSession(p.sessionId);
        const handler = this.termHandlers.get(s.id);
        if (handler) handler(new TextDecoder().decode(base64ToBytes(String(p.dataBase64))));
        else this.termInput(s.id, String(p.dataBase64));
        return {};
      }
      case 'term.resize':
        this.liveSession(p.sessionId);
        return {};
      case 'term.snapshot': {
        const s = this.session(p.sessionId);
        if (s.mode !== 'terminal') throw new BizziError('bad_request', 'not a terminal session');
        const log = this.log(sessionChannel(s.id));
        const chunks: Uint8Array[] = [];
        for (const ev of log) if (ev.type === 'term.output') chunks.push(base64ToBytes(ev.data.dataBase64));
        const total = chunks.reduce((n, c) => n + c.byteLength, 0);
        const all = new Uint8Array(total);
        let o = 0;
        for (const c of chunks) {
          all.set(c, o);
          o += c.byteLength;
        }
        return { dataBase64: bytesToBase64(all.subarray(Math.max(0, total - 256 * 1024))), seq: log.length };
      }
      case 'fs.list':
        this.workspaceOnline(p.workspaceId);
        return { entries: this.fsList(String(p.path ?? '')) };
      case 'fs.read': {
        this.workspaceOnline(p.workspaceId);
        const path = String(p.path).replace(/^\/+/, '');
        const content = FILES[path];
        if (content === undefined) throw new BizziError('not_found', `no such file: ${path}`);
        return { content, encoding: 'utf8', truncated: false };
      }
      case 'git.status': {
        const ws = this.workspaceOnline(p.workspaceId);
        if (ws.kind === 'dir') return { isRepo: false, files: [] };
        const g = this.git.get(ws.id) ?? { branch: ws.branch ?? 'main', ahead: 0, behind: 0, files: [] };
        return { isRepo: true, branch: g.branch, ahead: g.ahead, behind: g.behind, files: g.files.map((f) => ({ ...f })) };
      }
      case 'git.diff': {
        const dws = this.workspaceOnline(p.workspaceId);
        const fanout = FANOUT_DIFFS[dws.id];
        if (fanout !== undefined) return { diff: p.path ? fanout.split(/(?=^diff --git )/m).filter((d) => d.includes(` b/${String(p.path)}\n`)).join('') : fanout };
        if (p.path === 'src/checkout/checkout.spec.ts') return { diff: CHECKOUT_DIFF };
        if (p.path === 'notes.txt') return { diff: NOTES_DIFF };
        if (p.path) return { diff: '' };
        return { diff: CHECKOUT_DIFF + NOTES_DIFF };
      }
      case 'pairing.create': {
        this.requireHub();
        const kind = p.kind === 'node' ? 'node' : 'device';
        const code = randomCode();
        const expiresAt = Date.now() + 10 * 60_000;
        const entry: { kind: DeviceKind; name?: string; expiresAt: number } = { kind, expiresAt };
        if (typeof p.name === 'string' && p.name) entry.name = p.name;
        this.pairingCodes.set(code, entry);
        return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt: new Date(expiresAt).toISOString(), pairUrl: `${HUB_ORIGIN}/#/pair?code=${code}` };
      }
      case 'devices.list':
        this.requireHub();
        return { devices: [...this.devices.values()].map(publicDevice) };
      case 'device.revoke': {
        this.requireHub();
        const d = this.devices.get(String(p.deviceId));
        if (!d) throw new BizziError('not_found', 'no such device');
        d.revoked = true;
        for (const [tok, dev] of this.tokens) if (dev === d.id) this.tokens.delete(tok);
        this.emit(GLOBAL_CHANNEL, { type: 'device.updated', data: { device: publicDevice(d) } });
        return {};
      }
      default:
        throw new BizziError('unsupported', `mock does not implement ${method}`);
    }
  }

  /** session.restart: replace the agent process at a safe point and resume (updates.md §5). */
  private async restartSession(s: SessionInfo, toVersion: string): Promise<void> {
    const fromVersion = s.agentVersion;
    while (this.runs.has(s.id)) await this.sleep(200);
    const prev = s.status === 'starting' ? 'idle' : s.status;
    this.emitS(s.id, { type: 'session.restarting', data: { ...(fromVersion ? { fromVersion } : {}), toVersion, reason: 'restart requested' } });
    this.emitS(s.id, { type: 'session.status', data: { status: 'starting', reason: `restarting on ${toVersion}`, source: 'bizzi:restart' } });
    this.setStatus(s.id, 'starting');
    await this.sleep(900);
    s.agentVersion = toVersion;
    this.emitS(s.id, { type: 'session.restarted', data: { ...(fromVersion ? { fromVersion } : {}), toVersion, ok: true } });
    this.emitS(s.id, { type: 'session.status', data: { status: prev, source: 'adapter' } });
    this.setStatus(s.id, prev);
    this.provision.refreshStale(s.machineId, s.agent);
  }

  private requireHub(): void {
    if (this.role !== 'hub') throw new BizziError('unsupported', 'only a hub manages devices');
  }

  private session(sessionId: unknown): SessionInfo {
    const s = this.sessionMap.get(String(sessionId));
    if (!s) throw new BizziError('not_found', 'no such session');
    return s;
  }

  /** A session whose machine is reachable (mutating calls); offline machines fail fast. */
  private liveSession(sessionId: unknown): SessionInfo {
    const s = this.session(sessionId);
    const m = this.machineMap.get(s.machineId);
    if (m && !m.online) throw new BizziError('machine_offline', `${m.name} is offline; this session is read-only until it reconnects`);
    return s;
  }

  private workspaceOnline(workspaceId: unknown): WorkspaceInfo {
    const ws = this.workspaceMap.get(String(workspaceId));
    if (!ws) throw new BizziError('not_found', 'no such workspace');
    this.requireOnline(ws.machineId);
    return ws;
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

  // ---------------------------------------------------------------- hub auth (used by createMockHubFetch)

  private checkToken(token: unknown): void {
    if (token === 'bad') throw new BizziError('unauthorized', 'invalid token');
    if (typeof token === 'string' && token.startsWith('mt_') && !this.tokens.has(token)) throw new BizziError('unauthorized', 'unknown or revoked token');
  }

  pair(body: { code?: string; kind?: DeviceKind; name?: string; publicKey?: Ed25519PublicJwk; machineId?: string }): { deviceId: string; kind: DeviceKind; owner: boolean; clientUrl: string; nodeUrl: string } {
    const code = normalizePairingCode(String(body.code ?? ''));
    const pk = body.publicKey;
    if (!pk || pk.kty !== 'OKP' || pk.crv !== 'Ed25519' || typeof pk.x !== 'string') throw new BizziError('bad_request', 'publicKey must be an Ed25519 JWK');
    const issued = this.pairingCodes.get(code);
    const setup = code === normalizePairingCode(MOCK_SETUP_CODE);
    if (!setup && (!issued || issued.expiresAt < Date.now())) throw new BizziError('unauthorized', 'unknown or expired pairing code');
    if (issued) this.pairingCodes.delete(code);
    const kind = body.kind === 'node' ? 'node' : 'device';
    const d: DeviceInfo & { publicKey?: Ed25519PublicJwk } = {
      id: id('d'),
      name: (body.name ?? '').trim() || issued?.name || 'new device',
      kind,
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      publicKey: pk,
    };
    if (body.machineId) d.machineId = body.machineId;
    this.devices.set(d.id, d);
    this.emit(GLOBAL_CHANNEL, { type: 'device.updated', data: { device: publicDevice(d) } });
    return { deviceId: d.id, kind, owner: false, clientUrl: 'mock://hub/ws', nodeUrl: 'mock://hub/ws/node' };
  }

  challenge(deviceId: string): { nonce: string; expiresAt: string } {
    const d = this.devices.get(deviceId);
    if (!d || d.revoked) throw new BizziError('unauthorized', 'unknown or revoked device');
    const nonce = randomCode() + randomCode();
    this.nonces.set(deviceId, nonce);
    return { nonce, expiresAt: new Date(Date.now() + 60_000).toISOString() };
  }

  async token(body: { deviceId?: string; nonce?: string; signature?: string }): Promise<{ token: string; expiresAt: string }> {
    const deviceId = String(body.deviceId ?? '');
    const d = this.devices.get(deviceId);
    const nonce = this.nonces.get(deviceId);
    if (!d?.publicKey || d.revoked || !nonce || nonce !== body.nonce) throw new BizziError('unauthorized', 'bad challenge');
    this.nonces.delete(deviceId);
    const ok = await verifySignature(d.publicKey, `bizzi-auth:v1:${deviceId}:${nonce}`, base64UrlToBytes(String(body.signature ?? '')) as Uint8Array<ArrayBuffer>);
    if (!ok) throw new BizziError('unauthorized', 'bad signature');
    const token = `mt_${randomCode()}${randomCode()}`;
    this.tokens.set(token, deviceId);
    return { token, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() };
  }

  // ---------------------------------------------------------------- terminal echo

  private termInput(sessionId: string, b64: string): void {
    const data = new TextDecoder().decode(base64ToBytes(b64));
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

  private async stream(sessionId: string, run: Run | undefined, type: 'message.delta' | 'reasoning.delta', messageId: string, text: string): Promise<void> {
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
      if (run.aborted) {
        this.emitS(S, { type: 'approval.resolved', data: { approvalId: ap, decision: 'cancelled' } });
        throw new Aborted();
      }
      this.emitS(S, { type: 'approval.resolved', data: { approvalId: ap, decision, by: 'you' } });
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
      this.growContext(S, 4_200);

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
      this.growContext(S, 6_800);
      this.finish(S, run, 'end_turn', { inputTokens: 12_780, outputTokens: 1_430, costUsd: 0.13 });
    } catch (e) {
      if (e instanceof Aborted) {
        this.finish(S, run, 'interrupted');
        return;
      }
      throw e;
    }
  }

  /** Messages grow and free space shrinks (context.updated after a step). */
  private growContext(sessionId: string, tokens: number): void {
    let last: ChannelEvent | undefined;
    for (const ev of this.log(sessionChannel(sessionId))) if (ev.type === 'context.updated') last = ev;
    if (!last || last.type !== 'context.updated') return;
    const ctx = last.data;
    const categories = ctx.categories?.map((c) => (c.id === 'messages' ? { ...c, tokens: c.tokens + tokens } : c.id === 'free' ? { ...c, tokens: Math.max(0, c.tokens - tokens) } : c));
    this.emitS(sessionId, { type: 'context.updated', data: { ...ctx, used: ctx.used + tokens, ...(categories ? { categories } : {}) } });
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

  /** s_plan: the questions were answered (or declined with null). */
  private async finishPlan(sessionId: string, questionId: string, answers: QuestionAnswers | null): Promise<void> {
    const S = sessionId;
    this.emitS(S, { type: 'question.resolved', data: answers ? { questionId, answers } : { questionId, cancelled: true } });
    this.emitS(S, { type: 'tool.completed', data: { toolId: 'tc_plan1', status: answers ? 'ok' : 'cancelled' } });
    this.emitS(S, { type: 'session.status', data: { status: 'running' } });
    this.setStatus(S, 'running');
    await this.sleep(400);
    const fmt = (v: string | string[] | undefined): string => (Array.isArray(v) ? v.join(', ') : (v ?? '')) || 'no preference';
    const text = answers
      ? `Thanks. The plan:\n\n1. Stand up **${fmt(answers.provider)}** and register the shop as a client.\n2. Ship these flows first: ${fmt(answers.flows)}.\n3. Existing sessions: ${fmt(answers.sessions)}.\n4. Remove the cookie middleware once traffic has moved.`
      : 'No problem, I will draft the plan with sensible defaults (Auth0, web login first) and mark the open decisions.';
    const msg = id('msg');
    await this.stream(S, undefined, 'message.delta', msg, text);
    this.emitS(S, { type: 'message.completed', data: { messageId: msg, role: 'assistant', text } });
    this.emitS(S, { type: 'turn.completed', data: { turnId: 't_plan1', stopReason: 'end_turn', usage: { inputTokens: 9_800, outputTokens: 640 } } });
    this.setStatus(S, 'idle');
  }

  /** Re-arm the scripted question in s_plan (tests). */
  get questionPending(): boolean {
    return this.pendingStatic.has(PLAN_QUESTION_ID);
  }

  armStaticQuestions(): void {
    this.pendingStatic.set(PLAN_QUESTION_ID, 's_plan');
  }
}

function publicDevice(d: DeviceInfo & { publicKey?: Ed25519PublicJwk }): DeviceInfo {
  const { publicKey: _pk, ...rest } = d;
  return { ...rest };
}

function randomCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(4);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += (alphabet[b % alphabet.length] ?? 'A') + (alphabet[(b >> 3) % alphabet.length] ?? 'Z');
  return out;
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

/** The hub's HTTP pairing/auth API (protocol hub.ts) on top of a MockCore, as a `fetch` replacement. */
export function createMockHubFetch(core: MockCore): FetchLike {
  return async (url, init) => {
    const path = url.replace(/^[a-z]+:\/\/[^/]+/i, '');
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const reply = (status: number, json: unknown): { ok: boolean; status: number; json(): Promise<unknown> } => ({ ok: status < 400, status, json: async () => json });
    try {
      await core.sleep(120);
      if (path === '/api/pair') return reply(200, core.pair(body));
      if (path === '/api/auth/challenge') return reply(200, core.challenge(String(body.deviceId ?? '')));
      if (path === '/api/auth/token') return reply(200, await core.token(body));
      return reply(404, { error: { code: 'not_found', message: `no route ${path}` } });
    } catch (e) {
      const err = e instanceof BizziError ? e.toObject() : { code: 'internal', message: String(e) };
      return reply(err.code === 'unauthorized' ? 401 : 400, { error: err });
    }
  };
}
