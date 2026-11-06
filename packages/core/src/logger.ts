import type { Logger, LogLevel } from '@bizzi/protocol';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function isLogLevel(v: unknown): v is LogLevel {
  return typeof v === 'string' && v in LEVELS;
}

export interface JsonLoggerOptions {
  /** Minimum level written (default 'info'). */
  level?: LogLevel;
  /** Where JSON lines go (default process.stderr). */
  write?: (line: string) => void;
  fields?: Record<string, unknown>;
}

/** Structured logger writing one JSON object per line: {ts, level, msg, ...fields}. */
export function createJsonLogger(opts: JsonLoggerOptions = {}): Logger {
  const min = LEVELS[opts.level ?? 'info'];
  const write = opts.write ?? ((line: string) => process.stderr.write(line));
  const make = (base: Record<string, unknown>): Logger => ({
    log(level, msg, fields) {
      if (LEVELS[level] < min) return;
      const rec: Record<string, unknown> = { ts: new Date().toISOString(), level, msg, ...base, ...fields };
      for (const [k, v] of Object.entries(rec)) {
        if (v instanceof Error) rec[k] = { name: v.name, message: v.message, stack: v.stack };
      }
      let line: string;
      try {
        line = JSON.stringify(rec);
      } catch {
        line = JSON.stringify({ ts: rec.ts, level, msg, note: 'unserializable fields' });
      }
      write(line + '\n');
    },
    child(fields) {
      return make({ ...base, ...fields });
    },
  });
  return make(opts.fields ?? {});
}

export const nullLogger: Logger = {
  log() {},
  child() {
    return nullLogger;
  },
};
