// Parsing of the `ServeReady` line that `bizzi serve` prints on stdout once it is listening
// (the CLI <-> desktop contract, see `ServeReady` in @bizzi/protocol).

import type { Readable } from 'node:stream';
import type { ServeReady } from '@bizzi/protocol';

/** Validates an already-parsed value as `ServeReady`. Returns null when it isn't one. */
export function asServeReady(value: unknown): ServeReady | null {
  if (typeof value !== 'object' || value === null) return null;
  const o = value as Record<string, unknown>;
  if (o['event'] !== 'ready') return null;
  const { url, token, machineId, pid } = o;
  if (typeof url !== 'string' || !isWsUrl(url)) return null;
  if (typeof token !== 'string' || token.length === 0) return null;
  if (typeof machineId !== 'string' || machineId.length === 0) return null;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  return { event: 'ready', url, token, machineId, pid };
}

/** Parses one stdout line. Anything that isn't a valid ready line yields null. */
export function parseReadyLine(line: string): ServeReady | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    return asServeReady(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

function isWsUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'ws:' || u.protocol === 'wss:';
  } catch {
    return false;
  }
}

export class ReadyLineError extends Error {
  readonly code: 'timeout' | 'closed';
  constructor(code: 'timeout' | 'closed', message: string) {
    super(message);
    this.name = 'ReadyLineError';
    this.code = code;
  }
}

export interface WaitForReadyOptions {
  timeoutMs: number;
  /** Called with every non-ready stdout line, before and after the ready line. */
  onOtherLine?: (line: string) => void;
}

/**
 * Resolves with the first valid ready line on `stream`. Rejects if the stream ends first or
 * nothing arrives within `timeoutMs`. Keeps reading afterwards so the pipe never fills up.
 */
export function waitForReadyLine(stream: Readable, opts: WaitForReadyOptions): Promise<ServeReady> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let buf = '';
    const timer = setTimeout(() => {
      settle(() => reject(new ReadyLineError('timeout', `no ready line within ${opts.timeoutMs} ms`)));
    }, opts.timeoutMs);

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const handleLine = (line: string) => {
      if (!settled) {
        const ready = parseReadyLine(line);
        if (ready) {
          settle(() => resolve(ready));
          return;
        }
      }
      if (line.trim() !== '') opts.onOtherLine?.(line);
    };

    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        handleLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
    const onEnd = () => {
      if (buf !== '') {
        handleLine(buf);
        buf = '';
      }
      settle(() => reject(new ReadyLineError('closed', 'stdout closed before the ready line')));
    };
    stream.on('end', onEnd);
    stream.on('close', onEnd);
    stream.on('error', onEnd);
  });
}
