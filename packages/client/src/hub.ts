// Hub HTTP API (protocol hub.ts): pairing and challenge/response token acquisition.
import { BizziError, authMessage, normalizePairingCode } from '@bizzi/protocol';
import type {
  ChallengeRequest,
  ChallengeResponse,
  DeviceKind,
  ErrorCode,
  PairRequest,
  PairResponse,
  TokenRequest,
  TokenResponse,
} from '@bizzi/protocol';
import { defaultIdentityStore, loadIdentity, loadOrCreateIdentity } from './identity.ts';
import type { DeviceIdentity, IdentityStore } from './identity.ts';

/** The subset of `fetch` the hub API needs (injectable for tests and the UI mock). */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

function defaultFetch(): FetchLike {
  const f = (globalThis as { fetch?: FetchLike }).fetch;
  if (!f) throw new BizziError('internal', 'no global fetch in this runtime');
  return f.bind(globalThis);
}

const LOCAL_HOST = /^(localhost|127(?:\.\d+){3}|\[::1\]|10(?:\.\d+){3}|192\.168(?:\.\d+){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d+){2}|[^/:]+\.local)(?::\d+)?$/i;

/**
 * Normalize what a person types (or a scanned link) into the hub's HTTP base URL, without a trailing slash:
 * "hub.example.com" → "https://hub.example.com", "wss://h/ws" → "https://h", "192.168.1.5:7777" → "http://192.168.1.5:7777".
 * A sub-path deployment ("https://h/bizzi/") keeps its path.
 */
