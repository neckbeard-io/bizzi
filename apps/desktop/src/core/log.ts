// Structured logger (the protocol's `Logger` interface) writing JSON lines to one or more sinks.
// The desktop app writes to its own stderr and to the core's log file, so desktop events
// (power, supervision) are interleaved with the core's stderr in one channel.

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger, LogLevel } from '@bizzi/protocol';

export type LogSink = (line: string) => void;

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(
  sinks: LogSink[],
  fields: Record<string, unknown> = {},
  minLevel: LogLevel = 'info',
): Logger {
  return {
    log(level, msg, extra) {
      if (LEVELS[level] < LEVELS[minLevel]) return;
      const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields, ...extra }) + '\n';
      for (const sink of sinks) {
        try {
          sink(line);
        } catch {
          // a broken sink must never take the app down
        }
      }
    },
    child(more) {
      return createLogger(sinks, { ...fields, ...more }, minLevel);
    },
  };
}

export const stderrSink: LogSink = (line) => {
  process.stderr.write(line);
};

/** Appends to `file` (created on demand). Synchronous on purpose: lines are tiny and ordering matters. */
export function fileSink(file: string): LogSink {
  mkdirSync(dirname(file), { recursive: true });
  return (line) => appendFileSync(file, line);
}

/** Rotates `file` to `file.1` when it is larger than `maxBytes`. Best effort. */
export function rotateIfLarge(file: string, maxBytes = 10 * 1024 * 1024): void {
  try {
    if (statSync(file).size > maxBytes) renameSync(file, `${file}.1`);
  } catch {
    // missing file or race with another writer: nothing to do
  }
}

export const nullLogger: Logger = createLogger([]);
