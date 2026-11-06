import { fileURLToPath } from 'node:url';
import type { AdapterContext, Logger, SessionEventBody, SessionEventMap, SessionEventType, StartSessionOptions } from '@bizzi/protocol';
import { CodexAdapter, type CodexAdapterOptions } from '../src/index.ts';

export const FAKE_SERVER = fileURLToPath(new URL('./fake-app-server.ts', import.meta.url));

export function fakeAdapter(opts: CodexAdapterOptions = {}): CodexAdapter {
  return new CodexAdapter({
    codexPath: process.execPath,
    codexArgsPrefix: [FAKE_SERVER],
    requestTimeoutMs: 5000,
    interruptTimeoutMs: 2000,
    ...opts,
  });
}

export function testLogger(): Logger & { lines: { level: string; msg: string; fields?: Record<string, unknown> }[] } {
  const lines: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
  const logger = {
    lines,
    log(level: string, msg: string, fields?: Record<string, unknown>) {
      lines.push({ level, msg, ...(fields ? { fields } : {}) });
    },
    child() {
      return logger;
    },
  };
  return logger;
}

export class EventLog {
  readonly events: SessionEventBody[] = [];
  #waiters: { pred: (e: SessionEventBody) => boolean; resolve: (e: SessionEventBody) => void }[] = [];

  readonly emit = (e: SessionEventBody): void => {
    this.events.push(e);
    for (const w of [...this.#waiters]) {
      if (w.pred(e)) {
        this.#waiters.splice(this.#waiters.indexOf(w), 1);
        w.resolve(e);
      }
    }
  };

  ofType<T extends SessionEventType>(type: T): SessionEventMap[T][] {
    return this.events.filter((e) => e.type === type).map((e) => e.data as SessionEventMap[T]);
  }

  waitFor<T extends SessionEventType>(
    type: T,
    pred: (d: SessionEventMap[T]) => boolean = () => true,
    timeoutMs = 5000,
  ): Promise<SessionEventMap[T]> {
    const match = (e: SessionEventBody) => e.type === type && pred(e.data as SessionEventMap[T]);
    const existing = this.events.find(match);
    if (existing) return Promise.resolve(existing.data as SessionEventMap[T]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeoutMs);
      this.#waiters.push({
        pred: match,
        resolve: (e) => {
          clearTimeout(timer);
          resolve(e.data as SessionEventMap[T]);
        },
      });
    });
  }

  /** Params of client messages the fake server echoed back as `fake/received`. */
  received(method: string): unknown[] {
    return this.ofType('agent.raw')
      .map((r) => r.payload as { method?: string; params?: { method?: string; params?: unknown } })
      .filter((p) => p.method === 'fake/received' && p.params?.method === method)
      .map((p) => p.params?.params);
  }
}

export function ctx(logger: Logger = testLogger()): AdapterContext {
  return { logger };
}

export function startOpts(extra: Partial<StartSessionOptions> = {}): StartSessionOptions {
  return { sessionId: 's_test', mode: 'structured', cwd: process.cwd(), ...extra };
}
