// Small typed client for the OpenCode v2 HTTP API (`opencode serve`). Only the routes the adapter
// uses. Paths and bodies follow the server's own OpenAPI document (GET /openapi.json, v2.0.25).
//
// The official `@opencode-ai/sdk` (1.19.x) ships a `./v2` entry, but it was generated from an older
// v2 snapshot: it still calls removed routes (`/api/health`, `/api/session/{id}/event`,
// `/api/session/{id}/question/...`, `/api/session/{id}/wait`) and lacks newer ones (forms,
// instruction entries, runtime MCP). A hand-written client against the live spec is smaller and
// fails loudly on drift instead of silently.

import { readSse } from './sse.ts';
import type {
  AgentInfo,
  CreateSessionBody,
  InboxUser,
  LocationRef,
  McpConfig,
  MessageInfo,
  ModelInfo,
  ModelRef,
  OcEvent,
  PermissionReply,
  PermissionRule,
  PromptBody,
  ServerInfo,
  SessionInfo,
} from './types.ts';

export class OpenCodeHttpError extends Error {
  readonly status: number;
  readonly body: string;
  readonly tag: string | undefined;
  constructor(method: string, path: string, status: number, body: string) {
    let tag: string | undefined;
    let detail = body;
    try {
      const j = JSON.parse(body) as { _tag?: string; message?: string };
      tag = j._tag;
      if (j.message) detail = j.message;
    } catch {
      // not JSON
    }
    super(`opencode ${method} ${path} -> ${status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
    this.name = 'OpenCodeHttpError';
    this.status = status;
    this.body = body;
    this.tag = tag;
  }
}

export interface ClientOptions {
  baseUrl: string;
  /** HTTP basic-auth password (`OPENCODE_SERVER_PASSWORD`); username is always "opencode". */
  password?: string;
  username?: string;
  requestTimeoutMs?: number;
}

type Query = Record<string, string | number | boolean | undefined>;

function locationQuery(loc: LocationRef | undefined): Query {
  return loc ? { 'location[directory]': loc.directory } : {};
}

export class OpenCodeClient {
  readonly baseUrl: string;
  #auth: string | undefined;
  #timeout: number;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.#auth =
      opts.password !== undefined
        ? 'Basic ' + Buffer.from(`${opts.username ?? 'opencode'}:${opts.password}`).toString('base64')
        : undefined;
    this.#timeout = opts.requestTimeoutMs ?? 30_000;
  }

  #url(path: string, query?: Query): string {
    const u = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
    return u.toString();
  }

  #headers(json: boolean): Record<string, string> {
    const h: Record<string, string> = { accept: 'application/json' };
    if (json) h['content-type'] = 'application/json';
    if (this.#auth) h.authorization = this.#auth;
    return h;
  }

  async request<T>(method: string, path: string, opts: { query?: Query; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
    const res = await fetch(this.#url(path, opts.query), {
      method,
      headers: this.#headers(opts.body !== undefined),
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? this.#timeout),
    });
    const text = await res.text();
    if (!res.ok) throw new OpenCodeHttpError(method, path, res.status, text);
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  // --- server ---------------------------------------------------------------------------------

  info(timeoutMs?: number): Promise<ServerInfo> {
    return this.request<ServerInfo>('GET', '/api/info', { timeoutMs });
  }

  // --- sessions -------------------------------------------------------------------------------

  async createSession(body: CreateSessionBody): Promise<SessionInfo> {
    return (await this.request<{ data: SessionInfo }>('POST', '/api/session', { body })).data;
  }

  async getSession(id: string): Promise<SessionInfo> {
    return (await this.request<{ data: SessionInfo }>('GET', `/api/session/${encodeURIComponent(id)}`)).data;
  }

  updateSession(id: string, body: { title?: string; permissions?: PermissionRule[] }): Promise<void> {
    return this.request('PATCH', `/api/session/${encodeURIComponent(id)}`, { body });
  }

  async prompt(id: string, body: PromptBody): Promise<InboxUser> {
    return (await this.request<{ data: InboxUser }>('POST', `/api/session/${encodeURIComponent(id)}/prompt`, { body })).data;
  }

  interrupt(id: string): Promise<{ interrupted: boolean }> {
    return this.request('POST', `/api/session/${encodeURIComponent(id)}/interrupt`);
  }

  switchModel(id: string, model: ModelRef): Promise<void> {
    return this.request('POST', `/api/session/${encodeURIComponent(id)}/model`, { body: { model } });
  }

  switchAgent(id: string, agent: string): Promise<void> {
    return this.request('POST', `/api/session/${encodeURIComponent(id)}/agent`, { body: { agent } });
  }

  async messages(id: string, opts: { limit?: number; order?: 'asc' | 'desc' } = {}): Promise<MessageInfo[]> {
    const r = await this.request<{ data: MessageInfo[] }>('GET', `/api/session/${encodeURIComponent(id)}/message`, {
      query: { limit: opts.limit, order: opts.order },
    });
    return r.data;
  }

  async activeSessions(): Promise<Record<string, unknown>> {
    return (await this.request<{ data: Record<string, unknown> }>('GET', '/api/session/active')).data;
  }

  replyPermission(sessionId: string, requestId: string, decision: PermissionReply, message?: string): Promise<void> {
    return this.request(
      'POST',
      `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`,
      { body: message ? { decision, message } : { decision } },
    );
  }

  /** Experimental: API-managed instruction entries appended to the session's system context. */
  putInstruction(sessionId: string, key: string, value: string): Promise<void> {
    return this.request(
      'PUT',
      `/api/experimental/session/${encodeURIComponent(sessionId)}/instructions/entries/${encodeURIComponent(key)}`,
      { body: { value } },
    );
  }

  /** Environment variables for the session's shell/tool processes. */
  setEnvironment(sessionId: string, variables: Record<string, string>): Promise<void> {
    return this.request('PUT', `/api/session/${encodeURIComponent(sessionId)}/environment`, { body: { variables } });
  }

  // --- location-scoped ------------------------------------------------------------------------

  async models(loc?: LocationRef): Promise<ModelInfo[]> {
    return (await this.request<{ data: ModelInfo[] }>('GET', '/api/model', { query: locationQuery(loc) })).data;
  }

  async agents(loc?: LocationRef): Promise<AgentInfo[]> {
    return (await this.request<{ data: AgentInfo[] }>('GET', '/api/agent', { query: locationQuery(loc) })).data;
  }

  /** Experimental: register an MCP server at runtime for one location (not written to config files). */
  addMcp(name: string, config: McpConfig, loc: LocationRef): Promise<void> {
    return this.request('PUT', `/api/experimental/mcp/${encodeURIComponent(name)}`, {
      query: locationQuery(loc),
      body: { config },
    });
  }

  removeMcp(name: string, loc: LocationRef): Promise<void> {
    return this.request('DELETE', `/api/experimental/mcp/${encodeURIComponent(name)}`, { query: locationQuery(loc) });
  }

  // --- events ---------------------------------------------------------------------------------

  /**
   * Subscribe to the global event stream. Resolves once the stream is open; the generator ends
   * when the server closes the stream or `signal` aborts. No replay: events missed while
   * disconnected must be reconciled from session state.
   */
  async events(signal: AbortSignal): Promise<AsyncGenerator<OcEvent>> {
    const res = await fetch(this.#url('/api/event'), {
      headers: { ...this.#headers(false), accept: 'text/event-stream' },
      signal,
    });
    if (!res.ok || !res.body) {
      throw new OpenCodeHttpError('GET', '/api/event', res.status, await res.text().catch(() => ''));
    }
    const body = res.body;
    return (async function* () {
      for await (const m of readSse(body)) {
        if (!m.data) continue;
        let ev: OcEvent;
        try {
          ev = JSON.parse(m.data) as OcEvent;
        } catch {
          continue;
        }
        if (ev && typeof ev.type === 'string') yield ev;
      }
    })();
  }
}
