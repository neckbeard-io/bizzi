// Pairing, challenge/response token issuance and token validation (docs/tech-choices.md D8, hub.ts).

import {
  BizziError,
  newId,
  normalizePairingCode,
  type ChallengeResponse,
  type DeviceKind,
  type PairRequest,
  type TokenRequest,
  type TokenResponse,
} from '@bizzi/protocol';
import { hashPairingCode, hashToken, importPublicKey, newPairingCode, newSecret, PAIRING_CODE_LENGTH, verifyChallenge } from './crypto.ts';
import type { DeviceRow, HubStore } from './store.ts';

export interface AuthOptions {
  /** Bearer token lifetime (default 1 h). */
  tokenTtlMs?: number;
  /** Challenge nonce lifetime (default 60 s). */
  nonceTtlMs?: number;
  /** pairing.create code lifetime (default 10 min). */
  pairingTtlMs?: number;
  /** Failed attempts allowed per client key and window before 429 (default 10). */
  maxFailures?: number;
  /** Failed attempts allowed across all clients per window (default 200). */
  maxGlobalFailures?: number;
  /** Rate-limit window (default 10 min). */
  failureWindowMs?: number;
  now?: () => number;
}

/** Thrown when a client exceeded its failed-attempt budget (HTTP 429). */
export class RateLimitedError extends BizziError {
  readonly retryAfterSec: number;
  constructor(retryAfterSec: number) {
    super('unauthorized', 'too many failed attempts; try again later', { retryAfter: retryAfterSec });
    this.retryAfterSec = retryAfterSec;
  }
}

/** Sliding-window counter of failures per key plus a global cap. */
export class FailureLimiter {
  readonly #max: number;
  readonly #maxGlobal: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #hits = new Map<string, number[]>();
  #global: number[] = [];

