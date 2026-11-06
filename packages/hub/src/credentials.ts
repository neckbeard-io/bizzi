// Node/device side of pairing and token issuance: the saved credential, POST /api/pair and the
// challenge → signature → token exchange (hub.ts).

import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BizziError,
  type ChallengeResponse,
  type DeviceKind,
  type Ed25519PublicJwk,
  type ErrorObject,
  type PairRequest,
  type PairResponse,
  type TokenResponse,
} from '@bizzi/protocol';
import { generateKeyPair, signChallenge, type Ed25519KeyPair, type Ed25519PrivateJwk } from './crypto.ts';

export const CREDENTIAL_FILE = 'hub-credential.json';

/** What `bizzi pair` saves in <dataDir>/hub-credential.json (mode 0600). */
export interface HubCredential {
  version: 1;
  /** Node link URL from the pair response, e.g. wss://bizzi.example.com/ws/node. */
  hubUrl: string;
  deviceId: string;
  kind: DeviceKind;
  machineId?: string;
  publicKey: Ed25519PublicJwk;
  privateKey: Ed25519PrivateJwk;
  pairedAt: string;
}

export function credentialPath(dataDir: string): string {
  return join(dataDir, CREDENTIAL_FILE);
}

export function loadCredential(dataDir: string): HubCredential | undefined {
  let raw: string;
  try {
    raw = readFileSync(credentialPath(dataDir), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  const c = JSON.parse(raw) as Partial<HubCredential>;
  if (c.version !== 1 || typeof c.deviceId !== 'string' || typeof c.hubUrl !== 'string' || typeof c.privateKey?.d !== 'string') {
    throw new Error(`${credentialPath(dataDir)} is not a valid bizzi hub credential`);
  }
  return c as HubCredential;
}

export function saveCredential(dataDir: string, cred: HubCredential): string {
  const file = credentialPath(dataDir);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cred, null, 2) + '\n', { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  return file;
}

/**
 * The hub's HTTP base for any URL a user might give: https://h, wss://h/ws/node, ws://h:7777/ws, h:7777.
 * A path prefix in front of /ws or /ws/node (hub behind a sub-path) is kept.
 */
export function hubHttpBase(url: string): string {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`;
  const u = new URL(withScheme);
  if (u.protocol === 'ws:') u.protocol = 'http:';
  else if (u.protocol === 'wss:') u.protocol = 'https:';
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new BizziError('bad_request', `unsupported hub URL ${url}`);
  const path = u.pathname.replace(/\/+$/, '').replace(/\/ws(\/node)?$/, '');
  return `${u.protocol}//${u.host}${path}`;
}

/** The node link URL for any hub URL (see hubHttpBase). */
export function hubNodeUrl(url: string): string {
  if (/^wss?:\/\/.+\/ws\/node\/?$/.test(url)) return url.replace(/\/+$/, '');
  return `${hubHttpBase(url).replace(/^http/, 'ws')}/ws/node`;
}

async function postJson<T>(url: string, body: unknown, f: typeof fetch = fetch): Promise<T> {
  let res: Response;
  try {
    res = await f(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new BizziError('machine_offline', `cannot reach hub at ${url}: ${(err as Error).cause ?? (err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    parsed = undefined;
  }
  if (!res.ok) {
    const e = (parsed as { error?: ErrorObject } | undefined)?.error;
    throw new BizziError(e?.code ?? (res.status === 401 || res.status === 429 ? 'unauthorized' : 'internal'), e?.message ?? `hub answered HTTP ${res.status}`, e?.data);
  }
  return parsed as T;
}

export interface PairOptions {
  hubUrl: string;
  code: string;
  kind: DeviceKind;
  name: string;
  machineId?: string;
  keyPair?: Ed25519KeyPair;
  fetch?: typeof fetch;
}

/** Pair with a one-time code; returns the credential to save. */
export async function pairWithHub(o: PairOptions): Promise<{ credential: HubCredential; response: PairResponse }> {
  const keyPair = o.keyPair ?? generateKeyPair();
  const req: PairRequest = { code: o.code, kind: o.kind, name: o.name, publicKey: keyPair.publicKey };
  if (o.machineId) req.machineId = o.machineId;
  const response = await postJson<PairResponse>(`${hubHttpBase(o.hubUrl)}/api/pair`, req, o.fetch);
  const credential: HubCredential = {
    version: 1,
    hubUrl: o.kind === 'node' ? response.nodeUrl : response.clientUrl,
    deviceId: response.deviceId,
    kind: response.kind,
    publicKey: keyPair.publicKey,
    privateKey: keyPair.privateKey,
    pairedAt: new Date().toISOString(),
  };
  if (o.machineId) credential.machineId = o.machineId;
  return { credential, response };
}

/** Challenge → sign → token. */
export async function requestToken(o: {
  hubUrl: string;
  deviceId: string;
  privateKey: Ed25519PrivateJwk;
  fetch?: typeof fetch;
}): Promise<TokenResponse> {
  const base = hubHttpBase(o.hubUrl);
  const { nonce } = await postJson<ChallengeResponse>(`${base}/api/auth/challenge`, { deviceId: o.deviceId }, o.fetch);
  const signature = signChallenge(o.privateKey, o.deviceId, nonce);
  return postJson<TokenResponse>(`${base}/api/auth/token`, { deviceId: o.deviceId, nonce, signature }, o.fetch);
}