export function hubHttpBase(input: string): string {
  let u = input.trim();
  if (!u) return u;
  if (/^wss:\/\//i.test(u)) u = u.replace(/^wss:/i, 'https:');
  else if (/^ws:\/\//i.test(u)) u = u.replace(/^ws:/i, 'http:');
  else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
    const host = u.split('/')[0] ?? u;
    u = `${LOCAL_HOST.test(host) ? 'http' : 'https'}://${u}`;
  }
  try {
    const p = new URL(u);
    let path = p.pathname.replace(/\/+$/, '');
    if (path.endsWith('/ws')) path = path.slice(0, -3);
    if (path.endsWith('/index.html')) path = path.slice(0, -'/index.html'.length);
    return `${p.protocol}//${p.host}${path}`;
  } catch {
    return u.replace(/\/+$/, '');
  }
}

/** The hub's client WebSocket URL derived from its HTTP base (used when a pair response lacks one). */
export function hubClientWsUrl(base: string): string {
  return `${base.replace(/^http/i, 'ws')}/ws`;
}

export interface PairLink {
  /** HTTP base of the hub, when the text names one. */
  hubUrl?: string;
  /** Normalized pairing code. */
  code: string;
}

/**
 * Parse a scanned or pasted pairing link. Accepts the hub's `pairUrl` (e.g. `https://hub/#/pair?code=…`,
 * `https://hub/pair?code=…`, `https://hub/pair/CODE`), a `bizzi://pair?hub=…&code=…` link, or a bare code.
 */
export function parsePairLink(text: string): PairLink | null {
  const t = text.trim();
  if (!t) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(t)) {
    const code = normalizePairingCode(t);
    return /^[A-Z0-9]{4,32}$/.test(code) ? { code } : null;
  }
  let url: URL;
  try {
    url = new URL(t);
  } catch {
    return null;
  }
  const hashQuery = url.hash.includes('?') ? new URLSearchParams(url.hash.slice(url.hash.indexOf('?') + 1)) : null;
  const param = (k: string): string | null => url.searchParams.get(k) ?? hashQuery?.get(k) ?? null;
  let code = param('code');
  let path = url.pathname;
  const m = /^(.*?)\/pair(?:\/([^/?#]+))?\/?$/.exec(path);
  if (m) {
    path = m[1] ?? '';
    if (!code && m[2]) code = decodeURIComponent(m[2]);
  }
  if (!code) return null;
  const out: PairLink = { code: normalizePairingCode(code) };
  const hub = param('hub');
  if (hub) out.hubUrl = hubHttpBase(hub);
  else if (url.protocol === 'http:' || url.protocol === 'https:') out.hubUrl = hubHttpBase(`${url.protocol}//${url.host}${path}`);
  return out;
}

const ERROR_CODES = new Set<ErrorCode>(['bad_request', 'unauthorized', 'not_found', 'conflict', 'unsupported', 'machine_offline', 'agent_unavailable', 'internal']);

function statusCode(status: number): ErrorCode {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status >= 400 && status < 500) return 'bad_request';
  return 'internal';
}

/** POST JSON to the hub; HTTP errors become BizziError (body `{ error: ErrorObject }`), network failures `machine_offline`. */
export async function hubPost<T>(base: string, path: string, body: unknown, fetchFn: FetchLike = defaultFetch()): Promise<T> {
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchFn(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) {
    throw new BizziError('machine_offline', `cannot reach the hub at ${base}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // empty or non-JSON body
  }
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string; data?: unknown } } | null)?.error;
    const code = err?.code && ERROR_CODES.has(err.code as ErrorCode) ? (err.code as ErrorCode) : statusCode(res.status);
    throw new BizziError(code, err?.message ?? `hub returned HTTP ${res.status}`, err?.data);
  }
  if (json === null) throw new BizziError('internal', `hub returned an empty response for ${path}`);
  return json as T;
}

export interface PairOptions {
  hubUrl: string;
  code: string;
  name: string;
  identity: DeviceIdentity;
  kind?: DeviceKind;
  machineId?: string;
  fetch?: FetchLike;
}

/** POST /api/pair: register this device's public key with a one-time code. */
export function pairDevice(opts: PairOptions): Promise<PairResponse> {
  const body: PairRequest = {
    code: normalizePairingCode(opts.code),
    kind: opts.kind ?? 'device',
    name: opts.name,
    publicKey: opts.identity.publicKey,
  };
  if (opts.machineId) body.machineId = opts.machineId;
  return hubPost<PairResponse>(hubHttpBase(opts.hubUrl), '/api/pair', body, opts.fetch);
}

/** challenge → sign `authMessage(deviceId, nonce)` → token. */
export async function requestToken(opts: { hubUrl: string; deviceId: string; identity: DeviceIdentity; fetch?: FetchLike }): Promise<TokenResponse> {
  const base = hubHttpBase(opts.hubUrl);
  const ch = await hubPost<ChallengeResponse>(base, '/api/auth/challenge', { deviceId: opts.deviceId } satisfies ChallengeRequest, opts.fetch);
  const signature = await opts.identity.sign(authMessage(opts.deviceId, ch.nonce));
  return hubPost<TokenResponse>(base, '/api/auth/token', { deviceId: opts.deviceId, nonce: ch.nonce, signature } satisfies TokenRequest, opts.fetch);
}

/** Supplies the bearer token for `hello`. Called before every (re)connect. */
export interface TokenProvider {
  getToken(opts?: { forceRefresh?: boolean }): Promise<string | undefined>;
}

export interface HubTokenProviderOptions {
  hubUrl: string;
  deviceId: string;
  identity: DeviceIdentity;
  fetch?: FetchLike;
  /** Refresh this long before expiry (capped at half the token's lifetime). Default 60 s. */
  refreshMarginMs?: number;
  now?: () => number;
}

/** Caches the hub token and fetches a new one shortly before it expires (concurrent callers share one fetch). */
export class HubTokenProvider implements TokenProvider {
  private readonly opts: HubTokenProviderOptions;
  private readonly now: () => number;
  private current: { token: string; expiresAt: number; fetchedAt: number } | null = null;
  private inflight: Promise<string> | null = null;
  /** Number of tokens fetched (tests, diagnostics). */
  fetches = 0;

  constructor(opts: HubTokenProviderOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
  }

  /** Epoch ms when the cached token expires, or null. */
  get expiresAt(): number | null {
    return this.current?.expiresAt ?? null;
  }

  private fresh(): boolean {
    const c = this.current;
    if (!c) return false;
    const margin = Math.min(this.opts.refreshMarginMs ?? 60_000, (c.expiresAt - c.fetchedAt) / 2);
    return this.now() < c.expiresAt - margin;
  }

  async getToken(opts: { forceRefresh?: boolean } = {}): Promise<string> {
    if (!opts.forceRefresh && this.fresh() && this.current) return this.current.token;
    if (this.inflight) return this.inflight;
    const p = (async () => {
      const fetchedAt = this.now();
      const req: { hubUrl: string; deviceId: string; identity: DeviceIdentity; fetch?: FetchLike } = {
        hubUrl: this.opts.hubUrl,
        deviceId: this.opts.deviceId,
        identity: this.opts.identity,
      };
      if (this.opts.fetch) req.fetch = this.opts.fetch;
      const res = await requestToken(req);
      this.fetches++;
      const exp = Date.parse(res.expiresAt);
      this.current = { token: res.token, expiresAt: Number.isNaN(exp) ? fetchedAt + 5 * 60_000 : exp, fetchedAt };
      return res.token;
    })();
    this.inflight = p;
    try {
      return await p;
    } finally {
      this.inflight = null;
    }
  }

  invalidate(): void {
    this.current = null;
  }
}

/** What a device remembers about a hub it paired with (not secret: the private key stays in the identity store). */
export interface HubCredentials {
  hubUrl: string;
  deviceId: string;
  /** Identity store key holding this pairing's private key. */
  keyId: string;
  clientUrl: string;
  name: string;
  owner: boolean;
  pairedAt: string;
}

/** Pair this device with a hub using a fresh keypair. */
export async function pairWithHub(opts: {
  hubUrl: string;
  code: string;
  name: string;
  store?: IdentityStore;
  fetch?: FetchLike;
}): Promise<HubCredentials> {
  const hubUrl = hubHttpBase(opts.hubUrl);
  if (!hubUrl) throw new BizziError('bad_request', 'enter the hub URL');
  if (!normalizePairingCode(opts.code)) throw new BizziError('bad_request', 'enter the pairing code');
  const store = opts.store ?? defaultIdentityStore();
  // A fresh key per pairing: re-pairing after a revoke never reuses a key the hub has seen.
  const keyId = `${hubUrl}#${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const identity = await loadOrCreateIdentity(keyId, store);
  const pairOpts: PairOptions = { hubUrl, code: opts.code, name: opts.name.trim() || 'bizzi device', identity };
  if (opts.fetch) pairOpts.fetch = opts.fetch;
  let res: PairResponse;
  try {
    res = await pairDevice(pairOpts);
  } catch (e) {
    await store.delete(keyId).catch(() => {});
    throw e;
  }
  return {
    hubUrl,
    deviceId: res.deviceId,
    keyId,
    clientUrl: res.clientUrl || hubClientWsUrl(hubUrl),
    name: pairOpts.name,
    owner: res.owner,
    pairedAt: new Date().toISOString(),
  };
}

/** Token provider for saved credentials; throws `unauthorized` when the device key is gone. */
export async function hubTokenProvider(creds: HubCredentials, opts: { store?: IdentityStore; fetch?: FetchLike } = {}): Promise<HubTokenProvider> {
  const identity = await loadIdentity(creds.keyId, opts.store ?? defaultIdentityStore());
  if (!identity) throw new BizziError('unauthorized', 'this device has no key for the hub any more; pair it again');
  const o: HubTokenProviderOptions = { hubUrl: creds.hubUrl, deviceId: creds.deviceId, identity };
  if (opts.fetch) o.fetch = opts.fetch;
  return new HubTokenProvider(o);
}
