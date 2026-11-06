// `<dataDir>/serve.json`: written by `bizzi serve` while it is listening (same JSON as the ready
// line), removed on exit. The desktop app uses it to attach to a running node (e.g. a launchd
// `bizzi serve`) instead of starting a second one.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ServeReady } from '@bizzi/protocol';
import { asServeReady } from './ready-line.ts';

export const SERVE_FILE = 'serve.json';

export function serveFilePath(dataDir: string): string {
  return join(dataDir, SERVE_FILE);
}

export type ServeFileRead =
  | { kind: 'ok'; ready: ServeReady }
  | { kind: 'missing' }
  | { kind: 'invalid'; error: string };

export async function readServeFile(dataDir: string): Promise<ServeFileRead> {
  let text: string;
  try {
    text = await readFile(serveFilePath(dataDir), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'invalid', error: String(err) };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return { kind: 'invalid', error: `not JSON: ${String(err)}` };
  }
  const ready = asServeReady(value);
  return ready ? { kind: 'ok', ready } : { kind: 'invalid', error: 'not a ServeReady object' };
}

/** True if a process with this pid exists (EPERM means it exists but belongs to someone else). */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** ws://host:port/ws -> http://host:port/healthz (wss -> https). */
export function healthzUrl(wsUrl: string): string {
  const u = new URL(wsUrl);
  u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
  u.pathname = '/healthz';
  u.search = '';
  u.hash = '';
  return u.toString();
}

export type HealthCheck = (ready: ServeReady, timeoutMs: number) => Promise<boolean>;

/** `GET /healthz` must answer 2xx. The token is sent in case the endpoint is authenticated. */
export const checkHealth: HealthCheck = async (ready, timeoutMs) => {
  try {
    const res = await fetch(healthzUrl(ready.url), {
      headers: { authorization: `Bearer ${ready.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
};

export type AttachDecision =
  | { attach: true; ready: ServeReady }
  | { attach: false; reason: 'missing' | 'invalid' | 'dead-pid' | 'unhealthy'; detail?: string };

export interface AttachDeps {
  isAlive?: (pid: number) => boolean;
  health?: HealthCheck;
  timeoutMs?: number;
}

/** Decides whether to attach to the node described by `<dataDir>/serve.json`. */
export async function decideAttach(dataDir: string, deps: AttachDeps = {}): Promise<AttachDecision> {
  const isAlive = deps.isAlive ?? isPidAlive;
  const health = deps.health ?? checkHealth;
  const file = await readServeFile(dataDir);
  if (file.kind === 'missing') return { attach: false, reason: 'missing' };
  if (file.kind === 'invalid') return { attach: false, reason: 'invalid', detail: file.error };
  if (!isAlive(file.ready.pid)) return { attach: false, reason: 'dead-pid', detail: `pid ${file.ready.pid}` };
  if (!(await health(file.ready, deps.timeoutMs ?? 1500))) {
    return { attach: false, reason: 'unhealthy', detail: healthzUrl(file.ready.url) };
  }
  return { attach: true, ready: file.ready };
}