  constructor(max: number, maxGlobal: number, windowMs: number, now: () => number) {
    this.#max = max;
    this.#maxGlobal = maxGlobal;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  /** Throws RateLimitedError when `key` (or everyone) is over budget. */
  check(key: string): void {
    const now = this.#now();
    const cutoff = now - this.#windowMs;
    this.#global = this.#global.filter((t) => t > cutoff);
    const hits = (this.#hits.get(key) ?? []).filter((t) => t > cutoff);
    if (hits.length) this.#hits.set(key, hits);
    else this.#hits.delete(key);
    const oldest = hits.length >= this.#max ? hits[0] : this.#global.length >= this.#maxGlobal ? this.#global[0] : undefined;
    if (oldest !== undefined) throw new RateLimitedError(Math.max(1, Math.ceil((oldest + this.#windowMs - now) / 1000)));
  }

  fail(key: string): void {
    const now = this.#now();
    this.#global.push(now);
    const hits = this.#hits.get(key) ?? [];
    hits.push(now);
    this.#hits.set(key, hits);
    if (this.#hits.size > 10_000) {
      // Don't let a flood of distinct keys grow memory without bound.
      const first = this.#hits.keys().next().value;
      if (first !== undefined) this.#hits.delete(first);
    }
  }
}

export interface PairResult {
  device: DeviceRow;
  /** Node devices previously serving the same machine (now revoked). */
  replaced: DeviceRow[];
  /** The setup code was used. */
  setup: boolean;
}

export class Auth {
  readonly #store: HubStore;
  readonly #now: () => number;
  readonly tokenTtlMs: number;
  readonly nonceTtlMs: number;
  readonly pairingTtlMs: number;
  readonly #pairLimiter: FailureLimiter;
  readonly #tokenLimiter: FailureLimiter;

  constructor(store: HubStore, opts: AuthOptions = {}) {
    this.#store = store;
    this.#now = opts.now ?? Date.now;
    this.tokenTtlMs = opts.tokenTtlMs ?? 60 * 60_000;
    this.nonceTtlMs = opts.nonceTtlMs ?? 60_000;
    this.pairingTtlMs = opts.pairingTtlMs ?? 10 * 60_000;
    const window = opts.failureWindowMs ?? 10 * 60_000;
    this.#pairLimiter = new FailureLimiter(opts.maxFailures ?? 10, opts.maxGlobalFailures ?? 200, window, this.#now);
    this.#tokenLimiter = new FailureLimiter(opts.maxFailures ?? 10, opts.maxGlobalFailures ?? 200, window, this.#now);
  }

  /**
   * When no device is paired yet, issue a fresh setup code (older unused ones are invalidated) and return it.
   * Returns undefined once the hub has devices.
   */
  issueSetupCode(): string | undefined {
    if (this.#store.countDevices() > 0) return undefined;
    const code = newPairingCode();
    this.#store.tx(() => {
      this.#store.dropSetupCodes();
      this.#store.insertPairingCode({ hash: hashPairingCode(code), kind: 'device', name: 'setup', setup: true });
    });
    return code;
  }

  /** A one-time code for a new device or node. */
  createPairingCode(kind: DeviceKind, opts: { name?: string; createdBy?: string } = {}): { code: string; expiresAt: string } {
    if (kind !== 'device' && kind !== 'node') throw new BizziError('bad_request', "kind must be 'device' or 'node'");
    const code = newPairingCode();
    const expiresAt = this.#now() + this.pairingTtlMs;
    const row: Parameters<HubStore['insertPairingCode']>[0] = { hash: hashPairingCode(code), kind, setup: false, expiresAt };
    if (opts.name) row.name = opts.name;
    if (opts.createdBy) row.createdBy = opts.createdBy;
    this.#store.sweep(this.#now());
    this.#store.insertPairingCode(row);
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  pair(body: unknown, clientKey: string): PairResult {
    this.#pairLimiter.check(clientKey);
    const req = (body && typeof body === 'object' ? body : {}) as Partial<PairRequest>;
    if (typeof req.code !== 'string' || req.code.length > 64) throw new BizziError('bad_request', 'code is required');
    if (req.kind !== 'device' && req.kind !== 'node') throw new BizziError('bad_request', "kind must be 'device' or 'node'");
    const name = typeof req.name === 'string' ? req.name.trim().slice(0, 100) : '';
    if (!name) throw new BizziError('bad_request', 'name is required');
    const { jwk } = importPublicKey(req.publicKey);
    let machineId: string | undefined;
    if (req.kind === 'node') {
      if (typeof req.machineId !== 'string' || !/^m_[0-9A-Za-z]{1,64}$/.test(req.machineId)) {
        throw new BizziError('bad_request', "machineId is required for kind 'node'");
      }
      machineId = req.machineId;
    }

    const normalized = normalizePairingCode(req.code);
    const hash = hashPairingCode(normalized);
    const code = normalized.length === PAIRING_CODE_LENGTH ? this.#store.getPairingCode(hash) : undefined;
    const now = this.#now();
    if (!code || code.usedAt || (code.expiresAt !== undefined && code.expiresAt < now)) {
      this.#pairLimiter.fail(clientKey);
      throw new BizziError('unauthorized', 'invalid or expired pairing code');
    }
    if (code.kind !== req.kind) {
      this.#pairLimiter.fail(clientKey);
      throw new BizziError('unauthorized', `this pairing code is for a ${code.kind}, not a ${req.kind}`);
    }

    return this.#store.tx(() => {
      const createdAt = new Date(now).toISOString();
      const device: DeviceRow = { id: newId('d'), name, kind: req.kind as DeviceKind, createdAt, publicKey: jwk };
      if (machineId) device.machineId = machineId;
      if (code.setup) device.owner = true;
      if (!this.#store.usePairingCode(hash, device.id)) throw new BizziError('unauthorized', 'invalid or expired pairing code');
      const replaced = machineId ? this.#store.nodeDevicesFor(machineId) : [];
      for (const old of replaced) this.#store.revokeDevice(old.id);
      this.#store.insertDevice(device);
      return { device, replaced: replaced.map((d) => ({ ...d, revoked: true })), setup: code.setup };
    });
  }

  challenge(body: unknown, clientKey: string): ChallengeResponse {
    this.#tokenLimiter.check(clientKey);
    const deviceId = (body as { deviceId?: unknown } | null)?.deviceId;
    if (typeof deviceId !== 'string') throw new BizziError('bad_request', 'deviceId is required');
    const device = this.#store.getDevice(deviceId);
    if (!device || device.revoked) {
      this.#tokenLimiter.fail(clientKey);
      throw new BizziError('unauthorized', 'unknown or revoked device');
    }
    const now = this.#now();
    this.#store.sweep(now);
    const nonce = newSecret(24);
    const expiresAt = now + this.nonceTtlMs;
    this.#store.insertNonce(nonce, deviceId, expiresAt);
    return { nonce, expiresAt: new Date(expiresAt).toISOString() };
  }

  token(body: unknown, clientKey: string): TokenResponse & { device: DeviceRow } {
    this.#tokenLimiter.check(clientKey);
    const req = (body && typeof body === 'object' ? body : {}) as Partial<TokenRequest>;
    if (typeof req.deviceId !== 'string' || typeof req.nonce !== 'string' || typeof req.signature !== 'string') {
      throw new BizziError('bad_request', 'deviceId, nonce and signature are required');
    }
    const fail = (message: string): never => {
      this.#tokenLimiter.fail(clientKey);
      throw new BizziError('unauthorized', message);
    };
    const now = this.#now();
    const nonce = this.#store.takeNonce(req.nonce);
    if (!nonce || nonce.deviceId !== req.deviceId || nonce.expiresAt < now) return fail('invalid or expired challenge');
    const device = this.#store.getDevice(req.deviceId);
    if (!device || device.revoked) return fail('unknown or revoked device');
    if (!verifyChallenge(device.publicKey, device.id, req.nonce, req.signature)) return fail('bad signature');
    const token = `bzt_${newSecret(32)}`;
    const expiresAt = now + this.tokenTtlMs;
    this.#store.insertToken(hashToken(token), device.id, expiresAt);
    this.#store.touchDevice(device.id, new Date(now).toISOString());
    return { token, expiresAt: new Date(expiresAt).toISOString(), device };
  }

  /** Resolve a bearer token to its (non-revoked) device; throws unauthorized. */
  authenticate(token: unknown): DeviceRow {
    if (typeof token !== 'string' || !token) throw new BizziError('unauthorized', 'token required');
    const row = this.#store.getToken(hashToken(token));
    if (!row || row.expiresAt < this.#now()) throw new BizziError('unauthorized', 'invalid or expired token');
    const device = this.#store.getDevice(row.deviceId);
    if (!device || device.revoked) throw new BizziError('unauthorized', 'device revoked');
    return device;
  }
}
