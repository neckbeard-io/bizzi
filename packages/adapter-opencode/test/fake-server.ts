// Fake OpenCode v2 server: the HTTP routes and SSE event shapes the adapter uses, reproduced from
// a real `opencode serve` 2.0.25 capture (see fixtures/opencode-2.0.25-events.jsonl). Prompts pick
// a scripted scenario by prefix ("scenario:<name>"), so it works in-process and as a child process.

import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

interface FakeSession {
  id: string;
  directory: string;
  agent: string;
  model?: { id: string; providerID: string; variant?: string };
  title?: string;
  permissions?: unknown[];
  running: boolean;
  interrupted: boolean;
  instructions: Record<string, unknown>;
  pendingPermissions: Map<string, (reply: string, message?: string) => void>;
  pendingForms: Map<string, { form: FakeForm; settle: (r: FormOutcome) => void }>;
  /** Session-cumulative usage, as `session.usage.updated` reports it. */
  totals: { cost: number; input: number; output: number };
  fork?: { sessionID: string; boundary: { type: 'through'; messageID: string } };
}

interface FakeForm {
  id: string;
  sessionID: string;
  title: string;
  metadata: Record<string, unknown>;
  fields: { key: string; type: string; title?: string; description?: string; options?: { value: string; label: string; description?: string }[]; custom?: boolean }[];
}

type FormOutcome = { kind: 'reply'; answer: Record<string, unknown> } | { kind: 'cancel'; message?: string } | { kind: 'interrupt' };

const FIXTURE = new URL('./fixtures/opencode-2.0.25-events.jsonl', import.meta.url);
const FIXTURE_SESSION = 'ses_e50565c4bffed3oqv2RCnX0jhm';
/** Real question-tool traffic (2.0.25 + qwen): answered single choice, declined multiselect, interrupted. */
const QUESTION_FIXTURE = new URL('./fixtures/opencode-2.0.25-question.jsonl', import.meta.url);

/** The n-th captured `question` tool call and the form the server created for it. */
function capturedQuestion(n: number): { input: Record<string, unknown>; form: FakeForm } {
  const events = readFileSync(QUESTION_FIXTURE, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { type: string; data: Record<string, unknown> });
  const forms = events.filter((e) => e.type === 'form.created').map((e) => e.data.form as FakeForm);
  const form = forms[n]!;
  const toolId = (form.metadata.tool as { id: string }).id;
  const called = events.find((e) => e.type === 'session.tool.called' && e.data.id === toolId)!;
  return { input: called.data.input as Record<string, unknown>, form };
}

export class FakeOpenCode {
  readonly password: string | undefined;
  readonly requests: RecordedRequest[] = [];
  readonly sessions = new Map<string, FakeSession>();
  /** Message history returned by GET /api/session/{id}/message (newest first when order=desc). */
  messages = new Map<string, unknown[]>();
  #server: Server;
  #clients = new Set<ServerResponse>();
  #seq = 0;
  #ids = 0;
  #replaySegment = 0;
  url = '';

