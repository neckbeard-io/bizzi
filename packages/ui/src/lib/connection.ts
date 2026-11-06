import { loadJson, remove, saveJson } from './storage.ts';

export interface ConnectionTarget {
  url: string;
  token?: string;
  source: 'electron' | 'saved' | 'manual' | 'mock';
}

/** Exposed by the desktop preload script. */
export interface BizziBridge {
  connection?: { url: string; token?: string };
}

declare global {
  interface Window {
    bizzi?: BizziBridge;
  }
}

const KEY = 'bizzi.connection';

export const MOCK_URL = 'mock://local';

export function isMockQuery(search: string): boolean {
  const q = new URLSearchParams(search);
  const v = q.get('mock');
  return v !== null && v !== '0' && v !== 'false';
}

/** Where to connect at startup: mock (?mock=1), the Electron bridge, a remembered target, or nothing. */
export function resolveInitialTarget(env: { search: string; bridge?: BizziBridge | undefined }): ConnectionTarget | null {
  if (isMockQuery(env.search)) return { url: MOCK_URL, source: 'mock' };
  const c = env.bridge?.connection;
  if (c?.url) return c.token === undefined ? { url: c.url, source: 'electron' } : { url: c.url, token: c.token, source: 'electron' };
  const saved = loadJson<{ url: string; token?: string }>(KEY);
  if (saved?.url) return saved.token === undefined ? { url: saved.url, source: 'saved' } : { url: saved.url, token: saved.token, source: 'saved' };
  return null;
}

export function rememberTarget(t: { url: string; token?: string }): void {
  saveJson(KEY, { url: t.url, token: t.token });
}

export function forgetTarget(): void {
  remove(KEY);
}

export function savedTarget(): { url: string; token?: string } | null {
  return loadJson<{ url: string; token?: string }>(KEY);
}

/** A sensible default URL when the UI is served by a hub over http(s). */
export function defaultUrl(loc: { protocol: string; host: string }): string {
  if (loc.protocol === 'https:') return `wss://${loc.host}/ws`;
  if (loc.protocol === 'http:' && loc.host && !loc.host.startsWith('localhost:5173')) return `ws://${loc.host}/ws`;
  return 'ws://127.0.0.1:7777/ws';
}

/** Accept "host:port", "http(s)://…" or "ws(s)://…" and return a WebSocket URL. */
export function normalizeUrl(input: string): string {
  let u = input.trim();
  if (!u) return u;
  if (/^https?:\/\//i.test(u)) u = u.replace(/^http/i, 'ws');
  if (!/^wss?:\/\//i.test(u)) u = `ws://${u}`;
  try {
    const parsed = new URL(u);
    if (parsed.pathname === '/' || parsed.pathname === '') parsed.pathname = '/ws';
    return parsed.toString();
  } catch {
    return u;
  }
}
