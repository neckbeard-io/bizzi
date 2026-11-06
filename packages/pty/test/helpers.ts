import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AdapterContext, Logger, SessionEventBody, StartSessionOptions } from '@bizzi/protocol';

export const logger: Logger = { log() {}, child: () => logger };
export const ctx: AdapterContext = { logger };

export class EventLog {
  events: SessionEventBody[] = [];
  emit = (e: SessionEventBody): void => {
    this.events.push(e);
  };

  /** All term.output decoded and concatenated. */
  output(): string {
    return Buffer.concat(
      this.events.flatMap((e) => (e.type === 'term.output' ? [Buffer.from(e.data.dataBase64, 'base64')] : [])),
    ).toString('utf8');
  }

  ofType<T extends SessionEventBody['type']>(type: T): Extract<SessionEventBody, { type: T }>[] {
    return this.events.filter((e): e is Extract<SessionEventBody, { type: T }> => e.type === type);
  }

  async waitFor(pred: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!pred()) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${what}; output so far: ${JSON.stringify(this.output())}`);
      }
      await sleep(20);
    }
  }

  waitForOutput(text: string, timeoutMs?: number): Promise<void> {
    return this.waitFor(() => this.output().includes(text), JSON.stringify(text), timeoutMs);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function tempDir(prefix = 'bzp-'): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function startOpts(over: Partial<StartSessionOptions> = {}): StartSessionOptions {
  return { sessionId: 's_test', mode: 'terminal', cwd: tmpdir(), cols: 80, rows: 24, ...over };
}
