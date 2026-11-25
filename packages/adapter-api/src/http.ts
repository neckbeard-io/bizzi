// HTTP for model APIs: POST with retries on transient failures, a header timeout, an idle timeout
// between chunks, and a per-provider concurrency limit. Keys go in headers only and are scrubbed from
// any error text before it leaves this module.

import { ApiError } from './errors.ts';
import { readSseBody } from './stream.ts';

export { ApiError };
import type { SseMessage } from './sse.ts';

/** Statuses worth retrying (Anthropic's 529 overloaded included). */
export const RETRY_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

export interface HttpOptions {
  fetch?: typeof fetch;
  /** Retries before any output was received (default 2). */
  maxRetries?: number;
  /** First backoff; doubles each retry (default 500 ms). `retry-after` wins when the server sends it (capped at 30 s). */
  retryBaseMs?: number;
  /** Until response headers (default 120 s). */
  timeoutMs?: number;
  /** Longest gap between stream chunks (default 300 s). */
  idleTimeoutMs?: number;
  /** Values to scrub from error messages (the key). */
  secrets?: string[];
}

export function scrub(text: string, secrets: readonly string[] | undefined): string {
  let out = text;
  for (const s of secrets ?? []) if (s && s.length >= 4) out = out.split(s).join('***');
  return out;
}

/** Message of an error body: `{ error: { message } }` (both wire formats), `{ message }`, or the text. */
export function errorText(raw: string): { message: string; type?: string } {
  try {
    const j = JSON.parse(raw) as { error?: { message?: unknown; type?: unknown } | string; message?: unknown };
    if (typeof j.error === 'string') return { message: j.error };
    if (j.error && typeof j.error.message === 'string') {
      return typeof j.error.type === 'string' ? { message: j.error.message, type: j.error.type } : { message: j.error.message };
    }
    if (typeof j.message === 'string') return { message: j.message };
  } catch {
    // not JSON
  }
  return { message: raw.trim().slice(0, 300) || 'empty response' };
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function retryAfterMs(res: Response): number | undefined {
  const ms = Number(res.headers.get('retry-after-ms'));
  if (Number.isFinite(ms) && ms > 0) return ms;
  const h = res.headers.get('retry-after');
  if (!h) return undefined;
  const s = Number(h);
  if (Number.isFinite(s)) return s * 1000;
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

export function isAbort(err: unknown): boolean {
  return (err as Error)?.name === 'AbortError' || (err as { code?: string })?.code === 'ABORT_ERR';
}

/**
 * POST `body` as JSON and return the open response once it is 2xx. Retries transient statuses and
 * network failures. The returned `signal` aborts the body read (caller's abort or idle timeout).
 */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal | undefined,
  o: HttpOptions = {},
): Promise<Response> {
  const doFetch = o.fetch ?? fetch;
  const maxRetries = o.maxRetries ?? 2;
  const base = o.retryBaseMs ?? 500;
  const payload = JSON.stringify(body);
  for (let attempt = 0; ; attempt++) {
    const headerTimeout = AbortSignal.timeout(o.timeoutMs ?? 120_000);
    const sig = signal ? AbortSignal.any([signal, headerTimeout]) : headerTimeout;
    let res: Response;
    try {
      res = await doFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: payload, signal: sig });
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? err;
      const timedOut = headerTimeout.aborted;
      if (attempt < maxRetries) {
        await sleep(base * 2 ** attempt, signal);
        continue;
      }
      const msg = timedOut ? `no response within ${Math.round((o.timeoutMs ?? 120_000) / 1000)} s` : (err as Error).message;
      throw new ApiError(scrub(`request to ${new URL(url).host} failed: ${msg}`, o.secrets));
    }
    if (res.ok) return res;
    const raw = await res.text().catch(() => '');
    if (RETRY_STATUSES.has(res.status) && attempt < maxRetries) {
      await sleep(Math.min(30_000, retryAfterMs(res) ?? base * 2 ** attempt), signal);
      continue;
    }
    const e = errorText(raw);
    throw new ApiError(scrub(`${res.status} ${e.message}`, o.secrets), res.status, e.type);
  }
}

/** GET JSON (discovery). Undefined on any failure. */
export async function getJson(url: string, headers: Record<string, string>, o: HttpOptions & { timeoutMs?: number } = {}): Promise<unknown> {
  try {
    const res = await (o.fetch ?? fetch)(url, { headers, signal: AbortSignal.timeout(o.timeoutMs ?? 5_000) });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return undefined;
    }
    return (await res.json()) as unknown;
  } catch {
    return undefined;
  }
}

/** SSE messages of a response body; aborts on `signal` or when no chunk arrives for `idleTimeoutMs`. */
export function sseMessages(res: Response, signal: AbortSignal | undefined, o: HttpOptions = {}): AsyncGenerator<SseMessage> {
  if (!res.body) throw new ApiError('response has no body');
  return readSseBody(res.body, signal, o.idleTimeoutMs ?? 300_000);
}

/** Counting semaphore. */
export class Limiter {
  #max: number;
  #active = 0;
  #queue: (() => void)[] = [];

  constructor(max: number) {
    this.#max = max;
  }

  set max(n: number) {
    this.#max = n;
    this.#drain();
  }

  get active(): number {
    return this.#active;
  }

  get queued(): number {
    return this.#queue.length;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.#active >= this.#max) {
      await new Promise<void>((resolve, reject) => {
        const go = (): void => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = (): void => {
          this.#queue = this.#queue.filter((f) => f !== go);
          reject(signal!.reason);
        };
        if (signal?.aborted) return reject(signal.reason);
        signal?.addEventListener('abort', onAbort, { once: true });
        this.#queue.push(go);
      });
    } else {
      this.#active++;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active--;
      this.#drain();
    };
  }

  #drain(): void {
    while (this.#active < this.#max && this.#queue.length) {
      this.#active++;
      this.#queue.shift()!();
    }
  }
}

const limiters = new Map<string, Limiter>();

/** One limiter per provider id in this process, shared by sessions and utility calls; undefined = unlimited. */
export function limiterFor(providerId: string, max: number | undefined): Limiter | undefined {
  if (!max) return undefined;
  let l = limiters.get(providerId);
  if (!l) limiters.set(providerId, (l = new Limiter(max)));
  else l.max = max;
  return l;
}
