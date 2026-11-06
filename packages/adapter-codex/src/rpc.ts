// Minimal JSON-RPC 2.0-style client for `codex app-server` over stdio.
// Wire format: one JSON object per line, no "jsonrpc" field.
//   request:      {id, method, params}
//   response:     {id, result} | {id, error: {code, message, data?}}
//   notification: {method, params}
// The server also sends requests to the client (approvals); the client answers with a response.

import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { Logger } from '@bizzi/protocol';

export type RpcId = string | number;

export interface RpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export class RpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

/** The connection closed before a response arrived. */
export class RpcClosedError extends Error {
  constructor(message = 'connection closed') {
    super(message);
    this.name = 'RpcClosedError';
  }
}

export interface IncomingNotification {
  method: string;
  params: unknown;
}

export interface IncomingRequest {
  id: RpcId;
  method: string;
  params: unknown;
}

export interface RpcHandlers {
  onNotification(msg: IncomingNotification): void;
  onRequest(msg: IncomingRequest): void;
}

interface Pending {
  method: string;
  resolve(v: unknown): void;
  reject(e: Error): void;
  timer?: ReturnType<typeof setTimeout>;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export class JsonRpcConnection {
  readonly #out: Writable;
  readonly #handlers: RpcHandlers;
  readonly #logger: Logger;
  readonly #pending = new Map<RpcId, Pending>();
  readonly #decoder = new StringDecoder('utf8');
  #buf = '';
  #nextId = 1;
  #closed = false;
  #closeReason = 'connection closed';

  constructor(input: Readable, output: Writable, handlers: RpcHandlers, logger: Logger) {
    this.#out = output;
    this.#handlers = handlers;
    this.#logger = logger;
    input.on('data', (chunk: Buffer | string) => this.#onData(chunk));
    input.on('end', () => this.#onData(Buffer.alloc(0), true));
    output.on('error', (err: Error) => this.#logger.log('warn', 'codex stdin error', { error: err.message }));
  }

  get closed(): boolean {
    return this.#closed;
  }

  request<R = unknown>(method: string, params: unknown, timeoutMs?: number): Promise<R> {
    if (this.#closed) return Promise.reject(new RpcClosedError(this.#closeReason));
    const id = this.#nextId++;
    return new Promise<R>((resolve, reject) => {
      const p: Pending = { method, resolve: resolve as (v: unknown) => void, reject };
      if (timeoutMs !== undefined && timeoutMs > 0) {
        p.timer = setTimeout(() => {
          this.#pending.delete(id);
          reject(new RpcError(-32000, `${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this.#pending.set(id, p);
      this.#write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.#closed) return;
    this.#write(params === undefined ? { method } : { method, params });
  }

  respond(id: RpcId, result: unknown): void {
    if (this.#closed) return;
    this.#write({ id, result });
  }

  respondError(id: RpcId, error: RpcErrorObject): void {
    if (this.#closed) return;
    this.#write({ id, error });
  }

  /** Reject every in-flight request; further calls fail fast. Idempotent. */
  close(reason = 'connection closed'): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeReason = reason;
    for (const [id, p] of this.#pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new RpcClosedError(reason));
      this.#pending.delete(id);
    }
  }

  #write(msg: unknown): void {
    try {
      this.#out.write(JSON.stringify(msg) + '\n');
    } catch (err) {
      this.#logger.log('warn', 'codex write failed', { error: (err as Error).message });
    }
  }

  #onData(chunk: Buffer | string, end = false): void {
    this.#buf += typeof chunk === 'string' ? chunk : this.#decoder.write(chunk);
    if (end) this.#buf += this.#decoder.end();
    let nl: number;
    while ((nl = this.#buf.indexOf('\n')) >= 0) {
      const line = this.#buf.slice(0, nl).trim();
      this.#buf = this.#buf.slice(nl + 1);
      if (line) this.#onLine(line);
    }
    if (end && this.#buf.trim()) {
      const line = this.#buf.trim();
      this.#buf = '';
      this.#onLine(line);
    }
  }

  #onLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      this.#logger.log('warn', 'codex sent a non-JSON line', { line: line.slice(0, 500) });
      return;
    }
    if (!isObject(msg)) {
      this.#logger.log('warn', 'codex sent a non-object message', { line: line.slice(0, 500) });
      return;
    }
    const hasId = typeof msg.id === 'string' || typeof msg.id === 'number';
    const method = typeof msg.method === 'string' ? msg.method : undefined;
    try {
      if (hasId && method !== undefined) {
        this.#handlers.onRequest({ id: msg.id as RpcId, method, params: msg.params });
      } else if (hasId) {
        this.#onResponse(msg.id as RpcId, msg);
      } else if (method !== undefined) {
        this.#handlers.onNotification({ method, params: msg.params });
      } else {
        this.#logger.log('warn', 'codex sent an unrecognized message', { line: line.slice(0, 500) });
      }
    } catch (err) {
      this.#logger.log('error', 'error handling codex message', { error: (err as Error).stack ?? String(err), method });
    }
  }

  #onResponse(id: RpcId, msg: Record<string, unknown>): void {
    const p = this.#pending.get(id);
    if (!p) {
      this.#logger.log('debug', 'response for unknown request id', { id });
      return;
    }
    this.#pending.delete(id);
    if (p.timer) clearTimeout(p.timer);
    if (isObject(msg.error)) {
      const e = msg.error;
      p.reject(
        new RpcError(
          typeof e.code === 'number' ? e.code : -32603,
          typeof e.message === 'string' ? e.message : `${p.method} failed`,
          e.data,
        ),
      );
    } else {
      p.resolve(msg.result);
    }
  }
}
