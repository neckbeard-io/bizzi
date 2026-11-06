// Minimal Server-Sent Events parser (WHATWG event-stream format).

export interface SseMessage {
  event?: string;
  id?: string;
  data: string;
}

/** Incremental parser: feed text chunks, get complete messages back. */
export class SseParser {
  #buf = '';
  #data: string[] = [];
  #event: string | undefined;
  #id: string | undefined;

  push(chunk: string): SseMessage[] {
    this.#buf += chunk;
    const out: SseMessage[] = [];
    let nl: number;
    while ((nl = this.#buf.search(/\r\n|\r|\n/)) >= 0) {
      const line = this.#buf.slice(0, nl);
      const sep = this.#buf[nl] === '\r' && this.#buf[nl + 1] === '\n' ? 2 : 1;
      // A trailing lone '\r' may be the first half of '\r\n'; wait for more input.
      if (this.#buf[nl] === '\r' && nl + 1 === this.#buf.length) break;
      this.#buf = this.#buf.slice(nl + sep);
      const msg = this.#line(line);
      if (msg) out.push(msg);
    }
    return out;
  }

  #line(line: string): SseMessage | undefined {
    if (line === '') {
      if (this.#data.length === 0) {
        this.#event = undefined;
        return undefined;
      }
      const msg: SseMessage = { data: this.#data.join('\n') };
      if (this.#event !== undefined) msg.event = this.#event;
      if (this.#id !== undefined) msg.id = this.#id;
      this.#data = [];
      this.#event = undefined;
      return msg;
    }
    if (line.startsWith(':')) return undefined; // comment / heartbeat
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.#data.push(value);
    else if (field === 'event') this.#event = value;
    else if (field === 'id') this.#id = value;
    return undefined;
  }
}

/** Read an SSE response body to completion (or until aborted), yielding messages. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const parser = new SseParser();
  const decoder = new TextDecoder();
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const m of parser.push(decoder.decode(value, { stream: true }))) yield m;
    }
    for (const m of parser.push(decoder.decode() + '\n\n')) yield m;
  } finally {
    reader.releaseLock();
  }
}
