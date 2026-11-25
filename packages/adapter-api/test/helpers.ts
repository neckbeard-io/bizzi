import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AdapterContext, Logger, SessionEventBody, SessionEventMap } from '@bizzi/protocol';

export const silentLogger: Logger = {
  log() {},
  child() {
    return silentLogger;
  },
};

/** Captures log lines (to check that keys never reach them). */
export function captureLogger(lines: string[]): Logger {
  const l: Logger = {
    log(level, msg, fields) {
      lines.push(`${level} ${msg} ${JSON.stringify(fields ?? {})}`);
    },
    child() {
      return l;
    },
  };
  return l;
}

export const ctx: AdapterContext = { logger: silentLogger };

type Type = keyof SessionEventMap;

export class Recorder {
  readonly events: SessionEventBody[] = [];

  emit = (e: SessionEventBody): void => {
    this.events.push(e);
  };

  of<T extends Type>(type: T): SessionEventMap[T][] {
    return this.events.filter((e) => e.type === type).map((e) => e.data as SessionEventMap[T]);
  }

  types(): string[] {
    return this.events.map((e) => e.type);
  }

  async waitFor<T extends Type>(type: T, pred: (d: SessionEventMap[T]) => boolean = () => true, timeoutMs = 5_000): Promise<SessionEventMap[T]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.of(type).find(pred);
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${type}; got: ${this.types().join(', ')}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  }
}

export interface Recorded {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: any;
}

export type Handler = (req: Recorded, res: ServerResponse) => void | Promise<void>;

/** A fake model API on a loopback port. Unhandled paths answer 404. */
export async function fakeApi(handler: Handler): Promise<{ url: string; requests: Recorded[]; close(): Promise<void> }> {
  const requests: Recorded[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (raw += c));
    req.on('end', () => {
      const r: Recorded = { method: req.method ?? 'GET', path: req.url ?? '/', headers: req.headers, body: raw ? JSON.parse(raw) : undefined };
      requests.push(r);
      Promise.resolve(handler(r, res)).catch((err: unknown) => {
        res.statusCode = 500;
        res.end(String(err));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

export interface SseScriptOptions {
  /** Pause between events. */
  delayMs?: number;
  /** Keep the connection open after the events (for interrupt / idle tests). */
  hang?: boolean;
}

/** Write SSE events: `{ event?, data }` objects; `data` objects are JSON-encoded. */
export async function sse(res: ServerResponse, events: { event?: string; data: unknown }[], o: SseScriptOptions = {}): Promise<void> {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const [i, e] of events.entries()) {
    if (res.destroyed) return;
    if (o.delayMs && i > 0) await new Promise((r) => setTimeout(r, o.delayMs));
    const data = typeof e.data === 'string' ? e.data : JSON.stringify(e.data);
    res.write(`${e.event ? `event: ${e.event}\n` : ''}data: ${data}\n\n`);
  }
  if (!o.hang) res.end();
}

/** A complete Anthropic stream for `text` (optionally with a thinking block first). */
export function anthropicEvents(text: string[], o: { thinking?: string; signature?: string; stop?: string; usage?: { in: number; out: number; cacheRead?: number; cacheWrite?: number } } = {}): { event: string; data: unknown }[] {
  const u = o.usage ?? { in: 10, out: 5 };
  const ev: { event: string; data: unknown }[] = [
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: [],
          usage: { input_tokens: u.in, output_tokens: 1, cache_read_input_tokens: u.cacheRead ?? 0, cache_creation_input_tokens: u.cacheWrite ?? 0 },
        },
      },
    },
    { event: 'ping', data: { type: 'ping' } },
  ];
  let i = 0;
  if (o.thinking !== undefined) {
    ev.push({ event: 'content_block_start', data: { type: 'content_block_start', index: i, content_block: { type: 'thinking', thinking: '', signature: '' } } });
    ev.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: i, delta: { type: 'thinking_delta', thinking: o.thinking } } });
    ev.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: i, delta: { type: 'signature_delta', signature: o.signature ?? 'sig' } } });
    ev.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: i } });
    i++;
  }
  ev.push({ event: 'content_block_start', data: { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } } });
  for (const t of text) ev.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: t } } });
  ev.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: i } });
  ev.push({ event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: o.stop ?? 'end_turn', stop_sequence: null }, usage: { output_tokens: u.out } } });
  ev.push({ event: 'message_stop', data: { type: 'message_stop' } });
  return ev;
}

/** A complete OpenAI-compatible stream for `text`, with a usage chunk and [DONE]. */
export function openaiEvents(text: string[], o: { reasoning?: string; finish?: string; usage?: { prompt: number; completion: number; cached?: number } | null } = {}): { data: unknown }[] {
  const base = { id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'test-model' };
  const ev: { data: unknown }[] = [{ data: { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] } }];
  if (o.reasoning) ev.push({ data: { ...base, choices: [{ index: 0, delta: { reasoning_content: o.reasoning }, finish_reason: null }] } });
  for (const t of text) ev.push({ data: { ...base, choices: [{ index: 0, delta: { content: t }, finish_reason: null }] } });
  ev.push({ data: { ...base, choices: [{ index: 0, delta: {}, finish_reason: o.finish ?? 'stop' }] } });
  const u = o.usage === undefined ? { prompt: 12, completion: 4 } : o.usage;
  if (u) {
    ev.push({
      data: {
        ...base,
        choices: [],
        usage: { prompt_tokens: u.prompt, completion_tokens: u.completion, total_tokens: u.prompt + u.completion, prompt_tokens_details: { cached_tokens: u.cached ?? 0 } },
      },
    });
  }
  ev.push({ data: '[DONE]' });
  return ev;
}
