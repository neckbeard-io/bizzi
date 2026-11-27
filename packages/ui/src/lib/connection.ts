import type { HubCredentials } from '@bizzi/client';
import type { MachineRole } from '@bizzi/protocol';
import { loadJson, loadString, remove, saveJson, saveString } from './storage.ts';
import type { UpdateBridge } from './updates.ts';

export interface ConnectionTarget {
  /** WebSocket URL of the client endpoint (node or hub). */
  url: string;
  /** Static token (local / manual node connections). */
  token?: string;
  source: 'electron' | 'saved' | 'manual' | 'mock' | 'hub';
  /** Hub connections: the pairing this device holds (token comes from challenge/response). */
  hub?: HubCredentials;
  /** Mock server settings (`?mock=1`, or a hub paired at `mock://…`). */
  mock?: { role: MachineRole; demo: string[] };
}

/** Colors for the desktop window chrome (themed title bar strip, window background). */
export interface ChromeColors {
  background: string;
  card: string;
  sidebar: string;
  foreground: string;
  dark: boolean;
}

/** Exposed by the desktop preload script. */
export interface BizziBridge {
  connection?: { url: string; token?: string };
  platform?: string;
  /** The desktop hid the native title bar: the UI reserves a themed strip of this height (theming.md §8). */
  titleBar?: { style: 'inset' | 'overlay'; height: number };
  /** Send the theme's chrome colors to the desktop shell after each theme change. */
  setChrome?: (c: ChromeColors) => void;
  /** System accent color (`rrggbbaa`, macOS/Windows) for the Device theme. */
  accentColor?: string;
  /** The desktop app's self-updater (Settings › Updates). */
  updates?: UpdateBridge;
}

declare global {
  interface Window {
    bizzi?: BizziBridge;
  }
}

const KEY = 'bizzi.connection';
const HUB_KEY = 'bizzi.hub';
const MODE_KEY = 'bizzi.mode';

export type ConnectionMode = 'local' | 'hub' | 'manual';

export const MOCK_URL = 'mock://local';
export const MOCK_HUB_URL = 'mock://hub';

export function isMockQuery(search: string): boolean {
  const q = new URLSearchParams(search);
  const v = q.get('mock');
  return v !== null && v !== '0' && v !== 'false';
}

export function mockTarget(search: string): ConnectionTarget {
  const q = new URLSearchParams(search);
  const role: MachineRole = q.get('mock') === 'node' ? 'node' : 'hub';
  const demo = (q.get('demo') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return { url: MOCK_URL, source: 'mock', mock: { role, demo } };
}

export function isMockHub(hubUrl: string): boolean {
  return hubUrl.startsWith('mock://');
}

export function hubTarget(hub: HubCredentials): ConnectionTarget {
  const t: ConnectionTarget = { url: hub.clientUrl, source: 'hub', hub };
  if (isMockHub(hub.hubUrl)) t.mock = { role: 'hub', demo: [] };
  return t;
}

export interface StartupEnv {
  search: string;
  bridge?: BizziBridge | undefined;
  savedHub?: HubCredentials | null;
  savedManual?: { url: string; token?: string } | null;
  mode?: string | null;
}

/**
 * Where to connect at startup: mock (?mock=1), the remembered choice (hub or local), the Electron bridge,
 * a remembered hub pairing or node URL, or nothing (connect screen).
 */
export function resolveInitialTarget(env: StartupEnv): ConnectionTarget | null {
  if (isMockQuery(env.search)) return mockTarget(env.search);
  const hub = env.savedHub ?? null;
  if (env.mode === 'hub' && hub) return hubTarget(hub);
  const c = env.bridge?.connection;
  if (c?.url && env.mode !== 'manual') return c.token === undefined ? { url: c.url, source: 'electron' } : { url: c.url, token: c.token, source: 'electron' };
  if (hub && env.mode !== 'manual' && env.mode !== 'local') return hubTarget(hub);
  const saved = env.savedManual;
  if (saved?.url && env.mode !== 'local') return saved.token === undefined ? { url: saved.url, source: 'saved' } : { url: saved.url, token: saved.token, source: 'saved' };
  return null;
}

/** Startup environment from storage and the page. */
export function loadStartupEnv(): StartupEnv {
  return {
    search: window.location.search,
    bridge: window.bizzi,
    savedHub: savedHub(),
    savedManual: savedTarget(),
    mode: loadString(MODE_KEY),
  };
}

export function rememberTarget(t: { url: string; token?: string }): void {
  saveJson(KEY, { url: t.url, token: t.token });
  saveString(MODE_KEY, 'manual');
}

export function rememberMode(mode: ConnectionMode): void {
  saveString(MODE_KEY, mode);
}

/** Leave the current connection (the hub pairing stays, so it can be resumed). */
export function forgetTarget(): void {
  remove(KEY);
  remove(MODE_KEY);
}

export function savedTarget(): { url: string; token?: string } | null {
  return loadJson<{ url: string; token?: string }>(KEY);
}

export function savedHub(): HubCredentials | null {
  const h = loadJson<HubCredentials>(HUB_KEY);
  return h?.hubUrl && h.deviceId && h.keyId ? h : null;
}

export function rememberHub(h: HubCredentials): void {
  saveJson(HUB_KEY, h);
  saveString(MODE_KEY, 'hub');
}

export function forgetHub(): void {
  remove(HUB_KEY);
  if (loadString(MODE_KEY) === 'hub') remove(MODE_KEY);
}

/** A sensible default URL when the UI is served by a hub over http(s). */
export function defaultUrl(loc: { protocol: string; host: string }): string {
  if (loc.protocol === 'https:') return `wss://${loc.host}/ws`;
  if (loc.protocol === 'http:' && loc.host && !loc.host.startsWith('localhost:5173')) return `ws://${loc.host}/ws`;
  return 'ws://127.0.0.1:7777/ws';
}

/** The hub URL to suggest: the page's own origin when a hub serves the UI over http(s). */
export function defaultHubUrl(loc: { protocol: string; host: string; pathname: string }): string {
  if ((loc.protocol === 'https:' || loc.protocol === 'http:') && loc.host && !/^(localhost|127\.0\.0\.1):(5173|5288)$/.test(loc.host)) {
    return `${loc.protocol}//${loc.host}${loc.pathname.replace(/\/(index\.html)?$/, '')}`;
  }
  return '';
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

/** A default device name from the platform ("iPhone", "Chrome on macOS", …). */
export function defaultDeviceName(ua: string, nativePlatform?: string): string {
  if (nativePlatform === 'ios') return /iPad/.test(ua) ? 'iPad' : 'iPhone';
  if (nativePlatform === 'android') return 'Android phone';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'this device';
  if (/Electron\//.test(ua)) return `bizzi desktop on ${os}`;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return os === 'iPhone' || os === 'iPad' ? `${browser} on ${os}` : `${browser} on ${os}`;
}