  constructor(opts: { password?: string } = {}) {
    this.password = opts.password;
    this.#server = createServer((req, res) => {
      this.#handle(req, res).catch((err: unknown) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ _tag: 'UnknownError', message: String(err) }));
      });
    });
  }

  async start(port = 0): Promise<string> {
    await new Promise<void>((r) => this.#server.listen(port, '127.0.0.1', r));
    const addr = this.#server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${addr.port}`;
    return this.url;
  }

  async close(): Promise<void> {
    for (const c of this.#clients) c.destroy();
    this.#clients.clear();
    this.#server.closeAllConnections();
    await new Promise<void>((r) => this.#server.close(() => r()));
  }

  /** Drop every open event stream (simulates a network gap while the server stays up). */
  dropStreams(): void {
    for (const c of this.#clients) c.destroy();
    this.#clients.clear();
  }

  get streamCount(): number {
    return this.#clients.size;
  }

  id(prefix: string): string {
    this.#ids++;
    return `${prefix}_${Date.now().toString(16)}${String(this.#ids).padStart(4, '0')}fake`;
  }

  emit(type: string, data: Record<string, unknown>, opts: { directory?: string; durable?: boolean } = {}): void {
    const ev: Record<string, unknown> = { id: this.id('evt'), created: Date.now(), type, data };
    if (opts.directory) ev.location = { directory: opts.directory };
    if (opts.durable && typeof data.sessionID === 'string') {
      ev.durable = { aggregateID: data.sessionID, seq: ++this.#seq, version: 1 };
    }
    this.emitRaw(ev);
  }

  emitRaw(ev: unknown): void {
    const frame = `data: ${JSON.stringify(ev)}\n\n`;
    for (const c of this.#clients) c.write(frame);
  }

  session(id: string, directory = '/tmp'): FakeSession {
    let s = this.sessions.get(id);
    if (!s) {
      s = {
        id,
        directory,
        agent: 'build',
        running: false,
        interrupted: false,
        instructions: {},
        pendingPermissions: new Map(),
        pendingForms: new Map(),
        totals: { cost: 0, input: 0, output: 0 },
      };
      this.sessions.set(id, s);
    }
    return s;
  }

  // --- HTTP -----------------------------------------------------------------------------------

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const u = new URL(req.url ?? '/', 'http://x');
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
    const query = Object.fromEntries(u.searchParams);
    this.requests.push({ method: req.method ?? 'GET', path: u.pathname, query, body });

    if (this.password !== undefined) {
      const expected = 'Basic ' + Buffer.from(`opencode:${this.password}`).toString('base64');
      if (req.headers.authorization !== expected) return json(res, 401, { _tag: 'UnauthorizedError', message: 'Unauthorized' });
    }
    const p = u.pathname;
    const m = req.method ?? 'GET';
    let mm: RegExpExecArray | null;

    if (m === 'GET' && p === '/api/info') return json(res, 200, { version: process.env.FAKE_OPENCODE_VERSION ?? '2.0.25', pid: process.pid, urls: [this.url], paths: { tmp: '/tmp' } });
    if (m === 'GET' && p === '/api/event') return this.#sse(req, res);
    if (m === 'GET' && p === '/api/session/active') {
      const data: Record<string, unknown> = {};
      for (const s of this.sessions.values()) if (s.running) data[s.id] = { type: 'running' };
      return json(res, 200, { data });
    }
    if (m === 'POST' && p === '/api/session') {
      const b = body ?? {};
      const id = (b.id as string | undefined) ?? this.id('ses');
      const dir = (b.location as { directory?: string } | undefined)?.directory ?? '/tmp';
      const s = this.session(id, dir);
      if (typeof b.agent === 'string') s.agent = b.agent;
      if (b.model) s.model = b.model as FakeSession['model'];
      if (typeof b.title === 'string') s.title = b.title;
      if (Array.isArray(b.permissions)) s.permissions = b.permissions;
      s.model ??= { id: 'fake-model', providerID: 'fake', variant: 'default' };
      this.emit('session.created', { sessionID: id, location: { directory: dir }, agent: s.agent, model: s.model, title: s.title }, { directory: dir, durable: true });
      return json(res, 200, { data: this.#info(s) });
    }
    if ((mm = /^\/api\/session\/(ses[^/]+)$/.exec(p))) {
      const s = this.sessions.get(mm[1]!);
      if (!s) return json(res, 404, { _tag: 'SessionNotFoundError', message: `Session not found: ${mm[1]}` });
      if (m === 'GET') return json(res, 200, { data: this.#info(s) });
      if (m === 'PATCH') return empty(res);
    }
    if ((mm = /^\/api\/session\/(ses[^/]+)\/(\w+)$/.exec(p))) {
      const [, id, action] = mm as unknown as [string, string, string];
      const s = this.session(id); // lenient: sessions survive a fake "restart" like the real DB
      switch (`${m} ${action}`) {
        case 'POST prompt':
          return this.#prompt(s, body ?? {}, res);
        case 'POST interrupt': {
          const was = s.running;
          if (was) s.interrupted = true;
          json(res, 200, { interrupted: was });
          // Like the real server: an interrupt cancels the session's pending forms.
          for (const f of [...s.pendingForms.values()]) f.settle({ kind: 'interrupt' });
          for (const [pid, settle] of [...s.pendingPermissions]) {
            s.pendingPermissions.delete(pid);
            settle('reject', 'interrupted');
          }
          return;
        }
        case 'POST fork': {
          const src = this.sessions.get(id);
          if (!src?.model) return json(res, 404, { _tag: 'SessionNotFoundError', sessionID: id, message: `Session not found: ${id}` });
          const fork = this.session(this.id('ses'), src.directory);
          fork.agent = '';
          fork.model = src.model;
          fork.title = `${src.title ?? 'Session'} (fork #1)`;
          fork.fork = { sessionID: src.id, boundary: { type: 'through', messageID: this.id('msg') } };
          this.messages.set(fork.id, [...(this.messages.get(src.id) ?? [])]);
          return json(res, 200, { data: this.#info(fork) });
        }
        case 'GET form':
          return json(res, 200, { data: [...s.pendingForms.values()].map((f) => f.form) });
        case 'POST model':
          s.model = body?.model as FakeSession['model'];
          this.emit('session.model.selected', { sessionID: s.id, model: s.model }, { directory: s.directory, durable: true });
          return empty(res);
        case 'POST agent':
          s.agent = String(body?.agent);
          this.emit('session.agent.selected', { sessionID: s.id, agent: s.agent }, { directory: s.directory, durable: true });
          return empty(res);
        case 'GET message':
          return json(res, 200, { data: this.messages.get(s.id) ?? [], cursor: {} });
        case 'PUT environment':
          return empty(res);
      }
    }
    if ((mm = /^\/api\/session\/(ses[^/]+)\/permission\/(per[^/]+)\/reply$/.exec(p)) && m === 'POST') {
      const s = this.session(mm[1]!);
      const resolve = s.pendingPermissions.get(mm[2]!);
      if (!resolve) return json(res, 404, { _tag: 'PermissionNotFoundError', message: 'Permission not found' });
      s.pendingPermissions.delete(mm[2]!);
      empty(res);
      resolve(String(body?.decision), body?.message as string | undefined);
      return;
    }
    if ((mm = /^\/api\/session\/(ses[^/]+)\/form\/(frm[^/]+)(\/reply)?$/.exec(p))) {
      const s = this.session(mm[1]!);
      const pending = s.pendingForms.get(mm[2]!);
      if (m === 'GET' && !mm[3]) {
        if (!pending) return json(res, 404, { _tag: 'FormNotFoundError', id: mm[2], message: 'Form not found' });
        return json(res, 200, { data: { ...pending.form, state: { status: 'pending' } } });
      }
      if (!pending) return json(res, 404, { _tag: 'FormNotFoundError', id: mm[2], message: 'Form not found' });
      if (m === 'POST' && mm[3]) {
        const answer = (body?.answer ?? {}) as Record<string, unknown>;
        const bad = Object.keys(answer).find((k) => !pending.form.fields.some((f) => f.key === k));
        if (bad) return json(res, 400, { _tag: 'FormInvalidAnswerError', id: mm[2], message: `Unknown field ${bad}` });
        empty(res);
        pending.settle({ kind: 'reply', answer });
        return;
      }
      if (m === 'DELETE' && !mm[3]) {
        empty(res);
        pending.settle({ kind: 'cancel', message: query.message });
        return;
      }
    }
    if ((mm = /^\/api\/experimental\/session\/(ses[^/]+)\/instructions\/entries\/([^/]+)$/.exec(p)) && m === 'PUT') {
      this.session(mm[1]!).instructions[decodeURIComponent(mm[2]!)] = body?.value;
      return empty(res);
    }
    if ((mm = /^\/api\/experimental\/mcp\/([^/]+)$/.exec(p)) && (m === 'PUT' || m === 'DELETE')) return empty(res);
    if (m === 'GET' && p === '/api/model') {
      const loc = { directory: query['location[directory]'] ?? '/tmp' };
      return json(res, 200, {
        location: loc,
        data: [
          { id: 'fake-model', modelID: 'fake-model', providerID: 'fake', name: 'Fake', variants: [{ id: 'low' }, { id: 'high' }], enabled: true, limit: { context: 128000, output: 8000 } },
          { id: 'other', modelID: 'other', providerID: 'fake', name: 'Other', variants: [], enabled: true, limit: { context: 32000, output: 4000 } },
        ],
      });
    }
    if (m === 'GET' && p === '/api/agent') {
      return json(res, 200, {
        location: { directory: query['location[directory]'] ?? '/tmp' },
        data: [
          { id: 'build', name: 'Build', mode: 'primary', hidden: false },
          { id: 'plan', name: 'Plan', mode: 'primary', hidden: false },
          { id: 'general', name: 'General', mode: 'subagent', hidden: false },
        ],
      });
    }
    return json(res, 404, { _tag: 'NotFound', message: `no route ${m} ${p}` });
  }

  #info(s: FakeSession): Record<string, unknown> {
    return {
      id: s.id,
      ...(s.fork ? { fork: s.fork } : {}),
      projectID: 'proj',
      ...(s.agent ? { agent: s.agent } : {}),
      model: s.model,
      cost: s.totals.cost,
      tokens: { input: s.totals.input, output: s.totals.output, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: Date.now(), updated: Date.now() },
      title: s.title,
      location: { directory: s.directory },
    };
  }

  #sse(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform' });
    res.write(`data: ${JSON.stringify({ id: this.id('evt'), type: 'server.connected', data: {} })}\n\n`);
    res.write(': heartbeat\n\n');
    this.#clients.add(res);
    req.on('close', () => this.#clients.delete(res));
  }

  #prompt(s: FakeSession, body: Record<string, unknown>, res: ServerResponse): void {
    const text = String(body.text ?? '');
    const inboxID = this.id('msg');
    json(res, 200, { data: { id: inboxID, sessionID: s.id, time: { created: Date.now() }, type: 'user', payload: { text }, delivery: body.delivery ?? 'steer' } });
    this.emit('session.inbox.enqueued', { inboxID, sessionID: s.id, item: { type: 'user', payload: { text }, delivery: body.delivery ?? 'steer' } }, { directory: s.directory, durable: true });
    if (s.running) return; // steer: delivered into the running execution
    const scenario = /^scenario:(\w+)/.exec(text)?.[1] ?? 'basic';
    setTimeout(() => void this.#run(s, scenario), 5);
  }

  // --- scenarios ------------------------------------------------------------------------------

  async #run(s: FakeSession, scenario: string): Promise<void> {
    const sid = s.id;
    const dir = s.directory;
    const ev = (type: string, data: Record<string, unknown>, durable = true): void =>
      this.emit(type, { sessionID: sid, ...data }, { directory: dir, durable });
    const msg = this.id('msg');
    s.running = true;
    s.interrupted = false;
    this.emit('session.execution.started', { sessionID: sid }, { durable: true });
    const step = (m: string): void => ev('session.step.started', { assistantMessageID: m, agent: s.agent, model: s.model });
    const endStep = (m: string, finish: string, input: number, output: number, cost = 0): void => {
      ev('session.step.ended', { assistantMessageID: m, finish, cost, tokens: { input, output, reasoning: 0, cache: { read: 0, write: 0 } } });
      const t = s.totals;
      t.cost += cost;
      t.input += input;
      t.output += output;
      ev('session.usage.updated', { cost: t.cost, tokens: { input: t.input, output: t.output, reasoning: 0, cache: { read: 0, write: 0 } } }, false);
    };
    const text = (m: string, parts: string[], ordinal = 0): void => {
      ev('session.text.started', { assistantMessageID: m, ordinal });
      for (const p of parts) ev('session.text.delta', { assistantMessageID: m, ordinal, delta: p }, false);
      ev('session.text.ended', { assistantMessageID: m, ordinal, text: parts.join('') });
    };
    const tool = (m: string, id: string, name: string, input: Record<string, unknown>): void => {
      ev('session.tool.input.started', { assistantMessageID: m, id, name });
      ev('session.tool.input.ended', { assistantMessageID: m, id, text: JSON.stringify(input) });
      ev('session.tool.called', { assistantMessageID: m, id, input, executed: false });
    };
    const ok = (m: string, id: string, out: string, metadata: Record<string, unknown> = { truncated: false }): void =>
      ev('session.tool.success', { assistantMessageID: m, id, content: [{ type: 'text', text: out }], metadata, executed: false });
    const done = (outcome: 'succeeded' | 'failed' | 'interrupted', extra: Record<string, unknown> = {}): void => {
      s.running = false;
      this.emit(`session.execution.${outcome}`, { sessionID: sid, ...extra }, { durable: true });
    };

    switch (scenario) {
      case 'basic': {
        step(msg);
        ev('session.reasoning.started', { assistantMessageID: msg, ordinal: 0, state: { reasoningField: 'reasoning' } });
        ev('session.reasoning.delta', { assistantMessageID: msg, ordinal: 0, delta: 'Thinking' }, false);
        ev('session.reasoning.ended', { assistantMessageID: msg, ordinal: 0, text: 'Thinking' });
        text(msg, ['Hello', ' from', ' fake']);
        endStep(msg, 'stop', 100, 7, 0.0012);
        return done('succeeded');
      }
      case 'tools': {
        step(msg);
        tool(msg, 'call_shell', 'shell', { command: 'echo hi' });
        ev('session.tool.progress', { assistantMessageID: msg, id: 'call_shell', metadata: { shellID: 'sh_1' } }, false);
        ok(msg, 'call_shell', 'hi\n', { status: 'completed', exit: 0 });
        tool(msg, 'call_read', 'read', { path: `${dir}/a.txt` });
        ok(msg, 'call_read', '1: a');
        tool(msg, 'call_grep', 'grep', { pattern: 'TODO', path: 'src' });
        ok(msg, 'call_grep', 'src/x.ts:1');
        tool(msg, 'call_glob', 'glob', { pattern: '**/*.ts' });
        ok(msg, 'call_glob', 'src/x.ts');
        tool(msg, 'call_fetch', 'webfetch', { url: 'https://example.com' });
        ev('session.tool.failed', { assistantMessageID: msg, id: 'call_fetch', error: { type: 'tool.error', message: 'network down' }, executed: false });
        tool(msg, 'call_write', 'write', { path: `${dir}/new.txt`, content: 'x' });
        ok(msg, 'call_write', 'Created file successfully: new.txt');
        tool(msg, 'call_edit', 'edit', { path: 'b.txt', oldString: 'a', newString: 'b' });
        ok(msg, 'call_edit', 'Edited b.txt');
        tool(msg, 'call_mcp', 'execute', { code: 'tools.memory.search({})', description: 'search memory' });
        ok(msg, 'call_mcp', '[]');
        tool(msg, 'call_todo', 'todowrite', { todos: [{ content: 'one', status: 'completed' }, { content: 'two', status: 'in_progress' }] });
        ok(msg, 'call_todo', 'ok');
        // Subagent: child session linked through the parent's tool progress metadata.
        tool(msg, 'call_sub', 'subagent', { agent: 'general', description: 'Look around', prompt: 'ls' });
        const child = this.id('ses');
        this.emit('session.created', { sessionID: child, parentID: sid, agent: 'general', title: 'Look around', location: { directory: dir } }, { directory: dir, durable: true });
        ev('session.tool.progress', { assistantMessageID: msg, id: 'call_sub', metadata: { sessionID: child, status: 'running' } }, false);
        this.emit('session.execution.started', { sessionID: child }, { durable: true });
        const cm = this.id('msg');
        this.emit('session.tool.input.started', { sessionID: child, assistantMessageID: cm, id: 'call_child_read', name: 'read' }, { directory: dir, durable: true });
        this.emit('session.tool.called', { sessionID: child, assistantMessageID: cm, id: 'call_child_read', input: { path: 'c.txt' } }, { directory: dir, durable: true });
        this.emit('session.tool.success', { sessionID: child, assistantMessageID: cm, id: 'call_child_read', content: [{ type: 'text', text: 'c' }] }, { directory: dir, durable: true });
        this.emit('session.text.delta', { sessionID: child, assistantMessageID: cm, ordinal: 0, delta: 'child says c' }, { directory: dir });
        this.emit('session.step.ended', { sessionID: child, assistantMessageID: cm, finish: 'stop', cost: 0.5, tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } }, { directory: dir, durable: true });
        this.emit('session.execution.succeeded', { sessionID: child }, { durable: true });
        ok(msg, 'call_sub', `<subagent sessionID="${child}" state="completed">c</subagent>`, { sessionID: child, status: 'completed' });
        endStep(msg, 'tool-calls', 50, 5, 0.25);
        const msg2 = this.id('msg');
        step(msg2);
        text(msg2, ['All done.']);
        endStep(msg2, 'stop', 60, 3, 0.25);
        this.emit('session.retry.scheduled', { sessionID: sid, assistantMessageID: msg2, attempt: 1, at: Date.now(), error: { type: 'x', message: 'y' } }, { directory: dir });
        return done('succeeded');
      }
      case 'permission': {
        step(msg);
        tool(msg, 'call_rm', 'shell', { command: 'rm -rf build' });
        ev('session.step.streamed', { assistantMessageID: msg });
        const per = this.id('per');
        const reply = await new Promise<{ reply: string; message?: string }>((resolve) => {
          s.pendingPermissions.set(per, (r, message) => resolve({ reply: r, message }));
          this.emit(
            'permission.asked',
            { id: per, sessionID: sid, action: 'shell', resources: ['rm -rf build'], save: ['rm *'], source: { type: 'tool', messageID: msg, id: 'call_rm' } },
            { directory: dir },
          );
        });
        this.emit('permission.replied', { sessionID: sid, requestID: per, reply: reply.reply }, { directory: dir });
        if (s.interrupted) {
          ev('session.tool.failed', { assistantMessageID: msg, id: 'call_rm', error: { type: 'aborted', message: 'Tool execution interrupted' } });
          return done('interrupted', { reason: 'user' });
        }
        if (reply.reply === 'reject') {
          ev('session.tool.failed', { assistantMessageID: msg, id: 'call_rm', error: { type: 'permission.rejected', message: reply.message ?? 'The user rejected permission to use this specific tool call.' } });
        } else {
          ok(msg, 'call_rm', '', { status: 'completed', exit: 0 });
        }
        endStep(msg, 'tool-calls', 20, 2);
        const msg2 = this.id('msg');
        step(msg2);
        text(msg2, [reply.reply === 'reject' ? 'Skipped.' : 'Removed.']);
        endStep(msg2, 'stop', 22, 1);
        return done('succeeded');
      }
      case 'long': {
        step(msg);
        ev('session.text.started', { assistantMessageID: msg, ordinal: 0 });
        tool(msg, 'call_sleep', 'shell', { command: 'sleep 100' });
        for (let i = 0; i < 500 && !s.interrupted; i++) {
          ev('session.text.delta', { assistantMessageID: msg, ordinal: 0, delta: `${i} ` }, false);
          await new Promise((r) => setTimeout(r, 10));
        }
        ev('session.step.failed', { assistantMessageID: msg, error: { type: 'aborted', message: 'Step interrupted' } });
        return done('interrupted', { reason: 'user' });
      }
      case 'question':
      case 'questionmulti': {
        // Shapes from the real capture; the form waits for reply / DELETE / interrupt.
        const cap = capturedQuestion(scenario === 'question' ? 0 : 1);
        const callId = this.id('call');
        step(msg);
        tool(msg, callId, 'question', cap.input);
        ev('session.step.streamed', { assistantMessageID: msg });
        const form: FakeForm = { ...cap.form, id: this.id('frm'), sessionID: sid, metadata: { kind: 'question', tool: { messageID: msg, id: callId } } };
        const outcome = await new Promise<FormOutcome>((settle) => {
          s.pendingForms.set(form.id, { form, settle });
          this.emit('form.created', { form }, { directory: dir });
        });
        s.pendingForms.delete(form.id);
        if (outcome.kind === 'interrupt') {
          this.emit('form.cancelled', { id: form.id, sessionID: sid }, { directory: dir });
          ev('session.tool.failed', { assistantMessageID: msg, id: callId, error: { type: 'aborted', message: 'Tool execution interrupted' }, executed: false });
          return done('interrupted', { reason: 'user' });
        }
        if (outcome.kind === 'cancel') {
          this.emit('form.cancelled', { id: form.id, sessionID: sid }, { directory: dir });
          ev('session.tool.failed', { assistantMessageID: msg, id: callId, error: { type: 'tool.execution', message: outcome.message ?? 'cancelled' }, executed: false });
        } else {
          this.emit('form.replied', { id: form.id, sessionID: sid, answer: outcome.answer }, { directory: dir });
          ok(msg, callId, `User has answered your questions: ${JSON.stringify(outcome.answer)}`, { answers: Object.values(outcome.answer), truncated: false });
        }
        endStep(msg, 'tool-calls', 30, 4);
        const msg2 = this.id('msg');
        step(msg2);
        text(msg2, [outcome.kind === 'cancel' ? 'You declined.' : `Answer: ${JSON.stringify(outcome.answer)}`]);
        endStep(msg2, 'stop', 40, 2);
        return done('succeeded');
      }
      case 'fail': {
        return done('failed', { error: { type: 'provider.no-route', message: 'Model unavailable: nope/bogus' } });
      }
      case 'silent':
        return; // execution "running" until the test intervenes
      case 'replay':
        return this.#replay(s);
      default:
        return done('succeeded');
    }
  }

  /** Replay the next execution segment of the real 2.0.25 capture, re-targeted at this session. */
  #replay(s: FakeSession): void {
    const lines = readFileSync(FIXTURE, 'utf8').trim().split('\n');
    const segments: string[][] = [];
    let cur: string[] | undefined;
    for (const line of lines) {
      const ev = JSON.parse(line) as { type: string; data: { sessionID?: string } };
      if (ev.type === 'session.execution.started' && ev.data.sessionID === FIXTURE_SESSION) {
        cur = [];
        segments.push(cur);
      }
      if (!cur) continue;
      if (ev.type === 'session.inbox.enqueued') continue;
      cur.push(line);
    }
    const seg = segments[this.#replaySegment++ % segments.length] ?? [];
    for (const line of seg) {
      const ev = JSON.parse(line.replaceAll(FIXTURE_SESSION, s.id)) as Record<string, unknown>;
      this.emitRaw(ev);
      const type = String(ev.type);
      if (type.startsWith('session.execution.') && type !== 'session.execution.started') {
        if ((ev.data as { sessionID?: string }).sessionID === s.id) {
          s.running = false;
          return;
        }
      }
    }
    s.running = false;
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function empty(res: ServerResponse): void {
  res.writeHead(204);
  res.end();
}
