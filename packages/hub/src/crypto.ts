// Ed25519 keys, signatures, pairing codes and token hashing.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomInt, sign, verify, type KeyObject } from 'node:crypto';
import { authMessage, BizziError, normalizePairingCode, type Ed25519PublicJwk } from '@bizzi/protocol';

type Jwk = { [key: string]: string };

/** Ed25519 private key as a JWK (`{ kty: 'OKP', crv: 'Ed25519', x, d }`). */
export interface Ed25519PrivateJwk extends Ed25519PublicJwk {
  d: string;
}

export interface Ed25519KeyPair {
  publicKey: Ed25519PublicJwk;
  privateKey: Ed25519PrivateJwk;
}

export function generateKeyPair(): Ed25519KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'jwk' }) as Jwk;
  const priv = privateKey.export({ format: 'jwk' }) as Jwk;
  return {
    publicKey: { kty: 'OKP', crv: 'Ed25519', x: pub.x as string },
    privateKey: { kty: 'OKP', crv: 'Ed25519', x: priv.x as string, d: priv.d as string },
  };
}

/** Parse and validate an Ed25519 public JWK; throws bad_request. */
export function importPublicKey(jwk: unknown): { key: KeyObject; jwk: Ed25519PublicJwk } {
  const j = jwk as Partial<Ed25519PublicJwk> | null;
  if (!j || typeof j !== 'object' || j.kty !== 'OKP' || j.crv !== 'Ed25519' || typeof j.x !== 'string') {
    throw new BizziError('bad_request', 'publicKey must be an Ed25519 JWK ({kty:"OKP",crv:"Ed25519",x})');
  }
  const clean: Ed25519PublicJwk = { kty: 'OKP', crv: 'Ed25519', x: j.x };
  try {
    const key = createPublicKey({ key: { ...clean }, format: 'jwk' });
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('not ed25519');
    return { key, jwk: clean };
  } catch {
    throw new BizziError('bad_request', 'invalid Ed25519 public key');
  }
}

/** base64url Ed25519 signature over `authMessage(deviceId, nonce)`. */
export function signChallenge(privateKey: Ed25519PrivateJwk, deviceId: string, nonce: string): string {
  const key = createPrivateKey({ key: { ...privateKey }, format: 'jwk' });
  return sign(null, Buffer.from(authMessage(deviceId, nonce), 'utf8'), key).toString('base64url');
}

export function verifyChallenge(publicKey: Ed25519PublicJwk, deviceId: string, nonce: string, signature: string): boolean {
  try {
    const sig = Buffer.from(signature, 'base64url');
    if (sig.length !== 64) return false;
    const key = createPublicKey({ key: { ...publicKey }, format: 'jwk' });
    return verify(null, Buffer.from(authMessage(deviceId, nonce), 'utf8'), key, sig);
  } catch {
    return false;
  }
}

// Crockford base32 without the letters most often misread (0/O, 1/I/L are excluded entirely).
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
export const PAIRING_CODE_LENGTH = 8;

/** A fresh human-friendly code, formatted "ABCD-EFGH". */
export function newPairingCode(): string {
  let s = '';
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

export function hashPairingCode(code: string): string {
  return sha256(`bizzi-pair:${normalizePairingCode(code)}`);
}

export function newSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function hashToken(token: string): string {
  return sha256(`bizzi-token:${token}`);
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}
