// Web Push primitives on node:crypto (docs/tech-choices.md D9): message encryption with `aes128gcm`
// (RFC 8291 on top of RFC 8188) and VAPID application-server identification (RFC 8292). Delivery
// (RFC 8030) lives in webpush-service.ts.

import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { BizziError } from '@bizzi/protocol';

/** A VAPID keypair as base64url: the uncompressed P-256 point (65 bytes) and the private scalar (32 bytes). */
export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/** The record size the header announces; one record carries the whole message. */
export const WEB_PUSH_RECORD_SIZE = 4096;
/** Push services accept bodies up to 4096 bytes: 86 header + plaintext + 1 delimiter + 16 tag. */
export const WEB_PUSH_MAX_PLAINTEXT = 4096 - 86 - 1 - 16;

export function b64url(buf: Uint8Array): string {
  return Buffer.from(buf).toString('base64url');
}

export function fromB64url(s: string): Buffer {
  // Browsers' PushSubscription.toJSON() is base64url; tolerate standard base64 and padding too.
  return Buffer.from(s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), 'base64url');
}

function pad32(b: Buffer): Buffer {
  if (b.length === 32) return b;
  if (b.length > 32) throw new BizziError('bad_request', 'P-256 private key longer than 32 bytes');
  return Buffer.concat([Buffer.alloc(32 - b.length), b]);
}

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(pad32(ecdh.getPrivateKey())) };
}

/** Throws unless `keys` is a consistent P-256 keypair. */
export function checkVapidKeys(keys: VapidKeys): void {
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(pad32(fromB64url(keys.privateKey)));
  if (!ecdh.getPublicKey().equals(fromB64url(keys.publicKey))) throw new BizziError('bad_request', 'VAPID public key does not match the private key');
}

export function vapidKeyObject(keys: VapidKeys): KeyObject {
  const pub = fromB64url(keys.publicKey);
  if (pub.length !== 65 || pub[0] !== 4) throw new BizziError('bad_request', 'VAPID public key must be an uncompressed P-256 point');
  return createPrivateKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', d: b64url(pad32(fromB64url(keys.privateKey))), x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33, 65)) },
  });
}

/** The push service's origin, which is the JWT audience (RFC 8292 §2). */
export function pushAudience(endpoint: string): string {
  return new URL(endpoint).origin;
}

/** An ES256 JWT `{ aud, exp, sub }` signed with the VAPID key (RFC 8292 §2). */
export function vapidJwt(o: { audience: string; subject: string; expiresAt: number; key: KeyObject }): string {
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(Buffer.from(JSON.stringify({ aud: o.audience, exp: Math.floor(o.expiresAt), sub: o.subject })));
  const input = `${header}.${claims}`;
  const sig = sign('sha256', Buffer.from(input), { key: o.key, dsaEncoding: 'ieee-p1363' });
  return `${input}.${b64url(sig)}`;
}

/** The `Authorization` header value: `vapid t=<jwt>, k=<public key>` (RFC 8292 §3). */
export function vapidAuthorization(jwt: string, publicKey: string): string {
  return `vapid t=${jwt}, k=${publicKey}`;
}

export interface EncryptOptions {
  /** Fixed application-server ECDH private key (tests); default: a fresh one per message. */
  asPrivateKey?: Uint8Array;
  /** Fixed 16-byte salt (tests); default: random. */
  salt?: Uint8Array;
  recordSize?: number;
}

/**
 * Encrypt one push message for a subscription (RFC 8291 §3.4): ECDH with the user agent's `p256dh`
 * key, combined with its `auth` secret, then a single aes128gcm record (RFC 8188 §2) whose header
 * carries the salt, record size and the application server's ephemeral public key.
 */
export function encryptWebPush(plaintext: Uint8Array, sub: { p256dh: string; auth: string }, o: EncryptOptions = {}): Buffer {
  const uaPublic = fromB64url(sub.p256dh);
  const authSecret = fromB64url(sub.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new BizziError('bad_request', 'p256dh must be an uncompressed P-256 point');
  if (authSecret.length !== 16) throw new BizziError('bad_request', 'auth secret must be 16 bytes');
  const rs = o.recordSize ?? WEB_PUSH_RECORD_SIZE;
  if (plaintext.length + 1 + 16 > rs) throw new BizziError('bad_request', 'push message does not fit in one record');

  const ecdh = createECDH('prime256v1');
  if (o.asPrivateKey) ecdh.setPrivateKey(Buffer.from(o.asPrivateKey));
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const salt = o.salt ? Buffer.from(o.salt) : randomBytes(16);
  if (salt.length !== 16) throw new BizziError('bad_request', 'salt must be 16 bytes');

  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // The last (only) record ends with the 0x02 delimiter and no further padding.
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.update(Buffer.from([2])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(rs, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, ct]);
}
