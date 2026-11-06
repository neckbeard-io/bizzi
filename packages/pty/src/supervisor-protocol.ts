// Wire format between the adapter (client) and a detached PTY supervisor: newline-delimited JSON
// over a Unix socket in the runtime dir. Internal to @bizzi/pty; both ends ship together.

import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Socket } from 'node:net';
import type { ExitInfo } from './backend.ts';

export type ClientMessage =
  | { t: 'attach' }
  | { t: 'input'; b64: string }
  | { t: 'resize'; cols: number; rows: number }
  | { t: 'kill'; signal?: string }
  /** Output up to this absolute offset has been delivered downstream (persisted by the core). */
  | { t: 'ack'; offset: number };

export interface HelloMessage {
  t: 'hello';
  id: string;
  /** PTY child pid. */
  pid: number;
  supervisorPid: number;
  cols: number;
  rows: number;
  /** Scrollback window [start, end) as absolute offsets; `replay` chunks cover it. */
  start: number;
  end: number;
  /** Last offset a previous client acknowledged. */
  acked: number;
  exit?: ExitInfo;
}

export type SupervisorMessage =
  | HelloMessage
  | { t: 'replay'; b64: string }
  | { t: 'replayed' }
  | { t: 'data'; b64: string }
  | ({ t: 'exit' } & ExitInfo)
  | { t: 'error'; message: string };

/** Written by the client (mode 0600), read and deleted by the supervisor at startup. */
export interface SupervisorSpec {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  scrollbackBytes: number;
  /** How long to stay up after the child exits while no client has collected the exit. */
  lingerMs: number;
  /** Kill the child after this long without a client (0 = never). */
  orphanTimeoutMs: number;
  killTimeoutMs: number;
  /** Opaque labels stored in the meta file (agent, sessionId, …). */
  labels: Record<string, string>;
}

/** Status file the supervisor keeps next to its socket (no environment: it may hold secrets). */
export interface SupervisorMeta {
  id: string;
  supervisorPid: number;
  pid: number;
  command: string;
  args: string[];
  cwd: string;
  startedAt: string;
  labels: Record<string, string>;
  exit?: ExitInfo;
  exitedAt?: string;
  error?: string;
}

export function socketPath(dir: string, id: string): string {
  return join(dir, `${id}.sock`);
}
export function metaPath(dir: string, id: string): string {
  return join(dir, `${id}.json`);
}
export function specPath(dir: string, id: string): string {
  return join(dir, `${id}.spec.json`);
}

/** Supervisor ids: 16 chars of lowercase base32, short enough for Unix socket path limits. */
export const SUPERVISOR_ID_RE = /^[a-z2-7]{16}$/;

export function sendMessage(socket: Socket, msg: ClientMessage | SupervisorMessage): void {
  if (socket.destroyed || !socket.writable) return;
  socket.write(JSON.stringify(msg) + '\n');
}

/** Feed socket data; calls `onMessage` per complete JSON line. Malformed lines are skipped. */
export function lineParser<T>(onMessage: (msg: T) => void): (chunk: Buffer | string) => void {
  let pending = '';
  const decoder = new StringDecoder('utf8');
  return (chunk) => {
    pending += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    let nl: number;
    while ((nl = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      if (line.trim() === '') continue;
      let msg: T;
      try {
        msg = JSON.parse(line) as T;
      } catch {
        continue;
      }
      onMessage(msg);
    }
  };
}
