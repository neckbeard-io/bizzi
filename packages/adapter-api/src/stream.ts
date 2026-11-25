// Read an SSE response body with abort and an idle timeout.

import { ApiError } from './errors.ts';
import { SseParser, type SseMessage } from './sse.ts';

export class IdleTimeoutError extends ApiError {
  constructor(ms: number) {
    super(`stream stalled: no data for ${Math.round(ms / 1000)} s`);
    this.name = 'IdleTimeoutError';
  }
}

export async function* readSseBody(body: ReadableStream<Uint8Array>, signal: AbortSignal | undefined, idleMs: number): AsyncGenerator<SseMessage> {
  const parser = new SseParser();
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let timer: NodeJS.Timeout | undefined;
  let failure: unknown;
  const cancel = (reason: unknown): void => {
    failure ??= reason;
    void reader.cancel(reason).catch(() => undefined);
  };
  const arm = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => cancel(new IdleTimeoutError(idleMs)), idleMs);
  };
  const onAbort = (): void => cancel(signal!.reason);
  if (signal?.aborted) onAbort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    arm();
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (err) {
        throw failure ?? err;
      }
      if (failure) throw failure;
      if (chunk.done) break;
      arm();
      for (const m of parser.push(decoder.decode(chunk.value, { stream: true }))) yield m;
    }
    parser.push(decoder.decode());
    for (const m of parser.end()) yield m;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    if (!failure) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
