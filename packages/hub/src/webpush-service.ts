// Web Push delivery (docs/tech-choices.md D9, RFC 8030): browser/PWA subscriptions registered with
// `push.register`, a VAPID keypair kept in the hub data dir, and a `PushSink` that encrypts the same
// notifications ntfy gets to every subscription. Approvals carry a single-use action token so the
// service worker's Approve / Deny buttons can answer through POST /api/push/action.

import { createHash, randomBytes, type KeyObject } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  BizziError,
  type ApprovalDecisionKind,
  type Logger,
  type PushActionResponse,
  type WebPushPayload,
  type WebPushSubscription,
} from '@bizzi/protocol';
import type { PushNotification, PushSink } from './push.ts';
import type { DeviceRow, HubStore } from './store.ts';
import {
  WEB_PUSH_MAX_PLAINTEXT,
  checkVapidKeys,
  encryptWebPush,
  fromB64url,
  generateVapidKeys,
  pushAudience,
  vapidAuthorization,
  vapidJwt,
  vapidKeyObject,
  type VapidKeys,
} from './webpush.ts';

export const VAPID_FILE = 'vapid.json';
/** How long an Approve / Deny token stays valid. */
const ACTION_TTL_MS = 24 * 60 * 60_000;
/** VAPID JWTs are reused per push service for this long (RFC 8292 allows up to 24 h). */
const JWT_LIFETIME_S = 12 * 60 * 60;
const MAX_SUBSCRIPTIONS_PER_DEVICE = 20;
const MAX_ENDPOINT = 2048;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint   TEXT PRIMARY KEY,
  device_id  TEXT NOT NULL,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  vapid_key  TEXT NOT NULL,
  base_url   TEXT,
  name       TEXT,
  created_at TEXT NOT NULL,
  last_ok_at TEXT
);
CREATE TABLE IF NOT EXISTS push_actions (
  hash        TEXT PRIMARY KEY,
  device_id   TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  approval_id TEXT NOT NULL,
  options     TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
);
`;

export interface PushSubscriptionRow {
  endpoint: string;
  deviceId: string;
  p256dh: string;
  auth: string;
  /** The VAPID public key the browser subscribed with; another key can't reach it. */
  vapidKey: string;
  /** Hub base URL the device registered through (click-through and action links without a publicUrl). */
  baseUrl?: string;
  name?: string;
  createdAt: string;
  lastOkAt?: string;
}

interface ActionRow {
  deviceId: string;
  sessionId: string;
  approvalId: string;
  options: ApprovalDecisionKind[];
  expiresAt: number;
}

type Row = Record<string, unknown>;

/** Subscriptions and action tokens, in hub.db. */
export class WebPushTable {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
    db.exec(SCHEMA);
  }

  upsert(r: PushSubscriptionRow): void {
    this.#db
      .prepare(
        `INSERT INTO push_subscriptions (endpoint, device_id, p256dh, auth, vapid_key, base_url, name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET device_id = excluded.device_id, p256dh = excluded.p256dh, auth = excluded.auth,
           vapid_key = excluded.vapid_key, base_url = excluded.base_url, name = excluded.name`,
      )
      .run(r.endpoint, r.deviceId, r.p256dh, r.auth, r.vapidKey, r.baseUrl ?? null, r.name ?? null, r.createdAt);
    // Keep the newest few per device (a browser that re-subscribes gets a new endpoint each time).
    this.#db
      .prepare(
        `DELETE FROM push_subscriptions WHERE device_id = ? AND endpoint NOT IN
           (SELECT endpoint FROM push_subscriptions WHERE device_id = ? ORDER BY created_at DESC, endpoint LIMIT ?)`,
      )
      .run(r.deviceId, r.deviceId, MAX_SUBSCRIPTIONS_PER_DEVICE);
  }

  list(deviceId?: string): PushSubscriptionRow[] {
    const rows = (
      deviceId === undefined
        ? this.#db.prepare('SELECT * FROM push_subscriptions ORDER BY created_at, endpoint').all()
        : this.#db.prepare('SELECT * FROM push_subscriptions WHERE device_id = ? ORDER BY created_at, endpoint').all(deviceId)
    ) as Row[];
    return rows.map(subFromRow);
  }

  delete(endpoint: string, deviceId?: string): boolean {
    const res =
      deviceId === undefined
        ? this.#db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint)
        : this.#db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND device_id = ?').run(endpoint, deviceId);
    return Number(res.changes) > 0;
  }

  /** Drop subscriptions made with another VAPID key (the key file was replaced); returns how many. */
  dropOtherKeys(vapidKey: string): number {
    return Number(this.#db.prepare('DELETE FROM push_subscriptions WHERE vapid_key <> ?').run(vapidKey).changes);
  }

  markOk(endpoint: string, at: string): void {
    this.#db.prepare('UPDATE push_subscriptions SET last_ok_at = ? WHERE endpoint = ?').run(at, endpoint);
  }

  insertAction(hash: string, a: ActionRow): void {
    this.#db
      .prepare('INSERT INTO push_actions (hash, device_id, session_id, approval_id, options, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(hash, a.deviceId, a.sessionId, a.approvalId, JSON.stringify(a.options), a.expiresAt);
  }

  /** Single use: returns the token's row and invalidates every token for the same approval. */
  takeAction(hash: string, now: number): ActionRow | undefined {
    this.#db.prepare('DELETE FROM push_actions WHERE expires_at < ?').run(now);
    const r = this.#db.prepare('SELECT * FROM push_actions WHERE hash = ?').get(hash) as Row | undefined;
    if (!r) return undefined;
    this.#db.prepare('DELETE FROM push_actions WHERE approval_id = ? AND session_id = ?').run(r.approval_id as string, r.session_id as string);
    return {
      deviceId: r.device_id as string,
      sessionId: r.session_id as string,
      approvalId: r.approval_id as string,
      options: JSON.parse(r.options as string) as ApprovalDecisionKind[],
      expiresAt: Number(r.expires_at),
    };
  }
}

function subFromRow(r: Row): PushSubscriptionRow {
  const s: PushSubscriptionRow = {
    endpoint: r.endpoint as string,
    deviceId: r.device_id as string,
    p256dh: r.p256dh as string,
    auth: r.auth as string,
    vapidKey: r.vapid_key as string,
    createdAt: r.created_at as string,
  };
  if (r.base_url) s.baseUrl = r.base_url as string;
  if (r.name) s.name = r.name as string;
  if (r.last_ok_at) s.lastOkAt = r.last_ok_at as string;
  return s;
}

/** Load `<dataDir>/vapid.json`, or generate and write it (mode 0600) on first start. */
export function loadOrCreateVapidKeys(dataDir: string): { keys: VapidKeys; created: boolean } {
  const file = join(dataDir, VAPID_FILE);
  if (existsSync(file)) {
    let keys: VapidKeys;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<VapidKeys>;
      if (typeof raw.publicKey !== 'string' || typeof raw.privateKey !== 'string') throw new Error('publicKey and privateKey are required');
      keys = { publicKey: raw.publicKey, privateKey: raw.privateKey };
      checkVapidKeys(keys);
    } catch (err) {
      throw new BizziError('internal', `invalid VAPID key file ${file} (delete it to generate a new key): ${(err as Error).message}`);
    }
    return { keys, created: false };
  }
  const keys = generateVapidKeys();
  writeFileSync(file, JSON.stringify({ ...keys, createdAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
  return { keys, created: true };
}

export interface WebPushServiceOptions {
  store: HubStore;
  dataDir: string;
  logger: Logger;
  /** Public UI base URL; else the URL each device registered through. */
  publicUrl?: string;
  /** VAPID `sub` claim: a mailto: or https: URL (default: an https publicUrl, else mailto:bizzi@localhost). */
  subject?: string;
  /** How long push services keep an undelivered message (default 24 h). */
  ttlSec?: number;
  /** Accept http:// endpoints (tests against a fake push service). */
  allowInsecureEndpoints?: boolean;
  fetch?: typeof fetch;
  now?: () => number;
  /** Answer an approval as `device` (the relay's `approval.respond`). */
  respond: (device: DeviceRow, params: { sessionId: string; approvalId: string; decision: ApprovalDecisionKind }) => Promise<unknown>;
}

type Outcome = 'ok' | 'gone' | 'failed';

export class WebPushService implements PushSink {
  readonly publicKey: string;
  readonly #o: WebPushServiceOptions;
  readonly #key: KeyObject;
  readonly #subject: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #jwts = new Map<string, { header: string; exp: number }>();

  constructor(o: WebPushServiceOptions) {
    this.#o = o;
    this.#fetch = o.fetch ?? fetch;
    this.#now = o.now ?? Date.now;
    const { keys, created } = loadOrCreateVapidKeys(o.dataDir);
    this.publicKey = keys.publicKey;
    this.#key = vapidKeyObject(keys);
    const pub = o.publicUrl?.replace(/\/+$/, '');
    this.#subject = o.subject ?? (pub?.startsWith('https://') ? pub : 'mailto:bizzi@localhost');
    if (!/^(mailto:|https:\/\/)/.test(this.#subject)) throw new BizziError('bad_request', 'the VAPID subject must be a mailto: or https: URL');
    if (created) o.logger.log('info', 'generated a VAPID key for Web Push', { file: join(o.dataDir, VAPID_FILE) });
    const dropped = o.store.webPush.dropOtherKeys(keys.publicKey);
    if (dropped) o.logger.log('warn', 'dropped Web Push subscriptions made with another VAPID key', { dropped });
  }

  /** Hub-only `push.*` methods for a paired device. */
  async handle(device: DeviceRow, method: string, p: Record<string, unknown>, ctx: { baseUrl?: string }): Promise<unknown> {
    switch (method) {
      case 'push.config':
        return { webPush: { publicKey: this.publicKey } };
      case 'push.register': {
        const sub = this.#validSubscription(p.subscription);
        const row: PushSubscriptionRow = {
          endpoint: sub.endpoint,
          deviceId: device.id,
          p256dh: sub.keys.p256dh,
          auth: sub.keys.auth,
          vapidKey: this.publicKey,
          createdAt: new Date(this.#now()).toISOString(),
        };
        if (ctx.baseUrl) row.baseUrl = ctx.baseUrl;
        if (typeof p.name === 'string' && p.name.trim()) row.name = p.name.trim().slice(0, 100);
        this.#o.store.webPush.upsert(row);
        this.#o.logger.log('info', 'web push subscription registered', { deviceId: device.id, service: pushAudience(sub.endpoint) });
        return {};
      }
      case 'push.unregister':
        if (typeof p.endpoint !== 'string') throw new BizziError('bad_request', 'endpoint is required');
        this.#o.store.webPush.delete(p.endpoint, device.id);
        return {};
      case 'push.test': {
        const subs = this.#o.store.webPush.list(device.id);
        const outcomes = await Promise.all(
          subs.map((s) =>
            this.#deliver(s, { title: 'bizzi', body: 'Notifications work on this device.', tags: 'white_check_mark', priority: 'default', key: 'test' }),
          ),
        );
        const sent = outcomes.filter((x) => x === 'ok').length;
        return { sent, failed: outcomes.length - sent };
      }
    }
    throw new BizziError('unsupported', `unknown method ${method}`);
  }

  /** PushSink: deliver to every live subscription. */
  async send(n: PushNotification): Promise<void> {
    const subs = this.#o.store.isOpen ? this.#o.store.webPush.list() : [];
    await Promise.all(subs.map((s) => this.#deliver(s, n)));
  }

  /** POST /api/push/action: answer an approval with a notification's token. */
  async action(body: unknown): Promise<PushActionResponse> {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    if (typeof b.token !== 'string' || !b.token) throw new BizziError('bad_request', 'token is required');
    const decision = b.decision;
    if (decision !== 'allow' && decision !== 'deny' && decision !== 'allow_always') throw new BizziError('bad_request', 'decision must be allow, allow_always or deny');
    const row = this.#o.store.webPush.takeAction(hashToken(b.token), this.#now());
    if (!row) throw new BizziError('unauthorized', 'unknown or expired action token');
    const device = this.#o.store.getDevice(row.deviceId);
    if (!device || device.revoked || device.kind !== 'device') throw new BizziError('unauthorized', 'device revoked');
    if (row.options.length > 0 && !row.options.includes(decision)) throw new BizziError('bad_request', `this approval does not offer ${decision}`);
    await this.#o.respond(device, { sessionId: row.sessionId, approvalId: row.approvalId, decision });
    this.#o.logger.log('info', 'approval answered from a notification', { deviceId: device.id, sessionId: row.sessionId, decision });
    return { ok: true };
  }

  #validSubscription(v: unknown): WebPushSubscription {
    const s = (v && typeof v === 'object' ? v : {}) as Partial<WebPushSubscription>;
    if (typeof s.endpoint !== 'string' || s.endpoint.length > MAX_ENDPOINT) throw new BizziError('bad_request', 'subscription.endpoint is required');
    let url: URL;
    try {
      url = new URL(s.endpoint);
    } catch {
      throw new BizziError('bad_request', 'subscription.endpoint must be a URL');
    }
    if (url.protocol !== 'https:' && !(this.#o.allowInsecureEndpoints && url.protocol === 'http:')) {
      throw new BizziError('bad_request', 'subscription.endpoint must be https');
    }
    const keys = s.keys;
    if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') throw new BizziError('bad_request', 'subscription.keys.p256dh and auth are required');
    const p256dh = fromB64url(keys.p256dh);
    if (p256dh.length !== 65 || p256dh[0] !== 4) throw new BizziError('bad_request', 'subscription.keys.p256dh must be an uncompressed P-256 point');
    if (fromB64url(keys.auth).length !== 16) throw new BizziError('bad_request', 'subscription.keys.auth must be 16 bytes');
    return { endpoint: s.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
  }

  #payload(sub: PushSubscriptionRow, n: PushNotification): WebPushPayload {
    const base = (this.#o.publicUrl ?? sub.baseUrl)?.replace(/\/+$/, '');
    const route = n.sessionId !== undefined ? `#/s/${encodeURIComponent(n.sessionId)}` : '#/';
    const payload: WebPushPayload = {
      v: 1,
      title: n.title.slice(0, 200),
      body: n.body.slice(0, 1500),
      tag: n.key,
      url: base ? `${base}/${route}` : `./${route}`,
    };
    if (n.sessionId !== undefined) payload.sessionId = n.sessionId;
    if (n.priority === 'high') payload.urgent = true;
    if (n.approval && base) {
      const token = randomBytes(32).toString('base64url');
      this.#o.store.webPush.insertAction(hashToken(token), {
        deviceId: sub.deviceId,
        sessionId: n.approval.sessionId,
        approvalId: n.approval.approvalId,
        options: n.approval.options,
        expiresAt: this.#now() + ACTION_TTL_MS,
      });
      payload.approval = { ...n.approval, token, actionUrl: `${base}/api/push/action` };
    }
    // Stay inside one 4 KiB record: trim the body until the JSON fits.
    while (Buffer.byteLength(JSON.stringify(payload)) > WEB_PUSH_MAX_PLAINTEXT && payload.body.length > 0) {
      payload.body = payload.body.slice(0, Math.floor(payload.body.length / 2));
    }
    return payload;
  }

  #authorization(endpoint: string): string {
    const aud = pushAudience(endpoint);
    const nowS = Math.floor(this.#now() / 1000);
    const cached = this.#jwts.get(aud);
    if (cached && cached.exp - nowS > 3600) return cached.header;
    const exp = nowS + JWT_LIFETIME_S;
    const header = vapidAuthorization(vapidJwt({ audience: aud, subject: this.#subject, expiresAt: exp, key: this.#key }), this.publicKey);
    this.#jwts.set(aud, { header, exp });
    return header;
  }

  async #deliver(sub: PushSubscriptionRow, n: PushNotification): Promise<Outcome> {
    const log = this.#o.logger;
    if (!this.#o.store.isOpen) return 'failed';
    const device = this.#o.store.getDevice(sub.deviceId);
    if (!device || device.revoked) {
      this.#o.store.webPush.delete(sub.endpoint);
      return 'gone';
    }
    let body: Buffer;
    try {
      body = encryptWebPush(Buffer.from(JSON.stringify(this.#payload(sub, n))), sub);
    } catch (err) {
      log.log('warn', 'web push: could not encrypt for a subscription', { deviceId: sub.deviceId, err: String(err) });
      return 'failed';
    }
    let res: Response;
    try {
      res = await this.#fetch(sub.endpoint, {
        method: 'POST',
        headers: {
          TTL: String(this.#o.ttlSec ?? 86_400),
          Urgency: n.priority === 'high' ? 'high' : 'normal',
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          Authorization: this.#authorization(sub.endpoint),
        },
        body,
      });
    } catch (err) {
      log.log('warn', 'web push failed', { service: pushAudience(sub.endpoint), err: String(err) });
      return 'failed';
    }
    await res.body?.cancel().catch(() => {});
    if (res.ok) {
      if (this.#o.store.isOpen) this.#o.store.webPush.markOk(sub.endpoint, new Date(this.#now()).toISOString());
      return 'ok';
    }
    if (res.status === 404 || res.status === 410) {
      // RFC 8030 §7.3: the subscription expired or was removed; don't use it again.
      if (this.#o.store.isOpen) this.#o.store.webPush.delete(sub.endpoint);
      log.log('info', 'web push subscription expired; removed', { deviceId: sub.deviceId, status: res.status });
      return 'gone';
    }
    log.log('warn', 'web push rejected', { service: pushAudience(sub.endpoint), status: res.status });
    return 'failed';
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}
