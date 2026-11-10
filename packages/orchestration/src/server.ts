// The bizzi-agents MCP endpoint: Streamable HTTP on a loopback-only listener, one bearer token per
// agent session. The token is minted when the session's agent process starts (prepareStart) and
// identifies the calling session; it dies with the session or the node.

import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { BizziNode } from '@bizzi/core';
import type { Logger } from '@bizzi/protocol';
import { createAgentsMcpServer } from './tools.ts';

export const MCP_PATH = '/mcp';
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface AgentsServerOptions {
  /** Loopback address to bind (default 127.0.0.1). Must not be reachable from other machines. */
  host?: string;
  /** Default 0 (any free port). */
  port?: number;
  logger: Logger;
}

export class AgentsServer {
  readonly #node: BizziNode;
  readonly #log: Logger;
  readonly #http: Server;
  /** sha256(token) → session id, and session id → its current token hash. */
  readonly #tokens = new Map<string, string>();
  readonly #bySession = new Map<string, string>();
  #url?: string;
  #hosts = new Set<string>();

  constructor(node: BizziNode, logger: Logger) {
    this.#node = node;
    this.#log = logger;
    this.#http = createServer((req, res) => void this.#handle(req, res));
  }

  /** http://127.0.0.1:<port>/mcp once listening. */
  get url(): string | undefined {
    return this.#url;
  }

  listen(opts: { host?: string; port?: number } = {}): Promise<string> {
    const host = opts.host ?? '127.0.0.1';
    return new Promise((resolve, reject) => {
      this.#http.once('error', reject);
      this.#http.listen(opts.port ?? 0, host, () => {
        this.#http.off('error', reject);
        const { port } = this.#http.address() as AddressInfo;
        const h = host.includes(':') ? `[${host}]` : host;
        this.#hosts = new Set([`${h}:${port}`, `localhost:${port}`]);
        this.#url = `http://${h}:${port}${MCP_PATH}`;
        this.#log.log('info', 'bizzi-agents MCP listening', { url: this.#url });
        resolve(this.#url);
      });
    });
  }

  /** A new token for `sessionId`; any earlier one stops working. */
  mint(sessionId: string): string {
    this.revoke(sessionId);
    const token = randomBytes(32).toString('base64url');
    const h = hash(token);
    this.#tokens.set(h, sessionId);
    this.#bySession.set(sessionId, h);
    return token;
  }

  revoke(sessionId: string): void {
    const h = this.#bySession.get(sessionId);
    if (h === undefined) return;
    this.#tokens.delete(h);
    this.#bySession.delete(sessionId);
  }

  /** Session id behind a bearer token, if it is live. */
  sessionFor(token: string): string | undefined {
    return this.#tokens.get(hash(token));
  }

  close(): Promise<void> {
    this.#tokens.clear();
    this.#bySession.clear();
    return new Promise((resolve) => {
      if (!this.#http.listening) return resolve();
      this.#http.close(() => resolve());
      this.#http.closeAllConnections();
    });
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname !== MCP_PATH) return reply(res, 404, 'not found');
      // DNS-rebinding guard: only loopback host names.
      if (!this.#hosts.has(String(req.headers.host ?? ''))) return reply(res, 403, 'forbidden host');
      const auth = String(req.headers.authorization ?? '');
      const m = /^Bearer\s+(\S+)$/i.exec(auth);
      const callerId = m ? this.sessionFor(m[1]!) : undefined;
      if (!callerId || !this.#node.sessions.has(callerId)) {
        res.setHeader('www-authenticate', 'Bearer');
        return reply(res, 401, 'unauthorized');
      }
      if (req.method !== 'POST') {
        // Stateless server: no standalone SSE stream, no MCP sessions to delete.
        res.setHeader('allow', 'POST');
        return reply(res, 405, 'method not allowed');
      }
      const body = await readJson(req);
      if (body === undefined) return reply(res, 400, 'invalid JSON body');

      const server = createAgentsMcpServer(this.#node, callerId);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close().catch(() => {});
        void server.close().catch(() => {});
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      this.#log.log('warn', 'bizzi-agents request failed', { err });
      if (!res.headersSent) reply(res, 500, 'internal error');
      else res.end();
    }
  }
}

function hash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function reply(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = chunk as Buffer;
    size += b.length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(b);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}
